import 'server-only';
import type { OrganizationCategory } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Organization data access for the web tier.
 *
 * Thin pass-through to the API. Every call is scoped server-side by the API —
 * nothing here decides who may see what, and the organization id always travels
 * in the path so there is no body field for a client to rewrite.
 */

export interface OrganizationDto {
  id: string;
  key: string;
  name: string;
  shortName: string;
  description: string | null;
  category: OrganizationCategory;
  color: string;
  logoUrl: string | null;
  isActive: boolean;
  isArchived: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface OrganizationLeadDto {
  organizationId: string;
  userId: string;
  displayName: string;
  username: string;
  email: string;
  grantedAt: string;
  grantedBy: string | null;
}

export interface OrganizationStats {
  activeMembers: number;
  totalMembers: number;
  roles: number;
  activeUnits: number;
  fleetVehicles: number;
  leads: number;
}

export interface OrganizationCapabilities {
  canEdit: boolean;
  canManageLeads: boolean;
  canViewPersonnel: boolean;
  canViewRoles: boolean;
  canViewVehicles: boolean;
}

export interface OrganizationDetail {
  organization: OrganizationDto;
  stats: OrganizationStats;
  leads: OrganizationLeadDto[];
  capabilities: OrganizationCapabilities;
}

export interface OrgMemberRow {
  memberId: string; userId: string; displayName: string; username: string;
  status: string; callsign: string | null; employeeNumber: string | null;
  roleName: string | null; hierarchyLevel: number; dutyStatus: string | null;
  isLead: boolean; joinedAt: string;
}

export interface OrgRoleRow {
  id: string; key: string; name: string; description: string | null;
  hierarchyLevel: number; isDefault: boolean; isSystem: boolean;
  memberCount: number; permissionCount: number;
}

export interface OrgUnitRow {
  id: string; callsign: string; unitType: string; statusKey: string;
  memberCount: number; createdAt: string;
}

export interface OrgVehicleRow {
  id: string; plate: string; model: string; displayName: string | null;
  color: string | null; registrationStatus: string; isFleet: boolean;
}

export async function fetchOrganizations(includeArchived = false): Promise<OrganizationDto[]> {
  const res = await apiFetch<{ organizations: OrganizationDto[] }>(
    `/api/v1/organizations${includeArchived ? '?includeArchived=true' : ''}`,
  );
  return res.data?.organizations ?? [];
}

export async function fetchOrganizationDetail(id: string): Promise<OrganizationDetail | null> {
  const res = await apiFetch<OrganizationDetail>(`/api/v1/organizations/${id}`);
  return res.ok && res.data ? res.data : null;
}

/**
 * Section fetchers return an empty list when the API refuses.
 *
 * Each section is authorized independently, so a partial permission set yields a
 * partial page rather than a blanket error — the panel simply reports that it is
 * unavailable.
 */
export async function fetchOrgMembers(id: string): Promise<OrgMemberRow[] | null> {
  const res = await apiFetch<{ members: OrgMemberRow[] }>(`/api/v1/organizations/${id}/members`);
  return res.ok ? (res.data?.members ?? []) : null;
}

export async function fetchOrgRoles(id: string): Promise<OrgRoleRow[] | null> {
  const res = await apiFetch<{ roles: OrgRoleRow[] }>(`/api/v1/organizations/${id}/roles`);
  return res.ok ? (res.data?.roles ?? []) : null;
}

export async function fetchOrgUnits(id: string): Promise<OrgUnitRow[] | null> {
  const res = await apiFetch<{ units: OrgUnitRow[] }>(`/api/v1/organizations/${id}/units`);
  return res.ok ? (res.data?.units ?? []) : null;
}

export async function fetchOrgVehicles(id: string): Promise<OrgVehicleRow[] | null> {
  const res = await apiFetch<{ vehicles: OrgVehicleRow[] }>(`/api/v1/organizations/${id}/vehicles`);
  return res.ok ? (res.data?.vehicles ?? []) : null;
}

export interface LeadCandidate {
  userId: string; displayName: string; username: string; roleName: string | null;
}

export async function fetchLeadCandidates(id: string): Promise<LeadCandidate[]> {
  const res = await apiFetch<{ candidates: LeadCandidate[] }>(
    `/api/v1/organizations/${id}/lead-candidates`,
  );
  return res.ok ? (res.data?.candidates ?? []) : [];
}
