import { describe, expect, it } from 'vitest';
import {
  MAP, MAP_PLANE_SIZE, WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH,
  boundsOf, clampToWorld, headingDelta, headingToCompass, isWithinWorldBounds,
  latLngToWorld, lerpHeading, mapToWorld, worldDistance, worldToLatLng, worldToMap,
} from '../src/geo';

/**
 * The coordinate transform is the one piece of map maths that client and server
 * both depend on being identical. A drift here does not throw — it silently puts
 * every marker in the wrong place, which is far worse than a crash.
 *
 * Landmark fixtures are placeholders until calibration (see geo.ts); the
 * ROUND-TRIP and BOUNDARY properties below hold regardless of what the final
 * constants turn out to be, so these tests keep their value across the
 * re-calibration in Phase 6.
 */

describe('world ↔ map plane', () => {
  it('places the world corners at the corners of the plane', () => {
    expect(worldToMap({ x: MAP.worldMinX, y: MAP.worldMaxY })).toEqual({ u: 0, v: 0 });
    expect(worldToMap({ x: MAP.worldMaxX, y: MAP.worldMinY })).toEqual({ u: 1, v: 1 });
  });

  it('puts the world centre at the centre of the plane', () => {
    const centre = worldToMap({
      x: (MAP.worldMinX + MAP.worldMaxX) / 2,
      y: (MAP.worldMinY + MAP.worldMaxY) / 2,
    });
    expect(centre.u).toBeCloseTo(0.5, 12);
    expect(centre.v).toBeCloseTo(0.5, 12);
  });

  it('round-trips an arbitrary position', () => {
    const original = { x: 1234.5, y: -678.25 };
    const back = mapToWorld(worldToMap(original));
    expect(back.x).toBeCloseTo(original.x, 9);
    expect(back.y).toBeCloseTo(original.y, 9);
  });

  it('increases v as the world y decreases — the map plane is screen-oriented', () => {
    const north = worldToMap({ x: 0, y: 1000 });
    const south = worldToMap({ x: 0, y: -1000 });
    expect(south.v).toBeGreaterThan(north.v);
  });
});

describe('world ↔ leaflet CRS.Simple plane', () => {
  it('round-trips through the leaflet plane', () => {
    const original = { x: -2500, y: 4200 };
    const [lat, lng] = worldToLatLng(original);
    const back = latLngToWorld(lat, lng);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
  });

  it('spans exactly the tile pyramid at native zoom', () => {
    const [topLat, leftLng] = worldToLatLng({ x: MAP.worldMinX, y: MAP.worldMaxY });
    const [bottomLat, rightLng] = worldToLatLng({ x: MAP.worldMaxX, y: MAP.worldMinY });
    expect(topLat).toBe(0);
    expect(Object.is(topLat, -0)).toBe(false);
    expect(leftLng).toBe(0);
    expect(bottomLat).toBe(-MAP_PLANE_SIZE);
    expect(rightLng).toBe(MAP_PLANE_SIZE);
    expect(MAP_PLANE_SIZE).toBe(MAP.tileSize * 2 ** MAP.nativeZoom);
  });

  it('agrees with the normalised plane it is derived from', () => {
    // There must be ONE affine map in the system: the leaflet helpers compose the
    // normalised transform rather than restating it.
    const pos = { x: 700, y: -900 };
    const { u, v } = worldToMap(pos);
    expect(worldToLatLng(pos)).toEqual([-v * MAP_PLANE_SIZE, u * MAP_PLANE_SIZE]);
  });
});

describe('bounds', () => {
  it('accepts the boundary itself', () => {
    expect(isWithinWorldBounds({ x: MAP.worldMinX, y: MAP.worldMinY })).toBe(true);
    expect(isWithinWorldBounds({ x: MAP.worldMaxX, y: MAP.worldMaxY })).toBe(true);
  });

  it('rejects a position outside the playable area', () => {
    expect(isWithinWorldBounds({ x: MAP.worldMaxX + 1, y: 0 })).toBe(false);
    expect(isWithinWorldBounds({ x: 0, y: MAP.worldMinY - 1 })).toBe(false);
  });

  it('clamps a bad sample instead of discarding the unit', () => {
    expect(clampToWorld({ x: 99999, y: -99999 }))
      .toEqual({ x: MAP.worldMaxX, y: MAP.worldMinY });
  });

  it('preserves z when clamping', () => {
    expect(clampToWorld({ x: 0, y: 0, z: 42 }).z).toBe(42);
  });

  it('computes the bounding rectangle of a set', () => {
    expect(boundsOf([{ x: -10, y: 5 }, { x: 30, y: -2 }, { x: 12, y: 40 }]))
      .toEqual({ minX: -10, minY: -2, maxX: 30, maxY: 40 });
  });

  it('has no bounds for an empty set', () => {
    expect(boundsOf([])).toBeNull();
  });

  it('exposes the world rectangle consistently with the raw constants', () => {
    expect(WORLD_BOUNDS).toEqual({
      minX: MAP.worldMinX, minY: MAP.worldMinY,
      maxX: MAP.worldMaxX, maxY: MAP.worldMaxY,
    });
    expect(WORLD_WIDTH).toBe(MAP.worldMaxX - MAP.worldMinX);
    expect(WORLD_HEIGHT).toBe(MAP.worldMaxY - MAP.worldMinY);
  });
});

describe('distance', () => {
  it('measures in world metres, ignoring altitude', () => {
    expect(worldDistance({ x: 0, y: 0, z: 500 }, { x: 3, y: 4, z: -500 })).toBe(5);
  });
});

describe('headings', () => {
  it('names the compass points', () => {
    expect(headingToCompass(0)).toBe('N');
    expect(headingToCompass(90)).toBe('E');
    expect(headingToCompass(180)).toBe('S');
    expect(headingToCompass(270)).toBe('W');
    expect(headingToCompass(359)).toBe('N');
    expect(headingToCompass(-90)).toBe('W');
  });

  it('takes the short way round the wrap point', () => {
    // The bug this prevents: a unit turning 350° → 10° spinning 340° backwards.
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
    // An exact half-turn is resolved anticlockwise, consistently.
    expect(headingDelta(0, 180)).toBe(-180);
    expect(headingDelta(180, 0)).toBe(-180);
  });

  it('interpolates across the wrap point', () => {
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpHeading(10, 350, 0.5)).toBeCloseTo(0, 9);
    expect(lerpHeading(90, 180, 0)).toBeCloseTo(90, 9);
    expect(lerpHeading(90, 180, 1)).toBeCloseTo(180, 9);
  });

  it('always returns a heading in [0, 360)', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const h = lerpHeading(355, 5, t);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
