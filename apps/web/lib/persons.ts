import 'server-only';
import { apiFetch } from './api-client';

/**
 * Person data access for the web tier.
 *
 * A thin pass-through. The register is shared across organizations and gated by
 * permission, so there is no organization id in any path here — the API decides
 * what this caller may see from their own membership (ADR-0001, rule 9).
 */

export interface PersonListItem {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  address: string | null;
  status: string;
  isDeceased: boolean;
  aliases: string[];
  flagCount: number;
  highestFlagSeverity: string | null;
  activeWarrants: number;
  vehicleCount: number;
  isArchived: boolean;
  createdAt: string;
}

export interface PersonCapabilities {
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canManageFlags: boolean;
  canManageWarrants: boolean;
  canViewCriminal: boolean;
  canViewMedical: boolean;
  canEditMedical: boolean;
  canViewArchived: boolean;
}

export interface PersonList {
  persons: PersonListItem[];
  total: number;
  limit: number;
  offset: number;
  capabilities: PersonCapabilities;
}

export interface PersonAlias { id: string; alias: string; note: string | null }

export interface PersonFlag {
  id: string; type: string; severity: string; note: string | null;
  createdAt: string; createdByName: string | null; resolvedAt: string | null;
}

export interface PersonWarrant {
  id: string; type: string; status: string; reason: string;
  organizationKey: string; organizationName: string;
  issuedAt: string; issuedByName: string | null; expiresAt: string | null;
}

export interface PersonCharge {
  id: string; title: string; severity: string; status: string;
  statuteCode: string | null; fineAmount: number | null;
  jailTimeMinutes: number | null; filedAt: string; filedByName: string | null;
}

export interface PersonLicense {
  id: string; type: string; status: string;
  issuedAt: string; expiresAt: string | null; suspendedReason: string | null;
}

export interface PersonMedical {
  bloodType: string | null;
  allergies: string[];
  conditions: string[];
  medications: string[];
  emergencyContact: string | null;
  notes: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

export interface PersonVehicle {
  id: string; plate: string; model: string; displayName: string | null;
  color: string | null; registrationStatus: string; insuranceStatus: string;
  flagCount: number;
}

export interface PersonAffiliation {
  organizationId: string; organizationKey: string; organizationName: string;
  organizationColor: string; roleName: string | null; callsign: string | null; status: string;
}

export interface PersonProfile {
  person: {
    id: string; firstName: string; lastName: string;
    dateOfBirth: string | null; gender: string | null;
    phoneNumber: string | null; address: string | null;
    heightCm: number | null; weightKg: number | null;
    eyeColor: string | null; hairColor: string | null;
    notes: string | null; status: string; isDeceased: boolean;
    isArchived: boolean; archivedReason: string | null;
    createdAt: string; updatedAt: string;
    createdByName: string | null; updatedByName: string | null;
  };
  aliases: PersonAlias[];
  flags: PersonFlag[];
  warrants: PersonWarrant[];
  licenses: PersonLicense[];
  vehicles: PersonVehicle[];
  affiliations: PersonAffiliation[];
  /** Absent entirely without the permission — not null, absent. */
  criminal?: PersonCharge[];
  medical?: PersonMedical | null;
  capabilities: PersonCapabilities;
  withheld: string[];
}

export interface PersonFilters {
  search?: string;
  status?: string;
  dateOfBirth?: string;
  onlyFlagged?: string;
  onlyWanted?: string;
  includeArchived?: string;
  limit?: string;
  offset?: string;
}

export async function fetchPersons(filters: PersonFilters = {}): Promise<PersonList | null> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const res = await apiFetch<PersonList>(`/api/v1/persons${suffix}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchPersonProfile(personId: string): Promise<PersonProfile | null> {
  const res = await apiFetch<PersonProfile>(`/api/v1/persons/${personId}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchFlagTypes(): Promise<string[]> {
  const res = await apiFetch<{ types: string[] }>('/api/v1/persons/flag-types');
  return res.ok ? (res.data?.types ?? []) : [];
}
