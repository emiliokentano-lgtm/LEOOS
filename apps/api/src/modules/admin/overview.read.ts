import { count, eq, isNull, sql } from 'drizzle-orm';
import {
  auditLog, organization, userAccount, type Database,
} from '@leoos/db';
import {
  PERMISSION_KEYS, isGlobalPermission, permissionMeta,
  type OrganizationCategory, type OrganizationSummary,
  type PermissionKey, type PermissionOverview, type PermissionOverviewEntry,
  type PermissionRoleGrant,
} from '@leoos/contracts';

/**
 * The cross-cutting admin reads: leads, the permission overview, system scale.
 */

// ── Organization leads, across every organization ──────────────────────────

export type LeadRow = {
  userId: string;
  username: string;
  displayName: string;
  accountStatus: string;
  membershipStatus: string;
  callsign: string | null;
  /** Raw `sql` projection — a string, not a Date. */
  grantedAt: string;
  grantedByName: string | null;
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  organizationShortName: string;
  organizationCategory: string;
  organizationColor: string;
};

/**
 * Every current lead, in ONE query.
 *
 * The organization admin screen used to fetch these per organization, which is
 * a request per agency for a list that is six rows long — and which grew a
 * request every time somebody added an organization. Authorization is unchanged
 * by collapsing it: this endpoint is gated on a global capability, so there is
 * no per-organization scope for the loop to have been enforcing.
 *
 * The membership join is INNER on purpose. A lead grant requires an active
 * membership (a database trigger enforces it), so a lead row with no membership
 * would be a data fault — and showing it as a lead of an organization they no
 * longer belong to would be worse than not showing it.
 */
export async function listAllLeads(db: Database): Promise<LeadRow[]> {
  return db.execute<LeadRow>(sql`
    SELECT ol.user_id                AS "userId",
           u.username,
           u.display_name            AS "displayName",
           u.status::text            AS "accountStatus",
           m.status::text            AS "membershipStatus",
           m.callsign,
           -- created_at, not granted_at: the schema declares the field with
           -- the createdAt() helper, which hardcodes that column name.
           ol.created_at             AS "grantedAt",
           granter.display_name      AS "grantedByName",
           o.id                      AS "organizationId",
           o.key                     AS "organizationKey",
           o.name                    AS "organizationName",
           o.short_name              AS "organizationShortName",
           o.category::text          AS "organizationCategory",
           o.color                   AS "organizationColor"
    FROM organization_lead ol
    JOIN user_account u        ON u.id = ol.user_id
    JOIN organization o        ON o.id = ol.organization_id
    JOIN organization_member m ON m.user_id = ol.user_id
                              AND m.organization_id = ol.organization_id
    LEFT JOIN user_account granter ON granter.id = ol.granted_by
    WHERE ol.revoked_at IS NULL
      AND o.deleted_at IS NULL
    ORDER BY o.short_name, u.display_name
  `);
}

export async function listActiveOrganizations(db: Database): Promise<OrganizationSummary[]> {
  const rows = await db
    .select({
      id: organization.id,
      key: organization.key,
      name: organization.name,
      shortName: organization.shortName,
      category: organization.category,
      color: organization.color,
    })
    .from(organization)
    .where(isNull(organization.deletedAt))
    .orderBy(organization.shortName);

  return rows.map((r) => ({ ...r, category: r.category as OrganizationCategory }));
}

// ── Permission overview ────────────────────────────────────────────────────

type RoleGrantRow = {
  permissionKey: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  hierarchyLevel: number;
  organizationId: string | null;
  organizationKey: string | null;
  organizationName: string | null;
  organizationShortName: string | null;
  organizationCategory: string | null;
  organizationColor: string | null;
  memberCount: number;
};

type OverrideCountRow = {
  permissionKey: string;
  effect: string;
  value: number;
};

/**
 * Where every permission is actually in force.
 *
 * The catalogue on its own answers "what permissions exist", which nobody asks.
 * The question an administrator has is "who can terminate members right now",
 * and that is a join: permission → roles that grant it → members holding those
 * roles. Two queries, aggregated in memory, rather than one query per
 * permission — there are eighty of them.
 *
 * Member counts count ACTIVE members only. A terminated member holds nothing
 * (their permission set is emptied at the source), so including them would
 * inflate every figure on the screen with people who cannot use it.
 */
export async function buildPermissionOverview(db: Database): Promise<PermissionOverview> {
  const [grants, overrides, organizations] = await Promise.all([
    db.execute<RoleGrantRow>(sql`
      SELECT rp.permission_key       AS "permissionKey",
             r.id                    AS "roleId",
             r.key                   AS "roleKey",
             r.name                  AS "roleName",
             r.hierarchy_level       AS "hierarchyLevel",
             o.id                    AS "organizationId",
             o.key                   AS "organizationKey",
             o.name                  AS "organizationName",
             o.short_name            AS "organizationShortName",
             o.category::text        AS "organizationCategory",
             o.color                 AS "organizationColor",
             COALESCE(mc.members, 0)::int AS "memberCount"
      FROM role_permission rp
      JOIN role r ON r.id = rp.role_id
      LEFT JOIN organization o ON o.id = r.organization_id
      LEFT JOIN (
        SELECT mr.role_id, count(*)::int AS members
        FROM member_role mr
        JOIN organization_member m ON m.id = mr.member_id
        WHERE m.status = 'active'
        GROUP BY mr.role_id
      ) mc ON mc.role_id = r.id
      -- Roles are deactivated with is_active, not soft-deleted with a
      -- timestamp. An inactive role grants nothing, so counting it would put
      -- permissions on this screen that nobody actually holds.
      WHERE r.is_active = true
      ORDER BY rp.permission_key, o.short_name NULLS FIRST, r.hierarchy_level DESC
    `),
    db.execute<OverrideCountRow>(sql`
      SELECT po.permission_key AS "permissionKey",
             po.effect::text   AS effect,
             count(*)::int     AS value
      FROM member_permission_override po
      JOIN organization_member m ON m.id = po.member_id
      WHERE m.status = 'active'
        -- An expired override grants nothing, so counting it would put people
        -- on this screen who cannot use the permission it names.
        AND (po.expires_at IS NULL OR po.expires_at > now())
      GROUP BY po.permission_key, po.effect
    `),
    listActiveOrganizations(db),
  ]);

  const grantsByKey = new Map<string, PermissionRoleGrant[]>();
  for (const row of grants) {
    const list = grantsByKey.get(row.permissionKey) ?? [];
    list.push({
      roleId: row.roleId,
      roleKey: row.roleKey,
      roleName: row.roleName,
      hierarchyLevel: row.hierarchyLevel,
      organization: row.organizationId && row.organizationKey
        ? {
            id: row.organizationId,
            key: row.organizationKey,
            name: row.organizationName ?? row.organizationKey,
            shortName: row.organizationShortName ?? row.organizationKey,
            category: (row.organizationCategory ?? 'other') as OrganizationCategory,
            color: row.organizationColor ?? '#64748b',
          }
        : null,
      memberCount: row.memberCount,
    });
    grantsByKey.set(row.permissionKey, list);
  }

  const overrideCounts = new Map<string, { grant: number; deny: number }>();
  for (const row of overrides) {
    const entry = overrideCounts.get(row.permissionKey) ?? { grant: 0, deny: 0 };
    if (row.effect === 'grant') entry.grant = row.value;
    if (row.effect === 'deny') entry.deny = row.value;
    overrideCounts.set(row.permissionKey, entry);
  }

  /**
   * Built from the CATALOGUE, not from the rows.
   *
   * Iterating the grant rows would list only permissions somebody happens to
   * have assigned, and the interesting entries on this screen are the empty
   * ones: a high-risk permission no role grants is a fact worth seeing, and it
   * would be invisible if the screen were assembled from what exists.
   */
  const entries: PermissionOverviewEntry[] = PERMISSION_KEYS.map((key) => {
    const meta = permissionMeta(key);
    const counts = overrideCounts.get(key) ?? { grant: 0, deny: 0 };
    return {
      key,
      label: meta.label,
      category: meta.category,
      risk: meta.risk,
      scope: meta.scope ?? 'organization',
      grants: grantsByKey.get(key) ?? [],
      overrideGrantCount: counts.grant,
      overrideDenyCount: counts.deny,
    };
  });

  return {
    entries,
    organizations,
    globalPermissionKeys: PERMISSION_KEYS.filter(isGlobalPermission) as PermissionKey[],
  };
}

// ── System scale ───────────────────────────────────────────────────────────

export async function systemScale(db: Database): Promise<{
  users: number;
  activeUsers: number;
  organizations: number;
  auditEntries: number;
}> {
  const [users, activeUsers, orgs, audit] = await Promise.all([
    db.select({ value: count() }).from(userAccount),
    db.select({ value: count() }).from(userAccount).where(eq(userAccount.status, 'active')),
    db.select({ value: count() }).from(organization).where(isNull(organization.deletedAt)),
    /**
     * An ESTIMATE, and labelled as one in the DTO.
     *
     * `count(*)` over an append-only log that grows forever is a sequential
     * scan for a number that is stale before it renders. The planner's estimate
     * is the right precision for "how big is this installation".
     */
    db.execute<{ value: number }>(sql`
      SELECT COALESCE(
        (SELECT reltuples::bigint FROM pg_class WHERE oid = 'audit_log'::regclass),
        0
      )::int AS value
    `),
  ]);

  return {
    users: users[0]?.value ?? 0,
    activeUsers: activeUsers[0]?.value ?? 0,
    organizations: orgs[0]?.value ?? 0,
    auditEntries: Math.max(audit[0]?.value ?? 0, 0),
  };
}

/** Rows present in the audit log, so the system screen can say if it is empty. */
export async function auditLogIsEmpty(db: Database): Promise<boolean> {
  const rows = await db.select({ value: count() }).from(auditLog).limit(1);
  return (rows[0]?.value ?? 0) === 0;
}
