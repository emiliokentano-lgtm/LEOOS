import { redirect } from 'next/navigation';
import type { Route } from 'next';
import type { AdminCapabilities } from '@leoos/contracts';
import { hasAnyAdminCapability } from '@leoos/contracts';
import { fetchAdminCapabilities } from '@/lib/admin';

/**
 * The page-level guard for the administration area.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS A REDIRECT, NOT A SECURITY BOUNDARY.
 *
 * Every endpoint behind these screens re-decides authorization for itself; a
 * caller who reached one of these URLs without the capability would see an
 * empty page and be refused by every request it made. What this adds is the
 * difference between "refused" and "not for you" — an operator who lands here
 * from a stale bookmark gets sent somewhere useful instead of a wall of errors
 * (engineering rule 9: the frontend is never the boundary).
 *
 * The capabilities come from the API rather than from the session's own
 * capability list, so this and the endpoints are answering from one source.
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function requireAdminCapabilities(
  needs?: keyof AdminCapabilities,
): Promise<AdminCapabilities> {
  const capabilities = await fetchAdminCapabilities();

  // No capabilities at all — including the unauthenticated case, where the API
  // refuses and this comes back null.
  if (!capabilities || !hasAnyAdminCapability(capabilities)) {
    redirect('/dashboard' as Route);
  }

  // Holds something, but not the thing this screen needs. Sent to the hub,
  // which shows them what they CAN reach rather than a dead end.
  if (needs && !capabilities[needs]) {
    redirect('/admin' as Route);
  }

  return capabilities;
}
