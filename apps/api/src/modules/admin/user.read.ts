import { and, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  organization, organizationLead, organizationMember, memberRole, role, session,
  userAccount, userGlobalRole,
  type Database,
} from '@leoos/db';
import type { AdminUserQuery, GlobalCapabilityKey } from '@leoos/contracts';

/**
 * Reads over the account register.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS NOT ALLOWED TO SELECT
 *
 * `user_account` holds `password_hash`, `totp_secret_enc` and the failed-login
 * counters. Every query below names its columns explicitly and none of them
 * names those. That is not a stylistic preference: `select()` with no argument
 * returns the whole row, and one such call anywhere in this file would put a
 * password hash one `JSON.stringify` away from a browser (engineering rule 16).
 *
 * The DTO layer is the second wall. This is the first.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface AdminUserRow {
  id: string;
  username: string;
  email: string;
  displayName: string;
  status: string;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AdminUserDetailRow extends AdminUserRow {
  lastLoginIp: string | null;
  lockedUntil: Date | null;
  updatedAt: Date;
}

const LIST_COLUMNS = {
  id: userAccount.id,
  username: userAccount.username,
  email: userAccount.email,
  displayName: userAccount.displayName,
  status: userAccount.status,
  emailVerifiedAt: userAccount.emailVerifiedAt,
  lastLoginAt: userAccount.lastLoginAt,
  createdAt: userAccount.createdAt,
};

/**
 * The filter, as one expression.
 *
 * Written once and used by both the page query and the count, so the total can
 * never describe a different set from the rows — the classic pagination bug
 * where the header says 240 and the list is filtered to 12.
 */
function whereFor(query: AdminUserQuery) {
  const clauses = [];

  if (query.search) {
    // Escaped, so a `%` typed into the search box matches a literal percent
    // rather than turning the query into "everyone".
    const needle = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(or(
      ilike(userAccount.username, needle),
      ilike(userAccount.email, needle),
      ilike(userAccount.displayName, needle),
    ));
  }

  if (query.status) {
    clauses.push(eq(userAccount.status, query.status));
  }

  if (query.capability) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM ${userGlobalRole}
      WHERE ${userGlobalRole.userId} = ${userAccount.id}
        AND ${userGlobalRole.capability} = ${query.capability}
    )`);
  }

  if (query.organizationId) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM ${organizationMember}
      WHERE ${organizationMember.userId} = ${userAccount.id}
        AND ${organizationMember.organizationId} = ${query.organizationId}
    )`);
  }

  if (query.unaffiliated) {
    // The queue after registration: verified accounts nobody has hired yet.
    clauses.push(sql`NOT EXISTS (
      SELECT 1 FROM ${organizationMember}
      WHERE ${organizationMember.userId} = ${userAccount.id}
        AND ${organizationMember.status} = 'active'
    )`);
  }

  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function listAdminUsers(
  db: Database,
  query: AdminUserQuery,
): Promise<{ rows: AdminUserRow[]; total: number }> {
  const where = whereFor(query);
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const [rows, totals] = await Promise.all([
    db
      .select(LIST_COLUMNS)
      .from(userAccount)
      .where(where)
      // Newest first: the accounts an administrator is looking for are almost
      // always recent ones — a registration to approve, a suspension to review.
      .orderBy(sql`${userAccount.createdAt} DESC`, userAccount.id)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(userAccount).where(where),
  ]);

  return { rows: rows as AdminUserRow[], total: totals[0]?.value ?? 0 };
}

/** Capabilities for a set of users, in one query rather than one per row. */
export async function capabilitiesFor(
  db: Database,
  userIds: string[],
): Promise<Map<string, GlobalCapabilityKey[]>> {
  const out = new Map<string, GlobalCapabilityKey[]>();
  if (userIds.length === 0) return out;

  const rows = await db
    .select({ userId: userGlobalRole.userId, capability: userGlobalRole.capability })
    .from(userGlobalRole)
    .where(inArray(userGlobalRole.userId, userIds));

  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push(row.capability as GlobalCapabilityKey);
    out.set(row.userId, list);
  }
  return out;
}

export interface MembershipCountRow {
  userId: string;
  membershipCount: number;
  organizationShortNames: string[];
}

/** Membership counts and organization badges for the list, in one query. */
export async function membershipSummaryFor(
  db: Database,
  userIds: string[],
): Promise<Map<string, MembershipCountRow>> {
  const out = new Map<string, MembershipCountRow>();
  if (userIds.length === 0) return out;

  const rows = await db
    .select({
      userId: organizationMember.userId,
      shortName: organization.shortName,
      status: organizationMember.status,
    })
    .from(organizationMember)
    .innerJoin(organization, eq(organization.id, organizationMember.organizationId))
    .where(inArray(organizationMember.userId, userIds));

  for (const row of rows) {
    const entry = out.get(row.userId)
      ?? { userId: row.userId, membershipCount: 0, organizationShortNames: [] };
    entry.membershipCount += 1;
    // Only current memberships earn a badge. A terminated one is history the
    // detail read shows in full; on a list row it would read as current.
    if (row.status === 'active' && !entry.organizationShortNames.includes(row.shortName)) {
      entry.organizationShortNames.push(row.shortName);
    }
    out.set(row.userId, entry);
  }
  return out;
}

export async function findAdminUser(
  db: Database,
  userId: string,
): Promise<AdminUserDetailRow | null> {
  const rows = await db
    .select({
      ...LIST_COLUMNS,
      lastLoginIp: sql<string | null>`${userAccount.lastLoginIp}::text`,
      lockedUntil: userAccount.lockedUntil,
      updatedAt: userAccount.updatedAt,
    })
    .from(userAccount)
    .where(eq(userAccount.id, userId))
    .limit(1);

  return (rows[0] as AdminUserDetailRow | undefined) ?? null;
}

export interface AdminMembershipRow {
  memberId: string;
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  organizationShortName: string;
  organizationCategory: string;
  organizationColor: string;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  isOrgLead: boolean;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
}

/**
 * One user's memberships, with roles and lead grants.
 *
 * Includes TERMINATED memberships. Employment history is preserved rather than
 * erased (engineering rules 24, 25), and "was this person ever in FIB" is a
 * question an administrator reviewing an account genuinely needs answered.
 */
export async function membershipsFor(
  db: Database,
  userId: string,
): Promise<AdminMembershipRow[]> {
  const members = await db
    .select({
      memberId: organizationMember.id,
      organizationId: organization.id,
      organizationKey: organization.key,
      organizationName: organization.name,
      organizationShortName: organization.shortName,
      organizationCategory: organization.category,
      organizationColor: organization.color,
      status: organizationMember.status,
      callsign: organizationMember.callsign,
      employeeNumber: organizationMember.employeeNumber,
      joinedAt: organizationMember.joinedAt,
      leftAt: organizationMember.leftAt,
    })
    .from(organizationMember)
    .innerJoin(organization, eq(organization.id, organizationMember.organizationId))
    .where(eq(organizationMember.userId, userId))
    .orderBy(organization.shortName);

  if (members.length === 0) return [];

  const memberIds = members.map((m) => m.memberId);
  const [roleRows, leadRows] = await Promise.all([
    db
      .select({
        memberId: memberRole.memberId,
        id: role.id,
        key: role.key,
        name: role.name,
        hierarchyLevel: role.hierarchyLevel,
      })
      .from(memberRole)
      .innerJoin(role, eq(role.id, memberRole.roleId))
      .where(inArray(memberRole.memberId, memberIds)),
    db
      .select({ organizationId: organizationLead.organizationId })
      .from(organizationLead)
      .where(and(
        eq(organizationLead.userId, userId),
        isNull(organizationLead.revokedAt),
      )),
  ]);

  const leadOrgs = new Set(leadRows.map((r) => r.organizationId));

  return members.map((m) => ({
    ...m,
    isOrgLead: leadOrgs.has(m.organizationId),
    roles: roleRows
      .filter((r) => r.memberId === m.memberId)
      .map(({ memberId: _memberId, ...rest }) => rest),
  }));
}

export async function capabilityGrantsFor(
  db: Database,
  userId: string,
): Promise<{ key: GlobalCapabilityKey; grantedAt: Date | string; grantedByName: string | null }[]> {
  /**
   * `created_at`, not `granted_at`.
   *
   * The schema declares the field as `grantedAt: createdAt()`, and the
   * `createdAt()` helper hardcodes the column name `created_at` — so the
   * TypeScript property and the database column have different names. The query
   * builder maps between them; raw SQL does not, and naming the property here
   * fails at runtime rather than at compile time.
   */
  const rows = await db.execute<{
    capability: string; granted_at: string; granter_name: string | null;
  }>(sql`
    SELECT ugr.capability,
           ugr.created_at AS granted_at,
           granter.display_name AS granter_name
    FROM user_global_role ugr
    LEFT JOIN user_account granter ON granter.id = ugr.granted_by
    WHERE ugr.user_id = ${userId}
    ORDER BY ugr.created_at
  `);

  return rows.map((r) => ({
    key: r.capability as GlobalCapabilityKey,
    grantedAt: r.granted_at,
    grantedByName: r.granter_name,
  }));
}

export async function activeSessionCount(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(session)
    .where(and(
      eq(session.userId, userId),
      isNull(session.revokedAt),
      sql`${session.expiresAt} > now()`,
    ));
  return rows[0]?.value ?? 0;
}

/**
 * Global administrators who can currently sign in, EXCLUDING one user.
 *
 * The lockout guard's input. Counting "everyone else who could still get in"
 * rather than "everyone" means the caller does not have to reason about whether
 * the target is inside or outside the number — which is exactly the off-by-one
 * that would make the guard let the last administrator through.
 *
 * Must be called inside the transaction that performs the change, so two
 * concurrent disables cannot each see one remaining.
 */
export async function countOtherEnabledGlobalAdmins(
  tx: Database,
  excludingUserId: string,
): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(userGlobalRole)
    .innerJoin(userAccount, eq(userAccount.id, userGlobalRole.userId))
    .where(and(
      eq(userGlobalRole.capability, 'global_admin'),
      sql`${userGlobalRole.userId} <> ${excludingUserId}`,
      eq(userAccount.status, 'active'),
    ));
  return rows[0]?.value ?? 0;
}

/** Holders of `global_admin` other than one user, regardless of account state. */
export async function countOtherGlobalAdminGrants(
  tx: Database,
  excludingUserId: string,
): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(userGlobalRole)
    .where(and(
      eq(userGlobalRole.capability, 'global_admin'),
      sql`${userGlobalRole.userId} <> ${excludingUserId}`,
    ));
  return rows[0]?.value ?? 0;
}
