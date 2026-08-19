import { NextResponse } from 'next/server';
import { fetchSearch } from '@/lib/search';

/**
 * Search, for the palette.
 *
 * A client component cannot call the API directly — the session cookie and the
 * internal service token are held server-side (ADR-0010) — so this is the hop.
 * It is a pass-through and adds no authorization of its own: the API resolves
 * which categories this caller may search, filters every result and count, and
 * audits the search.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const category = url.searchParams.get('category') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
  const offset = Number(url.searchParams.get('offset') ?? '') || undefined;

  const body = await fetchSearch({ q, category, limit, offset });
  if (!body) {
    return NextResponse.json({ error: 'Search is unavailable.' }, { status: 503 });
  }

  // Operational records must never sit in a shared or browser cache.
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
