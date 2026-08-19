'use client';

import * as React from 'react';
import type { OrganizationSummary, PermissionKey } from '@leoos/contracts';

/**
 * Client-side authentication state.
 *
 * ⚠ COSMETIC ONLY. Everything in this context exists to decide what to RENDER —
 * which navigation entries to show, which buttons to disable. It is NEVER an
 * authorization decision (engineering rules 9, 10).
 *
 * Every value here arrived from the server and could be tampered with in the
 * browser. The API re-derives all of it from the database on every request, and
 * decides fine-grained permissions inside the transaction that performs the
 * change. If the two ever disagree, the API is right by construction.
 */

export interface AuthMembership {
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

export interface AuthState {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  memberships: AuthMembership[];
  activeOrganizationId: string | null;
  isGlobalAdmin: boolean;
  globalCapabilities: string[];
  permissionVersion: number;
}

export interface AuthContextValue extends AuthState {
  /** The membership matching `activeOrganizationId`, if any. */
  activeMembership: AuthMembership | null;
  activeOrganization: OrganizationSummary | null;
  isOrgLead: boolean;
  hierarchyLevel: number;
  /** Cosmetic permission check. See the warning above. */
  can: (permission: PermissionKey) => boolean;
  canAll: (...permissions: PermissionKey[]) => boolean;
  canAny: (...permissions: PermissionKey[]) => boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Returns null outside an authenticated tree, rather than throwing. */
export function useAuthOptional(): AuthContextValue | null {
  return React.useContext(AuthContext);
}

export function AuthProvider({
  state, children,
}: {
  state: AuthState;
  children: React.ReactNode;
}) {
  const value = React.useMemo<AuthContextValue>(() => {
    const activeMembership =
      state.memberships.find((m) => m.organization.id === state.activeOrganizationId) ?? null;

    const permissions = new Set(activeMembership?.permissions ?? []);
    const can = (permission: PermissionKey) =>
      state.isGlobalAdmin || permissions.has(permission);

    return {
      ...state,
      activeMembership,
      activeOrganization: activeMembership?.organization ?? null,
      isOrgLead: activeMembership?.isOrgLead ?? false,
      hierarchyLevel: activeMembership?.hierarchyLevel ?? 0,
      can,
      canAll: (...keys) => keys.every(can),
      canAny: (...keys) => keys.some(can),
    };
  }, [state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hides UI the user cannot act on.
 *
 * A usability affordance, not a security control — the API refuses the action
 * regardless of what was rendered.
 */
export function PermissionGate({
  permission, children, fallback = null,
}: {
  permission: PermissionKey;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const auth = useAuthOptional();
  if (!auth) return <>{fallback}</>;
  return <>{auth.can(permission) ? children : fallback}</>;
}
