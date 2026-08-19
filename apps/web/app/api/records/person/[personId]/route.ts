import { NextResponse } from 'next/server';
import { fetchPersonProfile } from '@/lib/persons';

/**
 * Person profile, for the detail drawer.
 *
 * A client component cannot call the API directly — the session cookie and the
 * internal service token are held server-side (ADR-0010) — so this is the hop.
 * It is a pass-through and adds no authorization of its own: the API decides
 * which sections this caller may see, and audits the read.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ personId: string }> },
): Promise<NextResponse> {
  const { personId } = await params;
  const profile = await fetchPersonProfile(personId);
  if (!profile) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  // A person record must never sit in a shared or browser cache.
  return NextResponse.json(profile, { headers: { 'cache-control': 'no-store' } });
}
