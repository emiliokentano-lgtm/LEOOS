import 'server-only';
import type { PermissionKey } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Role data access for the web tier.
 *
 * A thin pass-through. The organization id travels in the PATH, and the API
 * decides scope from the caller's own membership — nothing here filters, hides
 * or authorizes anything (ADR-0001, engineering rule 9).
 */

export interface RoleCapabilities {
  canEdit: boolean;
  canEditPermissions: boolean;
  canDelete: boolean;
  canAssign: boolean;
  lockedReason: string | null;
}

export interface RoleDto {
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
  capabilities: RoleCapabilities;
}

export interface RoleScreenCapabilities {
  canCreate: boolean;
  canEdit: boolean;
  canEditPermissions: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canAssign: boolean;
  canReorder: boolean;
  actorLevel: number | 'unbounded';
}

export interface RoleList {
  roles: RoleDto[];
  archivedCount: number;
  capabilities: RoleScreenCapabilities;
}

export interface PermissionOption {
  key: PermissionKey;
  label: string;
  category: string;
  risk: string;
  scope: string;
  organizationScoped: boolean;
  /** Whether THIS caller may hand the permission out (H4). */
  grantable: boolean;
}

export interface PermissionCatalogue {
  categories: { category: string; permissions: PermissionOption[] }[];
}

export interface RoleHolder {
  memberId: string;
  userId: string;
  displayName: string;
  callsign: string | null;
  status: string;
}

const basePath = (organizationId: string) =>
  `/api/v1/organizations/${organizationId}/roles`;

/**
 * Returns null when the API refuses.
 *
 * Out of scope is a 404 there, so "refused" and "no such organization" are
 * indistinguishable from here — which is the point.
 */
export async function fetchRoles(
  organizationId: string,
  includeArchived = false,
): Promise<RoleList | null> {
  const res = await apiFetch<RoleList>(
    `${basePath(organizationId)}${includeArchived ? '?includeArchived=true' : ''}`,
  );
  return res.ok && res.data ? res.data : null;
}

/**
 * The permission catalogue, served by the API rather than imported here.
 *
 * The browser must not be the source of truth for which permissions exist: a
 * bundled copy can drift from the deployed server, and the editor would then
 * offer a checkbox the server refuses.
 */
export async function fetchPermissionCatalogue(
  organizationId: string,
): Promise<PermissionCatalogue | null> {
  const res = await apiFetch<PermissionCatalogue>(`${basePath(organizationId)}/permissions`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchRoleDetail(
  organizationId: string,
  roleId: string,
): Promise<{ role: RoleDto; holders: RoleHolder[] } | null> {
  const res = await apiFetch<{ role: RoleDto; holders: RoleHolder[] }>(
    `${basePath(organizationId)}/${roleId}`,
  );
  return res.ok && res.data ? res.data : null;
}
