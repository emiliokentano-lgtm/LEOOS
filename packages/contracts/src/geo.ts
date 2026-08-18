/**
 * GTA V world ↔ map-plane coordinate transform.
 *
 * Defined once and shared by client and server so that a marker placed by
 * clicking the map and a marker placed from an in-game coordinate land in the
 * same place. Divergent client and server transforms are the classic bug here.
 *
 * NOTE: the bounds below are the nominal playable area. The precise affine
 * constants must be calibrated against two known landmarks when the real tile set
 * arrives (Phase 6, blocked on tile licensing). Until then these values are
 * dimensionally correct and adequate for layout work, but positions are NOT
 * survey-accurate. See docs/architecture/05-map.md §2.
 */

export const MAP = {
  worldMinX: -4000,
  worldMaxX: 4500,
  worldMinY: -4500,
  worldMaxY: 8500,
  tileSize: 256,
  minZoom: 0,
  maxZoom: 5,
} as const;

export const WORLD_WIDTH = MAP.worldMaxX - MAP.worldMinX;
export const WORLD_HEIGHT = MAP.worldMaxY - MAP.worldMinY;

export interface WorldPosition {
  x: number;
  y: number;
  z?: number;
}

/** Normalised map-plane position, both axes in [0, 1]. Y is flipped so that 0 is
 *  the top of the image, matching screen coordinates. */
export interface MapPosition {
  u: number;
  v: number;
}

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

export function isWithinWorldBounds(pos: WorldPosition): boolean {
  return (
    pos.x >= MAP.worldMinX && pos.x <= MAP.worldMaxX &&
    pos.y >= MAP.worldMinY && pos.y <= MAP.worldMaxY
  );
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
