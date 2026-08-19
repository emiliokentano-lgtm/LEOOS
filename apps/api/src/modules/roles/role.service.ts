import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, memberRole, organization, permission, role, rolePermission,
  organizationMember, type Database,
} from '@leoos/db';
import {
  canChangeRolePermissions, canCreateRole, canDeleteRole, canEditRole, canMoveRole,
  requirePermission, MAX_HIERARCHY_LEVEL, MIN_HIERARCHY_LEVEL,
  type ActorContext, type Decision, type RoleRef,
} from '@leoos/authz-core';
import { PERMISSION_KEYS, type PermissionKey } from '@leoos/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { withDenialAudit, writeAudit } from '../../lib/audit.js';
import { bumpPermissionVersion, loadActorContextLocked } from '../auth/context.service.js';
import type { RequestMeta } from '../auth/auth.service.js';

/**
 * Role management.
 *
 * Roles are the authority structure itself, so every mutation here follows the
 * same shape as the personnel module: open a transaction, LOCK the row, re-read
 * the actor from the locked state, ask the kernel, mutate and audit together.
 *
 * The lock matters more here than almost anywhere else. A role's hierarchy level
 * is read to decide whether the actor may touch it; without the lock, two
 * concurrent edits can each pass a check against a level the other is in the
 * middle of changing, and the pair of them lands a role above its editor.
 *
 * THE ORDER OF CHECKS IS PART OF THE DESIGN, and follows the sequence the brief
 * lays out: identify the actor, resolve their organization from their own
 * membership, take their rank and permissions from the locked row, read the
 * target role's rank, then decide — permission first for the coarse gate, rank
 * and subset rules before anything is written.
 */

function enforce(decision: Decision, what: string): void {
  if (!decision.allowed) {
    throw new ForbiddenError(`${what}: ${decision.reason}`, {
      reason: decision.reason,
      ...(decision.detail ? { detail: decision.detail } : {}),
    });
  }
}

interface LoadedRole {
  id: string;
  organizationId: string | null;
  key: string;
  name: string;
  description: string | null;
  hierarchyLevel: number;
  isDefault: boolean;
  isSystem: boolean;
  color: string | null;
  deletedAt: Date | null;
  permissions: PermissionKey[];
  memberCount: number;
}

function toRoleRef(row: LoadedRole): RoleRef {
  return {
    id: row.id,
    organizationId: row.organizationId,
    hierarchyLevel: row.hierarchyLevel,
    isSystem: row.isSystem,
    isDefault: row.isDefault,
  };
}

/**
 * Locks a role row and reads it back with its permissions and member count.
 *
 * `FOR UPDATE` on the role, not merely a read: the level this returns is the one
 * the decision is made on, and it must not move underneath the transaction.
 */
async function loadRoleLocked(tx: Database, roleId: string): Promise<LoadedRole | null> {
  await tx.execute(sql`SELECT id FROM role WHERE id = ${roleId} FOR UPDATE`);

  const rows = await tx
    .select({
      id: role.id,
      organizationId: role.organizationId,
      key: role.key,
      name: role.name,
      description: role.description,
      hierarchyLevel: role.hierarchyLevel,
      isDefault: role.isDefault,
      isSystem: role.isSystem,
      color: role.color,
      deletedAt: role.deletedAt,
      memberCount: sql<number>`(SELECT count(*) FROM member_role mr WHERE mr.role_id = ${role.id})::int`,
    })
    .from(role)
    .where(eq(role.id, roleId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const perms = await tx
    .select({ key: rolePermission.permissionKey })
    .from(rolePermission)
    .where(eq(rolePermission.roleId, roleId));

  return {
    ...row,
    memberCount: Number(row.memberCount),
    permissions: perms.map((p) => p.key as PermissionKey),
  };
}

/** Locks the actor's own membership so their rank cannot move mid-decision. */
async function lockActorMembership(
  tx: Database, actorUserId: string, organizationId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT id FROM organization_member
    WHERE user_id = ${actorUserId} AND organization_id = ${organizationId}
    ORDER BY id FOR UPDATE
  `);
}

/**
 * Scope guard shared by every mutation.
 *
 * A role from another organization is NOT FOUND rather than FORBIDDEN — a 403
 * would confirm the role exists (docs/architecture/02-authorization.md §B.8).
 */
function assertInOrganization(row: LoadedRole, organizationId: string): void {
  if (row.organizationId !== organizationId) throw new NotFoundError('role');
}

function assertKnownPermissions(keys: readonly string[]): PermissionKey[] {
  const known = new Set<string>(PERMISSION_KEYS);
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ValidationError({ permissions: `unknown permission keys: ${unknown.join(', ')}` });
  }
  return [...new Set(keys)] as PermissionKey[];
}

/**
 * Everyone holding a role gets a new permission version.
 *
 * A role change rewrites the authority of every member who holds it, and the
 * session layer caches resolved permissions keyed by that version. Without this,
 * a permission removed from a role would keep working until each holder happened
 * to re-authenticate.
 */
async function bumpHoldersOfRole(tx: Database, roleId: string): Promise<number> {
  const holders = await tx
    .select({ userId: organizationMember.userId })
    .from(memberRole)
    .innerJoin(organizationMember, eq(organizationMember.id, memberRole.memberId))
    .where(eq(memberRole.roleId, roleId));

  for (const holder of holders) await bumpPermissionVersion(tx, holder.userId);
  return holders.length;
}

// ── Create ─────────────────────────────────────────────────────────────────

export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string | null;
  hierarchyLevel: number;
  color?: string | null;
  permissions?: string[];
}

export async function createRole(
  db: Database,
  actorUserId: string,
  organizationId: string,
  input: CreateRoleInput,
  meta: RequestMeta = {},
): Promise<{ roleId: string }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_CREATED,
      actorUserId,
      organizationId,
      entityType: 'role',
      entityId: null,
      metadata: { key: input.key, hierarchyLevel: input.hierarchyLevel },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);

      // Scope before permission: an actor with no standing here holds none of
      // this organization's permissions, so a permission-first check would
      // record every cross-organization attempt as a mundane missing permission.
      assertActorScope(actor, organizationId, 'create role');
      enforce(requirePermission(actor, 'roles.create'), 'create role');

      const orgRows = await tx
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(and(eq(organization.id, organizationId), isNull(organization.deletedAt)))
        .limit(1);
      if (!orgRows[0]) throw new NotFoundError('organization');

      // H5 — a role may not be created at or above the creator's own rank.
      enforce(canCreateRole(actor, input.hierarchyLevel), 'create role');

      const requested = assertKnownPermissions(input.permissions ?? []);
      if (requested.length > 0) {
        // H4 — and it may not be born carrying authority its creator lacks.
        enforce(
          canChangeRolePermissions(
            actor,
            { id: 'new', organizationId, hierarchyLevel: input.hierarchyLevel },
            requested,
          ),
          'create role',
        );
      }

      const clash = await tx
        .select({ id: role.id })
        .from(role)
        .where(and(
          eq(role.organizationId, organizationId),
          eq(role.key, input.key),
          isNull(role.deletedAt),
        ))
        .limit(1);
      if (clash[0]) {
        throw new ConflictError('ROLE_KEY_TAKEN', `A role with the key "${input.key}" already exists.`);
      }

      const created = await tx
        .insert(role)
        .values({
          organizationId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          hierarchyLevel: input.hierarchyLevel,
          color: input.color ?? null,
          createdBy: actorUserId,
        })
        .returning({ id: role.id });
      const roleId = created[0]!.id;

      if (requested.length > 0) {
        await tx.insert(rolePermission).values(
          requested.map((key) => ({ roleId, permissionKey: key, grantedBy: actorUserId })),
        );
      }

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_CREATED,
        actorUserId,
        organizationId,
        entityType: 'role',
        entityId: roleId,
        after: {
          key: input.key, name: input.name, hierarchyLevel: input.hierarchyLevel,
          permissions: requested,
        },
        metadata: {
          organizationName: orgRows[0].name,
          actorLevel: describeLevel(actor.level),
          permissionCount: requested.length,
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { roleId };
    }),
  );
}

/** H7 — the actor must belong to the organization they are acting on. */
function assertActorScope(actor: ActorContext, organizationId: string, what: string): void {
  if (actor.isGlobalAdmin) return;
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenError(`${what}: CROSS_ORGANIZATION`, { reason: 'CROSS_ORGANIZATION' });
  }
}

function describeLevel(level: number): number | 'unbounded' {
  return level === Number.POSITIVE_INFINITY ? 'unbounded' : level;
}

// ── Update name / description / level ──────────────────────────────────────

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  hierarchyLevel?: number;
  color?: string | null;
}

export async function updateRole(
  db: Database,
  actorUserId: string,
  organizationId: string,
  roleId: string,
  input: UpdateRoleInput,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_UPDATED,
      actorUserId, organizationId, entityType: 'role', entityId: roleId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
      assertActorScope(actor, organizationId, 'edit role');

      const target = await loadRoleLocked(tx, roleId);
      if (!target || target.deletedAt) throw new NotFoundError('role');
      assertInOrganization(target, organizationId);

      // H3 first — reachability is the rank question, and it is the one worth
      // auditing when it fails.
      enforce(canEditRole(actor, toRoleRef(target)), 'edit role');
      enforce(requirePermission(actor, 'roles.edit'), 'edit role');

      // A system role is structural; renaming or re-levelling one would change
      // the meaning of seeded data other organizations also rely on.
      if (target.isSystem) {
        throw new ForbiddenError('edit role: ROLE_IS_SYSTEM', { reason: 'ROLE_IS_SYSTEM' });
      }

      if (input.hierarchyLevel !== undefined && input.hierarchyLevel !== target.hierarchyLevel) {
        // H5b — both the current and the destination level are bounded by the
        // actor's own rank. See `canMoveRole` for the two attacks this closes.
        enforce(canMoveRole(actor, toRoleRef(target), input.hierarchyLevel), 'move role');
      }

      await tx
        .update(role)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.hierarchyLevel !== undefined ? { hierarchyLevel: input.hierarchyLevel } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
        })
        .where(eq(role.id, roleId));

      // A level change moves every holder's effective rank.
      const affected = input.hierarchyLevel !== undefined && input.hierarchyLevel !== target.hierarchyLevel
        ? await bumpHoldersOfRole(tx, roleId)
        : 0;

      await writeAudit(tx, {
        action: input.hierarchyLevel !== undefined && input.hierarchyLevel !== target.hierarchyLevel
          ? AUDIT_ACTIONS.ROLE_LEVEL_CHANGED
          : AUDIT_ACTIONS.ROLE_UPDATED,
        actorUserId, organizationId, entityType: 'role', entityId: roleId,
        before: {
          name: target.name, description: target.description,
          hierarchyLevel: target.hierarchyLevel,
        },
        after: {
          name: input.name ?? target.name,
          description: input.description !== undefined ? input.description : target.description,
          hierarchyLevel: input.hierarchyLevel ?? target.hierarchyLevel,
        },
        metadata: {
          roleName: target.name,
          actorLevel: describeLevel(actor.level),
          ...(affected > 0 ? { membersAffected: affected } : {}),
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Permission set ─────────────────────────────────────────────────────────

/**
 * Replaces a role's permission set.
 *
 * Takes the WHOLE set rather than a pair of add/remove lists, because a role
 * editor is a set of checkboxes and sending the resulting state is what the UI
 * actually knows. The add/remove diff is computed here, server-side, against the
 * locked row — so two editors working at once cannot combine into a set neither
 * of them submitted, and the H4 subset rule is applied to the additions the
 * server derived rather than to a list the client labelled.
 */
export async function setRolePermissions(
  db: Database,
  actorUserId: string,
  organizationId: string,
  roleId: string,
  nextKeys: string[],
  meta: RequestMeta = {},
): Promise<{ added: PermissionKey[]; removed: PermissionKey[] }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
      actorUserId, organizationId, entityType: 'role', entityId: roleId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
      assertActorScope(actor, organizationId, 'change role permissions');

      const target = await loadRoleLocked(tx, roleId);
      if (!target || target.deletedAt) throw new NotFoundError('role');
      assertInOrganization(target, organizationId);

      enforce(canEditRole(actor, toRoleRef(target)), 'change role permissions');
      enforce(requirePermission(actor, 'roles.permissions'), 'change role permissions');

      const desired = assertKnownPermissions(nextKeys);
      const current = new Set(target.permissions);
      const next = new Set(desired);

      const added = desired.filter((key) => !current.has(key));
      const removed = target.permissions.filter((key) => !next.has(key));

      if (added.length === 0 && removed.length === 0) {
        throw new ConflictError('NO_CHANGE', 'That role already has exactly these permissions.');
      }

      // H3 + H4, on the additions the SERVER computed.
      enforce(canChangeRolePermissions(actor, toRoleRef(target), added), 'change role permissions');

      // Every key must exist in the catalogue table, or the foreign key would
      // fail as a raw 500 rather than a validation error.
      if (added.length > 0) {
        const known = await tx
          .select({ key: permission.key })
          .from(permission)
          .where(sql`${permission.key} = ANY(${sql.raw(`ARRAY[${added.map((k) => `'${k}'`).join(',')}]`)})`);
        if (known.length !== added.length) {
          const found = new Set(known.map((k) => k.key));
          throw new ValidationError({
            permissions: `not in the catalogue: ${added.filter((k) => !found.has(k)).join(', ')}`,
          });
        }
      }

      if (removed.length > 0) {
        await tx.delete(rolePermission).where(and(
          eq(rolePermission.roleId, roleId),
          sql`${rolePermission.permissionKey} = ANY(${sql.raw(`ARRAY[${removed.map((k) => `'${k}'`).join(',')}]`)})`,
        ));
      }
      if (added.length > 0) {
        await tx.insert(rolePermission).values(
          added.map((key) => ({ roleId, permissionKey: key, grantedBy: actorUserId })),
        ).onConflictDoNothing();
      }

      const affected = await bumpHoldersOfRole(tx, roleId);

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
        actorUserId, organizationId, entityType: 'role', entityId: roleId,
        before: { permissions: [...target.permissions].sort() },
        after: { permissions: [...desired].sort() },
        metadata: {
          roleName: target.name,
          added: added.sort(),
          removed: removed.sort(),
          membersAffected: affected,
          actorLevel: describeLevel(actor.level),
        },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { added, removed };
    }),
  );
}

// ── Archive / restore ──────────────────────────────────────────────────────

/**
 * Archives a role. SOFT DELETE — the row and its history stay
 * (engineering rules 24, 25).
 *
 * A role still held by somebody is refused: archiving it would silently strip
 * those members of their rank and leave them at level 0, unmanageable by anyone
 * below the organization lead. A database trigger refuses it too.
 */
export async function archiveRole(
  db: Database,
  actorUserId: string,
  organizationId: string,
  roleId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_ARCHIVED,
      actorUserId, organizationId, entityType: 'role', entityId: roleId,
      metadata: { reason },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
      assertActorScope(actor, organizationId, 'archive role');

      const target = await loadRoleLocked(tx, roleId);
      if (!target) throw new NotFoundError('role');
      assertInOrganization(target, organizationId);
      if (target.deletedAt) {
        throw new ConflictError('ALREADY_ARCHIVED', 'That role is already archived.');
      }

      enforce(canDeleteRole(actor, toRoleRef(target)), 'archive role');
      enforce(requirePermission(actor, 'roles.delete'), 'archive role');

      if (target.memberCount > 0) {
        throw new ConflictError(
          'ROLE_IN_USE',
          `${target.name} is still held by ${target.memberCount} member(s). Reassign them first.`,
        );
      }

      await tx
        .update(role)
        .set({
          deletedAt: new Date(), deletedBy: actorUserId, deletionReason: reason,
          isActive: false,
        })
        .where(eq(role.id, roleId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_ARCHIVED,
        actorUserId, organizationId, entityType: 'role', entityId: roleId,
        before: {
          name: target.name, hierarchyLevel: target.hierarchyLevel,
          permissions: [...target.permissions].sort(),
        },
        after: { archived: true },
        metadata: { reason, roleName: target.name, actorLevel: describeLevel(actor.level) },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

export async function restoreRole(
  db: Database,
  actorUserId: string,
  organizationId: string,
  roleId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_RESTORED,
      actorUserId, organizationId, entityType: 'role', entityId: roleId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
      assertActorScope(actor, organizationId, 'restore role');

      const target = await loadRoleLocked(tx, roleId);
      if (!target) throw new NotFoundError('role');
      assertInOrganization(target, organizationId);
      if (!target.deletedAt) {
        throw new ConflictError('NOT_ARCHIVED', 'That role is not archived.');
      }

      // Restoring brings a role back WITH ITS PERMISSIONS. It is therefore an
      // act of granting, and is bounded by both the rank and the subset rule —
      // otherwise archiving would be a way to park authority out of reach and
      // retrieve it later from a weaker position.
      enforce(canEditRole(actor, toRoleRef(target)), 'restore role');
      enforce(requirePermission(actor, 'roles.restore'), 'restore role');
      enforce(
        canChangeRolePermissions(actor, toRoleRef(target), target.permissions),
        'restore role',
      );

      const clash = await tx
        .select({ id: role.id })
        .from(role)
        .where(and(
          eq(role.organizationId, organizationId),
          eq(role.key, target.key),
          isNull(role.deletedAt),
          ne(role.id, roleId),
        ))
        .limit(1);
      if (clash[0]) {
        throw new ConflictError(
          'ROLE_KEY_TAKEN',
          `A live role already uses the key "${target.key}". Rename it before restoring this one.`,
        );
      }

      await tx
        .update(role)
        .set({ deletedAt: null, deletedBy: null, deletionReason: null, isActive: true })
        .where(eq(role.id, roleId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_RESTORED,
        actorUserId, organizationId, entityType: 'role', entityId: roleId,
        after: { name: target.name, hierarchyLevel: target.hierarchyLevel },
        metadata: { roleName: target.name, actorLevel: describeLevel(actor.level) },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}

// ── Reorder ────────────────────────────────────────────────────────────────

export interface ReorderEntry {
  roleId: string;
  hierarchyLevel: number;
}

/**
 * Reassigns levels across several roles in one transaction.
 *
 * Reordering is the single most dangerous role operation, because it is where a
 * per-role check is easiest to get wrong. Three rules make it safe:
 *
 *   1. EVERY role in the batch is locked before ANY of them is decided on, in id
 *      order, so a concurrent reorder cannot interleave.
 *   2. EVERY entry is checked at BOTH its current and its destination level
 *      (`canMoveRole`). A batch is not a licence to move one role through a
 *      position the actor could not have set directly.
 *   3. The batch is all-or-nothing. A partially applied reorder is a hierarchy
 *      in a state nobody chose, which is worse than a refusal.
 */
export async function reorderRoles(
  db: Database,
  actorUserId: string,
  organizationId: string,
  entries: ReorderEntry[],
  meta: RequestMeta = {},
): Promise<{ moved: number }> {
  return withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_LEVEL_CHANGED,
      actorUserId, organizationId, entityType: 'role', entityId: null,
      metadata: { batch: entries.length },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      if (entries.length === 0) throw new ValidationError({ order: 'no roles supplied' });

      const ids = [...new Set(entries.map((e) => e.roleId))];
      if (ids.length !== entries.length) {
        throw new ValidationError({ order: 'a role appears more than once' });
      }
      for (const entry of entries) {
        if (entry.hierarchyLevel < MIN_HIERARCHY_LEVEL || entry.hierarchyLevel > MAX_HIERARCHY_LEVEL) {
          throw new ValidationError({
            order: `level ${entry.hierarchyLevel} is outside ${MIN_HIERARCHY_LEVEL}–${MAX_HIERARCHY_LEVEL}`,
          });
        }
      }

      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
      assertActorScope(actor, organizationId, 'reorder roles');
      enforce(requirePermission(actor, 'roles.edit'), 'reorder roles');

      // Ascending id order, matching the personnel module, so two reorders
      // touching overlapping sets serialise instead of deadlocking.
      await tx.execute(sql`
        SELECT id FROM role
        WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]`)})
        ORDER BY id FOR UPDATE
      `);

      const loaded: LoadedRole[] = [];
      for (const id of ids) {
        const row = await loadRoleLocked(tx, id);
        if (!row || row.deletedAt) throw new NotFoundError('role');
        assertInOrganization(row, organizationId);
        loaded.push(row);
      }

      // Decide the WHOLE batch before writing any of it.
      for (const entry of entries) {
        const row = loaded.find((r) => r.id === entry.roleId)!;
        if (row.hierarchyLevel === entry.hierarchyLevel) continue;
        if (row.isSystem) {
          throw new ForbiddenError('reorder roles: ROLE_IS_SYSTEM', {
            reason: 'ROLE_IS_SYSTEM', detail: row.name,
          });
        }
        enforce(canMoveRole(actor, toRoleRef(row), entry.hierarchyLevel), 'reorder roles');
      }

      let moved = 0;
      for (const entry of entries) {
        const row = loaded.find((r) => r.id === entry.roleId)!;
        if (row.hierarchyLevel === entry.hierarchyLevel) continue;
        await tx
          .update(role)
          .set({ hierarchyLevel: entry.hierarchyLevel })
          .where(eq(role.id, entry.roleId));
        await bumpHoldersOfRole(tx, entry.roleId);
        moved += 1;
      }

      if (moved === 0) throw new ConflictError('NO_CHANGE', 'That order is already in effect.');

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_LEVEL_CHANGED,
        actorUserId, organizationId, entityType: 'role', entityId: null,
        before: {
          order: loaded
            .map((r) => ({ role: r.name, hierarchyLevel: r.hierarchyLevel }))
            .sort((a, b) => b.hierarchyLevel - a.hierarchyLevel),
        },
        after: {
          order: entries
            .map((e) => ({
              role: loaded.find((r) => r.id === e.roleId)!.name,
              hierarchyLevel: e.hierarchyLevel,
            }))
            .sort((a, b) => b.hierarchyLevel - a.hierarchyLevel),
        },
        metadata: { moved, actorLevel: describeLevel(actor.level) },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });

      return { moved };
    }),
  );
}

// ── Default role ───────────────────────────────────────────────────────────

/**
 * Sets the role new hires receive.
 *
 * Bounded by the actor's rank like any other role change: without that, someone
 * could point the default at a senior role and let the next hire arrive above
 * them. A partial unique index keeps at most one default per organization.
 */
export async function setDefaultRole(
  db: Database,
  actorUserId: string,
  organizationId: string,
  roleId: string,
  meta: RequestMeta = {},
): Promise<void> {
  await withDenialAudit(
    db,
    () => ({
      action: AUDIT_ACTIONS.ROLE_UPDATED,
      actorUserId, organizationId, entityType: 'role', entityId: roleId,
      metadata: { isDefault: true },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    }),
    () => db.transaction(async (tx) => {
      await lockActorMembership(tx, actorUserId, organizationId);
      const actor = await loadActorContextLocked(tx, actorUserId, organizationId);
      assertActorScope(actor, organizationId, 'set default role');

      const target = await loadRoleLocked(tx, roleId);
      if (!target || target.deletedAt) throw new NotFoundError('role');
      assertInOrganization(target, organizationId);

      enforce(canEditRole(actor, toRoleRef(target)), 'set default role');
      enforce(requirePermission(actor, 'roles.edit'), 'set default role');
      if (target.isDefault) {
        throw new ConflictError('NO_CHANGE', 'That role is already the default.');
      }

      // Cleared first: the partial unique index permits only one default, so
      // both statements must land in the same transaction.
      await tx
        .update(role)
        .set({ isDefault: false })
        .where(and(eq(role.organizationId, organizationId), eq(role.isDefault, true)));
      await tx.update(role).set({ isDefault: true }).where(eq(role.id, roleId));

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        actorUserId, organizationId, entityType: 'role', entityId: roleId,
        after: { isDefault: true },
        metadata: { roleName: target.name, actorLevel: describeLevel(actor.level) },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
    }),
  );
}
