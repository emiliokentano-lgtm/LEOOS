/**
 * GTA V world ↔ map-space coordinate transform.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COORDINATE LAYERS, and why there are three of them.
 *
 *   1. WORLD          metres, GTA V's own frame. `{x, y, z}`, y increasing north.
 *                     This is what FiveM emits and the ONLY thing the database
 *                     stores (docs/architecture/05-map.md §2). Everything else is
 *                     derived, so re-calibrating or replacing the tile set never
 *                     invalidates a stored coordinate.
 *
 *   2. MAP PLANE      normalised `{u, v}`, both in [0, 1], v flipped so 0 is the
 *                     top. This is TILE space: it addresses the raster pyramid,
 *                     and it is what Leaflet's `CRS.Simple` plane is built from
 *                     (ADR-0005). It deliberately stretches each axis
 *                     independently, because a tile image covers the world
 *                     rectangle whatever its own pixel aspect ratio.
 *
 *   3. SCREEN         css pixels. Derived in `map-viewport.ts` from WORLD, not
 *                     from the map plane — see the note there. Rendering must be
 *                     metrically square or headings and distances read wrong.
 *
 * Layers 1 and 2 live here because they are shared by client and server: a marker
 * placed by clicking the map and a marker placed from an in-game coordinate have
 * to land in the same place. Divergent client and server transforms are the
 * classic bug in this kind of system.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * CALIBRATION STATUS: the bounds below are the nominal playable area. The precise
 * affine constants must be solved against two known in-game landmarks when the
 * real tile set arrives (Phase 6, blocked on tile licensing). Until then these
 * values are dimensionally correct and adequate for layout and relative
 * positioning, but they are NOT survey-accurate. See docs/architecture/05-map.md.
 */

export const MAP = {
  worldMinX: -4000,
  worldMaxX: 4500,
  worldMinY: -4500,
  worldMaxY: 8500,
  tileSize: 256,
  minZoom: 0,
  maxZoom: 5,
  nativeZoom: 5,
} as const;

export const WORLD_WIDTH = MAP.worldMaxX - MAP.worldMinX;
export const WORLD_HEIGHT = MAP.worldMaxY - MAP.worldMinY;

export interface WorldPosition {
  x: number;
  y: number;
  z?: number | null;
}

/**
 * Normalised map-plane position, both axes in [0, 1].
 *
 * Y is flipped so that 0 is the top of the image, matching both screen
 * coordinates and tile-pyramid row order.
 */
export interface MapPosition {
  u: number;
  v: number;
}

/** An axis-aligned rectangle in world metres. */
export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const WORLD_BOUNDS: WorldBounds = {
  minX: MAP.worldMinX,
  minY: MAP.worldMinY,
  maxX: MAP.worldMaxX,
  maxY: MAP.worldMaxY,
};

export function worldToMap(pos: WorldPosition): MapPosition {
  return {
    u: (pos.x - MAP.worldMinX) / WORLD_WIDTH,
    v: 1 - (pos.y - MAP.worldMinY) / WORLD_HEIGHT,
  };
}

export function mapToWorld(pos: MapPosition): WorldPosition {
  return {
    x: pos.u * WORLD_WIDTH + MAP.worldMinX,
    y: (1 - pos.v) * WORLD_HEIGHT + MAP.worldMinY,
  };
}

/**
 * Leaflet `CRS.Simple` plane coordinates.
 *
 * `CRS.Simple` takes an unprojected `[lat, lng]` pair and maps it linearly to the
 * pixel plane. Anchoring the plane to the full tile pyramid at native zoom means
 * a Leaflet `TileLayer` needs no further configuration than these bounds.
 *
 * These two functions exist so that when the tile pyramid lands (ADR-0005) the
 * Leaflet integration does not have to re-derive a transform — it composes this
 * one. There is still exactly one affine map in the system.
 */
export const MAP_PLANE_SIZE = MAP.tileSize * 2 ** MAP.nativeZoom;

export function worldToLatLng(pos: WorldPosition): [number, number] {
  const { u, v } = worldToMap(pos);
  // Leaflet's y axis grows upward, so the flipped v is negated back. The `+ 0`
  // normalises the negative zero that `-0 * n` produces at the top edge: it is
  // arithmetically identical but compares unequal under `Object.is`, which is
  // enough to break a memo key or a snapshot comparison much later.
  return [-v * MAP_PLANE_SIZE + 0, u * MAP_PLANE_SIZE];
}

export function latLngToWorld(lat: number, lng: number): WorldPosition {
  return mapToWorld({ u: lng / MAP_PLANE_SIZE, v: -lat / MAP_PLANE_SIZE });
}

export function isWithinWorldBounds(pos: WorldPosition): boolean {
  return (
    pos.x >= MAP.worldMinX && pos.x <= MAP.worldMaxX &&
    pos.y >= MAP.worldMinY && pos.y <= MAP.worldMaxY
  );
}

/**
 * Clamps a coordinate into the playable area.
 *
 * Used on ingest: a position outside the world rectangle is a bad sample, not a
 * reason to reject the unit outright and lose track of it entirely.
 */
export function clampToWorld(pos: WorldPosition): WorldPosition {
  return {
    x: Math.min(Math.max(pos.x, MAP.worldMinX), MAP.worldMaxX),
    y: Math.min(Math.max(pos.y, MAP.worldMinY), MAP.worldMaxY),
    ...(pos.z === undefined ? {} : { z: pos.z }),
  };
}

/** Straight-line ground distance in metres. Z is ignored — dispatch reasons in 2D. */
export function worldDistance(a: WorldPosition, b: WorldPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Bounding rectangle of a set of positions. Null for an empty set. */
export function boundsOf(positions: readonly WorldPosition[]): WorldBounds | null {
  if (positions.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Formats a world coordinate the way it is read aloud over radio. */
export function formatWorldPosition(pos: WorldPosition): string {
  return `${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}`;
}

/** Compass bearing from a GTA heading (0 = north, increasing clockwise). */
export function headingToCompass(heading: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(((heading % 360) + 360) % 360 / 45) % 8;
  return points[idx] ?? 'N';
}

/**
 * Shortest signed difference between two headings, in degrees [−180, 180).
 *
 * Needed for interpolation: a unit turning from 350° to 10° has rotated +20°,
 * not −340°, and naive interpolation spins the marker most of the way round.
 *
 * An exact half-turn has two equally short paths; this resolves it anticlockwise
 * (−180). Which one it picks is arbitrary, but it has to be FIXED — an
 * implementation that chose by floating-point luck would make a marker's spin
 * direction irreproducible.
 */
export function headingDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Interpolates a heading the short way round. */
export function lerpHeading(from: number, to: number, t: number): number {
  return (((from + headingDelta(from, to) * t) % 360) + 360) % 360;
}
