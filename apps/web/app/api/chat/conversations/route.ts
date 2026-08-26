import { NextResponse } from 'next/server';
import type { ConversationListDto } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * The caller's conversations.
 *
 * A pass-through. Which conversations exist for this caller is decided entirely
 * by the API from their membership of each one; nothing here filters.
 */
export async function GET(): Promise<NextResponse> {
  const res = await apiFetch<ConversationListDto>('/api/v1/chat/conversations');

  // No membership is an ordinary state — a global administrator is in it — so
  // it is an empty list, not an error.
  if (res.status === 403 || res.status === 404) {
    return NextResponse.json(
      { conversations: [], totalUnread: 0 },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!res.ok || !res.data) {
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
