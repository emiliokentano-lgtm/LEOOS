import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  AUDIT_ACTIONS, memberPermissionOverride, memberRole, memberStatus, memberStatusHistory,
  organization, organizationMember, role, rolePermission, unitMember, userAccount,
  type Database,
} from '@leoos/db';
import {
  canAssignRole, canClearPermissionOverride, canManageMember, canSetPermissionOverride,
  effectiveLevel, requirePermission,
  type ActorContext, type Decision, type TargetContext,
} from '@leoos/authz-core';
import { PERMISSION_KEYS, type PermissionKey } from '@leoos/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import { bumpPermissionVersion, loadActorContextLocked } from '../auth/context.service.js';
import { revokeAllSessions } from '../auth/session.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { lockMemberships, lockMembershipsByUser } from './locking.js';

/**
 * Personnel management.
 *
 * This is the module the hierarchy rules exist for. Every mutation here:
 *
 *   1. opens a transaction
 *   2. LOCKS the actor's and the target's membership rows, in id order
 *   3. re-reads both contexts from the locked rows
 *   4. asks the kernel (packages/authz-core) for a decision
 *   5. mutates and audits in the same transaction
 *
 * Steps 2 and 3 are what make step 4 meaningful. A permission check performed
 * before the transaction is a statement about the past.
 *
 * Refusals are audited too — outside the rolled-back transaction, so the record
 * survives. A member repeatedly attempting to promote above their rank is
 * exactly the signal an operations lead needs.
 */

function enforce(decision: Decision, what: string): void {
  if (!decision.allowed) {
    throw new ForbiddenError(`${what}: ${decision.reason}`, {
      reason: decision.reason,
      ...(decision.detail ? { detail: decision.detail } : {}),
    });
  }
}

// ── Target resolution ──────────────────────────────────────────────────────

interface LoadedTarget {
  memberId: string;
  userId: string;
  organizationId: string;
  displayName: string;
  username: string;
  status: 'active' | 'on_leave' | 'suspended' | 'terminated';
  callsign: string | null;
  employeeNumber: string | null;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
  level: number;
  isOrgLead: boolean;
  isGlobalAdmin: boolean;
}

/** Reads a target's full context from rows the caller has already locked. */
async function loadTarget(tx: Database, memberId: string): Promise<LoadedTarget | null> {
  const rows = await tx
    .select({
      memberId: organizationMember.id,
      userId: organizationMember.userId,
      organizationId: organizationMember.organizationId,
      status: organizationMember.status,
      callsign: organizationMember.callsign,
      employeeNumber: organizationMember.employeeNumber,
      displayName: userAccount.displayName,
      username: userAccount.username,
      isOrgLead: sql<boolean>`EXISTS (
        SELECT 1 FROM organization_lead ol
        WHERE ol.user_id = ${organizationMember.userId}
          AND ol.organization_id = ${organizationMember.organizationId}
          AND ol.revoked_at IS NULL)`,
      isGlobalAdmin: sql<boolean>`EXISTS (
        SELECT 1 FROM user_global_role ugr
        WHERE ugr.user_id = ${organizationMember.userId} AND ugr.capability = 'global_admin')`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .where(eq(organizationMember.id, memberId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const roles = await tx
    .select({
      id: role.id, key: role.key, name: role.name, hierarchyLevel: role.hierarchyLevel,
    })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .where(and(eq(memberRole.memberId, memberId), isNull(role.deletedAt)));

  // A terminated or suspended member holds nothing and outranks nobody.
  const active = row.status === 'active';

  return {
    ...row,
    roles,
    level: active ? effectiveLevel(roles.map((r) => r.hierarchyLevel)) : 0,
  };
}

function toTargetContext(target: LoadedTarget): TargetContext {
  return {
    userId: target.userId,
    organizationId: target.organizationId,
    level: target.level,
    isOrgLead: target.isOrgLead,
    isGlobalAdmin: target.isGlobalAdmin,
  };
}

/** Permissions a role would confer, for the H4 subset check. */
async function permissionsOfRole(tx: Database, roleId: string): Promise<PermissionKey[]> {
  const rows = await tx
    .select({ key: rolePermission.permissionKey })
    .from(rolePermission)
    .where(eq(rolePermission.roleId, roleId));
  return rows.map((r) => r.key as PermissionKey);
}

/**
 * H4 applied to a ROLE rather than a bare permission list.
 *
 * Assigning a role hands over every permission it carries. Without this, an
 * actor who may not grant `personnel.fire` directly could grant it by assigning
 * a role that happens to include it — the subset rule has to follow the
 * permissions, not the shape of the request.
 */
async function enforceRolePermissionSubset(
  tx: Database,
  actor: ActorContext,
  roleId: string,
): Promise<void> {
  if (actor.isGlobalAdmin || actor.isOrgLead) return;

  const granted = await permissionsOfRole(tx, roleId);
  const missing = granted.filter((key) => !actor.permissions.has(key));
  if (missing.length > 0) {
    throw new ForbiddenError(
      `role confers permissions the actor does not hold: ${missing.join(', ')}`,
      { reason: 'PERMISSION_NOT_HELD_BY_ACTOR', detail: missing.join(', ') },
    );
  }
}

/**
 * Callsign and employee-number uniqueness.
 *
 * Both are enforced by partial unique indexes scoped to ACTIVE members, so a
 * retired callsign is reusable (docs/architecture/01-data-model.md §8). Checking
 * here as well is not redundant: without it the index raises a raw unique
 * violation, which surfaces as a 500 and tells the user nothing. The index stays
 * as the real guarantee — this only decides which error the operator sees.
 */
async function enforceIdentifiersFree(
  tx: Database,
  organizationId: string,
  memberId: string | null,
  input: { callsign?: string | null; employeeNumber?: string | null },
): Promise<void> {
  const checks: {
    column: AnyPgColumn; value: string; code: string; label: string;
  }[] = [];
  if (input.callsign) {
    checks.push({
      column: organizationMember.callsign, value: input.callsign,
      code: 'CALLSIGN_TAKEN', label: `Callsign ${input.callsign}`,
    });
  }
  if (input.employeeNumber) {
    checks.push({
      column: organizationMember.employeeNumber, value: input.employeeNumber,
      code: 'EMPLOYEE_NUMBER_TAKEN', label: `Employee number ${input.employeeNumber}`,
    });
  }

  for (const check of checks) {
    const clash = await tx
      .select({ id: organizationMember.id })
      .from(organizationMember)
      .where(and(
        eq(organizationMember.organizationId, organizationId),
        eq(check.column, check.value),
        eq(organizationMember.status, 'active'),
      ))
      .limit(1);
    if (clash[0] && clash[0].id !== memberId) {
      throw new ConflictError(check.code, `${check.label} is already in use.`);
    }
  }
}

// ── Hire ───────────────────────────────────────────────────────────────────

export interface HireInput {
  organizationId: string;
  userId: string;
  roleId: string;
  callsign?: string | null;
  employeeNumber?: string | null;
  notes?: string | null;
}

/**
 * Hires a user into an organization.
 *
 * The actor cannot hire someone into a rank at or above their own — that is H2
 * applied at the moment of hiring, and without it "promote" would be
 * unnecessary: anyone with `personnel.hire` could seat a subordinate above
 * themselves on day one.
 */
export async function hireMember(
  db: Database,
  actorUserId: string,
  input: HireInput,
  meta: RequestMeta = {},
): Promise<{ memberId: string }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.MEMBER_HIRED,
      actorUserId,
      organizationId: input.organizationId,
      entityType: 'user_account',
      entityId: input.userId,
      metadata: { roleId: input.roleId },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockMembershipsByUser(tx, input.organizationId, [actorUserId, input.userId]);

      const actor = await loadActorContextLocked(tx, actorUserId, input.organizationId);

      // H7 FIRST — the actor must belong to the organization they are hiring
      // into. Ordering matters for the audit trail, not just the answer: an
      // actor with no standing in this organization also holds none of its
      // permissions, so a permission check placed first would record every
      // cross-organization attempt as a mundane missing permission and bury the
      // thing an operations lead actually needs to see.
      if (!actor.isGlobalAdmin && actor.organizationId !== input.organizationId) {
        throw new ForbiddenError('hire: CROSS_ORGANIZATION', { reason: 'CROSS_ORGANIZATION' });
      }

      enforce(requirePermission(actor, 'personnel.hire'), 'hire');

      const orgRows = await tx
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(and(eq(organization.id, input.organizationId), isNull(organization.deletedAt)))
        .limit(1);
      if (!orgRows[0]) throw new NotFoundError('organization');

      const roleRows = await tx
        .select({
          id: role.id, name: role.name, hierarchyLevel: role.hierarchyLevel,
          organizationId: role.organizationId,
        })
        .from(role)
        .where(and(eq(role.id, input.roleId), isNull(role.deletedAt)))
        .limit(1);
      const targetRole = roleRows[0];
      if (!targetRole) throw new NotFoundError('role');

      // H2 — cannot seat someone at or above your own rank.
      enforce(canAssignRole(actor, targetRole), 'hire');
      // H4 — and cannot hand over permissions you do not hold.
      await enforceRolePermissionSubset(tx, actor, targetRole.id);

      const userRows = await tx
        .select({ id: userAccount.id, displayName: userAccount.displayName, status: userAccount.status })
        .from(userAccount)
        .where(eq(userAccount.id, input.userId))
        .limit(1);
      const user = userRows[0];
      if (!user) throw new NotFoundError('user');
      if (user.status !== 'active') {
        throw new ConflictError('USER_NOT_ACTIVE', 'That account is not active and cannot be hired.');
      }

      await enforceIdentifiersFree(tx, input.organizationId, null, input);

      const existing = await tx
        .select({ id: organizationMember.id, status: organizationMember.status })
        .from(organizationMember)
        .where(and(
          eq(organizationMember.userId, input.userId),
          eq(organizationMember.organizationId, input.organizationId),
        ))
        .limit(1);

      if (existing[0] && existing[0].status === 'active') {
        throw new ConflictError('ALREADY_MEMBER', 'That person is already an active member.');
      }

      // Re-hiring reuses the row, so employment history is one continuous record
      // rather than a fresh membership with no past (engineering rule 24).
      const memberId = existing[0]
        ? (await tx
            .update(organizationMember)
            .set({
              status: 'active', callsign: input.callsign ?? null,
              employeeNumber: input.employeeNumber ?? null, notes: input.notes ?? null,
              joinedAt: new Date(), hiredBy: actorUserId,
              leftAt: null, terminatedBy: null, terminationReason: null,
            })
            .where(eq(organizationMember.id, existing[0].id))
            .returning({ id: organizationMember.id }))[0]!.id
        : (await tx
            .insert(organizationMember)
            .values({
              userId: input.userId, organizationId: input.organizationId,
              status: 'active', callsign: input.callsign ?? null,
              employeeNumber: input.employeeNumber ?? null, notes: input.notes ?? null,
              hiredBy: actorUserId,
            })
            .returning({ id: organizationMember.id }))[0]!.id;

      // A re-hire must not silently keep roles from a previous term.
      await tx.delete(memberRole).where(eq(memberRole.memberId, memberId));
      await tx.insert(memberRole).values({
        memberId, roleId: targetRole.id, assignedBy: actorUserId,
      });

      await tx
        .insert(memberStatus)
        .values({ memberId, statusKey: 'off_duty' })
        .onConflictDoUpdate({
          target: memberStatus.memberId,
          set: { statusKey: 'off_duty', since: new Date() },
        });

      await bumpPermissionVersion(tx, input.userId);

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.MEMBER_HIRED,
        actorUserId,
        organizationId: input.organizationId,
        entityType: 'organization_member',
        entityId: memberId,
        after: {
          userId: input.userId, displayName: user.displayName,
          role: targetRole.name, hierarchyLevel: targetRole.hierarchyLevel,
          callsign: input.callsign ?? null,
        },
        metadata: {
          organizationName: orgRows[0].name,
          actorLevel: actor.level === Number.POSITIVE_INFINITY ? 'unbounded' : actor.level,
          rehire: Boolean(existing[0]),
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { memberId };
    }),
  );
}

// ── Terminate ──────────────────────────────────────────────────────────────

/**
 * Terminates a membership.
 *
 * NOTHING IS DELETED. The row moves to `terminated` and keeps its roles, its
 * callsign history, its join date and its audit trail (engineering rule 24). The
 * member's effective level drops to 0 and their permissions to none, so access
 * ends immediately even though the record remains.
 */
export async function terminateMember(
  db: Database,
  actorUserId: string,
  input: { memberId: string; reason: string },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.MEMBER_TERMINATED,
      actorUserId,
      entityType: 'organization_member',
      entityId: input.memberId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, input.memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [input.memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);

      const target = await loadTarget(tx, input.memberId);
      if (!target) throw new NotFoundError('member');

      // H1 + H6 + H7 first — strictly higher rank, not yourself, same
      // organization. See the note in `hireMember`: the scope and rank reasons
      // are the ones worth auditing, so they are decided before the permission.
      enforce(canManageMember(actor, toTargetContext(target)), 'terminate');
      enforce(requirePermission(actor, 'personnel.fire'), 'terminate');

      if (target.status === 'terminated') {
        throw new ConflictError('ALREADY_TERMINATED', 'That membership is already terminated.');
      }

      await tx
        .update(organizationMember)
        .set({
          status: 'terminated', leftAt: new Date(),
          terminatedBy: actorUserId, terminationReason: input.reason,
        })
        .where(eq(organizationMember.id, input.memberId));

      // Leaving an open patrol behind would keep them on the dispatch board.
      await tx
        .update(unitMember)
        .set({ leftAt: new Date() })
        .where(and(eq(unitMember.memberId, input.memberId), isNull(unitMember.leftAt)));

      await tx
        .update(memberStatus)
        .set({ statusKey: 'off_duty', unitId: null, since: new Date() })
        .where(eq(memberStatus.memberId, input.memberId));

      await tx.insert(memberStatusHistory).values({
        memberId: input.memberId, toStatusKey: 'off_duty', changedBy: actorUserId,
      });

      await bumpPermissionVersion(tx, target.userId);
      // Access ends now, not when their session happens to expire.
      await revokeAllSessions(tx, target.userId, 'privilege_change');

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.MEMBER_TERMINATED,
        actorUserId,
        organizationId: target.organizationId,
        entityType: 'organization_member',
        entityId: input.memberId,
        before: {
          status: target.status, roles: target.roles.map((r) => r.name),
          hierarchyLevel: target.level, callsign: target.callsign,
        },
        after: { status: 'terminated' },
        metadata: {
          reason: input.reason,
          targetName: target.displayName,
          targetUsername: target.username,
          actorLevel: actor.level === Number.POSITIVE_INFINITY ? 'unbounded' : actor.level,
          targetLevel: target.level,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Promote / demote ───────────────────────────────────────────────────────

export type RankChangeKind = 'promote' | 'demote';

/**
 * Changes a member's rank by replacing their role set with one role.
 *
 * The direction is derived from the levels, not taken from the caller: a request
 * labelled "promote" that lowers the level is a demotion and is audited as one.
 * Letting the client name the action would make the audit trail describe
 * intent rather than effect.
 */
export async function changeMemberRank(
  db: Database,
  actorUserId: string,
  input: { memberId: string; roleId: string; reason?: string },
  meta: RequestMeta = {},
): Promise<{ kind: RankChangeKind; fromLevel: number; toLevel: number }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.MEMBER_PROMOTED,
      actorUserId,
      entityType: 'organization_member',
      entityId: input.memberId,
      metadata: { roleId: input.roleId },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, input.memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [input.memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);
      const target = await loadTarget(tx, input.memberId);
      if (!target) throw new NotFoundError('member');
      if (target.status !== 'active') {
        throw new ConflictError('NOT_ACTIVE', 'That membership is not active.');
      }

      // H1 + H6 + H7 first: may the actor touch this person at all?
      enforce(canManageMember(actor, toTargetContext(target)), 'change rank');

      const roleRows = await tx
        .select({
          id: role.id, name: role.name, hierarchyLevel: role.hierarchyLevel,
          organizationId: role.organizationId,
        })
        .from(role)
        .where(and(eq(role.id, input.roleId), isNull(role.deletedAt)))
        .limit(1);
      const nextRole = roleRows[0];
      if (!nextRole) throw new NotFoundError('role');

      // A role from another organization is not a valid transition, whatever the
      // levels say. The database refuses it too (member_role trigger).
      if (nextRole.organizationId !== target.organizationId) {
        throw new ForbiddenError('role belongs to another organization', {
          reason: 'CROSS_ORGANIZATION',
        });
      }

      const kind: RankChangeKind =
        nextRole.hierarchyLevel >= target.level ? 'promote' : 'demote';

      enforce(
        requirePermission(actor, kind === 'promote' ? 'personnel.promote' : 'personnel.demote'),
        kind,
      );

      // H2 — cannot place anyone at or above your own rank.
      enforce(canAssignRole(actor, nextRole), kind);
      // H4 — cannot hand over permissions you do not hold.
      await enforceRolePermissionSubset(tx, actor, nextRole.id);

      if (nextRole.hierarchyLevel === target.level &&
          target.roles.length === 1 && target.roles[0]?.id === nextRole.id) {
        throw new ConflictError('NO_CHANGE', 'That member already holds this role.');
      }

      await tx.delete(memberRole).where(eq(memberRole.memberId, input.memberId));
      await tx.insert(memberRole).values({
        memberId: input.memberId, roleId: nextRole.id, assignedBy: actorUserId,
      });

      await bumpPermissionVersion(tx, target.userId);

      await writeAudit(tx, {
        action: kind === 'promote' ? AUDIT_ACTIONS.MEMBER_PROMOTED : AUDIT_ACTIONS.MEMBER_DEMOTED,
        actorUserId,
        organizationId: target.organizationId,
        entityType: 'organization_member',
        entityId: input.memberId,
        before: { roles: target.roles.map((r) => r.name), hierarchyLevel: target.level },
        after: { roles: [nextRole.name], hierarchyLevel: nextRole.hierarchyLevel },
        metadata: {
          targetName: target.displayName,
          targetUsername: target.username,
          actorLevel: actor.level === Number.POSITIVE_INFINITY ? 'unbounded' : actor.level,
          fromLevel: target.level,
          toLevel: nextRole.hierarchyLevel,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { kind, fromLevel: target.level, toLevel: nextRole.hierarchyLevel };
    }),
  );
}

// ── Add / remove an individual role ────────────────────────────────────────

export async function addMemberRole(
  db: Database,
  actorUserId: string,
  input: { memberId: string; roleId: string },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_ASSIGNED,
      actorUserId, entityType: 'organization_member', entityId: input.memberId,
      metadata: { roleId: input.roleId },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, input.memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [input.memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);

      const target = await loadTarget(tx, input.memberId);
      if (!target) throw new NotFoundError('member');
      enforce(canManageMember(actor, toTargetContext(target)), 'assign role');
      enforce(requirePermission(actor, 'roles.assign'), 'assign role');

      const roleRows = await tx
        .select({
          id: role.id, name: role.name, hierarchyLevel: role.hierarchyLevel,
          organizationId: role.organizationId,
        })
        .from(role)
        .where(and(eq(role.id, input.roleId), isNull(role.deletedAt)))
        .limit(1);
      const nextRole = roleRows[0];
      if (!nextRole) throw new NotFoundError('role');
      if (nextRole.organizationId !== target.organizationId) {
        throw new ForbiddenError('role belongs to another organization', {
          reason: 'CROSS_ORGANIZATION',
        });
      }

      enforce(canAssignRole(actor, nextRole), 'assign role');
      await enforceRolePermissionSubset(tx, actor, nextRole.id);

      if (target.roles.some((r) => r.id === nextRole.id)) {
        throw new ConflictError('ALREADY_ASSIGNED', 'That member already holds this role.');
      }

      await tx.insert(memberRole).values({
        memberId: input.memberId, roleId: nextRole.id, assignedBy: actorUserId,
      });
      await bumpPermissionVersion(tx, target.userId);

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_ASSIGNED,
        actorUserId, organizationId: target.organizationId,
        entityType: 'organization_member', entityId: input.memberId,
        before: { roles: target.roles.map((r) => r.name), hierarchyLevel: target.level },
        after: {
          roles: [...target.roles.map((r) => r.name), nextRole.name],
          hierarchyLevel: Math.max(target.level, nextRole.hierarchyLevel),
        },
        metadata: { targetName: target.displayName, roleName: nextRole.name },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function removeMemberRole(
  db: Database,
  actorUserId: string,
  input: { memberId: string; roleId: string },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_UNASSIGNED,
      actorUserId, entityType: 'organization_member', entityId: input.memberId,
      metadata: { roleId: input.roleId },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, input.memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [input.memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);

      const target = await loadTarget(tx, input.memberId);
      if (!target) throw new NotFoundError('member');
      enforce(canManageMember(actor, toTargetContext(target)), 'remove role');
      enforce(requirePermission(actor, 'roles.assign'), 'remove role');

      const held = target.roles.find((r) => r.id === input.roleId);
      if (!held) throw new NotFoundError('role assignment');

      // Removing a role you could not grant is still a rank change you are not
      // entitled to make — the check runs in both directions.
      enforce(
        canAssignRole(actor, {
          id: held.id, organizationId: target.organizationId, hierarchyLevel: held.hierarchyLevel,
        }),
        'remove role',
      );

      if (target.roles.length === 1) {
        throw new ConflictError(
          'LAST_ROLE',
          'A member must hold at least one role. Change their rank instead, or terminate them.',
        );
      }

      await tx.delete(memberRole).where(and(
        eq(memberRole.memberId, input.memberId),
        eq(memberRole.roleId, input.roleId),
      ));
      await bumpPermissionVersion(tx, target.userId);

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_UNASSIGNED,
        actorUserId, organizationId: target.organizationId,
        entityType: 'organization_member', entityId: input.memberId,
        before: { roles: target.roles.map((r) => r.name), hierarchyLevel: target.level },
        after: {
          roles: target.roles.filter((r) => r.id !== input.roleId).map((r) => r.name),
        },
        metadata: { targetName: target.displayName, roleName: held.name },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Edit details / callsign ────────────────────────────────────────────────

export interface EditMemberInput {
  callsign?: string | null;
  employeeNumber?: string | null;
  notes?: string | null;
  status?: 'active' | 'on_leave' | 'suspended';
}

export async function editMember(
  db: Database,
  actorUserId: string,
  memberId: string,
  input: EditMemberInput,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.MEMBER_UPDATED,
      actorUserId, entityType: 'organization_member', entityId: memberId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);
      const target = await loadTarget(tx, memberId);
      if (!target) throw new NotFoundError('member');

      // Changing only a callsign needs the narrower permission; anything else
      // needs `personnel.edit`.
      const onlyCallsign =
        input.callsign !== undefined &&
        input.employeeNumber === undefined &&
        input.notes === undefined &&
        input.status === undefined;

      enforce(canManageMember(actor, toTargetContext(target)), 'edit member');
      enforce(
        requirePermission(actor, onlyCallsign ? 'personnel.callsign' : 'personnel.edit'),
        'edit member',
      );

      await enforceIdentifiersFree(tx, target.organizationId, memberId, input);

      await tx
        .update(organizationMember)
        .set({
          ...(input.callsign !== undefined ? { callsign: input.callsign } : {}),
          ...(input.employeeNumber !== undefined ? { employeeNumber: input.employeeNumber } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        })
        .where(eq(organizationMember.id, memberId));

      if (input.status !== undefined) await bumpPermissionVersion(tx, target.userId);

      const callsignChanged =
        input.callsign !== undefined && input.callsign !== target.callsign;

      await writeAudit(tx, {
        action: callsignChanged && onlyCallsign
          ? AUDIT_ACTIONS.MEMBER_CALLSIGN_CHANGED
          : AUDIT_ACTIONS.MEMBER_UPDATED,
        actorUserId, organizationId: target.organizationId,
        entityType: 'organization_member', entityId: memberId,
        before: {
          callsign: target.callsign, employeeNumber: target.employeeNumber, status: target.status,
        },
        after: {
          callsign: input.callsign ?? target.callsign,
          employeeNumber: input.employeeNumber ?? target.employeeNumber,
          status: input.status ?? target.status,
        },
        metadata: { targetName: target.displayName },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Per-member permission overrides ────────────────────────────────────────
//
// The exception to the role model, and the only place authority is handed to a
// PERSON rather than to a rank. See `canSetPermissionOverride` in the kernel for
// why it is a separate decision; this layer adds the things a kernel cannot
// know — that the key exists, that the member is active, and that a reason was
// written down.

export interface SetOverrideInput {
  memberId: string;
  permissionKey: string;
  effect: 'grant' | 'deny';
  reason: string;
  /** When the exception lapses. `null` means it stands until cleared. */
  expiresAt: Date | null;
}

export async function setMemberPermissionOverride(
  db: Database,
  actorUserId: string,
  input: SetOverrideInput,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERMISSION_OVERRIDE_SET,
      actorUserId, entityType: 'organization_member', entityId: input.memberId,
      metadata: { permissionKey: input.permissionKey, effect: input.effect },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, input.memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [input.memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);

      const target = await loadTarget(tx, input.memberId);
      if (!target) throw new NotFoundError('member');

      /**
       * The key is checked against the CATALOGUE, not merely against the foreign
       * key. The column references `permission`, so an unknown key would fail as
       * a constraint violation — a 500 describing a foreign key rather than a
       * 400 naming the field, which is the same shape of problem as T1 and T2.
       */
      if (!(PERMISSION_KEYS as readonly string[]).includes(input.permissionKey)) {
        throw new ValidationError({ permissionKey: `Unknown permission: ${input.permissionKey}` });
      }
      const key = input.permissionKey as PermissionKey;

      enforce(canSetPermissionOverride(actor, toTargetContext(target), key, input.effect),
        'set permission override');
      enforce(requirePermission(actor, 'roles.permissions'), 'set permission override');

      /**
       * AN OVERRIDE ON A TERMINATED MEMBERSHIP IS INERT AND MISLEADING.
       *
       * `loadMemberships` gives a non-active member no permissions at all, so
       * the row would sit in the table looking like a grant and doing nothing —
       * and would silently come alive if they were ever reinstated. Refused
       * rather than stored.
       */
      if (target.status !== 'active') {
        throw new ConflictError(
          'MEMBER_NOT_ACTIVE',
          `${target.displayName} is ${target.status}. Reinstate them before writing an exception.`,
        );
      }

      if (input.expiresAt !== null && input.expiresAt.getTime() <= Date.now()) {
        throw new ValidationError({ expiresAt: 'The expiry must be in the future.' });
      }

      const existing = await tx
        .select({
          effect: memberPermissionOverride.effect,
          expiresAt: memberPermissionOverride.expiresAt,
        })
        .from(memberPermissionOverride)
        .where(and(
          eq(memberPermissionOverride.memberId, input.memberId),
          eq(memberPermissionOverride.permissionKey, key),
        ))
        .limit(1);

      await tx
        .insert(memberPermissionOverride)
        .values({
          memberId: input.memberId,
          permissionKey: key,
          effect: input.effect,
          reason: input.reason,
          grantedBy: actorUserId,
          expiresAt: input.expiresAt,
        })
        .onConflictDoUpdate({
          target: [memberPermissionOverride.memberId, memberPermissionOverride.permissionKey],
          set: {
            effect: input.effect,
            reason: input.reason,
            grantedBy: actorUserId,
            expiresAt: input.expiresAt,
          },
        });

      await bumpPermissionVersion(tx, target.userId);

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERMISSION_OVERRIDE_SET,
        actorUserId, organizationId: target.organizationId,
        entityType: 'organization_member', entityId: input.memberId,
        before: existing[0]
          ? { effect: existing[0].effect, expiresAt: existing[0].expiresAt?.toISOString() ?? null }
          : { effect: null },
        after: { effect: input.effect, expiresAt: input.expiresAt?.toISOString() ?? null },
        metadata: {
          targetName: target.displayName,
          targetUsername: target.username,
          permissionKey: key,
          reason: input.reason,
          actorLevel: actor.level === Number.POSITIVE_INFINITY ? 'unbounded' : actor.level,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function clearMemberPermissionOverride(
  db: Database,
  actorUserId: string,
  input: { memberId: string; permissionKey: string },
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.PERMISSION_OVERRIDE_CLEARED,
      actorUserId, entityType: 'organization_member', entityId: input.memberId,
      metadata: { permissionKey: input.permissionKey },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      const pre = await loadTarget(tx, input.memberId);
      if (!pre) throw new NotFoundError('member');

      await lockMemberships(tx, [input.memberId]);
      await lockMembershipsByUser(tx, pre.organizationId, [actorUserId]);

      const actor = await loadActorContextLocked(tx, actorUserId, pre.organizationId);

      const target = await loadTarget(tx, input.memberId);
      if (!target) throw new NotFoundError('member');

      enforce(canClearPermissionOverride(actor, toTargetContext(target)),
        'clear permission override');
      enforce(requirePermission(actor, 'roles.permissions'), 'clear permission override');

      const removed = await tx
        .delete(memberPermissionOverride)
        .where(and(
          eq(memberPermissionOverride.memberId, input.memberId),
          eq(memberPermissionOverride.permissionKey, input.permissionKey),
        ))
        .returning({ effect: memberPermissionOverride.effect });

      if (removed.length === 0) throw new NotFoundError('override');

      await bumpPermissionVersion(tx, target.userId);

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.PERMISSION_OVERRIDE_CLEARED,
        actorUserId, organizationId: target.organizationId,
        entityType: 'organization_member', entityId: input.memberId,
        before: { effect: removed[0]!.effect },
        after: { effect: null },
        metadata: {
          targetName: target.displayName,
          targetUsername: target.username,
          permissionKey: input.permissionKey,
          actorLevel: actor.level === Number.POSITIVE_INFINITY ? 'unbounded' : actor.level,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}
