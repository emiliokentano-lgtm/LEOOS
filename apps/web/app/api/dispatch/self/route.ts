import { NextResponse } from 'next/server';
import type { DispatchBoard } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * The caller's own dispatch state, for the shell.
 *
 * The status control and panic button live in the top bar on every screen, so
 * this exists to serve them without loading a whole dispatch board per page.
 */
export async function GET(): Promise<NextResponse> {
  const res = await apiFetch<{ self: DispatchBoard['self']; statuses: DispatchBoard['statuses'] }>(
    '/api/v1/dispatch/self',
  );
  /**
   * "No dispatch access" is an ANSWER, not a missing resource.
   *
   * The API returns 404 when the caller has no dispatch state — an account with
   * no membership, which is exactly what a global administrator is. Passing that
   * through as a 404 made the shell ask a question every few seconds that could
   * never be answered, and filled the browser console with what looked like a
   * bug on every administration screen.
   *
   * So the absence is reported as a successful empty state with
   * `available: false`, and the shell stops asking. A 401 or a 503 still comes
   * through as itself: those are transient, and giving up on them would leave an
   * operational shell blank after one blip.
   */
  if (res.status === 404) {
    return NextResponse.json(
      { self: null, statuses: [], available: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!res.ok || !res.data) {
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(
    { ...res.data, available: true },
    { headers: { 'cache-control': 'no-store' } },
  );
}
