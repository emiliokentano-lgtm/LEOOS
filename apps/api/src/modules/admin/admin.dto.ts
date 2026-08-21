import {
  ACCOUNT_STATUSES, auditSeverityOf,
  type AccountStatus, type AdminLeadEntry, type AdminMembershipSummary,
  type AdminUserCapabilities, type AdminUserDetail, type AdminUserSummary,
  type AuditEntry, type AuditOutcome, type GlobalCapabilityKey,
  type OrganizationCategory, type OrganizationSummary,
} from '@leoos/contracts';
import type {
  AdminMembershipRow, AdminUserDetailRow, AdminUserRow,
} from './user.read.js';

/**
 * The serialization boundary for administration.
 *
 * Every response the module sends is built here, field by field, from a typed
 * row. No function in this file spreads its input — `{ ...row }` on a
 * `user_account` row is how a password hash reaches a browser, and this is the
 * one module where that row is routinely in hand (engineering rule 16).
 *
 * The test `admin.test.ts › no admin response carries a credential` serialises
 * every endpoint's output and searches it for the forbidden keys, so this is
 * checked rather than merely intended.
 */

/**
 * A timestamp, as ISO-8601.
 *
 * Accepts a string as well as a `Date` because the two query paths in this
 * module return different things for the same column: the Drizzle query builder
 * converts `timestamptz` to a `Date`, while a raw `sql` projection hands back
 * whatever the driver parsed — a string. Normalising here rather than at each
 * call site removes a class of runtime error that only appears on the endpoints
 * built from raw SQL.
 */
const iso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/** Non-null variant, for columns the schema guarantees. */
const isoRequired = (value: Date | string): string => iso(value) as string;

export function toOrganizationRef(row: {
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  organizationShortName: string;
  organizationCategory: string;
  organizationColor: string;
}): OrganizationSummary {
  return {
    id: row.organizationId,
    key: row.organizationKey,
    name: row.organizationName,
    shortName: row.organizationShortName,
    category: row.organizationCategory as OrganizationCategory,
    color: row.organizationColor,
  };
}

export function toAdminUserSummary(
  row: AdminUserRow,
  capabilities: GlobalCapabilityKey[],
  memberships: { membershipCount: number; organizationShortNames: string[] } | undefined,
): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    status: row.status as AccountStatus,
    emailVerified: row.emailVerifiedAt !== null,
    globalCapabilities: capabilities,
    membershipCount: memberships?.membershipCount ?? 0,
    organizationShortNames: memberships?.organizationShortNames ?? [],
    lastLoginAt: iso(row.lastLoginAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export function toAdminMembership(row: AdminMembershipRow): AdminMembershipSummary {
  return {
    memberId: row.memberId,
    organization: toOrganizationRef(row),
    status: row.status,
    callsign: row.callsign,
    employeeNumber: row.employeeNumber,
    roles: row.roles,
    // The effective level is the HIGHEST role held, matching the kernel's
    // `effectiveLevel`. Recomputing it differently here would put a number on
    // screen that disagrees with the one authorization actually uses.
    hierarchyLevel: row.roles.reduce((max, r) => Math.max(max, r.hierarchyLevel), 0),
    isOrgLead: row.isOrgLead,
    joinedAt: isoRequired(row.joinedAt),
    leftAt: iso(row.leftAt),
  };
}

export function toAdminUserDetail(
  row: AdminUserDetailRow,
  parts: {
    capabilities: { key: GlobalCapabilityKey; grantedAt: Date | string; grantedByName: string | null }[];
    memberships: AdminMembershipRow[];
    activeSessionCount: number;
    callerCapabilities: AdminUserCapabilities;
  },
): AdminUserDetail {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    status: row.status as AccountStatus,
    emailVerified: row.emailVerifiedAt !== null,
    emailVerifiedAt: iso(row.emailVerifiedAt),
    globalCapabilities: parts.capabilities.map((c) => ({
      key: c.key,
      grantedAt: isoRequired(c.grantedAt),
      grantedByName: c.grantedByName,
    })),
    memberships: parts.memberships.map(toAdminMembership),
    lastLoginAt: iso(row.lastLoginAt),
    lastLoginIp: row.lastLoginIp,
    activeSessionCount: parts.activeSessionCount,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    /**
     * Reported as a lock only while it is IN THE FUTURE.
     *
     * The column keeps the last lockout's expiry after it has passed, so
     * rendering it raw would show an account locked out for something that
     * resolved itself hours ago.
     */
    lockedUntil: row.lockedUntil && row.lockedUntil.getTime() > Date.now()
      ? row.lockedUntil.toISOString()
      : null,
    capabilities: parts.callerCapabilities,
  };
}

export function toAdminLeadEntry(row: {
  userId: string;
  username: string;
  displayName: string;
  accountStatus: string;
  membershipStatus: string;
  callsign: string | null;
  grantedAt: Date | string;
  grantedByName: string | null;
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  organizationShortName: string;
  organizationCategory: string;
  organizationColor: string;
}): AdminLeadEntry {
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    accountStatus: row.accountStatus as AccountStatus,
    organization: toOrganizationRef(row),
    membershipStatus: row.membershipStatus,
    callsign: row.callsign,
    grantedAt: isoRequired(row.grantedAt),
    grantedByName: row.grantedByName,
  };
}

export type AuditRow = {
  id: string;
  /** A raw `sql` projection: the driver hands this back as a string. */
  occurredAt: Date | string;
  actorType: string;
  actorUserId: string | null;
  actorLabel: string | null;
  action: string;
  outcome: string;
  entityType: string | null;
  entityId: string | null;
  organizationId: string | null;
  organizationKey: string | null;
  organizationName: string | null;
  organizationShortName: string | null;
  organizationCategory: string | null;
  organizationColor: string | null;
  metadata: unknown;
  ip: string | null;
  requestId: string | null;
};

/**
 * An audit row, as an entry.
 *
 * `metadata` is passed through as an object rather than rendered into prose.
 * The metadata of a role change and of a panic have nothing in common, and one
 * formatter over both would end up summarising one of them wrongly — the screen
 * shows the keys and lets the reader read them.
 */
export function toAuditEntry(row: AuditRow, entityLabel: string | null): AuditEntry {
  const outcome = row.outcome as AuditOutcome;

  return {
    id: row.id,
    occurredAt: isoRequired(row.occurredAt),
    actor: {
      type: row.actorType as AuditEntry['actor']['type'],
      userId: row.actorUserId,
      label: row.actorLabel,
    },
    action: row.action,
    outcome,
    severity: auditSeverityOf(row.action, outcome),
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel,
    organization: row.organizationId && row.organizationKey
      ? {
          id: row.organizationId,
          key: row.organizationKey,
          name: row.organizationName ?? row.organizationKey,
          shortName: row.organizationShortName ?? row.organizationKey,
          category: (row.organizationCategory ?? 'other') as OrganizationCategory,
          color: row.organizationColor ?? '#64748b',
        }
      : null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    ip: row.ip,
    requestId: row.requestId,
  };
}

/** The status catalogue, sent to the client so no component hardcodes a label. */
export function accountStatusCatalogue() {
  return Object.values(ACCOUNT_STATUSES);
}
