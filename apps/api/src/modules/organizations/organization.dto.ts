import type { OrganizationCategory } from '@leoos/contracts';
import type {
  OrganizationLeadRow, OrganizationStats, OrganizationSummaryRow,
} from './organization.service.js';

/**
 * Organization DTOs — the serialization boundary (engineering rule 16).
 *
 * Responses are assembled here, never spread from a row. `settings` is passed
 * through as an object, so anything an administrator stores in it is visible to
 * anyone who can read the organization: it is for operational toggles, not for
 * secrets, and the route schema constrains what may be written there.
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

export function toOrganizationDto(row: OrganizationSummaryRow): OrganizationDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    shortName: row.shortName,
    description: row.description,
    category: row.category,
    color: row.color,
    logoUrl: row.logoUrl,
    isActive: row.isActive,
    isArchived: row.archivedAt !== null,
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
  };
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

export function toLeadDto(
  row: OrganizationLeadRow & { organizationId: string },
): OrganizationLeadDto {
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    displayName: row.displayName,
    username: row.username,
    email: row.email,
    grantedAt: row.grantedAt.toISOString(),
    grantedBy: row.grantedByName,
  };
}

export interface OrganizationDetailDto {
  organization: OrganizationDto;
  stats: OrganizationStats;
  leads: OrganizationLeadDto[];
  /** What the CALLER may do here. Cosmetic — the API re-checks every action. */
  capabilities: {
    canEdit: boolean;
    canManageLeads: boolean;
    canViewPersonnel: boolean;
    canViewRoles: boolean;
    canViewVehicles: boolean;
  };
}
