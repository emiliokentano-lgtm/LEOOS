import type { WorldPosition } from './geo';
import { projectToScreen, type ScreenPoint, type Viewport } from './map-viewport';

/**
 * Screen-space grid clustering.
 *
 * Units bunch up: an entire shift parks at the station, four cars converge on
 * one call. Drawn individually at low zoom that is an unreadable pile of
 * overlapping chevrons, and the callsign labels turn into a smear.
 *
 * The approach is a fixed screen-space grid rather than a distance-based
 * hierarchy (DBSCAN, supercluster and friends). Three reasons:
 *
 *   • It is O(n) per frame with no preprocessing, and the input set changes
 *     every tick. A hierarchical index has to be rebuilt as things move, which
 *     is the opposite of what a live feed wants.
 *   • Clustering in SCREEN space is what the eye actually cares about: two units
 *     500 m apart overlap when zoomed out and do not when zoomed in, which is
 *     exactly what a screen-space cell captures and a world-space one does not.
 *   • It is stable. Grid membership changes only when a marker crosses a cell
 *     boundary, so clusters do not flicker in and out between frames the way a
 *     nearest-neighbour rule does when two markers hover at its threshold.
 *
 * The cost is that a cell boundary can split a visually tight pair. At the cell
 * size used here that is a cosmetic nuisance, not a correctness problem, and the
 * operator resolves it by zooming — which is the gesture they would have used
 * anyway.
 */

export interface Clusterable {
  id: string;
  position: WorldPosition;
}

export interface Cluster<T extends Clusterable> {
  /** Stable across frames while membership holds — used as a React key. */
  key: string;
  /** Screen position: the centroid of the members, not the cell centre. */
  point: ScreenPoint;
  members: T[];
}

export interface ClusterOptions {
  /** Grid cell edge in css pixels. */
  cellSize?: number;
  /** Below this many members a cell is emitted as individual items instead. */
  minMembers?: number;
  /** Above this scale nothing is clustered — the operator has zoomed in to look. */
  disableAboveScale?: number;
}

export interface ClusterResult<T extends Clusterable> {
  /** Items drawn individually. */
  singles: { item: T; point: ScreenPoint }[];
  /** Cells that collapsed. */
  clusters: Cluster<T>[];
}

export const DEFAULT_CLUSTER_CELL = 44;

export function clusterByScreenGrid<T extends Clusterable>(
  items: readonly T[],
  viewport: Viewport,
  options: ClusterOptions = {},
): ClusterResult<T> {
  const {
    cellSize = DEFAULT_CLUSTER_CELL,
    minMembers = 3,
    disableAboveScale = 0.09,
  } = options;

  const projected = items.map((item) => ({ item, point: projectToScreen(viewport, item.position) }));

  if (viewport.scale >= disableAboveScale) {
    return { singles: projected, clusters: [] };
  }

  const cells = new Map<string, { item: T; point: ScreenPoint }[]>();
  for (const entry of projected) {
    const cx = Math.floor(entry.point.x / cellSize);
    const cy = Math.floor(entry.point.y / cellSize);
    const key = `${cx}:${cy}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(entry);
    else cells.set(key, [entry]);
  }

  const singles: { item: T; point: ScreenPoint }[] = [];
  const clusters: Cluster<T>[] = [];

  for (const [, bucket] of cells) {
    if (bucket.length < minMembers) {
      singles.push(...bucket);
      continue;
    }
    let sx = 0;
    let sy = 0;
    for (const entry of bucket) {
      sx += entry.point.x;
      sy += entry.point.y;
    }
    // Keyed by membership, sorted, so the key survives the map iteration order
    // changing between ticks.
    const ids = bucket.map((entry) => entry.item.id).sort();
    clusters.push({
      key: `c:${ids.join(',')}`,
      point: { x: sx / bucket.length, y: sy / bucket.length },
      members: bucket.map((entry) => entry.item),
    });
  }

  return { singles, clusters };
}
