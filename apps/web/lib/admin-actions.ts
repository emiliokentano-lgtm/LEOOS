'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, CSRF_COOKIE } from './api-client';
import type { ActionState } from './auth-action-types';

/**
 * Administration server actions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NONE OF THESE DECIDES ANYTHING.
 *
 * Every one is a forwarder: it collects a form, posts it to the API and returns
 * what came back. The self-action rule, the last-administrator guard and the
 * capability check all live in the service, inside the transaction, with the
 * counts in hand. Repeating any of them here would be a second opinion formed
 * from a stale read — and the one that matters is the one holding the lock
 * (engineering rules 9, 10).
 *
 * What this layer does add is the CSRF header and the cache invalidation, both
 * of which are properties of the web tier rather than of the domain.
 * ────────────────────────────────────────────────────────────────────────────
 */

async function csrfHeader(): Promise<Record<string, string>> {
  const jar = await cookies();
  const token = jar.get(CSRF_COOKIE)?.value;
  return token ? { 'x-leoos-csrf': token } : {};
}

function failure(
  error: { message: string; detail?: unknown } | undefined,
  requestId: string | undefined,
): ActionState {
  return { status: 'error', message: error?.message ?? 'Request failed.', requestId };
}

/** Refreshes every screen an account change can be seen from. */
function revalidateAccount(userId: string): void {
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath('/admin');
  revalidatePath('/audit');
}

export async function changeAccountStatusAction(
  userId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const status = String(formData.get('status') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!status) return { status: 'error', message: 'Choose a status.' };

  const res = await apiFetch<{ status: string; sessionsRevoked: number }>(
    `/api/v1/admin/users/${userId}/status`,
    { method: 'POST', body: { status, ...(reason ? { reason } : {}) }, headers: await csrfHeader() },
  );

  if (!res.ok) return failure(res.error, res.requestId);
  revalidateAccount(userId);

  /**
   * The session count is reported back.
   *
   * "Suspended" and "suspended, and the four sessions they had open are gone"
   * are different pieces of news, and the second is the one that tells an
   * administrator the action took effect immediately rather than whenever a
   * cookie expires.
   */
  const revoked = res.data?.sessionsRevoked ?? 0;
  return {
    status: 'success',
    message: revoked > 0
      ? `Account ${status}. ${revoked} active session(s) were ended.`
      : `Account ${status}.`,
  };
}

export async function grantCapabilityAction(
  userId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const capability = String(formData.get('capability') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!capability) return { status: 'error', message: 'Choose a capability.' };

  const res = await apiFetch<{ sessionsRevoked: number }>(
    `/api/v1/admin/users/${userId}/capabilities`,
    {
      method: 'POST',
      body: { capability, ...(reason ? { reason } : {}) },
      headers: await csrfHeader(),
    },
  );

  if (!res.ok) return failure(res.error, res.requestId);
  revalidateAccount(userId);
  return {
    status: 'success',
    message: `Granted ${capability}. The holder was signed out so it takes effect on `
      + 'their next sign-in.',
  };
}

export async function revokeCapabilityAction(
  userId: string,
  capability: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get('reason') ?? '').trim();

  const res = await apiFetch(`/api/v1/admin/users/${userId}/capabilities/${capability}`, {
    method: 'DELETE',
    body: reason ? { reason } : {},
    headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  revalidateAccount(userId);
  return { status: 'success', message: `Revoked ${capability}.` };
}
