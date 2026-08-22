import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  auditLog, memberRole, memberStatus, organizationMember, role, unit,
  userAccount, vehicle, type Database,
} from '@leoos/db';

/**
 * Personnel reads.
 *
 * Every query is filtered by `organizationId` in its WHERE clause. There is no
 * variant that spans organizations, so a missing scope check upstream cannot
 * turn into a cross-organization leak here.
 */

export interface PersonnelRow {
  memberId: string;
  userId: string;
  displayName: string;
  username: string;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
  hierarchyLevel: number;
  dutyStatus: string | null;
  unitCallsign: string | null;
  isOrgLead: boolean;
  joinedAt: string;
  leftAt: string | null;
}

export interface PersonnelFilters {
  search?: string;
  /** Membership status; `all` includes terminated. */
  status?: 'active' | 'on_leave' | 'suspended' | 'terminated' | 'all';
  roleId?: string;
  dutyStatus?: string;
  /** Inclusive hierarchy band. */
  minLevel?: number;
  maxLevel?: number;
  /**
   * Page window. Bounded at the route, because an unbounded roster is both a
   * denial-of-service surface and an unusable screen — a large organization
   * would otherwise ship every member on every request.
   */
  limit?: number;
  offset?: number;
}

export interface PersonnelPage {
  rows: PersonnelRow[];
  /** Total matching the filters, before the page window. */
  total: number;
}

const LEVEL_SQL = sql<number>`COALESCE((
  SELECT MAX(r.hierarchy_level) FROM member_role mr JOIN role r ON r.id = mr.role_id
  WHERE mr.member_id = ${organizationMember.id} AND r.deleted_at IS NULL), 0)::int`;

export async function listPersonnel(
  db: Database,
  organizationId: string,
  filters: PersonnelFilters = {},
): Promise<PersonnelPage> {
  const search = filters.search?.trim();
  const status = filters.status ?? 'active';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  // Built once and used by both the count and the page, so the two can never
  // describe different sets.
  const where = and(
    eq(organizationMember.organizationId, organizationId),
    status === 'all' ? undefined : eq(organizationMember.status, status),
    search
      ? or(
          sql`${userAccount.displayName} ILIKE ${'%' + search + '%'}`,
          sql`${userAccount.username}::text ILIKE ${'%' + search + '%'}`,
          sql`${organizationMember.callsign}::text ILIKE ${'%' + search + '%'}`,
          sql`${organizationMember.employeeNumber}::text ILIKE ${'%' + search + '%'}`,
        )
      : undefined,
    filters.dutyStatus ? eq(memberStatus.statusKey, filters.dutyStatus) : undefined,
    filters.roleId
      ? sql`EXISTS (SELECT 1 FROM member_role mr
            WHERE mr.member_id = ${organizationMember.id} AND mr.role_id = ${filters.roleId})`
      : undefined,
    filters.minLevel !== undefined ? sql`${LEVEL_SQL} >= ${filters.minLevel}` : undefined,
    filters.maxLevel !== undefined ? sql`${LEVEL_SQL} <= ${filters.maxLevel}` : undefined,
  );

  const totals = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .where(where);
  const total = Number(totals[0]?.total ?? 0);

  const rows = await db
    .select({
      memberId: organizationMember.id,
      userId: organizationMember.userId,
      displayName: userAccount.displayName,
      username: userAccount.username,
      status: organizationMember.status,
      callsign: organizationMember.callsign,
      employeeNumber: organizationMember.employeeNumber,
      joinedAt: organizationMember.joinedAt,
      leftAt: organizationMember.leftAt,
      dutyStatus: memberStatus.statusKey,
      unitCallsign: unit.callsign,
      hierarchyLevel: LEVEL_SQL,
      isOrgLead: sql<boolean>`EXISTS (
        SELECT 1 FROM organization_lead ol
        WHERE ol.user_id = ${organizationMember.userId}
          AND ol.organization_id = ${organizationId} AND ol.revoked_at IS NULL)`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .leftJoin(unit, eq(unit.id, memberStatus.unitId))
    .where(where)
    // Ordered by member id last so the sort is TOTAL: without a tie-break, two
    // members of the same rank and name could swap places between pages and one
    // of them would never be shown.
    .orderBy(desc(LEVEL_SQL), asc(userAccount.displayName), asc(organizationMember.id))
    .limit(limit)
    .offset(offset);

  if (rows.length === 0) return { rows: [], total };

  const memberIds = rows.map((r) => r.memberId);
  const roleRows = await db
    .select({
      memberId: memberRole.memberId,
      id: role.id, key: role.key, name: role.name, hierarchyLevel: role.hierarchyLevel,
    })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .where(and(
      sql`${memberRole.memberId} = ANY(${sql.raw(`ARRAY[${memberIds.map((i) => `'${i}'::uuid`).join(',')}]`)})`,
      isNull(role.deletedAt),
    ));

  return {
    total,
    rows: rows.map((r) => ({
      ...r,
      hierarchyLevel: Number(r.hierarchyLevel),
      joinedAt: r.joinedAt.toISOString(),
      leftAt: r.leftAt?.toISOString() ?? null,
      roles: roleRows
        .filter((rr) => rr.memberId === r.memberId)
        .map(({ memberId: _m, ...rest }) => rest)
        .sort((a, b) => b.hierarchyLevel - a.hierarchyLevel),
    })),
  };
}

export interface PersonnelProfile extends PersonnelRow {
  email: string;
  notes: string | null;
  organizationId: string;
  organizationName: string;
  hiredByName: string | null;
  terminatedByName: string | null;
  terminationReason: string | null;
  currentVehicle: { plate: string; displayName: string | null } | null;
  /**
   * The exceptions written against this person, as they STAND.
   *
   * Expired rows are excluded by the same predicate identity resolution uses, so
   * the screen cannot show an exception that is no longer in force. They are
   * kept in the table rather than deleted — an expired exception is a record of
   * something that was once approved, and the audit trail refers to it.
   */
  overrides: {
    permissionKey: string;
    effect: 'grant' | 'deny';
    reason: string;
    grantedByName: string | null;
    createdAt: string;
    expiresAt: string | null;
  }[];
  activity: {
    at: string;
    action: string;
    actorName: string | null;
    outcome: string;
    summary: string | null;
  }[];
}

/**
 * One member's full profile, including their recent audit activity.
 *
 * The activity list is read from `audit_log` rather than kept as a separate
 * feed, so it cannot disagree with the audit trail.
 */
export async function getPersonnelProfile(
  db: Database,
  organizationId: string,
  memberId: string,
): Promise<PersonnelProfile | null> {
  const rows = await db
    .select({
      memberId: organizationMember.id,
      userId: organizationMember.userId,
      displayName: userAccount.displayName,
      username: userAccount.username,
      email: userAccount.email,
      status: organizationMember.status,
      callsign: organizationMember.callsign,
      employeeNumber: organizationMember.employeeNumber,
      notes: organizationMember.notes,
      joinedAt: organizationMember.joinedAt,
      leftAt: organizationMember.leftAt,
      terminationReason: organizationMember.terminationReason,
      organizationId: organizationMember.organizationId,
      dutyStatus: memberStatus.statusKey,
      unitCallsign: unit.callsign,
      unitVehicleId: unit.vehicleId,
      hierarchyLevel: LEVEL_SQL,
      isOrgLead: sql<boolean>`EXISTS (
        SELECT 1 FROM organization_lead ol
        WHERE ol.user_id = ${organizationMember.userId}
          AND ol.organization_id = ${organizationId} AND ol.revoked_at IS NULL)`,
      organizationName: sql<string>`(
        SELECT o.name FROM organization o WHERE o.id = ${organizationMember.organizationId})`,
      hiredByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${organizationMember.hiredBy})`,
      terminatedByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${organizationMember.terminatedBy})`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .leftJoin(unit, eq(unit.id, memberStatus.unitId))
    // Scoped: a member id from another organization simply does not match.
    .where(and(
      eq(organizationMember.id, memberId),
      eq(organizationMember.organizationId, organizationId),
    ))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const roles = await db
    .select({ id: role.id, key: role.key, name: role.name, hierarchyLevel: role.hierarchyLevel })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .where(and(eq(memberRole.memberId, memberId), isNull(role.deletedAt)))
    .orderBy(desc(role.hierarchyLevel));

  let currentVehicle: PersonnelProfile['currentVehicle'] = null;
  if (row.unitVehicleId) {
    const v = await db
      .select({ plate: vehicle.plate, displayName: vehicle.displayName })
      .from(vehicle)
      .where(eq(vehicle.id, row.unitVehicleId))
      .limit(1);
    currentVehicle = v[0] ?? null;
  }

  const activity = await db
    .select({
      at: auditLog.occurredAt,
      action: auditLog.action,
      outcome: auditLog.outcome,
      actorName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${auditLog.actorUserId})`,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(or(
      and(eq(auditLog.entityType, 'organization_member'), eq(auditLog.entityId, memberId)),
      and(eq(auditLog.entityType, 'user_account'), eq(auditLog.entityId, row.userId)),
    ))
    .orderBy(desc(auditLog.occurredAt))
    .limit(30);

  const overrideRows = await db.execute<{
    permission_key: string;
    effect: 'grant' | 'deny';
    reason: string;
    granted_by_name: string | null;
    // `db.execute` returns driver values, and postgres-js hands back timestamps
    // as strings here rather than as Date objects — unlike the query builder,
    // which maps them. Typed as what actually arrives.
    created_at: string;
    expires_at: string | null;
  }>(sql`
    SELECT po.permission_key, po.effect, po.reason,
           u.display_name AS granted_by_name, po.created_at, po.expires_at
      FROM member_permission_override po
      LEFT JOIN user_account u ON u.id = po.granted_by
     WHERE po.member_id = ${memberId}
       AND (po.expires_at IS NULL OR po.expires_at > now())
     ORDER BY po.permission_key
  `);

  return {
    ...row,
    hierarchyLevel: Number(row.hierarchyLevel),
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
    roles,
    currentVehicle,
    overrides: overrideRows.map((o) => ({
      permissionKey: o.permission_key,
      effect: o.effect,
      reason: o.reason,
      grantedByName: o.granted_by_name,
      createdAt: new Date(o.created_at).toISOString(),
      expiresAt: o.expires_at === null ? null : new Date(o.expires_at).toISOString(),
    })),
    activity: activity.map((a) => {
      const md = (a.metadata ?? {}) as Record<string, unknown>;
      const parts: string[] = [];
      if (md.fromLevel !== undefined && md.toLevel !== undefined) {
        parts.push(`L${md.fromLevel} → L${md.toLevel}`);
      }
      if (typeof md.roleName === 'string') parts.push(md.roleName);
      if (typeof md.reason === 'string') parts.push(md.reason);
      return {
        at: a.at.toISOString(),
        action: a.action,
        actorName: a.actorName,
        outcome: a.outcome,
        summary: parts.length > 0 ? parts.join(' · ') : null,
      };
    }),
  };
}

/** Accounts with no membership here — the candidate pool for hiring. */
export async function listHireCandidates(
  db: Database,
  organizationId: string,
  search?: string,
): Promise<{ userId: string; displayName: string; username: string; email: string }[]> {
  const term = search?.trim();
  return db
    .select({
      userId: userAccount.id,
      displayName: userAccount.displayName,
      username: userAccount.username,
      email: userAccount.email,
    })
    .from(userAccount)
    .where(and(
      eq(userAccount.status, 'active'),
      sql`NOT EXISTS (
        SELECT 1 FROM organization_member om
        WHERE om.user_id = ${userAccount.id}
          AND om.organization_id = ${organizationId}
          AND om.status = 'active')`,
      term
        ? or(
            sql`${userAccount.displayName} ILIKE ${'%' + term + '%'}`,
            sql`${userAccount.username}::text ILIKE ${'%' + term + '%'}`,
            sql`${userAccount.email}::text ILIKE ${'%' + term + '%'}`,
          )
        : undefined,
    ))
    .orderBy(asc(userAccount.displayName))
    .limit(50);
}

/** Roles in this organization, with the level each one confers. */
export async function listAssignableRoles(
  db: Database,
  organizationId: string,
): Promise<{ id: string; key: string; name: string; hierarchyLevel: number; isDefault: boolean }[]> {
  return db
    .select({
      id: role.id, key: role.key, name: role.name,
      hierarchyLevel: role.hierarchyLevel, isDefault: role.isDefault,
    })
    .from(role)
    .where(and(eq(role.organizationId, organizationId), isNull(role.deletedAt)))
    .orderBy(desc(role.hierarchyLevel));
}


/**
 * Path-scope guard: is this member id actually in this organization?
 *
 * The mutating services derive scope from the target's own row and re-decide
 * under lock, so this is not the security boundary. It exists so that a member
 * id from another organization presented under this organization's path is
 * answered with 404 rather than silently succeeding for a global administrator
 * — the URL should mean what it says.
 */
export async function memberBelongsToOrganization(
  db: Database,
  organizationId: string,
  memberId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: organizationMember.id })
    .from(organizationMember)
    .where(and(
      eq(organizationMember.id, memberId),
      eq(organizationMember.organizationId, organizationId),
    ))
    .limit(1);
  return rows.length > 0;
}
