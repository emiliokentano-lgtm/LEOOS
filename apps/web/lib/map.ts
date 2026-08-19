import 'server-only';
import type { MapSnapshot, MapTick } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Map data access.
 *
 * A pass-through. Which units, incidents and markers this caller may see is
 * decided entirely by the API (ADR-0001, engineering rule 9) — nothing here
 * filters, hides, or decides. In particular the covert-unit rule is applied in
 * SQL before serialisation, so a unit that is not in the response was never
 * sent, rather than removed on the way through.
 */

export async function fetchMapSnapshot(): Promise<MapSnapshot | null> {
  const res = await apiFetch<MapSnapshot>('/api/v1/map/snapshot');
  return res.ok && res.data ? res.data : null;
}

export async function fetchMapTick(knownUnitIds: string[]): Promise<MapTick | null> {
  const res = await apiFetch<MapTick>('/api/v1/map/tick', {
    method: 'POST',
    body: { knownUnitIds },
  });
  return res.ok && res.data ? res.data : null;
}
