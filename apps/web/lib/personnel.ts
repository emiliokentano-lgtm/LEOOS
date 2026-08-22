import 'server-only';
import { apiFetch } from './api-client';

/**
 * Personnel data access for the web tier.
 *
 * A thin pass-through. The organization id always travels in the PATH, and the
 * API decides scope from the caller's own membership — nothing here filters,
 * hides or authorizes anything (ADR-0001, engineering rule 9).
 */

export interface PersonnelRole {
  id: string;
  key: string;
  name: string;
  hierarchyLevel: number;
}

export interface PersonnelListItem {
  memberId: string;
  userId: string;
  displayName: string;
  username: string;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roles: PersonnelRole[];
  hierarchyLevel: number;
  rankName: string | null;
  dutyStatus: string | null;
  unitCallsign: string | null;
  isOrgLead: boolean;
  joinedAt: string;
  leftAt: string | null;
  /** Cosmetic hint from the API; the server re-decides every action. */
  manageable: boolean;
}

export interface PersonnelActivity {
  at: string;
  action: string;
  actorName: string | null;
  outcome: string;
  summary: string | null;
}

export interface PersonnelProfile extends PersonnelListItem {
  email: string;
  notes: string | null;
  organizationId: string;
  organizationName: string;
  hiredByName: string | null;
  terminatedByName: string | null;
  terminationReason: string | null;
  currentVehicle: { plate: string; displayName: string | null } | null;
  overrides: PersonnelOverride[];
  activity: PersonnelActivity[];
}

/** One standing exception to what the member's roles say. */
export interface PersonnelOverride {
  permissionKey: string;
  effect: 'grant' | 'deny';
  reason: string;
  grantedByName: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface PersonnelCapabilities {
  canHire: boolean;
  canFire: boolean;
  canPromote: boolean;
  canDemote: boolean;
  canAssignRoles: boolean;
  canEdit: boolean;
  canSetCallsign: boolean;
  canSetOverrides: boolean;
  /** What the CALLER may hand out — their own ceiling, never the target's. */
  grantablePermissions: string[];
  actorLevel: number | 'unbounded';
  actorUserId: string;
}

export interface AssignableRole extends PersonnelRole {
  isDefault: boolean;
}

export interface HireCandidate {
  userId: string;
  displayName: string;
  username: string;
  email: string;
}

export interface PersonnelFilters {
  search?: string;
  status?: string;
  roleId?: string;
  dutyStatus?: string;
  limit?: string;
  offset?: string;
}

const basePath = (organizationId: string) =>
  `/api/v1/organizations/${organizationId}/personnel`;

export interface PersonnelRoster {
  personnel: PersonnelListItem[];
  /** Total matching the filters, before the page window. */
  total: number;
  limit: number;
  offset: number;
  capabilities: PersonnelCapabilities;
}

/**
 * Returns null when the API refuses.
 *
 * Out of scope is a 404 there, so "refused" and "no such organization" are
 * indistinguishable from here — which is the point. The screen reports that
 * personnel are unavailable rather than confirming anything.
 */
export async function fetchPersonnel(
  organizationId: string,
  filters: PersonnelFilters = {},
): Promise<PersonnelRoster | null> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const res = await apiFetch<PersonnelRoster>(`${basePath(organizationId)}${suffix}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchPersonnelProfile(
  organizationId: string,
  memberId: string,
): Promise<PersonnelProfile | null> {
  const res = await apiFetch<{ member: PersonnelProfile }>(
    `${basePath(organizationId)}/${memberId}`,
  );
  return res.ok && res.data ? res.data.member : null;
}

export async function fetchAssignableRoles(organizationId: string): Promise<AssignableRole[]> {
  const res = await apiFetch<{ roles: AssignableRole[] }>(`${basePath(organizationId)}/roles`);
  return res.ok ? (res.data?.roles ?? []) : [];
}

/** Empty when the caller may not hire — enumerating accounts needs that permission. */
export async function fetchHireCandidates(
  organizationId: string,
  search?: string,
): Promise<HireCandidate[]> {
  const suffix = search ? `?search=${encodeURIComponent(search)}` : '';
  const res = await apiFetch<{ candidates: HireCandidate[] }>(
    `${basePath(organizationId)}/candidates${suffix}`,
  );
  return res.ok ? (res.data?.candidates ?? []) : [];
}
