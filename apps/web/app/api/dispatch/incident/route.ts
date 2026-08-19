import { NextResponse } from 'next/server';
import { fetchIncidentDetail } from '@/lib/dispatch';

/**
 * Incident detail, for the client.
 *
 * Loaded on selection rather than shipped with the board: the timeline is
 * unbounded in a way the queue is not, and pushing every call's full history
 * into every poll would make the common case pay for the rare one.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get('id');
  if (id === null || id === '') {
    return NextResponse.json({ error: 'Missing incident id.' }, { status: 400 });
  }

  const body = await fetchIncidentDetail(id);
  if (!body) {
    return NextResponse.json({ error: 'Incident not found.' }, { status: 404 });
  }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
