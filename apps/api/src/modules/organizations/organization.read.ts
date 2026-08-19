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

export async function listOrganizationMembers(
  db: Database,
  organizationId: string,
): Promise<OrganizationMemberRow[]> {
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
      roleName: sql<string | null>`(
        SELECT r.name FROM member_role mr JOIN role r ON r.id = mr.role_id
        WHERE mr.member_id = ${organizationMember.id} AND r.deleted_at IS NULL
        ORDER BY r.hierarchy_level DESC LIMIT 1)`,
      hierarchyLevel: sql<number>`COALESCE((
        SELECT MAX(r.hierarchy_level) FROM member_role mr JOIN role r ON r.id = mr.role_id
        WHERE mr.member_id = ${organizationMember.id} AND r.deleted_at IS NULL), 0)::int`,
      isLead: sql<boolean>`EXISTS (
        SELECT 1 FROM organization_lead ol
        WHERE ol.user_id = ${organizationMember.userId}
          AND ol.organization_id = ${organizationId}
          AND ol.revoked_at IS NULL)`,
    })
    .from(organizationMember)
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .where(eq(organizationMember.organizationId, organizationId))
    .orderBy(desc(sql`COALESCE((
      SELECT MAX(r.hierarchy_level) FROM member_role mr JOIN role r ON r.id = mr.role_id
      WHERE mr.member_id = ${organizationMember.id} AND r.deleted_at IS NULL), 0)`),
      asc(userAccount.displayName));

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
    .orderBy(asc(unit.callsign));

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
    .orderBy(asc(vehicle.plate));
}
