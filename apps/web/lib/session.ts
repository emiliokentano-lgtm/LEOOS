import 'server-only';
import type { PermissionKey } from '@leoos/contracts';
import { MOCK_SESSION, MOCK_USER_ORGANIZATIONS, type MockSession } from '@/mocks/session';
import { mockOrg } from '@/mocks/organizations';

/**
 * Server-side session accessor.
 *
 * In this phase it returns fixture data. From Phase 1 it reads the session cookie
 * and calls the API — the signature does not change, so screens built against it
 * keep working.
 *
 * `server-only` is imported deliberately: this module must never be pulled into a
 * client bundle, because the real implementation will handle the session token.
 */

export type Session = MockSession;

export async function getSession(): Promise<Session> {
  return MOCK_SESSION;
}

export async function getActiveOrganization() {
  const session = await getSession();
  return mockOrg(session.organizationId);
}

export async function getUserOrganizations() {
  return MOCK_USER_ORGANIZATIONS;
}

/**
 * Permission check used to decide what to RENDER.
 *
 * This is cosmetic (engineering rule 9). It hides navigation and controls the
 * user cannot use, which is a usability feature, not a security boundary. Every
 * operation is authorized again server-side inside the mutating transaction, and
 * the API assumes the client is hostile.
 */
export function hasPermission(session: Session, permission: PermissionKey): boolean {
  if (session.isGlobalAdmin) return true;
  return session.permissions.includes(permission);
}
