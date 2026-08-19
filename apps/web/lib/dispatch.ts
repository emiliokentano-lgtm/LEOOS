import 'server-only';
import type { DispatchBoard, DispatchDelta, DispatchIncidentDetail } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Dispatch data access.
 *
 * A pass-through. What is on the board — which calls, which units, which
 * panics — is decided entirely by the API (ADR-0001, engineering rule 9).
 * Nothing here filters or hides.
 */

export async function fetchDispatchBoard(
  opts: { includeClosed?: boolean } = {},
): Promise<DispatchBoard | null> {
  const query = opts.includeClosed ? '?includeClosed=true' : '';
  const res = await apiFetch<DispatchBoard>(`/api/v1/dispatch/board${query}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchDispatchDelta(
  revision: string | null,
  includeClosed: boolean,
): Promise<DispatchDelta | null> {
  const res = await apiFetch<DispatchDelta>('/api/v1/dispatch/board/poll', {
    method: 'POST',
    body: { revision, includeClosed },
  });
  return res.ok && res.data ? res.data : null;
}

export async function fetchIncidentDetail(
  incidentId: string,
): Promise<DispatchIncidentDetail | null> {
  const res = await apiFetch<DispatchIncidentDetail>(
    `/api/v1/dispatch/incidents/${incidentId}`,
  );
  return res.ok && res.data ? res.data : null;
}
