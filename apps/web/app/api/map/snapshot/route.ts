import { NextResponse } from 'next/server';
import { fetchMapSnapshot } from '@/lib/map';

/**
 * Map snapshot, for the client after a resync.
 *
 * A client component cannot call the API directly — the session cookie and the
 * internal service token live server-side (ADR-0010) — so this is the hop. It
 * adds no authorization of its own; the API decides what is in the payload.
 */
export async function GET(): Promise<NextResponse> {
  const body = await fetchMapSnapshot();
  if (!body) {
    return NextResponse.json({ error: 'The map is unavailable.' }, { status: 503 });
  }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
