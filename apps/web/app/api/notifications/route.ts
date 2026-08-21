import { NextResponse, type NextRequest } from 'next/server';
import type { NotificationPage } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * The notification centre's feed, for the client shell.
 *
 * A Route Handler rather than a server action because the bell POLLS: the
 * socket is the fast path and this is the backstop behind it, and an action
 * invocation per tick would go through the server-action pipeline for what is a
 * plain read.
 *
 * The query is FORWARDED, not rebuilt. Every parameter is validated by a strict
 * schema at the API, so an unknown one is refused there rather than silently
 * dropped here — which means this file cannot become a second, weaker filter.
 * There is no user id in it, here or at the API: the feed's owner comes from the
 * session cookie this fetch carries.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const search = request.nextUrl.search;
  const res = await apiFetch<NotificationPage>(`/api/v1/notifications${search}`);

  if (!res.ok || !res.data) {
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
