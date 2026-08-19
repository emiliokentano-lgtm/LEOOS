import { NextResponse } from 'next/server';
import { fetchPersonnelProfile } from '@/lib/personnel';

/**
 * Personnel profile, for the drawer.
 *
 * The drawer loads on demand rather than shipping every profile with the
 * roster, and a client component cannot call the API directly: the session
 * cookie and the internal service token are held server-side (ADR-0010). This
 * handler is the hop, and it is a pass-through — it adds no authorization of its
 * own and takes no decision. The API scopes the read to the caller's own
 * membership and answers 404 when it is out of scope, which is what surfaces
 * here.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ organizationId: string; memberId: string }> },
): Promise<NextResponse> {
  const { organizationId, memberId } = await params;

  const member = await fetchPersonnelProfile(organizationId, memberId);
  if (!member) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  return NextResponse.json({ member }, {
    // A personnel record must never sit in a shared or browser cache.
    headers: { 'cache-control': 'no-store' },
  });
}
