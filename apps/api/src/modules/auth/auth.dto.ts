import type { PermissionKey } from '@leoos/contracts';
import type { ResolvedIdentity } from './context.service.js';

/**
 * The serialization boundary (engineering rule 16).
 *
 * Responses are ASSEMBLED from these types, never spread from a database row.
 * Selecting a whole row and forgetting to strip a field is the normal way a
 * password hash leaks; building the response explicitly makes that structurally
 * impossible rather than a code-review catch.
 *
 * Fields that must never appear below, in any shape:
 *   password_hash · totp_secret_enc · token_hash · secret_hash
 */

export interface SessionUserDto {
  id: string;
  email: string;
  username: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
}

export interface MembershipDto {
  memberId: string;
  organization: {
    id: string;
    key: string;
    name: string;
    shortName: string;
    color: string;
    category: string;
  };
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
  hierarchyLevel: number;
  permissions: PermissionKey[];
  isOrgLead: boolean;
  joinedAt: string;
}

export interface SessionDto {
  user: SessionUserDto;
  memberships: MembershipDto[];
  /** The organization this request resolved to. */
  activeOrganizationId: string | null;
  isGlobalAdmin: boolean;
  globalCapabilities: string[];
  /**
   * Bumped whenever anything affecting effective permissions changes. The client
   * uses it to detect that its cached view is stale; it is NOT an authorization
   * input.
   */
  permissionVersion: number;
}

export function toSessionDto(
  identity: ResolvedIdentity,
  activeOrganizationId: string | null,
): SessionDto {
  return {
    user: {
      id: identity.account.userId,
      email: identity.account.email,
      username: identity.account.username,
      displayName: identity.account.displayName,
      status: identity.account.status,
      emailVerified: identity.account.emailVerifiedAt !== null,
      lastLoginAt: identity.account.lastLoginAt?.toISOString() ?? null,
    },
    memberships: identity.memberships.map((m) => ({
      memberId: m.memberId,
      organization: {
        id: m.organizationId,
        key: m.organizationKey,
        name: m.organizationName,
        shortName: m.organizationShortName,
        color: m.organizationColor,
        category: m.organizationCategory,
      },
      status: m.status,
      callsign: m.callsign,
      employeeNumber: m.employeeNumber,
      roles: m.roles,
      hierarchyLevel: m.hierarchyLevel,
      permissions: m.permissions,
      isOrgLead: m.isOrgLead,
      joinedAt: m.joinedAt.toISOString(),
    })),
    activeOrganizationId,
    isGlobalAdmin: identity.account.isGlobalAdmin,
    globalCapabilities: identity.account.globalCapabilities,
    permissionVersion: identity.account.permissionVersion,
  };
}

export interface ActiveSessionDto {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
