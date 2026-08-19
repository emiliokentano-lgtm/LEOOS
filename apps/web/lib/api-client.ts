import 'server-only';
import { cookies } from 'next/headers';

/**
 * Server-side API client.
 *
 * The web tier holds the session cookie and forwards it; it never validates
 * credentials and never evaluates permissions for enforcement (ADR-0001). This
 * module is `server-only` so the internal service token cannot be bundled into
 * a client build.
 */

const API_URL = process.env.LEOOS_API_URL ?? 'http://localhost:3001';
const INTERNAL_TOKEN = process.env.LEOOS_INTERNAL_API_TOKEN ?? '';

export const SESSION_COOKIE = 'leoos_session';
export const CSRF_COOKIE = 'leoos_csrf';
export const ORG_COOKIE = 'leoos_org';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string; detail?: unknown };
  requestId?: string;
  /** Cookies the API asked us to set, passed through to the browser. */
  setCookie?: string[];
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Forward the caller's session cookie. Defaults to true. */
  withSession?: boolean;
  headers?: Record<string, string>;
}

export async function apiFetch<T>(path: string, init: ApiRequest = {}): Promise<ApiResult<T>> {
  const { method = 'GET', body, withSession = true, headers = {} } = init;

  const outgoing: Record<string, string> = {
    // Only when there IS a body. Declaring a JSON content-type on a bodyless
    // POST makes Fastify reject the request outright ("Body cannot be empty when
    // content-type is set to 'application/json'"), which broke every action that
    // needs no payload — restoring a role, setting the default role.
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    // Identifies this as the trusted web tier. Exempts the call from the
    // browser-oriented CSRF checks, which do not apply to a server-to-server hop.
    'x-leoos-internal': INTERNAL_TOKEN,
    ...headers,
  };

  if (withSession) {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    const org = jar.get(ORG_COOKIE)?.value;
    if (token) outgoing.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
    if (org) outgoing['x-leoos-organization'] = org;
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: outgoing,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    // A network failure must read as a service outage, not as a rejected login.
    // The underlying cause is deliberately not surfaced: it can name internal
    // hostnames and ports, which do not belong in a browser-facing message.
    return {
      ok: false,
      status: 503,
      error: {
        code: 'API_UNREACHABLE',
        message: 'Cannot reach the LEOOS service. Check your connection and try again.',
      },
    };
  }

  const setCookie = response.headers.getSetCookie?.() ?? [];
  const requestId = response.headers.get('x-request-id') ?? undefined;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string; detail?: unknown } })?.error;
    return {
      ok: false,
      status: response.status,
      error: err ?? { code: 'UNKNOWN', message: 'Request failed.' },
      requestId,
      setCookie,
    };
  }

  return { ok: true, status: response.status, data: payload as T, requestId, setCookie };
}
