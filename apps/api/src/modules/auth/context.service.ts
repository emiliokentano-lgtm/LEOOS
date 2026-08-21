import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  memberPermissionOverride, memberRole, organization, organizationLead,
  organizationMember, role, rolePermission, userAccount, userGlobalRole,
  type Database,
} from '@leoos/db';
import {
  effectiveLevel, effectivePermissions, UNBOUNDED_LEVEL,
  type ActorContext, type GlobalCapability,
} from '@leoos/authz-core';
import type { PermissionKey, OrganizationCategory } from '@leoos/contracts';

/**
 * Resolves a user into the authorization context the kernel decides on.
 *
 * TWO LOADERS, DELIBERATELY DIFFERENT NAMES:
 *
 *   loadActorContext        — plain read, for rendering and route guards
 *   loadActorContextLocked  — SELECT … FOR UPDATE, for mutations
 *
 * The distinction is load-bearing. Checking permissions before opening the
 * transaction is a race: demote a sergeant while they fire parallel promotion
 * requests and a stale check approves an action they are no longer entitled to
 * perform. Mutations MUST use the locked loader
 * (docs/architecture/02-authorization.md §B.5).
 */

export interface MembershipSummary {
  memberId: string;
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  organizationShortName: string;
  organizationColor: string;
  organizationCategory: OrganizationCategory;
  status: 'active' | 'on_leave' | 'suspended' | 'terminated';
  callsign: string | null;
  employeeNumber: string | null;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
  hierarchyLevel: number;
  permissions: PermissionKey[];
  isOrgLead: boolean;
  joinedAt: Date;
}

export interface AccountSummary {
  userId: string;
  email: string;
  username: string;
  displayName: string;
  status: string;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  permissionVersion: number;
  globalCapabilities: GlobalCapability[];
  isGlobalAdmin: boolean;
}

export interface ResolvedIdentity {
  account: AccountSummary;
  memberships: MembershipSummary[];
}

async function loadAccount(db: Database, userId: string): Promise<AccountSummary | null> {
  const rows = await db
    .select({
      id: userAccount.id,
      email: userAccount.email,
      username: userAccount.username,
      displayName: userAccount.displayName,
      status: userAccount.status,
      emailVerifiedAt: userAccount.emailVerifiedAt,
      lastLoginAt: userAccount.lastLoginAt,
      permissionVersion: userAccount.permissionVersion,
    })
    .from(userAccount)
    .where(eq(userAccount.id, userId))
    .limit(1);

  const account = rows[0];
  if (!account) return null;

  const caps = await db
    .select({ capability: userGlobalRole.capability })
    .from(userGlobalRole)
    .where(eq(userGlobalRole.userId, userId));

  const globalCapabilities = caps.map((c) => c.capability as GlobalCapability);

  return {
    userId: account.id,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    status: account.status,
    emailVerifiedAt: account.emailVerifiedAt,
    lastLoginAt: account.lastLoginAt,
    permissionVersion: account.permissionVersion,
    globalCapabilities,
    isGlobalAdmin: globalCapabilities.includes('global_admin'),
  };
}

/**
 * Loads every membership with its resolved roles and effective permissions.
 *
 * Effective set = role grants ∪ explicit grants − explicit denies. Deny wins.
 */
async function loadMemberships(db: Database, userId: string): Promise<MembershipSummary[]> {
  const members = await db
    .select({
      memberId: organizationMember.id,
      organizationId: organizationMember.organizationId,
      status: organizationMember.status,
      callsign: organizationMember.callsign,
      employeeNumber: organizationMember.employeeNumber,
      joinedAt: organizationMember.joinedAt,
      orgKey: organization.key,
      orgName: organization.name,
      orgShortName: organization.shortName,
      orgColor: organization.color,
      orgCategory: organization.category,
    })
    .from(organizationMember)
    .innerJoin(organization, eq(organization.id, organizationMember.organizationId))
    .where(and(eq(organizationMember.userId, userId), isNull(organization.deletedAt)));

  if (members.length === 0) return [];

  const memberIds = members.map((m) => m.memberId);

  const roleRows = await db
    .select({
      memberId: memberRole.memberId,
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      hierarchyLevel: role.hierarchyLevel,
    })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .where(and(inArray(memberRole.memberId, memberIds), isNull(role.deletedAt)));

  const permRows = await db
    .select({ memberId: memberRole.memberId, permissionKey: rolePermission.permissionKey })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(inArray(memberRole.memberId, memberIds), isNull(role.deletedAt)));

  const overrideRows = await db
    .select({
      memberId: memberPermissionOverride.memberId,
      permissionKey: memberPermissionOverride.permissionKey,
      effect: memberPermissionOverride.effect,
    })
    .from(memberPermissionOverride)
    .where(
      and(
        inArray(memberPermissionOverride.memberId, memberIds),
        // An expired override is not an override.
        or(
          isNull(memberPermissionOverride.expiresAt),
          gt(memberPermissionOverride.expiresAt, new Date()),
        ),
      ),
    );

  const leadRows = await db
    .select({ organizationId: organizationLead.organizationId })
    .from(organizationLead)
    .where(and(eq(organizationLead.userId, userId), isNull(organizationLead.revokedAt)));
  const leadOrgs = new Set(leadRows.map((r) => r.organizationId));

  return members.map((m) => {
    const roles = roleRows
      .filter((r) => r.memberId === m.memberId)
      .map((r) => ({
        id: r.roleId, key: r.roleKey, name: r.roleName, hierarchyLevel: r.hierarchyLevel,
      }));

    const isOrgLead = leadOrgs.has(m.organizationId);
    const active = m.status === 'active';

    const rolePermissionKeys = permRows
      .filter((p) => p.memberId === m.memberId)
      .map((p) => p.permissionKey as PermissionKey);
    const overrides = overrideRows.filter((o) => o.memberId === m.memberId);

    const permissions = active
      ? [
          ...effectivePermissions({
            rolePermissions: rolePermissionKeys,
            grants: overrides.filter((o) => o.effect === 'grant').map((o) => o.permissionKey as PermissionKey),
            denies: overrides.filter((o) => o.effect === 'deny').map((o) => o.permissionKey as PermissionKey),
          }),
        ]
      : []; // A terminated or suspended member holds nothing.

    return {
      memberId: m.memberId,
      organizationId: m.organizationId,
      organizationKey: m.orgKey,
      organizationName: m.orgName,
      organizationShortName: m.orgShortName,
      organizationColor: m.orgColor,
      organizationCategory: m.orgCategory as OrganizationCategory,
      status: m.status,
      callsign: m.callsign,
      employeeNumber: m.employeeNumber,
      roles,
      hierarchyLevel: active ? effectiveLevel(roles.map((r) => r.hierarchyLevel)) : 0,
      permissions,
      isOrgLead,
      joinedAt: m.joinedAt,
    };
  });
}

export async function resolveIdentity(
  db: Database,
  userId: string,
): Promise<ResolvedIdentity | null> {
  const account = await loadAccount(db, userId);
  if (!account) return null;
  const memberships = await loadMemberships(db, userId);
  return { account, memberships };
}

/**
 * Builds the kernel's actor context for one organization.
 *
 * `organizationId` on the result is the organization the actor ACTUALLY BELONGS
 * TO, not the one that was asked about. If the requested organization is one
 * they have no membership in, it comes back null.
 *
 * This is load-bearing. If the requested id were echoed back unconditionally,
 * every scope check of the form `actor.organizationId !== organizationId` would
 * compare a value to itself and always pass — the check would be tautological,
 * and a lead of one organization would fall through to a permission check
 * against the wrong organization instead of being refused for scope.
 */
export function toActorContext(
  identity: ResolvedIdentity,
  organizationId: string | null,
): ActorContext {
  const membership = organizationId
    ? identity.memberships.find((m) => m.organizationId === organizationId)
    : undefined;

  const membershipActive = membership?.status === 'active';

  /**
   * A LEAD GRANT DOES NOT SURVIVE THE MEMBERSHIP IT LEADS.
   *
   * `organization_lead` and `organization_member.status` are separate rows
   * changed by separate operations, so firing somebody does not revoke their
   * lead grant — and `MembershipSummary.isOrgLead` reports the grant as it
   * stands, which is right for a screen that wants to show "holds the lead
   * grant, membership terminated".
   *
   * It is NOT right for an authorization context. Without this line a fired
   * chief kept `isOrgLead: true` and `level: UNBOUNDED_LEVEL`, and every
   * decision that reads either directly — the organization view checks, the
   * role screen's disclosure rules, the personnel roster's — treated them as
   * still running the organization. The kernel's `can()` and every mutating
   * decision already guard on `membershipActive`, which is why this was a read
   * exposure rather than a write one; the fix is to stop the context from
   * asserting it in the first place, so a consumer that forgets the guard is no
   * longer a hole.
   */
  const isOrgLead = membershipActive && (membership?.isOrgLead ?? false);
  const level = identity.account.isGlobalAdmin || isOrgLead
    ? UNBOUNDED_LEVEL
    : (membershipActive ? (membership?.hierarchyLevel ?? 0) : 0);

  return {
    userId: identity.account.userId,
    organizationId: membership ? membership.organizationId : null,
    isGlobalAdmin: identity.account.isGlobalAdmin,
    isOrgLead,
    level,
    permissions: new Set(membership?.permissions ?? []),
    globalCapabilities: new Set(identity.account.globalCapabilities),
    membershipActive,
  };
}

/**
 * Mutation-safe loader.
 *
 * Takes a row lock on the actor's membership so a concurrent change to their own
 * roles serialises against this decision. MUST be used inside the transaction
 * that performs the mutation — see the module comment.
 */
export async function loadActorContextLocked(
  tx: Database,
  userId: string,
  organizationId: string | null,
): Promise<ActorContext> {
  if (organizationId) {
    await tx.execute(sql`
      SELECT id FROM organization_member
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
      FOR UPDATE
    `);
  }
  const identity = await resolveIdentity(tx, userId);
  if (!identity) {
    return {
      userId, organizationId: null, isGlobalAdmin: false, isOrgLead: false, level: 0,
      permissions: new Set(), globalCapabilities: new Set(), membershipActive: false,
    };
  }
  return toActorContext(identity, organizationId);
}

/**
 * Bumps a user's permission version.
 *
 * Called whenever anything that could change their effective permissions
 * changes — a role assignment, an override, a membership status change, an
 * organization-lead grant or revocation. The authorization cache is keyed on
 * this value, so invalidation is a key change rather than a delete, which is
 * race-free (docs/architecture/02-authorization.md §B.6).
 *
 * Must be called inside the same transaction as the change it describes.
 */
export async function bumpPermissionVersion(tx: Database, userId: string): Promise<void> {
  await tx
    .update(userAccount)
    .set({ permissionVersion: sql`${userAccount.permissionVersion} + 1` })
    .where(eq(userAccount.id, userId));
}
