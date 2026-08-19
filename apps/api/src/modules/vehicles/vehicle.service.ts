import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, organization, person, vehicle, vehicleFlag, type Database,
} from '@leoos/db';
import { can, requirePermission, type ActorContext, type Decision } from '@leoos/authz-core';
import type { PermissionKey } from '@leoos/contracts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';

/**
 * Vehicle record mutations.
 *
 * Access is by permission, as for persons — the register is shared. ONE THING IS
 * ORGANIZATION-SCOPED, and it is scoped because the data is owned rather than
 * because the actor is: a FLEET vehicle belongs to an organization, and editing
 * or archiving another organization's fleet is refused. A PD sergeant retagging
 * an MD ambulance is the same class of cross-organization interference the rank
 * rules exist to prevent (engineering rule 11).
 *
 * A privately owned vehicle has no such owner, so any holder of `vehicles.edit`
 * may correct its record — which is the point of a shared register.
 */

function enforce(decision: Decision, what: string): void {
  if (!decision.allowed) {
    throw new ForbiddenError(`${what}: ${decision.reason}`, {
      reason: decision.reason,
      ...(decision.detail ? { detail: decision.detail } : {}),
    });
  }
}

function require(actor: ActorContext, permission: PermissionKey, what: string): void {
  enforce(requirePermission(actor, permission), what);
}

interface LoadedVehicle {
  id: string;
  plate: string;
  model: string;
  registrationStatus: string;
  insuranceStatus: string;
  isFleet: boolean;
  ownerPersonId: string | null;
  ownerOrganizationId: string | null;
  deletedAt: Date | null;
}

async function loadVehicle(tx: Database, vehicleId: string): Promise<LoadedVehicle | null> {
  const rows = await tx
    .select({
      id: vehicle.id, plate: vehicle.plate, model: vehicle.model,
      registrationStatus: vehicle.registrationStatus,
      insuranceStatus: vehicle.insuranceStatus,
      isFleet: vehicle.isFleet,
      ownerPersonId: vehicle.ownerPersonId,
      ownerOrganizationId: vehicle.ownerOrganizationId,
      deletedAt: vehicle.deletedAt,
    })
    .from(vehicle)
    .where(eq(vehicle.id, vehicleId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A fleet vehicle may only be touched from inside the organization that owns it.
 *
 * Applied on writes only. Reads stay open: everyone should be able to see that a
 * unit belongs to MD, and hiding it would make a traffic stop harder without
 * making anything safer.
 */
function assertFleetScope(
  actor: ActorContext,
  target: { ownerOrganizationId: string | null },
  what: string,
): void {
  if (target.ownerOrganizationId === null) return;
  if (actor.isGlobalAdmin) return;
  if (actor.organizationId === target.ownerOrganizationId) return;
  throw new ForbiddenError(
    `${what}: CROSS_ORGANIZATION`,
    { reason: 'CROSS_ORGANIZATION' },
    'That vehicle belongs to another organization’s fleet.',
  );
}

/**
 * An organization assignment must be the actor's OWN organization.
 *
 * Without this, `vehicles.edit` would let anyone hand a vehicle to any
 * organization — including moving their own department's unit into someone
 * else's fleet, where they could then no longer reach it.
 */
function assertAssignableOrganization(
  actor: ActorContext,
  organizationId: string | null,
  what: string,
): void {
  if (organizationId === null) return;
  if (actor.isGlobalAdmin) return;
  if (actor.organizationId === organizationId) return;
  throw new ForbiddenError(
    `${what}: CROSS_ORGANIZATION`,
    { reason: 'CROSS_ORGANIZATION' },
    'You can only assign a vehicle to your own organization.',
  );
}

async function assertPlateFree(
  tx: Database,
  plate: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await tx
    .select({ id: vehicle.id })
    .from(vehicle)
    .where(and(
      eq(vehicle.plate, plate),
      isNull(vehicle.deletedAt),
      exceptId ? ne(vehicle.id, exceptId) : undefined,
    ))
    .limit(1);
  if (clash[0]) {
    // The partial unique index enforces this too; checking here decides which
    // error the operator sees rather than a raw constraint violation.
    throw new ConflictError('PLATE_TAKEN', `Plate ${plate} is already registered.`);
  }
}

async function assertOwnerExists(tx: Database, personId: string | null): Promise<void> {
  if (!personId) return;
  const rows = await tx
    .select({ id: person.id, deletedAt: person.deletedAt })
    .from(person)
    .where(eq(person.id, personId))
    .limit(1);
  if (!rows[0] || rows[0].deletedAt) throw new NotFoundError('owner');
}

async function assertOrganizationExists(
  tx: Database,
  organizationId: string | null,
): Promise<void> {
  if (!organizationId) return;
  const rows = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(and(eq(organization.id, organizationId), isNull(organization.deletedAt)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError('organization');
}

// ── Create ─────────────────────────────────────────────────────────────────

export interface VehicleInput {
  plate: string;
  model: string;
  displayName?: string | null;
  color?: string | null;
  vehicleClass?: string | null;
  ownerPersonId?: string | null;
  ownerOrganizationId?: string | null;
  registrationStatus?: 'registered' | 'expired' | 'unregistered';
  insuranceStatus?: 'insured' | 'uninsured' | 'expired';
  isFleet?: boolean;
  notes?: string | null;
}

export async function createVehicle(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  input: VehicleInput,
  meta: RequestMeta = {},
): Promise<{ vehicleId: string }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.VEHICLE_CREATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'vehicle', entityId: null, metadata: { plate: input.plate },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'vehicles.create', 'register vehicle');

      const ownerPersonId = input.ownerPersonId ?? null;
      const ownerOrganizationId = input.ownerOrganizationId ?? null;

      if (ownerPersonId && ownerOrganizationId) {
        // The database enforces this too (`vehicle_single_owner`); saying so
        // plainly beats a constraint name reaching the operator.
        throw new ConflictError(
          'DUAL_OWNER',
          'A vehicle has a person owner or an organization owner, not both.',
        );
      }

      assertAssignableOrganization(actor, ownerOrganizationId, 'register vehicle');
      await assertPlateFree(tx, input.plate, null);
      await assertOwnerExists(tx, ownerPersonId);
      await assertOrganizationExists(tx, ownerOrganizationId);

      const isFleet = Boolean(input.isFleet) && ownerOrganizationId !== null;

      const rows = await tx
        .insert(vehicle)
        .values({
          plate: input.plate,
          model: input.model,
          displayName: input.displayName ?? null,
          color: input.color ?? null,
          vehicleClass: input.vehicleClass ?? null,
          ownerPersonId,
          ownerOrganizationId,
          registrationStatus: input.registrationStatus ?? 'registered',
          insuranceStatus: input.insuranceStatus ?? 'uninsured',
          isFleet,
          notes: input.notes ?? null,
          createdBy: actorUserId,
        })
        .returning({ id: vehicle.id });

      const vehicleId = rows[0]!.id;

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.VEHICLE_CREATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'vehicle', entityId: vehicleId,
        after: {
          plate: input.plate, model: input.model,
          registrationStatus: input.registrationStatus ?? 'registered',
          insuranceStatus: input.insuranceStatus ?? 'uninsured',
          isFleet,
        },
        metadata: { plate: input.plate },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { vehicleId };
    }),
  );
}

// ── Update ─────────────────────────────────────────────────────────────────

export async function updateVehicle(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  vehicleId: string,
  input: Partial<VehicleInput>,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.VEHICLE_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'vehicle', entityId: vehicleId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'vehicles.edit', 'edit vehicle');

      const before = await loadVehicle(tx, vehicleId);
      if (!before || before.deletedAt) throw new NotFoundError('vehicle');

      // Scope on the CURRENT owner first: you must be able to touch the record
      // as it stands before you may change who owns it.
      assertFleetScope(actor, before, 'edit vehicle');

      const nextOrganizationId = input.ownerOrganizationId !== undefined
        ? input.ownerOrganizationId
        : before.ownerOrganizationId;
      const nextPersonId = input.ownerPersonId !== undefined
        ? input.ownerPersonId
        : before.ownerPersonId;

      if (nextPersonId && nextOrganizationId) {
        throw new ConflictError(
          'DUAL_OWNER',
          'A vehicle has a person owner or an organization owner, not both.',
        );
      }

      // …and on the DESTINATION: a record cannot be pushed into an organization
      // the actor has no standing in, where they could no longer reach it.
      assertAssignableOrganization(actor, nextOrganizationId, 'edit vehicle');

      if (input.plate !== undefined) await assertPlateFree(tx, input.plate, vehicleId);
      if (input.ownerPersonId !== undefined) await assertOwnerExists(tx, nextPersonId);
      if (input.ownerOrganizationId !== undefined) {
        await assertOrganizationExists(tx, nextOrganizationId);
      }

      const nextFleet = input.isFleet !== undefined ? input.isFleet : before.isFleet;

      await tx
        .update(vehicle)
        .set({
          ...(input.plate !== undefined ? { plate: input.plate } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.vehicleClass !== undefined ? { vehicleClass: input.vehicleClass } : {}),
          ...(input.ownerPersonId !== undefined ? { ownerPersonId: nextPersonId } : {}),
          ...(input.ownerOrganizationId !== undefined
            ? { ownerOrganizationId: nextOrganizationId } : {}),
          ...(input.registrationStatus !== undefined
            ? { registrationStatus: input.registrationStatus } : {}),
          ...(input.insuranceStatus !== undefined
            ? { insuranceStatus: input.insuranceStatus } : {}),
          // A fleet flag without an owning organization violates the database
          // CHECK, so it is corrected here rather than surfacing as a 500.
          isFleet: nextFleet && nextOrganizationId !== null,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        })
        .where(eq(vehicle.id, vehicleId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.VEHICLE_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'vehicle', entityId: vehicleId,
        before: {
          plate: before.plate,
          registrationStatus: before.registrationStatus,
          insuranceStatus: before.insuranceStatus,
          owner: before.ownerPersonId ?? before.ownerOrganizationId ?? 'none',
        },
        after: {
          plate: input.plate ?? before.plate,
          registrationStatus: input.registrationStatus ?? before.registrationStatus,
          insuranceStatus: input.insuranceStatus ?? before.insuranceStatus,
          owner: nextPersonId ?? nextOrganizationId ?? 'none',
        },
        metadata: { plate: before.plate },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Archive / restore ──────────────────────────────────────────────────────

export async function archiveVehicle(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  vehicleId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.VEHICLE_ARCHIVED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'vehicle', entityId: vehicleId, metadata: { reason },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'vehicles.delete', 'archive vehicle');

      const target = await loadVehicle(tx, vehicleId);
      if (!target) throw new NotFoundError('vehicle');
      if (target.deletedAt) {
        throw new ConflictError('ALREADY_ARCHIVED', 'That vehicle is already archived.');
      }
      assertFleetScope(actor, target, 'archive vehicle');

      // Soft delete: the plate becomes reusable (the unique index is partial)
      // while the record and its history survive (engineering rules 24, 25).
      await tx
        .update(vehicle)
        .set({ deletedAt: new Date(), deletedBy: actorUserId, deletionReason: reason })
        .where(eq(vehicle.id, vehicleId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.VEHICLE_ARCHIVED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'vehicle', entityId: vehicleId,
        before: { plate: target.plate, model: target.model },
        after: { archived: true },
        metadata: { reason, plate: target.plate },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function restoreVehicle(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  vehicleId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.VEHICLE_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'vehicle', entityId: vehicleId, metadata: { restore: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'vehicles.restore', 'restore vehicle');

      const target = await loadVehicle(tx, vehicleId);
      if (!target) throw new NotFoundError('vehicle');
      if (!target.deletedAt) {
        throw new ConflictError('NOT_ARCHIVED', 'That vehicle is not archived.');
      }
      assertFleetScope(actor, target, 'restore vehicle');

      // The plate may have been reissued while this record was archived — that
      // is the whole point of the partial index, so restoring has to check.
      await assertPlateFree(tx, target.plate, vehicleId);

      await tx
        .update(vehicle)
        .set({ deletedAt: null, deletedBy: null, deletionReason: null })
        .where(eq(vehicle.id, vehicleId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.VEHICLE_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'vehicle', entityId: vehicleId,
        after: { archived: false },
        metadata: { restored: true, plate: target.plate },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Flags ──────────────────────────────────────────────────────────────────

export async function addVehicleFlag(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  vehicleId: string,
  input: { type: string; note?: string | null },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.VEHICLE_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'vehicle', entityId: vehicleId, metadata: { flag: input.type },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'vehicles.flags.manage', 'flag vehicle');

      const target = await loadVehicle(tx, vehicleId);
      if (!target || target.deletedAt) throw new NotFoundError('vehicle');

      // Deliberately NOT fleet-scoped. Flagging a vehicle as stolen or of
      // interest is exactly what one organization needs to do about another
      // organization's property, and refusing it would make the shared register
      // useless at the moment it matters most.
      await tx.insert(vehicleFlag).values({
        vehicleId, type: input.type, note: input.note ?? null, createdBy: actorUserId,
      });

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.VEHICLE_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'vehicle', entityId: vehicleId,
        after: { flag: input.type },
        metadata: { plate: target.plate, flagAdded: input.type },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function resolveVehicleFlag(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  vehicleId: string,
  flagId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.VEHICLE_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'vehicle', entityId: vehicleId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'vehicles.flags.manage', 'clear vehicle flag');

      const rows = await tx
        .select({ type: vehicleFlag.type, resolvedAt: vehicleFlag.resolvedAt })
        .from(vehicleFlag)
        .where(and(eq(vehicleFlag.id, flagId), eq(vehicleFlag.vehicleId, vehicleId)))
        .limit(1);
      const flag = rows[0];
      if (!flag) throw new NotFoundError('flag');
      if (flag.resolvedAt) {
        throw new ConflictError('ALREADY_RESOLVED', 'That flag is already cleared.');
      }

      await tx
        .update(vehicleFlag)
        .set({ resolvedAt: new Date(), resolvedBy: actorUserId })
        .where(eq(vehicleFlag.id, flagId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.VEHICLE_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'vehicle', entityId: vehicleId,
        metadata: { flagResolved: flag.type },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Sensitive-read auditing ────────────────────────────────────────────────

/**
 * Records a plate lookup.
 *
 * Same reasoning as the person register: querying who owns a car is the read
 * most open to misuse, and the audit trail is what makes it answerable
 * afterwards. Written on the pool — a failure to record must not deny an
 * operator a lookup they are entitled to.
 */
export async function auditVehicleRead(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  vehicleId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await writeAudit(db, {
    action: AUDIT_ACTIONS.VEHICLE_VIEWED,
    actorUserId,
    organizationId: actor.organizationId,
    entityType: 'vehicle',
    entityId: vehicleId,
    ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
  }).catch(() => {});
}

/** Whether the actor may write to this record, for the DTO's capability flags. */
export function canWriteVehicle(
  actor: ActorContext,
  target: { ownerOrganizationId: string | null },
  permission: PermissionKey,
): boolean {
  if (!can(actor, permission)) return false;
  if (target.ownerOrganizationId === null) return true;
  return actor.isGlobalAdmin || actor.organizationId === target.ownerOrganizationId;
}
