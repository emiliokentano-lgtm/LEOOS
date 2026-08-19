import { describe, expect, it } from 'vitest';
import { MAP, WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH, worldDistance } from '../src/geo';
import {
  MAX_SCALE, centerViewport, clampScale, clampViewport, fitViewport, isVisible,
  minScaleFor, panViewport, projectToScreen, resizeViewport, scaleToTileZoom,
  screenToWorld, visibleBounds, worldViewport, type Viewport,
} from '../src/map-viewport';

const VIEW = { width: 1200, height: 800 };

/**
 * A scale with pan headroom.
 *
 * Below `minScaleFor(...)` the world is smaller than the viewport and
 * `clampViewport` pins the centre — correct behaviour, but it makes any test of
 * panning or follow-mode assert against the clamp instead of against the thing
 * under test. Anything exercising camera movement zooms in past this first.
 */
const PANNABLE_SCALE = 0.3;

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { center: { x: 0, y: 0 }, scale: 0.05, ...VIEW, ...over };
}

describe('projection', () => {
  it('puts the viewport centre at the middle of the screen', () => {
    const vp = viewport({ center: { x: 250, y: -800 } });
    expect(projectToScreen(vp, { x: 250, y: -800 }))
      .toEqual({ x: VIEW.width / 2, y: VIEW.height / 2 });
  });

  it('flips the y axis — GTA north is screen up', () => {
    const vp = viewport();
    const north = projectToScreen(vp, { x: 0, y: 1000 });
    const south = projectToScreen(vp, { x: 0, y: -1000 });
    expect(north.y).toBeLessThan(south.y);
  });

  it('round-trips screen ↔ world', () => {
    const vp = viewport({ center: { x: -1200, y: 3400 }, scale: 0.037 });
    const point = { x: 931, y: 208 };
    const back = projectToScreen(vp, screenToWorld(vp, point));
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * The previous renderer projected through the normalised map plane, which
   * scales x by 1/8500 and y by 1/13000. A square in the world came out 1.53×
   * taller than wide on screen: heading arrows pointed in the wrong direction
   * and nothing measured on the map meant anything. Projecting from world
   * metres makes the scale isotropic by construction — this test is what keeps
   * it that way.
   */
  it('is isotropic: equal world distances are equal screen distances on both axes', () => {
    const vp = viewport();
    const origin = projectToScreen(vp, { x: 0, y: 0 });
    const east = projectToScreen(vp, { x: 1000, y: 0 });
    const north = projectToScreen(vp, { x: 0, y: 1000 });

    const dx = Math.hypot(east.x - origin.x, east.y - origin.y);
    const dy = Math.hypot(north.x - origin.x, north.y - origin.y);
    expect(dx).toBeCloseTo(dy, 9);
  });

  it('preserves a 45° world bearing as a 45° screen bearing', () => {
    const vp = viewport();
    const origin = projectToScreen(vp, { x: 0, y: 0 });
    const diagonal = projectToScreen(vp, { x: 1000, y: 1000 });
    expect(Math.abs(diagonal.x - origin.x)).toBeCloseTo(Math.abs(diagonal.y - origin.y), 9);
  });

  it('scale means screen pixels per world metre', () => {
    const vp = viewport({ scale: 0.25 });
    const a = projectToScreen(vp, { x: 0, y: 0 });
    const b = projectToScreen(vp, { x: 400, y: 0 });
    expect(b.x - a.x).toBeCloseTo(400 * 0.25, 9);
  });
});

describe('clamping', () => {
  it('never zooms out past the point where the whole world is visible', () => {
    const floor = minScaleFor(VIEW.width, VIEW.height);
    expect(clampScale(0.000001, VIEW.width, VIEW.height)).toBe(floor);
    expect(floor).toBeCloseTo(Math.min(VIEW.width / WORLD_WIDTH, VIEW.height / WORLD_HEIGHT), 12);
  });

  it('caps zoom-in', () => {
    expect(clampScale(999, VIEW.width, VIEW.height)).toBe(MAX_SCALE);
  });

  it('keeps the world covering the viewport when panned to an extreme', () => {
    const vp = clampViewport(viewport({ center: { x: 900_000, y: -900_000 }, scale: 0.2 }));
    const seen = visibleBounds(vp);
    expect(seen.minX).toBeGreaterThanOrEqual(WORLD_BOUNDS.minX - 1e-6);
    expect(seen.maxX).toBeLessThanOrEqual(WORLD_BOUNDS.maxX + 1e-6);
    expect(seen.minY).toBeGreaterThanOrEqual(WORLD_BOUNDS.minY - 1e-6);
    expect(seen.maxY).toBeLessThanOrEqual(WORLD_BOUNDS.maxY + 1e-6);
  });

  it('centres rather than clamps an axis the world cannot fill', () => {
    // At the minimum scale the shorter axis has slack; jittering against an edge
    // it cannot reach would read as the map fighting the operator.
    const vp = clampViewport(viewport({ scale: minScaleFor(VIEW.width, VIEW.height) }));
    const expected = { x: (WORLD_BOUNDS.minX + WORLD_BOUNDS.maxX) / 2,
      y: (WORLD_BOUNDS.minY + WORLD_BOUNDS.maxY) / 2 };
    expect(vp.center.x).toBeCloseTo(expected.x, 6);
    expect(vp.center.y).toBeCloseTo(expected.y, 6);
  });

  it('pins the centre once the world no longer fills the viewport', () => {
    // Zoomed out this far there is nothing to pan TO, so follow mode and drags
    // both resolve to the same framing. Asserted because it is surprising the
    // first time you meet it, not because it is wrong.
    // 0.08 is above the fit-everything floor but still wider than the world
    // horizontally, so x is pinned while y retains a genuine pan range.
    const zoomedOut = viewport({ scale: 0.08 });
    expect(zoomedOut.scale).toBeGreaterThan(minScaleFor(VIEW.width, VIEW.height));
    const followed = centerViewport(zoomedOut, { x: 4000, y: 8000 });
    expect(followed.center.x).toBeCloseTo((WORLD_BOUNDS.minX + WORLD_BOUNDS.maxX) / 2, 6);
    expect(followed.center.y).toBeLessThan(8000);
    expect(followed.center.y).toBeGreaterThan(0);
  });

  it('survives a zero-size viewport without producing NaN', () => {
    const vp = clampViewport({ center: { x: 0, y: 0 }, scale: 0.05, width: 0, height: 0 });
    expect(Number.isFinite(vp.scale)).toBe(true);
    expect(Number.isFinite(vp.center.x)).toBe(true);
    expect(Number.isFinite(vp.center.y)).toBe(true);
  });
});

describe('panning', () => {
  it('moves the map with the pointer', () => {
    const vp = viewport({ center: { x: 0, y: 0 }, scale: PANNABLE_SCALE });
    const dragged = panViewport(vp, 100, 0);
    // Dragging right reveals what was to the west, so the centre moves west.
    expect(dragged.center.x).toBeLessThan(vp.center.x);
  });

  it('keeps a grabbed world point under the pointer', () => {
    const vp = viewport({ scale: PANNABLE_SCALE });
    const grabbed = screenToWorld(vp, { x: 500, y: 300 });
    const dragged = panViewport(vp, 60, -40);
    const under = screenToWorld(dragged, { x: 560, y: 260 });
    expect(under.x).toBeCloseTo(grabbed.x, 6);
    expect(under.y).toBeCloseTo(grabbed.y, 6);
  });
});

describe('fitting', () => {
  it('frames a set of positions', () => {
    const bounds = { minX: -500, minY: -500, maxX: 500, maxY: 500 };
    const vp = fitViewport(bounds, VIEW.width, VIEW.height);
    expect(vp.center).toEqual({ x: 0, y: 0 });
    const corner = projectToScreen(vp, { x: bounds.minX, y: bounds.maxY });
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.y).toBeGreaterThan(0);
  });

  it('does not divide by zero when everything is in one place', () => {
    // A whole shift parked at the station is the normal case at shift change.
    const point = { minX: 100, minY: 100, maxX: 100, maxY: 100 };
    const vp = fitViewport(point, VIEW.width, VIEW.height);
    expect(Number.isFinite(vp.scale)).toBe(true);
    expect(vp.scale).toBeLessThanOrEqual(MAX_SCALE);
    // Enough context around the pin to be useful, not a wall of tarmac.
    const seen = visibleBounds(vp);
    expect(seen.maxX - seen.minX).toBeGreaterThan(300);
  });

  it('respects the maximum fit zoom', () => {
    const vp = fitViewport({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, VIEW.width, VIEW.height,
      { maxScale: 0.2 });
    expect(vp.scale).toBeLessThanOrEqual(0.2);
  });

  it('frames the whole world by default', () => {
    const vp = worldViewport(VIEW.width, VIEW.height);
    const seen = visibleBounds(vp);
    expect(seen.maxX - seen.minX).toBeGreaterThanOrEqual(WORLD_WIDTH - 1);
  });
});

describe('follow mode and resizing', () => {
  it('recentres without changing zoom', () => {
    const vp = viewport({ scale: PANNABLE_SCALE });
    const followed = centerViewport(vp, { x: 1500, y: 2500 });
    expect(followed.scale).toBe(vp.scale);
    expect(followed.center.x).toBeCloseTo(1500, 6);
    expect(followed.center.y).toBeCloseTo(2500, 6);
  });

  it('re-clamps the scale when the viewport shrinks', () => {
    const vp = viewport({ scale: minScaleFor(VIEW.width, VIEW.height) });
    const bigger = resizeViewport(vp, 3000, 2000);
    expect(bigger.scale).toBeGreaterThanOrEqual(minScaleFor(3000, 2000));
  });
});

describe('visibility', () => {
  it('reports what is on screen', () => {
    const vp = viewport({ center: { x: 0, y: 0 }, scale: 0.1 });
    expect(isVisible(vp, { x: 0, y: 0 })).toBe(true);
    expect(isVisible(vp, { x: 100_000, y: 0 })).toBe(false);
  });

  it('includes a margin so a marker does not pop at the edge', () => {
    const vp = viewport({ center: { x: 0, y: 0 }, scale: 0.1 });
    const justOff = { x: (VIEW.width / 2) / 0.1 + 100, y: 0 };
    expect(isVisible(vp, justOff, 0)).toBe(false);
    expect(isVisible(vp, justOff, 200)).toBe(true);
  });
});

describe('tile zoom', () => {
  it('stays within the pyramid the tile set will ship', () => {
    for (const scale of [0.0001, 0.01, 0.05, 0.5, 10]) {
      const z = scaleToTileZoom(scale);
      expect(z).toBeGreaterThanOrEqual(MAP.minZoom);
      expect(z).toBeLessThanOrEqual(MAP.maxZoom);
    }
  });

  it('increases with scale', () => {
    expect(scaleToTileZoom(0.2)).toBeGreaterThan(scaleToTileZoom(0.02));
  });
});

describe('scale is metrically meaningful', () => {
  it('lets a distance measured on screen be converted back to metres', () => {
    const vp = viewport({ scale: 0.08 });
    const a = { x: -300, y: 1200 };
    const b = { x: 900, y: -400 };
    const pa = projectToScreen(vp, a);
    const pb = projectToScreen(vp, b);
    const metres = Math.hypot(pb.x - pa.x, pb.y - pa.y) / vp.scale;
    expect(metres).toBeCloseTo(worldDistance(a, b), 6);
  });
});
