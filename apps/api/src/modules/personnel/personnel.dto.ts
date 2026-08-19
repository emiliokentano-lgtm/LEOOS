import type { PersonnelProfile, PersonnelRow } from './personnel.read.js';

/**
 * Personnel DTOs — the serialization boundary (engineering rule 16).
 *
 * Personnel rows join `user_account`, which is the table that holds
 * `password_hash` and `totp_secret_enc`. Nothing here spreads a row: every field
 * is named, so widening the underlying SELECT can never widen the response.
 *
 * `email` is deliberately absent from the LIST shape and present only on the
 * profile, which requires `personnel.view` on a specific member.
 */

export interface PersonnelRoleDto {
  id: string;
  key: string;
  name: string;
  hierarchyLevel: number;
}

export interface PersonnelListItemDto {
  memberId: string;
  userId: string;
  displayName: string;
  username: string;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roles: PersonnelRoleDto[];
  hierarchyLevel: number;
  rankName: string | null;
  dutyStatus: string | null;
  unitCallsign: string | null;
  isOrgLead: boolean;
  joinedAt: string;
  leftAt: string | null;
  /**
   * Whether the CALLER outranks this member. Cosmetic only — it drives the lock
   * affordance in the UI, and every mutation re-decides server-side
   * (engineering rule 9).
   */
  manageable: boolean;
}

/** Highest-level role held, which is what "rank" means operationally. */
function rankName(roles: readonly PersonnelRoleDto[]): string | null {
  let best: PersonnelRoleDto | null = null;
  for (const r of roles) {
    if (best === null || r.hierarchyLevel > best.hierarchyLevel) best = r;
  }
  return best?.name ?? null;
}

export interface ViewerContext {
  userId: string;
  level: number;
  isOrgLead: boolean;
  isGlobalAdmin: boolean;
}

/**
 * Mirrors `canManageMember` for display purposes.
 *
 * It is a copy of the kernel's shape rather than a call into it because the list
 * has no `TargetContext` to hand and building one per row would be misleading:
 * this value is a hint, not a decision. Should the two ever drift, the kernel is
 * the one that governs — the worst outcome here is a button that turns out to be
 * refused.
 */
function isManageable(viewer: ViewerContext, row: PersonnelRow): boolean {
  if (viewer.isGlobalAdmin) return true;
  if (viewer.userId === row.userId) return false;
  if (row.isOrgLead) return false;
  if (viewer.isOrgLead) return true;
  if (row.status !== 'active') return false;
  return viewer.level > row.hierarchyLevel;
}

export function toPersonnelListItemDto(
  row: PersonnelRow,
  viewer: ViewerContext,
): PersonnelListItemDto {
  const roles = row.roles.map(toRoleDto);
  return {
    memberId: row.memberId,
    userId: row.userId,
    displayName: row.displayName,
    username: row.username,
    status: row.status,
    callsign: row.callsign,
    employeeNumber: row.employeeNumber,
    roles,
    hierarchyLevel: row.hierarchyLevel,
    rankName: rankName(roles),
    dutyStatus: row.dutyStatus,
    unitCallsign: row.unitCallsign,
    isOrgLead: row.isOrgLead,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    manageable: isManageable(viewer, row),
  };
}

function toRoleDto(r: { id: string; key: string; name: string; hierarchyLevel: number }): PersonnelRoleDto {
  return { id: r.id, key: r.key, name: r.name, hierarchyLevel: r.hierarchyLevel };
}

export interface PersonnelActivityDto {
  at: string;
  action: string;
  actorName: string | null;
  outcome: string;
  summary: string | null;
}

export interface PersonnelProfileDto extends PersonnelListItemDto {
  email: string;
  notes: string | null;
  organizationId: string;
  organizationName: string;
  hiredByName: string | null;
  terminatedByName: string | null;
  terminationReason: string | null;
  currentVehicle: { plate: string; displayName: string | null } | null;
  activity: PersonnelActivityDto[];
}

export function toPersonnelProfileDto(
  row: PersonnelProfile,
  viewer: ViewerContext,
): PersonnelProfileDto {
  return {
    ...toPersonnelListItemDto(row, viewer),
    email: row.email,
    notes: row.notes,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    hiredByName: row.hiredByName,
    terminatedByName: row.terminatedByName,
    terminationReason: row.terminationReason,
    currentVehicle: row.currentVehicle
      ? { plate: row.currentVehicle.plate, displayName: row.currentVehicle.displayName }
      : null,
    activity: row.activity.map((a) => ({
      at: a.at,
      action: a.action,
      actorName: a.actorName,
      outcome: a.outcome,
      summary: a.summary,
    })),
  };
}

/**
 * What the caller may do in THIS organization's personnel screen.
 *
 * Every flag is a permission the API re-checks on the corresponding route. The
 * UI uses them to decide what to render, never to decide what is allowed.
 */
export interface PersonnelCapabilitiesDto {
  canHire: boolean;
  canFire: boolean;
  canPromote: boolean;
  canDemote: boolean;
  canAssignRoles: boolean;
  canEdit: boolean;
  canSetCallsign: boolean;
  /** The caller's own ceiling, so the UI can grey out roles it knows are refused. */
  actorLevel: number | 'unbounded';
  actorUserId: string;
}
