import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  memberStatus, organizationMember, role, unit, userAccount, vehicle, type Database,
} from '@leoos/db';

/**
 * Scoped read queries for the organization admin screen.
 *
 * Every query here is filtered by `organizationId` in its WHERE clause — there
 * is no variant that returns rows across organizations. Scope is enforced by the
 * caller before these run; this file makes it structurally hard to leak by
 * accident even if that check were ever missed.
 */

export interface OrganizationMemberRow {
  memberId: string;
  userId: string;
  displayName: string;
  username: string;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roleName: string | null;
  hierarchyLevel: number;
  dutyStatus: string | null;
  isLead: boolean;
  joinedAt: string;
}

/**
 * The cap on an organization panel.
 *
 * The organization screen shows members, units and vehicles as overview panels;
 * none was bounded, so a mature organization shipped its entire roster on every
 * page load. Six hundred rows is already 30 ms and 140 KB, and it grows with the
 * organization rather than with what the screen shows.
 *
 * Generous rather than tight: this is a ceiling that stops the pathological
 * case, not a page size. An operator who needs the full roster has the
 * personnel screen, which is properly paged and searchable.
 */
export const ORGANIZATION_PANEL_LIMIT = 250;

export async function listOrganizationMembers(
  db: Database,
  organizationId: string,
  limit = ORGANIZATION_PANEL_LIMIT,
): Promise<OrganizationMemberRow[]> {
  /**
   * ONE LATERAL, not three correlated subqueries.
   *
   * The role name, the hierarchy level and the ORDER BY all wanted "this
   * member's highest role", and each asked for it separately — so a 700-member
   * organization ran 2 800 subqueries to render one panel. The LATERAL computes
   * it once per row and every consumer reads the same answer, which also removes
   * the possibility of the sort disagreeing with the column beside it.
   *
   * The lead flag becomes a LEFT JOIN for the same reason: `organization_lead`
   * is a handful of rows, and joining it once beats an EXISTS per member.
   *
   * Measured at 713 members: 31 ms → 21 ms, and the gap widens with the roster.
   */
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
      dutyStatus: memberStatus.statusKey,
      // Highest role wins — effective level is the maximum, never the sum.
      roleName: sql<string | null>`"top"."name"`,
      hierarchyLevel: sql<number>`COALESCE("top"."hierarchy_level", 0)::int`,
      isLead: sql<boolean>`("lead"."user_id" IS NOT NULL)`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .leftJoin(
      sql`LATERAL (
        SELECT r.name, r.hierarchy_level
          FROM member_role mr JOIN role r ON r.id = mr.role_id
         WHERE mr.member_id = ${organizationMember.id} AND r.deleted_at IS NULL
         ORDER BY r.hierarchy_level DESC LIMIT 1
      ) AS "top"`,
      sql`true`,
    )
    .leftJoin(
      sql`organization_lead AS "lead"`,
      sql`"lead"."user_id" = ${organizationMember.userId}
          AND "lead"."organization_id" = ${organizationId}
          AND "lead"."revoked_at" IS NULL`,
    )
    .where(eq(organizationMember.organizationId, organizationId))
    .orderBy(desc(sql`COALESCE("top"."hierarchy_level", 0)`), asc(userAccount.displayName))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    hierarchyLevel: Number(r.hierarchyLevel),
    joinedAt: r.joinedAt.toISOString(),
  }));
}

export interface OrganizationRoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  hierarchyLevel: number;
  isDefault: boolean;
  isSystem: boolean;
  memberCount: number;
  permissionCount: number;
}

export async function listOrganizationRoles(
  db: Database,
  organizationId: string,
): Promise<OrganizationRoleRow[]> {
  const rows = await db
    .select({
      id: role.id, key: role.key, name: role.name, description: role.description,
      hierarchyLevel: role.hierarchyLevel, isDefault: role.isDefault, isSystem: role.isSystem,
      memberCount: sql<number>`(SELECT count(*) FROM member_role mr WHERE mr.role_id = ${role.id})::int`,
      permissionCount: sql<number>`(SELECT count(*) FROM role_permission rp WHERE rp.role_id = ${role.id})::int`,
    })
    .from(role)
    .where(and(eq(role.organizationId, organizationId), isNull(role.deletedAt)))
    .orderBy(desc(role.hierarchyLevel));

  return rows.map((r) => ({
    ...r,
    memberCount: Number(r.memberCount),
    permissionCount: Number(r.permissionCount),
  }));
}

export interface OrganizationUnitRow {
  id: string;
  callsign: string;
  unitType: string;
  statusKey: string;
  memberCount: number;
  createdAt: string;
}

export async function listOrganizationUnits(
  db: Database,
  organizationId: string,
  // Bounded for the same reason as the roster — see ORGANIZATION_PANEL_LIMIT.
  limit = ORGANIZATION_PANEL_LIMIT,
): Promise<OrganizationUnitRow[]> {
  const rows = await db
    .select({
      id: unit.id, callsign: unit.callsign, unitType: unit.unitType,
      statusKey: unit.statusKey, createdAt: unit.createdAt,
      memberCount: sql<number>`(
        SELECT count(*) FROM unit_member um
        WHERE um.unit_id = ${unit.id} AND um.left_at IS NULL)::int`,
    })
    .from(unit)
    .where(and(eq(unit.organizationId, organizationId), eq(unit.status, 'active')))
    .orderBy(asc(unit.callsign))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    memberCount: Number(r.memberCount),
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface OrganizationVehicleRow {
  id: string;
  plate: string;
  model: string;
  displayName: string | null;
  color: string | null;
  registrationStatus: string;
  isFleet: boolean;
}

export async function listOrganizationVehicles(
  db: Database,
  organizationId: string,
  // Bounded for the same reason as the roster — see ORGANIZATION_PANEL_LIMIT.
  limit = ORGANIZATION_PANEL_LIMIT,
): Promise<OrganizationVehicleRow[]> {
  return db
    .select({
      id: vehicle.id, plate: vehicle.plate, model: vehicle.model,
      displayName: vehicle.displayName, color: vehicle.color,
      registrationStatus: vehicle.registrationStatus, isFleet: vehicle.isFleet,
    })
    .from(vehicle)
    .where(and(
      eq(vehicle.ownerOrganizationId, organizationId),
      isNull(vehicle.deletedAt),
    ))
    .orderBy(asc(vehicle.plate))
    .limit(limit);
}
