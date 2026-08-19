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
  if (!res.ok || !res.data) {
    // 404 here means the caller has no dispatch access at all. The shell renders
    // no status control rather than an error: not every account is operational.
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
