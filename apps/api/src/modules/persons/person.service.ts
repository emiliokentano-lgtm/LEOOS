import { and, eq, sql } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, medicalRecord, person, personAlias, personFlag, warrant,
  type Database,
} from '@leoos/db';
import { requirePermission, type ActorContext, type Decision } from '@leoos/authz-core';
import type { PermissionKey } from '@leoos/contracts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';

/**
 * Person record mutations.
 *
 * UNLIKE PERSONNEL AND ROLES, THIS IS NOT A HIERARCHY PROBLEM. A citizen record
 * has no rank, so there is nothing for the H1–H5 rules to compare. Authorization
 * here is purely a question of which permission the actor holds, and the
 * permission catalogue is what lets one organization see and change more than
 * another without a line of organization-specific code (engineering rules 5–8).
 *
 * Two things ARE scoped, and they are scoped because the DATA is
 * organization-owned rather than because the actor is:
 *
 *   - a warrant belongs to the organization that issued it, so revoking one
 *     issued by another organization is refused;
 *   - a fleet vehicle belongs to an organization (see the vehicles module).
 *
 * Every mutation is audited. Sensitive READS are audited too — see
 * `auditMedicalRead` and the route that calls it: in an operational system the
 * question "who looked this person up" is asked as often as "who changed it".
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

/** The organization the actor is acting on behalf of, for organization-owned data. */
function actingOrganization(actor: ActorContext, what: string): string {
  if (actor.organizationId === null) {
    throw new ForbiddenError(`${what}: NO_ACTIVE_MEMBERSHIP`, { reason: 'NO_ACTIVE_MEMBERSHIP' });
  }
  return actor.organizationId;
}

// ── Create / update ────────────────────────────────────────────────────────

export interface PersonInput {
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  phoneNumber?: string | null;
  address?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  eyeColor?: string | null;
  hairColor?: string | null;
  notes?: string | null;
  status?: 'alive' | 'deceased' | 'missing' | 'incarcerated';
}

export async function createPerson(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  input: PersonInput,
  meta: RequestMeta = {},
): Promise<{ personId: string }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_CREATED,
      actorUserId,
      organizationId: actor.organizationId,
      entityType: 'person',
      entityId: null,
      metadata: { lastName: input.lastName },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.create', 'create person');

      const status = input.status ?? 'alive';
      const rows = await tx
        .insert(person)
        .values({
          firstName: input.firstName,
          lastName: input.lastName,
          dateOfBirth: input.dateOfBirth ?? null,
          gender: input.gender ?? null,
          phoneNumber: input.phoneNumber ?? null,
          address: input.address ?? null,
          heightCm: input.heightCm ?? null,
          weightKg: input.weightKg ?? null,
          eyeColor: input.eyeColor ?? null,
          hairColor: input.hairColor ?? null,
          notes: input.notes ?? null,
          status,
          // The database enforces the same equivalence with a CHECK; keeping
          // them in step here means a valid request never trips it.
          isDeceased: status === 'deceased',
          createdBy: actorUserId,
          updatedBy: actorUserId,
        })
        .returning({ id: person.id });

      const personId = rows[0]!.id;

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_CREATED,
        actorUserId,
        organizationId: actor.organizationId,
        entityType: 'person',
        entityId: personId,
        after: {
          firstName: input.firstName, lastName: input.lastName,
          dateOfBirth: input.dateOfBirth ?? null, status,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { personId };
    }),
  );
}

export async function updatePerson(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  input: Partial<PersonInput>,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.edit', 'edit person');

      const before = await loadPerson(tx, personId);
      if (!before || before.deletedAt) throw new NotFoundError('person');

      const status = input.status ?? before.status;

      await tx
        .update(person)
        .set({
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.heightCm !== undefined ? { heightCm: input.heightCm } : {}),
          ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
          ...(input.eyeColor !== undefined ? { eyeColor: input.eyeColor } : {}),
          ...(input.hairColor !== undefined ? { hairColor: input.hairColor } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.status !== undefined
            ? { status: input.status, isDeceased: input.status === 'deceased' }
            : {}),
          updatedBy: actorUserId,
        })
        .where(eq(person.id, personId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        before: {
          firstName: before.firstName, lastName: before.lastName,
          phoneNumber: before.phoneNumber, address: before.address, status: before.status,
        },
        after: {
          firstName: input.firstName ?? before.firstName,
          lastName: input.lastName ?? before.lastName,
          phoneNumber: input.phoneNumber !== undefined ? input.phoneNumber : before.phoneNumber,
          address: input.address !== undefined ? input.address : before.address,
          status,
        },
        metadata: { personName: `${before.firstName} ${before.lastName}` },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

interface LoadedPerson {
  id: string;
  firstName: string;
  lastName: string;
  phoneNumber: string | null;
  address: string | null;
  status: 'alive' | 'deceased' | 'missing' | 'incarcerated';
  deletedAt: Date | null;
}

async function loadPerson(tx: Database, personId: string): Promise<LoadedPerson | null> {
  const rows = await tx
    .select({
      id: person.id, firstName: person.firstName, lastName: person.lastName,
      phoneNumber: person.phoneNumber, address: person.address,
      status: person.status, deletedAt: person.deletedAt,
    })
    .from(person)
    .where(eq(person.id, personId))
    .limit(1);
  return rows[0] ?? null;
}

// ── Archive / restore ──────────────────────────────────────────────────────

/**
 * Archives a person. SOFT DELETE — nothing is destroyed.
 *
 * A citizen record is referenced by charges, warrants and vehicles, several of
 * them with `ON DELETE RESTRICT`, precisely so operational history cannot be
 * erased by removing the person it hangs from (engineering rules 24, 25).
 */
export async function archivePerson(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_ARCHIVED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId, metadata: { reason },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.delete', 'archive person');

      const target = await loadPerson(tx, personId);
      if (!target) throw new NotFoundError('person');
      if (target.deletedAt) {
        throw new ConflictError('ALREADY_ARCHIVED', 'That record is already archived.');
      }

      const openWarrants = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(warrant)
        .where(and(eq(warrant.personId, personId), eq(warrant.status, 'active')));
      if (Number(openWarrants[0]?.n ?? 0) > 0) {
        // Archiving someone out from under a live warrant would take them off
        // every wanted list without anyone revoking it.
        throw new ConflictError(
          'ACTIVE_WARRANTS',
          'That person has active warrants. Resolve them before archiving the record.',
        );
      }

      await tx
        .update(person)
        .set({ deletedAt: new Date(), deletedBy: actorUserId, deletionReason: reason })
        .where(eq(person.id, personId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_ARCHIVED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        before: { firstName: target.firstName, lastName: target.lastName },
        after: { archived: true },
        metadata: { reason, personName: `${target.firstName} ${target.lastName}` },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function restorePerson(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId, metadata: { restore: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.restore', 'restore person');

      const target = await loadPerson(tx, personId);
      if (!target) throw new NotFoundError('person');
      if (!target.deletedAt) {
        throw new ConflictError('NOT_ARCHIVED', 'That record is not archived.');
      }

      await tx
        .update(person)
        .set({ deletedAt: null, deletedBy: null, deletionReason: null, updatedBy: actorUserId })
        .where(eq(person.id, personId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        after: { archived: false },
        metadata: { restored: true, personName: `${target.firstName} ${target.lastName}` },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Aliases ────────────────────────────────────────────────────────────────

export async function addAlias(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  alias: string,
  note: string | null,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId, metadata: { alias },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.edit', 'add alias');

      const target = await loadPerson(tx, personId);
      if (!target || target.deletedAt) throw new NotFoundError('person');

      const existing = await tx
        .select({ id: personAlias.id })
        .from(personAlias)
        .where(and(eq(personAlias.personId, personId), eq(personAlias.alias, alias)))
        .limit(1);
      if (existing[0]) {
        throw new ConflictError('ALIAS_EXISTS', `“${alias}” is already recorded.`);
      }

      await tx.insert(personAlias).values({
        personId, alias, note, createdBy: actorUserId,
      });

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        after: { aliasAdded: alias },
        metadata: { personName: `${target.firstName} ${target.lastName}`, alias },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function removeAlias(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  aliasId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.edit', 'remove alias');

      const rows = await tx
        .select({ alias: personAlias.alias })
        .from(personAlias)
        .where(and(eq(personAlias.id, aliasId), eq(personAlias.personId, personId)))
        .limit(1);
      if (!rows[0]) throw new NotFoundError('alias');

      await tx.delete(personAlias).where(eq(personAlias.id, aliasId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        before: { alias: rows[0].alias },
        metadata: { aliasRemoved: rows[0].alias },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Flags ──────────────────────────────────────────────────────────────────

export async function addFlag(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  input: { type: string; severity: 'info' | 'caution' | 'critical'; note?: string | null },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId,
      metadata: { flag: input.type, severity: input.severity },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.flags.manage', 'add flag');

      const target = await loadPerson(tx, personId);
      if (!target || target.deletedAt) throw new NotFoundError('person');

      await tx.insert(personFlag).values({
        personId, type: input.type, severity: input.severity,
        note: input.note ?? null, createdBy: actorUserId,
      });

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        after: { flag: input.type, severity: input.severity },
        metadata: {
          personName: `${target.firstName} ${target.lastName}`,
          flagAdded: input.type, severity: input.severity,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function resolveFlag(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  flagId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.flags.manage', 'resolve flag');

      const rows = await tx
        .select({ type: personFlag.type, resolvedAt: personFlag.resolvedAt })
        .from(personFlag)
        .where(and(eq(personFlag.id, flagId), eq(personFlag.personId, personId)))
        .limit(1);
      const flag = rows[0];
      if (!flag) throw new NotFoundError('flag');
      if (flag.resolvedAt) {
        throw new ConflictError('ALREADY_RESOLVED', 'That flag is already cleared.');
      }

      // Resolved, not deleted: the fact that a flag was once raised is part of
      // the record, and the person who cleared it is part of the account.
      await tx
        .update(personFlag)
        .set({ resolvedAt: new Date(), resolvedBy: actorUserId })
        .where(eq(personFlag.id, flagId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        metadata: { flagResolved: flag.type },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Warrants ───────────────────────────────────────────────────────────────

/**
 * Issues a warrant IN THE ACTOR'S OWN ORGANIZATION.
 *
 * The organization is taken from the actor's membership, never from the request:
 * a body field would let a PD sergeant file a warrant under FIB's name
 * (engineering rule 11).
 */
export async function issueWarrant(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  input: { type: 'arrest' | 'search' | 'bench'; reason: string; expiresAt?: string | null },
  meta: RequestMeta = {},
): Promise<{ warrantId: string }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.WARRANT_ISSUED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId, metadata: { type: input.type },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.warrants.manage', 'issue warrant');
      const organizationId = actingOrganization(actor, 'issue warrant');

      const target = await loadPerson(tx, personId);
      if (!target || target.deletedAt) throw new NotFoundError('person');

      const rows = await tx
        .insert(warrant)
        .values({
          personId, organizationId, type: input.type, reason: input.reason,
          issuedBy: actorUserId,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning({ id: warrant.id });

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.WARRANT_ISSUED,
        actorUserId, organizationId,
        entityType: 'person', entityId: personId,
        after: { type: input.type, reason: input.reason },
        metadata: { personName: `${target.firstName} ${target.lastName}`, warrantType: input.type },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { warrantId: rows[0]!.id };
    }),
  );
}

export async function resolveWarrant(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  warrantId: string,
  outcome: 'served' | 'revoked',
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: outcome === 'served' ? AUDIT_ACTIONS.WARRANT_SERVED : AUDIT_ACTIONS.WARRANT_REVOKED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.warrants.manage', 'resolve warrant');

      const rows = await tx
        .select({
          id: warrant.id, status: warrant.status, type: warrant.type,
          organizationId: warrant.organizationId,
        })
        .from(warrant)
        .where(and(eq(warrant.id, warrantId), eq(warrant.personId, personId)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundError('warrant');
      if (row.status !== 'active') {
        throw new ConflictError('NOT_ACTIVE', 'That warrant is no longer active.');
      }

      /**
       * REVOKING is scoped to the issuing organization; SERVING is not.
       *
       * A warrant is another organization's decision, and quietly cancelling it
       * is exactly the cross-organization interference the scope rules exist to
       * prevent. Serving one is the opposite: any organization that arrests the
       * subject should be able to close it out, which is how a shared wanted
       * list is meant to work.
       */
      if (outcome === 'revoked' && !actor.isGlobalAdmin
          && row.organizationId !== actor.organizationId) {
        throw new ForbiddenError('revoke warrant: CROSS_ORGANIZATION', {
          reason: 'CROSS_ORGANIZATION',
        }, 'Only the organization that issued a warrant can revoke it.');
      }

      await tx
        .update(warrant)
        .set({
          status: outcome,
          updatedAt: new Date(),
          ...(outcome === 'served' ? { servedBy: actorUserId, servedAt: new Date() } : {}),
        })
        .where(eq(warrant.id, warrantId));

      await writeAudit(tx, {
        action: outcome === 'served'
          ? AUDIT_ACTIONS.WARRANT_SERVED
          : AUDIT_ACTIONS.WARRANT_REVOKED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        before: { status: 'active' }, after: { status: outcome },
        metadata: { warrantType: row.type, issuingOrganizationId: row.organizationId },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Medical ────────────────────────────────────────────────────────────────

export interface MedicalInput {
  bloodType?: string | null;
  allergies?: string[];
  conditions?: string[];
  medications?: string[];
  emergencyContact?: string | null;
  notes?: string | null;
}

export async function updateMedical(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  input: MedicalInput,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERSON_UPDATED,
      actorUserId, organizationId: actor.organizationId,
      entityType: 'person', entityId: personId, metadata: { medical: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      require(actor, 'persons.medical.edit', 'edit medical record');

      const target = await loadPerson(tx, personId);
      if (!target || target.deletedAt) throw new NotFoundError('person');

      await tx
        .insert(medicalRecord)
        .values({
          personId,
          bloodType: input.bloodType ?? null,
          allergies: input.allergies ?? [],
          conditions: input.conditions ?? [],
          medications: input.medications ?? [],
          emergencyContact: input.emergencyContact ?? null,
          notes: input.notes ?? null,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: medicalRecord.personId,
          set: {
            ...(input.bloodType !== undefined ? { bloodType: input.bloodType } : {}),
            ...(input.allergies !== undefined ? { allergies: input.allergies } : {}),
            ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
            ...(input.medications !== undefined ? { medications: input.medications } : {}),
            ...(input.emergencyContact !== undefined
              ? { emergencyContact: input.emergencyContact } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            updatedBy: actorUserId,
            updatedAt: new Date(),
          },
        });

      // The CONTENT is deliberately not written to the audit row. Recording who
      // changed a medical record is oversight; copying the diagnosis into a
      // table read by a different permission would defeat the point of gating
      // the record at all.
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERSON_UPDATED,
        actorUserId, organizationId: actor.organizationId,
        entityType: 'person', entityId: personId,
        metadata: {
          medicalRecordUpdated: true,
          personName: `${target.firstName} ${target.lastName}`,
          fields: Object.keys(input).sort(),
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Sensitive-read auditing ────────────────────────────────────────────────

/**
 * Records that someone opened a record, and what they were shown.
 *
 * In an operational system "who looked this person up" is asked as often as "who
 * changed them" — misuse of a police database is overwhelmingly a READ problem,
 * and the audit trail is the only thing that makes it visible afterwards
 * (engineering rule 23).
 *
 * Written on the pool rather than in a transaction: a lookup is not a mutation,
 * and a failure to record one must not deny the operator the record they are
 * entitled to. The failure is logged by the audit helper.
 */
export async function auditPersonRead(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  personId: string,
  sections: { medical: boolean; criminal: boolean },
  meta: RequestMeta = {},
): Promise<void> {
  await writeAudit(db, {
    action: sections.medical ? AUDIT_ACTIONS.PERSON_MEDICAL_VIEWED : AUDIT_ACTIONS.PERSON_VIEWED,
    actorUserId,
    organizationId: actor.organizationId,
    entityType: 'person',
    entityId: personId,
    metadata: {
      sections: [
        'profile',
        ...(sections.criminal ? ['criminal'] : []),
        ...(sections.medical ? ['medical'] : []),
      ],
    },
    ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
  }).catch(() => {});
}
