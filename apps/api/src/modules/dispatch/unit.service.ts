import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, memberStatus, memberStatusHistory, unit, unitMember, type Database,
} from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from './dispatch.scope.js';

/**
 * Units and operational status.
 *
 * THE GOVERNING DISTINCTION IN THIS FILE is between acting on YOURSELF and
 * acting on SOMEONE ELSE.
 *
 * Self-actions — going available, crewing a car, leaving it — need only an
 * active membership in the organization. An officer with no dispatch authority
 * still has to be able to do all three, and requiring `units.manage` to get in a
 * car would make the system unusable for the people who use it most.
 *
 * Actions on other people — creating a unit, disbanding one, pulling someone out
 * of a car — need `units.manage`. That is where the permission bites, and it is
 * checked server-side on every path (engineering rules 9, 10).
 *
 * Both are checked inside the mutating transaction against rows held with
 * `FOR UPDATE`, because two people joining the last seat of the same unit, or a
 * dispatcher disbanding a unit as someone joins it, are races that happen on a
 * real shift rather than only in a test.
 */

/** The actor's own membership, locked. Null when they are not in the organization. */
async function lockOwnMembership(tx: Database, scope: DispatchScope) {
  if (scope.organizationId === null) return null;

  const rows = await tx.execute<{
    id: string; organization_id: string; status: string; callsign: string | null;
  }>(sql`
    SELECT id, organization_id, status, callsign
      FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
     FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockUnit(tx: Database, unitId: string) {
  const rows = await tx.execute<{
    id: string; organization_id: string; callsign: string; status: string;
  }>(sql`
    SELECT id, organization_id, callsign, status FROM unit
     WHERE id = ${unitId}
     FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * The five checks the brief asks for, in one place.
 *
 * Written as one function rather than repeated at each call site so that a new
 * path cannot accidentally implement four of them.
 */
function assertCanOperateIn(
  scope: DispatchScope,
  membership: { organization_id: string; status: string } | null,
  target: { organization_id: string; status: string } | null,
): asserts membership is { organization_id: string; status: string } {
  // 1. the user belongs to the organization
  if (membership === null) {
    throw new ForbiddenError('You are not a member of this organization.');
  }
  // 2. the user is allowed to operate — a terminated or suspended membership
  //    keeps its history but stops being able to act
  if (membership.status !== 'active') {
    throw new ForbiddenError('An inactive membership cannot go on duty.');
  }
  // 3. the unit exists
  if (target === null) throw new NotFoundError('unit');
  // 4. the unit is live
  if (target.status !== 'active') {
    throw new ConflictError('UNIT_DISBANDED', 'That unit has been disbanded.');
  }
  // 5. the unit belongs to the same organization the user is acting in
  if (target.organization_id !== membership.organization_id) {
    throw new ForbiddenError('That unit belongs to another organization.');
  }
  void scope;
}

// ── Create and disband ─────────────────────────────────────────────────────

export interface CreateUnitInput {
  callsign: string;
  name: string | null;
  unitType: string;
  vehicleId: string | null;
  isCovert: boolean;
  /** Crew the creator into the new unit immediately. */
  joinSelf: boolean;
}

export async function createUnit(
  db: Database,
  scope: DispatchScope,
  input: CreateUnitInput,
  meta: RequestMeta,
): Promise<{ id: string }> {
  if (!scope.canManageUnits) throw new ForbiddenError('You cannot create units.');
  if (scope.organizationId === null) {
    throw new ForbiddenError('Select an organization before creating a unit.');
  }

  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null || membership.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot create units.');
    }

    /**
     * Callsign collisions surface as a friendly conflict, not a 500.
     *
     * `unit_active_callsign_key` is a PARTIAL unique index over active units, so
     * a disbanded callsign is reusable — which is what an operational service
     * wants. Reaching the index raw produced an unhandled constraint error in
     * the personnel module; checked here for the same reason.
     */
    const clash = await tx.execute<{ id: string }>(sql`
      SELECT id FROM unit
       WHERE organization_id = ${scope.organizationId}
         AND callsign = ${input.callsign} AND status = 'active'
    `);
    if (clash.length > 0) {
      throw new ConflictError('CALLSIGN_TAKEN', `Callsign ${input.callsign} is already in use.`);
    }

    const [created] = await tx.insert(unit).values({
      organizationId: scope.organizationId!,
      callsign: input.callsign,
      name: input.name,
      unitType: input.unitType,
      statusKey: 'available',
      vehicleId: input.vehicleId,
      isCovert: input.isCovert,
      createdBy: scope.actorUserId,
    }).returning({ id: unit.id });

    if (!created) throw new ValidationError('The unit could not be created.');

    if (input.joinSelf) {
      await joinUnitWithin(tx, scope, membership.id, created.id, true);
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.UNIT_CREATED,
      actorUserId: scope.actorUserId,
      organizationId: scope.organizationId,
      entityType: 'unit', entityId: created.id,
      after: { callsign: input.callsign, unitType: input.unitType, isCovert: input.isCovert },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return created;
  });
}

export async function disbandUnit(
  db: Database,
  scope: DispatchScope,
  unitId: string,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const target = await lockUnit(tx, unitId);
    if (!target) throw new NotFoundError('unit');

    // Scope before permission, as everywhere.
    if (!scope.canViewAllOrganizations
      && !scope.organizationIds.includes(target.organization_id)) {
      throw new NotFoundError('unit');
    }
    if (!scope.canManageUnits) throw new ForbiddenError('You cannot disband units.');
    if (target.status !== 'active') {
      throw new ConflictError('UNIT_DISBANDED', 'That unit is already disbanded.');
    }

    const live = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident_assignment
       WHERE unit_id = ${unitId} AND released_at IS NULL
    `);
    if ((live[0]?.n ?? 0) > 0) {
      // Disbanding a committed unit would leave a call with a phantom responder.
      throw new ConflictError(
        'UNIT_ON_CALL', 'Release the unit from its incidents before disbanding it.',
      );
    }

    const now = new Date();
    await tx.update(unit)
      .set({ status: 'disbanded', disbandedAt: now, currentIncidentId: null })
      .where(eq(unit.id, unitId));

    // The crew leave with it. Their memberships and history are untouched
    // (engineering rule 24); only the crewing ends.
    await tx.update(unitMember)
      .set({ leftAt: now })
      .where(and(eq(unitMember.unitId, unitId), isNull(unitMember.leftAt)));

    await tx.update(memberStatus)
      .set({ unitId: null, updatedAt: now })
      .where(eq(memberStatus.unitId, unitId));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.UNIT_DISBANDED,
      actorUserId: scope.actorUserId,
      organizationId: target.organization_id,
      entityType: 'unit', entityId: unitId,
      before: { callsign: target.callsign },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

// ── Self-assignment ────────────────────────────────────────────────────────

/**
 * Crews a member into a unit. Assumes the caller has already locked and checked.
 *
 * Split out so `createUnit` can crew its creator inside the same transaction
 * without re-opening one.
 */
async function joinUnitWithin(
  tx: Database,
  scope: DispatchScope,
  memberId: string,
  unitId: string,
  asLeader: boolean,
): Promise<void> {
  /**
   * A member is in at most one active unit — enforced by a partial unique index.
   * Leaving the previous unit first turns "you are already in a car" from a
   * constraint violation into the obvious behaviour: joining a new one moves
   * you.
   */
  await tx.update(unitMember)
    .set({ leftAt: new Date() })
    .where(and(eq(unitMember.memberId, memberId), isNull(unitMember.leftAt)));

  // At most one leader per unit, also enforced by index. Claim leadership only
  // if the seat is genuinely free.
  let leader = asLeader;
  if (leader) {
    const existingLeader = await tx.execute<{ id: string }>(sql`
      SELECT id FROM unit_member
       WHERE unit_id = ${unitId} AND is_leader AND left_at IS NULL
    `);
    if (existingLeader.length > 0) leader = false;
  }

  await tx.insert(unitMember).values({ unitId, memberId, isLeader: leader });

  await tx.insert(memberStatus)
    .values({ memberId, statusKey: 'available', unitId })
    .onConflictDoUpdate({
      target: memberStatus.memberId,
      set: { unitId, updatedAt: new Date() },
    });

  void scope;
}

export async function joinUnit(
  db: Database,
  scope: DispatchScope,
  unitId: string,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    const target = await lockUnit(tx, unitId);

    // All five checks the brief lists, in one call.
    assertCanOperateIn(scope, membership, target);

    const already = await tx.execute<{ unit_id: string }>(sql`
      SELECT unit_id FROM unit_member
       WHERE member_id = ${membership.id} AND left_at IS NULL
    `);
    if (already[0]?.unit_id === unitId) {
      throw new ConflictError('ALREADY_CREWED', 'You are already in that unit.');
    }

    // First in the car takes the lead; joining an existing crew does not.
    const crew = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM unit_member
       WHERE unit_id = ${unitId} AND left_at IS NULL
    `);
    await joinUnitWithin(tx, scope, membership.id, unitId, (crew[0]?.n ?? 0) === 0);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.UNIT_JOINED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'unit', entityId: unitId,
      metadata: { memberId: membership.id, callsign: target!.callsign, self: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

export async function leaveUnit(
  db: Database,
  scope: DispatchScope,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) throw new ForbiddenError('You are not a member of this organization.');

    const current = await tx.execute<{ id: string; unit_id: string }>(sql`
      SELECT id, unit_id FROM unit_member
       WHERE member_id = ${membership.id} AND left_at IS NULL
       FOR UPDATE
    `);
    const crewing = current[0];
    if (!crewing) throw new ConflictError('NOT_CREWED', 'You are not currently in a unit.');

    const now = new Date();
    await tx.update(unitMember).set({ leftAt: now }).where(eq(unitMember.id, crewing.id));
    await tx.update(memberStatus)
      .set({ unitId: null, updatedAt: now })
      .where(eq(memberStatus.memberId, membership.id));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.UNIT_LEFT,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'unit', entityId: crewing.unit_id,
      metadata: { memberId: membership.id, self: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

// ── Operational status ─────────────────────────────────────────────────────

/**
 * Sets the caller's OWN duty status.
 *
 * Self only. There is no path here to set someone else's status, deliberately:
 * a status is a statement about what a person is doing, and letting a dispatcher
 * declare an officer "available" on their behalf produces a board that reads
 * confidently and is wrong. Dispatchers move units and calls; people move
 * themselves.
 *
 * Panic routes through `panic.service.ts` instead — it is an event with a
 * lifecycle, not merely a status value.
 */
export async function setOwnStatus(
  db: Database,
  scope: DispatchScope,
  statusKey: string,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) throw new ForbiddenError('You are not a member of this organization.');
    if (membership.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot go on duty.');
    }

    /**
     * The status must be in the catalogue, and in a catalogue this caller can
     * see: global statuses plus their own organization's additions. Validating
     * against the table rather than a hardcoded list is what makes
     * "additional statuses later" real (engineering rules 5-7).
     */
    const allowed = await tx.execute<{ key: string; is_panic: boolean }>(sql`
      SELECT key, (key = 'panic') AS is_panic FROM operational_status
       WHERE key = ${statusKey} AND is_active
         AND (organization_id IS NULL OR organization_id = ${membership.organization_id})
    `);
    const status = allowed[0];
    if (!status) throw new ValidationError('That status is not available to you.');

    if (status.is_panic) {
      // Panic has to create the event record, notify, and be acknowledgeable.
      // Setting it as a plain status would be the "merely visual state" the
      // brief explicitly rules out.
      throw new ValidationError('Use the panic action to raise an alert.');
    }

    const before = await tx.execute<{ status_key: string; unit_id: string | null }>(sql`
      SELECT status_key, unit_id FROM member_status WHERE member_id = ${membership.id}
    `);
    const previous = before[0]?.status_key ?? null;
    if (previous === statusKey) return;

    await tx.insert(memberStatus)
      .values({ memberId: membership.id, statusKey, unitId: before[0]?.unit_id ?? null })
      .onConflictDoUpdate({
        target: memberStatus.memberId,
        set: { statusKey, since: new Date(), updatedAt: new Date() },
      });

    // Append-only history: shift reconstruction depends on it, and it is
    // protected by trigger rather than by convention.
    await tx.insert(memberStatusHistory).values({
      memberId: membership.id,
      fromStatusKey: previous,
      toStatusKey: statusKey,
      unitId: before[0]?.unit_id ?? null,
      changedBy: scope.actorUserId,
    });

    /**
     * A unit's status follows its crew.
     *
     * The board shows unit status, and a car whose whole crew has gone busy is
     * busy. Only the crewed unit is touched, and only when the actor is in one.
     */
    if (before[0]?.unit_id) {
      await tx.update(unit)
        .set({ statusKey })
        .where(eq(unit.id, before[0].unit_id));
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.STATUS_CHANGED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'organization_member', entityId: membership.id,
      before: { statusKey: previous },
      after: { statusKey },
      metadata: { self: true, unitId: before[0]?.unit_id ?? null },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

/**
 * Sets a UNIT's status directly.
 *
 * Separate from a member's own status and gated on `units.manage`: this is a
 * dispatcher marking a car out of service, which is a statement about the
 * vehicle rather than about the people in it.
 */
export async function setUnitStatus(
  db: Database,
  scope: DispatchScope,
  unitId: string,
  statusKey: string,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const target = await lockUnit(tx, unitId);
    if (!target) throw new NotFoundError('unit');
    if (!scope.canViewAllOrganizations
      && !scope.organizationIds.includes(target.organization_id)) {
      throw new NotFoundError('unit');
    }
    if (!scope.canManageUnits) throw new ForbiddenError('You cannot change unit status.');
    if (target.status !== 'active') {
      throw new ConflictError('UNIT_DISBANDED', 'That unit has been disbanded.');
    }

    const allowed = await tx.execute<{ key: string }>(sql`
      SELECT key FROM operational_status
       WHERE key = ${statusKey} AND is_active
         AND (organization_id IS NULL OR organization_id = ${target.organization_id})
    `);
    if (allowed.length === 0) throw new ValidationError('That status is not available.');

    await tx.update(unit).set({ statusKey }).where(eq(unit.id, unitId));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.STATUS_CHANGED,
      actorUserId: scope.actorUserId,
      organizationId: target.organization_id,
      entityType: 'unit', entityId: unitId,
      after: { statusKey },
      metadata: { callsign: target.callsign, self: false },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}
