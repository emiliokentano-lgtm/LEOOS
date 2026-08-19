import { NextResponse } from 'next/server';
import { fetchMapTick } from '@/lib/map';

/**
 * Position tick.
 *
 * `no-store` is not a nicety here: a cached tick is a unit drawn where it no
 * longer is, and an operator acting on a stale position is the failure this
 * whole subsystem exists to avoid.
 *
 * The unit id list is passed through untrusted. It only tells the API which
 * units the client already knows about, so removals can be computed; the API
 * re-derives visibility from the caller's permissions on every tick and the
 * list can never widen what comes back.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let knownUnitIds: string[] = [];
  try {
    const body: unknown = await request.json();
    const ids = (body as { knownUnitIds?: unknown })?.knownUnitIds;
    if (Array.isArray(ids)) {
      knownUnitIds = ids.filter((id): id is string => typeof id === 'string').slice(0, 1000);
    }
  } catch {
    // An unparseable body is a full tick, not an error: the client still needs
    // positions, and it will simply not learn about removals this round.
  }

  const body = await fetchMapTick(knownUnitIds);
  if (!body) {
    return NextResponse.json({ error: 'The map is unavailable.' }, { status: 503 });
  }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
