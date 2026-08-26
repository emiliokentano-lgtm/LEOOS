import { NextResponse, type NextRequest } from 'next/server';
import type { MessagePageDto } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * One page of a thread.
 *
 * A pass-through, and deliberately so: the per-viewer link resolution that
 * makes chat safe happens in the API, against the caller's own permissions. A
 * web tier that cached or reshaped this would be a web tier that could serve
 * one operator's view of a message to another.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await params;
  const cursor = request.nextUrl.searchParams.get('cursor');

  const res = await apiFetch<MessagePageDto>(
    `/api/v1/chat/conversations/${conversationId}/messages`
    + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
  );

  if (!res.ok || !res.data) {
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
