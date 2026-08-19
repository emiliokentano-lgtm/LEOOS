import { describe, expect, it } from 'vitest';
import { DEFAULT_CLUSTER_CELL, clusterByScreenGrid } from '../src/map-cluster';
import type { Viewport } from '../src/map-viewport';

const VP: Viewport = { center: { x: 0, y: 0 }, scale: 0.02, width: 1200, height: 800 };

function pin(id: string, x: number, y: number) {
  return { id, position: { x, y } };
}

describe('screen-grid clustering', () => {
  it('collapses a pile of markers standing on top of each other', () => {
    // Shift change: the whole roster is parked at the station.
    const items = Array.from({ length: 8 }, (_, i) => pin(`u${i}`, i * 2, i * 2));
    const { singles, clusters } = clusterByScreenGrid(items, VP);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(8);
    expect(singles).toHaveLength(0);
  });

  it('leaves markers that are far apart alone', () => {
    const spread = DEFAULT_CLUSTER_CELL / VP.scale * 3;
    const items = [pin('a', 0, 0), pin('b', spread, 0), pin('c', spread * 2, 0)];
    const { singles, clusters } = clusterByScreenGrid(items, VP);
    expect(clusters).toHaveLength(0);
    expect(singles).toHaveLength(3);
  });

  it('emits a below-threshold cell as individuals rather than a cluster of two', () => {
    // A cluster badge reading "2" costs a click and reveals nothing.
    const items = [pin('a', 0, 0), pin('b', 5, 5)];
    const { singles, clusters } = clusterByScreenGrid(items, VP);
    expect(clusters).toHaveLength(0);
    expect(singles).toHaveLength(2);
  });

  it('stops clustering once the operator has zoomed in to look', () => {
    const items = Array.from({ length: 8 }, (_, i) => pin(`u${i}`, i * 2, i * 2));
    const zoomedIn: Viewport = { ...VP, scale: 0.4 };
    const { singles, clusters } = clusterByScreenGrid(items, zoomedIn);
    expect(clusters).toHaveLength(0);
    expect(singles).toHaveLength(8);
  });

  it('never loses or duplicates a marker', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => pin(`near${i}`, i, i)),
      pin('far', 6000, -3000),
      pin('further', -3500, 7000),
    ];
    const { singles, clusters } = clusterByScreenGrid(items, VP);
    const seen = [
      ...singles.map((s) => s.item.id),
      ...clusters.flatMap((c) => c.members.map((m) => m.id)),
    ].sort();
    expect(seen).toEqual(items.map((i) => i.id).sort());
  });

  it('places a cluster at the centroid of its members, not the cell centre', () => {
    const { clusters } = clusterByScreenGrid(
      [pin('a', 0, 0), pin('b', 10, 0), pin('c', 20, 0)], VP,
    );
    expect(clusters).toHaveLength(1);
    // Members are collinear on x, so the centroid must be too.
    expect(clusters[0]!.point.y).toBeCloseTo(VP.height / 2, 6);
  });

  it('keys a cluster by membership so it survives map iteration order', () => {
    // The key is a React key; if it changed every tick the badge would remount
    // and any open popover would close under the operator's cursor.
    const items = [pin('c', 0, 0), pin('a', 4, 4), pin('b', 8, 8)];
    const first = clusterByScreenGrid(items, VP).clusters[0]!.key;
    const reordered = clusterByScreenGrid([...items].reverse(), VP).clusters[0]!.key;
    expect(first).toBe(reordered);
  });

  it('handles an empty input', () => {
    expect(clusterByScreenGrid([], VP)).toEqual({ singles: [], clusters: [] });
  });
});
