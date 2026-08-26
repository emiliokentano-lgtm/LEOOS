import { NextResponse } from 'next/server';
import type { TaskListDto } from '@leoos/contracts';
import { apiFetch } from '@/lib/api-client';

/**
 * The caller's own tasks, for the dashboard panel.
 *
 * A pass-through. What is on the list is decided entirely by the API from the
 * caller's membership; nothing here filters or adds.
 */
export async function GET(): Promise<NextResponse> {
  const res = await apiFetch<TaskListDto>('/api/v1/tasks');

  /**
   * A refusal is an ANSWER. An account with no membership has no tasks, which
   * is a truthful empty list rather than an error — the same lesson the
   * dashboard learned when a missing `dispatch.view` reported "lost contact
   * with the server" while nothing was wrong.
   */
  if (res.status === 403 || res.status === 404) {
    return NextResponse.json(
      { tasks: [], counts: { overdue: 0, dueSoon: 0, open: 0 } },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!res.ok || !res.data) {
    // A genuine failure is reported AS a failure, so the panel can say the list
    // could not be loaded rather than showing an empty one.
    return NextResponse.json({ error: 'unavailable' }, { status: res.status });
  }
  return NextResponse.json(res.data, { headers: { 'cache-control': 'no-store' } });
}
