import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchMapSnapshot } from '@/lib/map';
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
  const snapshot = await fetchMapSnapshot();

  return <MapView initialSnapshot={snapshot} />;
}
