import 'server-only';
import type { DispatchBoard, DispatchDelta, DispatchIncidentDetail,
  FieldRequestListDto,
} from '@leoos/contracts';
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

/**
 * The unit the caller is currently crewing, or null.
 *
 * Used by the map to mark the viewer's OWN marker. Deliberately narrow: the map
 * needs one id, and pulling the whole dispatch board for it would fetch a queue
 * of incidents the map does not draw. A refusal is `null` rather than an error —
 * somebody with no dispatch access still gets a map, they simply have no unit on
 * it to point at.
 */
export async function fetchOwnUnitId(): Promise<string | null> {
  const res = await apiFetch<{ self: { unitId: string | null } }>('/api/v1/dispatch/self');
  return res.ok && res.data ? res.data.self.unitId : null;
}

/**
 * Live field requests for the organizations the caller may see.
 *
 * A SEPARATE REQUEST from the board, on purpose. The board is a large payload
 * that changes when anything changes; field requests are a handful of rows that
 * appear and vanish on their own clock. Folding them into the board would mean
 * refetching every incident and unit because somebody dropped a pin.
 *
 * They still share the board's REVISION, so the two cannot disagree about
 * whether anything changed.
 */
export async function fetchFieldRequests(): Promise<FieldRequestListDto | null> {
  const res = await apiFetch<FieldRequestListDto>('/api/v1/dispatch/field-requests');
  if (!res.ok || !res.data) return null;
  return res.data;
}
