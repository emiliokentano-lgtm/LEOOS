import 'server-only';
import { apiFetch } from './api-client';

/**
 * Vehicle data access for the web tier. Thin pass-through, permission-gated by
 * the API — see lib/persons.ts for the reasoning about the shared registers.
 */

export interface VehicleListItem {
  id: string;
  plate: string;
  model: string;
  displayName: string | null;
  color: string | null;
  vehicleClass: string | null;
  registrationStatus: string;
  insuranceStatus: string;
  isFleet: boolean;
  ownerPersonId: string | null;
  ownerName: string | null;
  ownerOrganizationId: string | null;
  ownerOrganizationKey: string | null;
  ownerOrganizationColor: string | null;
  flagCount: number;
  ownerHasWarrant: boolean;
  isArchived: boolean;
  createdAt: string;
  /** Cosmetic: false for another organization's fleet. The API re-decides. */
  manageable: boolean;
  lockedReason: string | null;
}

export interface VehicleCapabilities {
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canManageFlags: boolean;
  canViewArchived: boolean;
  actorOrganizationId: string | null;
}

export interface VehicleList {
  vehicles: VehicleListItem[];
  total: number;
  limit: number;
  offset: number;
  capabilities: VehicleCapabilities;
}

export interface VehicleFlag {
  id: string; type: string; note: string | null;
  createdAt: string; createdByName: string | null; resolvedAt: string | null;
}

export interface VehicleHistoryEntry {
  at: string; action: string; actorName: string | null;
  outcome: string; summary: string | null;
}

export interface VehicleProfile {
  vehicle: VehicleListItem & {
    notes: string | null;
    archivedReason: string | null;
    updatedAt: string;
    createdByName: string | null;
    ownerStatus: string | null;
    ownerPhone: string | null;
    ownerOrganizationName: string | null;
  };
  flags: VehicleFlag[];
  history: VehicleHistoryEntry[];
  capabilities: {
    canEdit: boolean;
    canArchive: boolean;
    canRestore: boolean;
    canManageFlags: boolean;
  };
}

export interface VehicleFilters {
  search?: string;
  registrationStatus?: string;
  insuranceStatus?: string;
  onlyFleet?: string;
  onlyFlagged?: string;
  includeArchived?: string;
  limit?: string;
  offset?: string;
}

export async function fetchVehicles(filters: VehicleFilters = {}): Promise<VehicleList | null> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const res = await apiFetch<VehicleList>(`/api/v1/vehicles${suffix}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchVehicleProfile(vehicleId: string): Promise<VehicleProfile | null> {
  const res = await apiFetch<VehicleProfile>(`/api/v1/vehicles/${vehicleId}`);
  return res.ok && res.data ? res.data : null;
}

export interface OwnerCandidate { id: string; name: string; dateOfBirth: string | null }

/** Searched, never listed whole — the person register is the largest table. */
export async function searchOwners(term: string): Promise<OwnerCandidate[]> {
  if (term.trim().length === 0) return [];
  const res = await apiFetch<{ candidates: OwnerCandidate[] }>(
    `/api/v1/vehicles/owner-candidates?search=${encodeURIComponent(term)}`,
  );
  return res.ok ? (res.data?.candidates ?? []) : [];
}

export interface OrganizationOption { id: string; key: string; name: string; color: string }

export async function fetchOrganizationOptions(): Promise<OrganizationOption[]> {
  const res = await apiFetch<{ organizations: OrganizationOption[] }>(
    '/api/v1/vehicles/organizations',
  );
  return res.ok ? (res.data?.organizations ?? []) : [];
}
