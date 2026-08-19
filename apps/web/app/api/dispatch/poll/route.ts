import { NextResponse } from 'next/server';
import { fetchDispatchDelta } from '@/lib/dispatch';

/**
 * Dispatch poll, for the client.
 *
 * A client component cannot call the API directly — the session cookie and the
 * internal service token live server-side (ADR-0010) — so this is the hop. It
 * adds no authorization of its own.
 *
 * `no-store` is not a nicety: a cached dispatch board shows calls that are
 * already finished and units that have already moved.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let revision: string | null = null;
  let includeClosed = false;
  try {
    const body = (await request.json()) as { revision?: unknown; includeClosed?: unknown };
    if (typeof body.revision === 'string') revision = body.revision;
    if (typeof body.includeClosed === 'boolean') includeClosed = body.includeClosed;
  } catch {
    // An unparseable body means a full board rather than an error: the operator
    // still needs the screen, they simply do not get the cheap path this round.
  }

  const body = await fetchDispatchDelta(revision, includeClosed);
  if (!body) {
    return NextResponse.json({ error: 'Dispatch is unavailable.' }, { status: 503 });
  }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
