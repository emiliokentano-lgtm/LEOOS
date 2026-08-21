import { NextResponse } from 'next/server';
import type { UnreadSummary } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * The badge, on its own.
 *
 * Separate from the feed because the shell polls this on every screen and only
 * opens the feed when somebody clicks the bell. Loading a page of notifications
 * to render a number would be the single most wasteful request in the
 * application.
 */
export async function GET(): Promise<NextResponse> {
  const res = await apiFetch<UnreadSummary>('/api/v1/notifications/unread');
  if (!res.ok || !res.data) {
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
