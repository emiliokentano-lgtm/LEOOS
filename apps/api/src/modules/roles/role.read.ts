import { and, asc, desc, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import {
  memberRole, organizationMember, role, rolePermission, userAccount, type Database,
} from '@leoos/db';
import type { PermissionKey } from '@leoos/contracts';

/**
 * Role reads.
 *
 * Every query filters by `organizationId`. There is no variant that spans
 * organizations, so a missing scope check upstream cannot become a leak here.
 */

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  hierarchyLevel: number;
  isDefault: boolean;
  isSystem: boolean;
  color: string | null;
  memberCount: number;
  permissionCount: number;
  permissions: PermissionKey[];
  isArchived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
}

export async function listRoles(
  db: Database,
  organizationId: string,
  options: { includeArchived?: boolean } = {},
): Promise<RoleRow[]> {
  const rows = await db
    .select({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      hierarchyLevel: role.hierarchyLevel,
      isDefault: role.isDefault,
      isSystem: role.isSystem,
      color: role.color,
      deletedAt: role.deletedAt,
      deletionReason: role.deletionReason,
      memberCount: sql<number>`(
        SELECT count(*) FROM member_role mr WHERE mr.role_id = ${role.id})::int`,
    })
    .from(role)
    .where(and(
      eq(role.organizationId, organizationId),
      options.includeArchived ? undefined : isNull(role.deletedAt),
    ))
    // Highest rank first, then by name, then by id so the order is total and
    // two roles sharing a level never swap places between requests.
    .orderBy(desc(role.hierarchyLevel), asc(role.name), asc(role.id));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const perms = await db
    .select({ roleId: rolePermission.roleId, key: rolePermission.permissionKey })
    .from(rolePermission)
    .where(sql`${rolePermission.roleId} = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})`);

  return rows.map((r) => {
    const keys = perms.filter((p) => p.roleId === r.id).map((p) => p.key as PermissionKey).sort();
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      hierarchyLevel: r.hierarchyLevel,
      isDefault: r.isDefault,
      isSystem: r.isSystem,
      color: r.color,
      memberCount: Number(r.memberCount),
      permissionCount: keys.length,
      permissions: keys,
      isArchived: r.deletedAt !== null,
      archivedAt: r.deletedAt?.toISOString() ?? null,
      archivedReason: r.deletionReason,
    };
  });
}

export async function getRole(
  db: Database,
  organizationId: string,
  roleId: string,
): Promise<RoleRow | null> {
  const all = await listRoles(db, organizationId, { includeArchived: true });
  return all.find((r) => r.id === roleId) ?? null;
}

export interface RoleHolder {
  memberId: string;
  userId: string;
  displayName: string;
  callsign: string | null;
  status: string;
}

/** Who holds this role — the list an operator needs before archiving it. */
export async function listRoleHolders(
  db: Database,
  organizationId: string,
  roleId: string,
): Promise<RoleHolder[]> {
  return db
    .select({
      memberId: organizationMember.id,
      userId: organizationMember.userId,
      displayName: userAccount.displayName,
      callsign: organizationMember.callsign,
      status: organizationMember.status,
    })
    .from(memberRole)
    .innerJoin(organizationMember, eq(organizationMember.id, memberRole.memberId))
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .where(and(
      eq(memberRole.roleId, roleId),
      eq(organizationMember.organizationId, organizationId),
    ))
    .orderBy(asc(userAccount.displayName))
    .limit(200);
}

/** Archived roles, for the restore path. */
export async function listArchivedRoles(
  db: Database,
  organizationId: string,
): Promise<RoleRow[]> {
  const all = await listRoles(db, organizationId, { includeArchived: true });
  return all.filter((r) => r.isArchived);
}

/**
 * Roles that would be refused a live key on restore.
 *
 * Read rather than discovered at write time so the UI can warn before the
 * operator commits to the action.
 */
export async function keysInUse(db: Database, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ key: role.key })
    .from(role)
    .where(and(eq(role.organizationId, organizationId), isNull(role.deletedAt)));
  return rows.map((r) => r.key);
}

/** Archived-role count, so the roles screen can offer the restore view honestly. */
export async function archivedRoleCount(
  db: Database,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(role)
    .where(and(eq(role.organizationId, organizationId), isNotNull(role.deletedAt)));
  return Number(rows[0]?.n ?? 0);
}
