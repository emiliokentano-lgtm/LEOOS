'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch, CSRF_COOKIE, ORG_COOKIE, SESSION_COOKIE } from './api-client';
import type { ActionState } from './auth-action-types';

/**
 * Server actions for authentication.
 *
 * These run on the server and are the only place the web tier touches session
 * cookies. Nothing here decides anything — the API does; this forwards the
 * request and passes cookies back to the browser.
 */



/** Copies the API's Set-Cookie directives onto this response. */
async function applyCookies(setCookie: string[] | undefined): Promise<void> {
  if (!setCookie?.length) return;
  const jar = await cookies();

  for (const line of setCookie) {
    const [pair, ...attrs] = line.split(';');
    const idx = pair?.indexOf('=') ?? -1;
    if (idx <= 0 || !pair) continue;

    const name = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    const lower = attrs.map((a) => a.trim().toLowerCase());
    const maxAgeAttr = lower.find((a) => a.startsWith('max-age='));
    const maxAge = maxAgeAttr ? Number(maxAgeAttr.split('=')[1]) : undefined;

    if (maxAge === 0 || value === '') {
      jar.delete(name);
      continue;
    }

    jar.set(name, value, {
      httpOnly: lower.includes('httponly'),
      secure: lower.includes('secure'),
      sameSite: 'lax',
      path: '/',
      ...(maxAge !== undefined ? { maxAge } : {}),
    });
  }
}

function fieldErrorsFrom(detail: unknown): Record<string, string[]> | undefined {
  if (!detail) return undefined;
  if (Array.isArray(detail)) {
    const out: Record<string, string[]> = {};
    for (const item of detail as { path?: string; message?: string }[]) {
      const key = item.path || 'form';
      (out[key] ??= []).push(item.message ?? 'Invalid value.');
    }
    return out;
  }
  if (typeof detail === 'object') {
    const out: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(detail as Record<string, unknown>)) {
      out[key] = Array.isArray(val) ? val.map(String) : [String(val)];
    }
    return out;
  }
  return undefined;
}

// ── Login ──────────────────────────────────────────────────────────────────

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const identifier = String(formData.get('identifier') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '');

  if (!identifier || !password) {
    return { status: 'error', message: 'Enter your username and password.' };
  }

  const result = await apiFetch<{ session: { activeOrganizationId: string | null } }>(
    '/api/v1/auth/login',
    { method: 'POST', body: { identifier, password }, withSession: false },
  );

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error?.message ?? 'Sign-in failed.',
      requestId: result.requestId,
    };
  }

  await applyCookies(result.setCookie);

  // Remember the active organization so the next request resolves to the same
  // context. Not authoritative — the API re-checks membership every time.
  const orgId = result.data?.session.activeOrganizationId;
  if (orgId) {
    const jar = await cookies();
    jar.set(ORG_COOKIE, orgId, { httpOnly: false, sameSite: 'lax', path: '/' });
  }

  // Only same-origin paths, so `?next=` cannot become an open redirect.
  // Cast because the destination is genuinely dynamic; `typedRoutes` cannot know
  // it, and the same-origin guard above is the real constraint.
  const destination = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  redirect(destination as Parameters<typeof redirect>[0]);
}

// ── Registration ───────────────────────────────────────────────────────────

export async function registerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const payload = {
    email: String(formData.get('email') ?? '').trim(),
    username: String(formData.get('username') ?? '').trim(),
    displayName: String(formData.get('displayName') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
  };

  const result = await apiFetch<{ accepted: boolean; message: string }>('/api/v1/auth/register', {
    method: 'POST', body: payload, withSession: false,
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error?.message ?? 'Registration failed.',
      fieldErrors: fieldErrorsFrom(result.error?.detail),
      requestId: result.requestId,
    };
  }

  return { status: 'success', message: result.data?.message };
}

// ── Logout ─────────────────────────────────────────────────────────────────

export async function logoutAction(): Promise<never> {
  const jar = await cookies();
  const csrf = jar.get(CSRF_COOKIE)?.value;

  await apiFetch('/api/v1/auth/logout', {
    method: 'POST',
    headers: csrf ? { 'x-leoos-csrf': csrf } : {},
  });

  // Cleared locally as well as server-side: if the API call failed, the browser
  // must still stop presenting a token it believes is valid.
  jar.delete(SESSION_COOKIE);
  jar.delete(CSRF_COOKIE);
  jar.delete(ORG_COOKIE);

  redirect('/login');
}

// ── Password reset ─────────────────────────────────────────────────────────

export async function forgotPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = String(formData.get('email') ?? '').trim();
  const result = await apiFetch<{ message: string }>('/api/v1/auth/password/forgot', {
    method: 'POST', body: { email }, withSession: false,
  });

  if (!result.ok) {
    return { status: 'error', message: result.error?.message ?? 'Request failed.', requestId: result.requestId };
  }
  // Always the same outcome, whether or not the address is known.
  return { status: 'success', message: result.data?.message };
}

export async function resetPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get('token') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');

  if (newPassword !== confirm) {
    return { status: 'error', fieldErrors: { confirmPassword: ['Passwords do not match.'] } };
  }

  const result = await apiFetch<{ reset: boolean }>('/api/v1/auth/password/reset', {
    method: 'POST', body: { token, newPassword }, withSession: false,
  });

  if (!result.ok) {
    return {
      status: 'error',
      message: result.error?.message ?? 'Reset failed.',
      fieldErrors: fieldErrorsFrom(result.error?.detail),
      requestId: result.requestId,
    };
  }
  return { status: 'success', message: 'Your password has been changed. You can sign in now.' };
}

export async function verifyEmailAction(token: string): Promise<{ verified: boolean }> {
  const result = await apiFetch<{ verified: boolean }>('/api/v1/auth/verify', {
    method: 'POST', body: { token }, withSession: false,
  });
  return { verified: result.ok && result.data?.verified === true };
}

/** Switches the active organization context. */
export async function switchOrganizationAction(organizationId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ORG_COOKIE, organizationId, { httpOnly: false, sameSite: 'lax', path: '/' });
}
