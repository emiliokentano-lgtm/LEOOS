import { NextResponse } from 'next/server';
import { apiFetch } from '@/lib/api-client';

/**
 * Mints a WebSocket ticket for the browser.
 *
 * THE HOP EXISTS BECAUSE THE COOKIE CANNOT CROSS. `leoos_session` is set on the
 * web tier's own origin, HttpOnly and SameSite=Lax, so a browser opening a
 * socket to the API origin sends nothing at all. This route is the one place
 * that has the cookie AND can talk to the API, so it is where the exchange
 * happens (ADR-0013).
 *
 * The browser receives a ticket that is good for thirty seconds, once. It is
 * never stored, never put in a URL, and never reused — a reconnect mints a new
 * one.
 */

/**
 * Where the browser should connect.
 *
 * Resolved here, from server-side configuration, rather than from a
 * `NEXT_PUBLIC_` variable: it keeps the deployment topology in one place and
 * out of the client bundle. Falling back to the API URL with the scheme swapped
 * is right for local development and wrong nowhere — behind a proxy the
 * variable is set explicitly.
 */
function websocketUrl(): string {
  const explicit = process.env.LEOOS_PUBLIC_WS_URL;
  if (explicit) return explicit;

  const api = process.env.LEOOS_API_URL ?? 'http://localhost:3001';
  return `${api.replace(/^http/, 'ws')}/ws`;
}

export async function POST(): Promise<NextResponse> {
  const res = await apiFetch<{ ticket: string; expiresAt: string; heartbeatMs: number }>(
    '/api/v1/realtime/ticket',
    { method: 'POST' },
  );

  if (!res.ok || !res.data) {
    // 401 here means the session has gone. The client stops rather than
    // reconnecting forever against a door that will not open.
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }

  return NextResponse.json(
    { ...res.data, url: websocketUrl() },
    // A cached ticket is a ticket that authenticates somebody else.
    { headers: { 'cache-control': 'no-store' } },
  );
}
