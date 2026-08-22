import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchMapSnapshot } from '@/lib/map';
import { fetchOwnUnitId } from '@/lib/dispatch';
import { MapView } from './map-view';

export const metadata: Metadata = { title: 'Live Map' };

/**
 * Live map.
 *
 * The first snapshot is fetched server-side so the map paints with units already
 * on it rather than a spinner that turns into them — the target is under 1.5 s
 * to an interactive map (docs/architecture/05-map.md §7). Subsequent positions
 * arrive through the client data source.
 *
 * What is in that snapshot is decided entirely by the API. This page does not
 * filter and does not know which units were withheld.
 */
export default async function MapPage() {
  await requireSession();

  /**
   * The viewer's own unit, so the map can say which marker is THEIRS.
   *
   * "Which one am I" is the first question anybody asks of a map with two
   * hundred markers on it, and nothing on the screen answered it. Fetched
   * alongside the snapshot rather than after it — neither depends on the other,
   * and the map's budget is 1.5 s to interactive.
   */
  const [snapshot, ownUnitId] = await Promise.all([fetchMapSnapshot(), fetchOwnUnitId()]);

  return <MapView initialSnapshot={snapshot} ownUnitId={ownUnitId} />;
}
