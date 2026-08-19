import { NextResponse } from 'next/server';
import { fetchDashboardDelta } from '@/lib/dashboard';

/**
 * Dashboard poll, for the client.
 *
 * A client component cannot call the API directly — the session cookie and the
 * internal service token live server-side (ADR-0010) — so this is the hop.
 *
 * `no-store`: a cached dashboard is the one failure this screen cannot have. Its
 * entire purpose is to be true right now.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let revision: string | null = null;
  try {
    const body = (await request.json()) as { revision?: unknown };
    if (typeof body.revision === 'string') revision = body.revision;
  } catch {
    // An unparseable body means a full snapshot rather than an error: the
    // operator still needs the screen.
  }

  const body = await fetchDashboardDelta(revision);
  if (!body) {
    return NextResponse.json({ error: 'The dashboard is unavailable.' }, { status: 503 });
  }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
