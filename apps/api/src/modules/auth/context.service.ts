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
  /**
   * The account row and its capabilities are INDEPENDENT, so they go together.
   *
   * This ran as two sequential round trips, and `loadMemberships` below ran five
   * more. Seven serial queries on every authenticated request measured 5.9 ms
   * median and 17 ms at p95 — a floor under every endpoint in the system,
   * including ones whose own work is a single indexed lookup.
   *
   * Nothing about the queries changed. Only the waiting did.
   */
  const [rows, caps] = await Promise.all([
    db
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
    .limit(1),
    db
      .select({ capability: userGlobalRole.capability })
      .from(userGlobalRole)
      .where(eq(userGlobalRole.userId, userId)),
  ]);

  const account = rows[0];
  if (!account) return null;

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

  /**
   * Four independent queries, one wait.
   *
   * Roles, role permissions, overrides and lead grants all key off the member
   * ids resolved above and none depends on another, so running them serially
   * was four round trips spent waiting rather than working. Same queries, same
   * results, a quarter of the latency.
   */
  const [roleRows, permRows, overrideRows, leadRows] = await Promise.all([
    db
    .select({
      memberId: memberRole.memberId,
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      hierarchyLevel: role.hierarchyLevel,
    })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .where(and(inArray(memberRole.memberId, memberIds), isNull(role.deletedAt))),
    db
    .select({ memberId: memberRole.memberId, permissionKey: rolePermission.permissionKey })
    .from(memberRole)
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(inArray(memberRole.memberId, memberIds), isNull(role.deletedAt))),
    db
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
    ),
    db
      .select({ organizationId: organizationLead.organizationId })
      .from(organizationLead)
      .where(and(eq(organizationLead.userId, userId), isNull(organizationLead.revokedAt))),
  ]);

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
 * ────────────────────────────────────────────────────────────────────────────
 * THE AUTHORIZATION CACHE
 *
 * `resolveIdentity` runs on EVERY authenticated request, before the route does
 * any of its own work. Measured against an RP-scale fixture it costs 5.36 ms at
 * the median and 11.68 ms at p95 — a floor under every endpoint in the system,
 * including ones whose own work is a single indexed lookup. Reading
 * `permission_version` alone costs 0.45 ms.
 *
 * The engineering rule this has to satisfy is the one about caching:
 *
 *     "Do not cache data that must be real-time unless the caching strategy is
 *      explicitly safe."
 *
 * Permissions must be real-time. A demoted sergeant must lose their authority on
 * the NEXT request, not thirty seconds later. So the strategy is stated
 * explicitly rather than assumed:
 *
 * 1. THE CACHE IS KEYED ON A VERSION, NOT A TIMER.
 *    Every path that can change a user's effective permissions already calls
 *    `bumpPermissionVersion` inside its own transaction — role assignment and
 *    removal, permission overrides, membership status changes, organization-lead
 *    grants and revocations, account disabling, capability changes. The cached
 *    entry is only used when the version read back from the database MATCHES the
 *    version the entry was built at. A change therefore invalidates by making
 *    the key not match, which needs no delete, no broadcast and no coordination
 *    between processes — which matters because a second API instance would have
 *    its own Map and no way to be told.
 *
 *    Invalidation-by-key-change is also race-free in a way invalidation-by-delete
 *    is not: a delete that lands before the commit it describes can be undone by
 *    a concurrent read repopulating the entry from the pre-commit state. A
 *    version bump cannot, because the version and the change commit together.
 *
 * 2. A SHORT TTL COVERS THE ONE CHANGE NO TRANSACTION CAN ANNOUNCE.
 *    A `member_permission_override` with an `expires_at` stops applying when the
 *    clock passes it. Nothing runs at that moment; no transaction commits; no
 *    version can be bumped. The TTL below is the bound on how long a
 *    just-expired override can still be honoured. Five seconds is chosen to be
 *    shorter than any operationally meaningful window and long enough to absorb
 *    the burst of parallel requests a single page load produces, which is where
 *    the win actually comes from.
 *
 *    Organization soft-deletion is the same shape — the organization row
 *    changes, not the user's — and is covered by the same bound.
 *
 * 3. THE CACHE IS NOT USED FOR DECISIONS INSIDE A TRANSACTION.
 *    `loadActorContextLocked` calls `resolveIdentity` DIRECTLY and always will.
 *    A mutation decides under `SELECT … FOR UPDATE` and must see the rows it
 *    locked, not a copy taken before the lock. Nothing here changes that; the
 *    cache serves the request-scoped identity that route guards and rendering
 *    read, and the locked loader remains the only thing a mutation trusts
 *    (docs/architecture/02-authorization.md §B.5, §B.6).
 *
 * The cached value is treated as IMMUTABLE by every consumer: `toActorContext`
 * copies what it needs into a fresh `ActorContext` and no caller mutates the
 * arrays. If that ever stops being true, this becomes a shared-mutable-state
 * bug rather than a stale-data one, so it is stated here.
 * ────────────────────────────────────────────────────────────────────────────
 */

const IDENTITY_TTL_MS = 5_000;

/**
 * Bounded so a long-running process cannot accumulate an entry per user who has
 * ever signed in. At the cap the whole map is dropped rather than evicted
 * one-by-one: entries are cheap to rebuild, the cap is far above any plausible
 * concurrent-operator count, and an LRU here would be complexity bought with no
 * measurable benefit.
 */
const IDENTITY_CACHE_MAX = 5_000;

interface IdentityCacheEntry {
  version: number;
  loadedAt: number;
  identity: ResolvedIdentity;
}

const identityCache = new Map<string, IdentityCacheEntry>();

type VersionRow = { permission_version: number };

/**
 * Resolves identity, reusing a cached copy when the user's permission version
 * is unchanged and the TTL holds.
 *
 * Read the block above before changing anything here. On a hit this is one
 * indexed read; on a miss it is that read plus the full resolution.
 */
export async function resolveIdentityCached(
  db: Database,
  userId: string,
): Promise<ResolvedIdentity | null> {
  const rows = await db.execute<VersionRow>(
    sql`SELECT permission_version FROM user_account WHERE id = ${userId}`,
  );
  const row = rows[0];
  if (!row) {
    identityCache.delete(userId);
    return null;
  }

  const now = Date.now();
  const cached = identityCache.get(userId);
  if (cached && cached.version === row.permission_version && now - cached.loadedAt < IDENTITY_TTL_MS) {
    return cached.identity;
  }

  const identity = await resolveIdentity(db, userId);
  if (!identity) {
    identityCache.delete(userId);
    return null;
  }

  if (identityCache.size >= IDENTITY_CACHE_MAX) identityCache.clear();
  identityCache.set(userId, {
    // The version stored is the one the IDENTITY was built with, not the one
    // read above: if a bump lands between the two reads, storing the earlier
    // value would make the next request re-resolve, which is merely wasteful.
    // Storing the LATER value would pin a stale identity to a version that has
    // already moved past it, which is the actual hazard.
    version: identity.account.permissionVersion,
    loadedAt: now,
    identity,
  });
  return identity;
}

/** Drops a user's cached identity. For tests and for explicit invalidation. */
export function clearIdentityCache(userId?: string): void {
  if (userId === undefined) identityCache.clear();
  else identityCache.delete(userId);
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
