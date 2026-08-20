import 'server-only';
import type { Route } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { OrganizationSummary, PermissionKey } from '@leoos/contracts';
import { apiFetch, ORG_COOKIE } from './api-client';

/**
 * Server-side session accessor.
 *
 * The signature is unchanged from the design-system phase — every screen built
 * against it keeps working — but the mock is gone: this now reads the session
 * cookie and asks the API who the caller is.
 *
 * `server-only`: this module must never reach a client bundle.
 */

export interface SessionMembership {
  memberId: string;
  organization: OrganizationSummary;
  status: string;
  callsign: string | null;
  employeeNumber: string | null;
  roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
  hierarchyLevel: number;
  permissions: PermissionKey[];
  isOrgLead: boolean;
}

export interface Session {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  status: string;
  emailVerified: boolean;
  memberships: SessionMembership[];
  organizationId: string | null;
  isGlobalAdmin: boolean;
  globalCapabilities: string[];
  permissionVersion: number;

  // Convenience projections of the ACTIVE membership, so existing screens that
  // read `session.roleName` keep working unchanged.
  roleName: string;
  hierarchyLevel: number;
  callsign: string;
  badgeNumber: string;
  isOrgLead: boolean;
  permissions: PermissionKey[];
}

interface SessionResponse {
  session: {
    user: {
      id: string; email: string; username: string; displayName: string;
      status: string; emailVerified: boolean; lastLoginAt: string | null;
    };
    memberships: {
      memberId: string;
      organization: { id: string; key: string; name: string; shortName: string; color: string; category: string };
      status: string;
      callsign: string | null;
      employeeNumber: string | null;
      roles: { id: string; key: string; name: string; hierarchyLevel: number }[];
      hierarchyLevel: number;
      permissions: PermissionKey[];
      isOrgLead: boolean;
      joinedAt: string;
    }[];
    activeOrganizationId: string | null;
    isGlobalAdmin: boolean;
    globalCapabilities: string[];
    permissionVersion: number;
  };
}

/** Returns null when there is no valid session — callers decide what that means. */
export async function getSessionOrNull(): Promise<Session | null> {
  const result = await apiFetch<SessionResponse>('/api/v1/auth/me');
  if (!result.ok || !result.data) return null;

  const s = result.data.session;
  const jar = await cookies();
  const preferredOrg = jar.get(ORG_COOKIE)?.value;

  const active =
    s.memberships.find((m) => m.organization.id === preferredOrg && m.status === 'active') ??
    s.memberships.find((m) => m.status === 'active') ??
    s.memberships[0];

  const memberships: SessionMembership[] = s.memberships.map((m) => ({
    memberId: m.memberId,
    organization: {
      id: m.organization.id,
      key: m.organization.key,
      name: m.organization.name,
      shortName: m.organization.shortName,
      color: m.organization.color,
      category: m.organization.category as OrganizationSummary['category'],
    },
    status: m.status,
    callsign: m.callsign,
    employeeNumber: m.employeeNumber,
    roles: m.roles,
    hierarchyLevel: m.hierarchyLevel,
    permissions: m.permissions,
    isOrgLead: m.isOrgLead,
  }));

  const activeMembership = memberships.find((m) => m.organization.id === active?.organization.id);
  const topRole = [...(activeMembership?.roles ?? [])].sort(
    (a, b) => b.hierarchyLevel - a.hierarchyLevel,
  )[0];

  return {
    userId: s.user.id,
    username: s.user.username,
    displayName: s.user.displayName,
    email: s.user.email,
    status: s.user.status,
    emailVerified: s.user.emailVerified,
    memberships,
    organizationId: activeMembership?.organization.id ?? null,
    isGlobalAdmin: s.isGlobalAdmin,
    globalCapabilities: s.globalCapabilities,
    permissionVersion: s.permissionVersion,

    roleName: topRole?.name ?? (s.isGlobalAdmin ? 'Global Administrator' : 'No role'),
    hierarchyLevel: activeMembership?.hierarchyLevel ?? 0,
    callsign: activeMembership?.callsign ?? '—',
    badgeNumber: activeMembership?.employeeNumber ?? '—',
    isOrgLead: activeMembership?.isOrgLead ?? false,
    permissions: activeMembership?.permissions ?? [],
  };
}

/**
 * For screens under the authenticated shell.
 *
 * Redirects rather than throwing. The layout guard has normally already sent an
 * unauthenticated caller away, but Next renders a layout and its page
 * CONCURRENTLY: when a session ends between the two, the page's throw surfaces
 * as a server error before the layout's redirect wins, and the operator sees a
 * crash where they should see a sign-in screen.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSessionOrNull();
  // Cast because typed routes enumerate pages only; see the layout.
  if (!session) redirect('/api/session/expired' as Route);
  return session;
}

/** Kept for compatibility with screens written in the design phase. */
export const getSession = requireSession;

export async function getActiveOrganization(): Promise<OrganizationSummary | null> {
  const session = await getSessionOrNull();
  if (!session) return null;
  return session.memberships.find((m) => m.organization.id === session.organizationId)
    ?.organization ?? null;
}

export async function getUserOrganizations(): Promise<OrganizationSummary[]> {
  const session = await getSessionOrNull();
  return session?.memberships.map((m) => m.organization) ?? [];
}

/**
 * Permission check used to decide what to RENDER.
 *
 * Cosmetic (engineering rule 9). It hides navigation and controls the user
 * cannot use, which is a usability feature and not a security boundary. Every
 * operation is authorized again by the API, inside the transaction that performs
 * it, and the API assumes this client is hostile.
 */
export function hasPermission(session: Session, permission: PermissionKey): boolean {
  if (session.isGlobalAdmin) return true;
  return session.permissions.includes(permission);
}

/**
 * For screens that cannot render without an organization context.
 *
 * A verified account with no membership is a real, expected state — it is
 * exactly what registration produces, since registration grants nothing. Those
 * users are sent to the holding screen rather than allowed to reach a page that
 * would have to invent an organization.
 */
export async function requireActiveOrganization(): Promise<{
  session: Session;
  organization: OrganizationSummary;
}> {
  const session = await getSessionOrNull();
  // Clears the stale cookie on the way, so middleware and the API cannot
  // disagree about whether this caller is signed in — see
  // app/api/session/expired/route.ts.
  if (!session) redirect('/api/session/expired' as Route);

  const organization = session.memberships.find(
    (m) => m.organization.id === session.organizationId,
  )?.organization;

  if (!organization) redirect('/no-organization');
  return { session, organization };
}
