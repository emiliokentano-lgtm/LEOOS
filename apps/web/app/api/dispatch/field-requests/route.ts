import { NextResponse } from 'next/server';
import type { FieldRequestListDto } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * Live field requests, for the strip above the dispatch board.
 *
 * A pass-through, like every other read here: what the caller may see is
 * decided entirely by the API from their membership, and nothing in this file
 * filters, hides or adds.
 */
export async function GET(): Promise<NextResponse> {
  const res = await apiFetch<FieldRequestListDto>('/api/v1/dispatch/field-requests');

  /**
   * A refusal is an ANSWER, not an outage.
   *
   * An operator with a membership but no `dispatch.view` gets a 403 here, and
   * passing that through as an error made the same class of bug the dashboard
   * had: a screen reporting "lost contact with the server" while nothing was
   * wrong. An empty list is the truthful answer — there is nothing they may
   * see.
   */
  if (res.status === 403 || res.status === 404) {
    return NextResponse.json(
      { requests: [], revision: '0:0' },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!res.ok || !res.data) {
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
