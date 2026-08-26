import { MAP, type WorldBounds } from './geo';
import type { MapFilterState, MapOrganizationRef } from './map';

/**
 * Areas and routes drawn on the map.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A "ROUTE" IS HERE, AND WHAT IT IS NOT
 *
 * This repository has NO ROAD GRAPH. There is no routing engine, no navigation
 * mesh, and nothing that knows a road from a field. A route in LEOOS is a
 * POLYLINE A HUMAN DREW — "come in along the canal, not down Route 68" — and
 * every name in this file, in the API and in the UI says so.
 *
 * That is engineering rule 45 applied to a feature name. Calling it navigation
 * would be a claim the software cannot make, and an operator who believed it
 * would follow a line nothing ever checked against a map.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Everything else is shared with markers rather than duplicated: the same
 * `map.markers.manage` permission, the same organization visibility rule, the
 * same expire-on-read semantics, the same soft deletion. What differs is the
 * geometry, and that is the only thing this module adds.
 */

export type MapShapeKind = 'area' | 'route';

/** World metres, like every other coordinate that crosses this boundary. */
export interface MapShapePoint {
  x: number;
  y: number;
}

export interface MapShape {
  id: string;
  kind: MapShapeKind;
  label: string;
  description: string | null;
  color: string | null;
  /**
   * Ordered. For an `area` the last point joins the first — the closing segment
   * is implied rather than stored, so a polygon cannot be persisted with a
   * duplicated final vertex that some renderers draw and others do not.
   */
  points: MapShapePoint[];
  /** Null for a shape shared across every organization. */
  organization: MapOrganizationRef | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export const MAP_SHAPE_KINDS: Record<
  MapShapeKind,
  { label: string; minPoints: number; closed: boolean; hint: string }
> = {
  area: {
    label: 'Area',
    minPoints: 3,
    closed: true,
    hint: 'A cordon, a search grid, a perimeter.',
  },
  route: {
    label: 'Route',
    minPoints: 2,
    closed: false,
    // Said in the UI too, not only in this file.
    hint: 'A line drawn by hand — an approach or a corridor. Not a navigated path.',
  },
};

/**
 * The hard ceiling on a shape's point count.
 *
 * Somebody dragging a mouse across a map for a minute generates thousands of
 * points; 500 is far more than a human needs to describe a perimeter and small
 * enough that a page of shapes stays a small payload. An unbounded array is an
 * allocation whose size the sender chooses, which is why this number exists in
 * three places that cannot disagree: here, in the request schema, and as a
 * CHECK constraint in migration 0014.
 */
export const MAP_SHAPE_MAX_POINTS = 500;

export function minPointsFor(kind: MapShapeKind): number {
  return MAP_SHAPE_KINDS[kind]?.minPoints ?? 2;
}

/**
 * Why a geometry is unacceptable, or null when it is fine.
 *
 * Lives in contracts so the drawing tool can refuse a bad shape before the round
 * trip AND the service can refuse it at the boundary — one rule, two callers,
 * rather than two rules that drift.
 */
export function validateShapeGeometry(
  kind: MapShapeKind,
  points: readonly MapShapePoint[],
): string | null {
  const min = minPointsFor(kind);
  if (points.length < min) {
    return kind === 'area'
      ? 'An area needs at least three points to enclose anything.'
      : 'A route needs at least two points.';
  }
  if (points.length > MAP_SHAPE_MAX_POINTS) {
    return `A shape can have at most ${MAP_SHAPE_MAX_POINTS} points.`;
  }
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return 'That shape has a point which is not a coordinate.';
    }
    if (point.x < MAP.worldMinX || point.x > MAP.worldMaxX
      || point.y < MAP.worldMinY || point.y > MAP.worldMaxY) {
      return 'That shape reaches outside the map.';
    }
  }
  return null;
}

/**
 * The axis-aligned box a shape occupies.
 *
 * Computed ONCE per shape when the set changes, never per frame: it is what lets
 * the renderer skip a shape entirely when its box does not meet the viewport,
 * and recomputing it inside the draw loop would spend more than the culling
 * saves. See docs/architecture/05-map.md §9.5.
 */
export function shapeBounds(points: readonly MapShapePoint[]): WorldBounds | null {
  const first = points[0];
  if (first === undefined) return null;

  let minX = first.x; let maxX = first.x;
  let minY = first.y; let maxY = first.y;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Where a shape's label goes.
 *
 * The centre of the BOUNDING BOX, not the polygon's centroid. A concave area's
 * true centroid can fall outside the shape, which puts the label somewhere the
 * operator cannot connect to anything; the box centre is always sensible even
 * when it is not the centre of mass.
 */
export function shapeLabelAnchor(points: readonly MapShapePoint[]): MapShapePoint | null {
  const bounds = shapeBounds(points);
  if (bounds === null) return null;
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

/**
 * A route's DRAWN length, in metres.
 *
 * Reported as "drawn length" everywhere it appears, never as a distance to
 * travel: it is the length of the line somebody drew, and the line does not
 * follow roads.
 */
export function drawnLength(points: readonly MapShapePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** The enclosed area of a polygon, in square metres. Shoelace. */
export function enclosedArea(points: readonly MapShapePoint[]): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/**
 * A VIEW filter, exactly like the marker one.
 *
 * Everything it can hide has already passed the server's visibility check;
 * clearing every filter cannot reveal a shape the caller was not entitled to.
 */
export function matchesShapeFilter(shape: MapShape, filter: MapFilterState): boolean {
  if (!filter.showShapes) return false;
  if (filter.organizationIds.length > 0
    && shape.organization !== null
    && !filter.organizationIds.includes(shape.organization.id)) return false;
  if (filter.query.trim() !== '') {
    const needle = filter.query.trim().toLowerCase();
    if (!`${shape.label} ${shape.description ?? ''}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Whether a shape has lapsed. Filtered in SQL too; this is the client's copy. */
export function isShapeLive(shape: MapShape, now: number): boolean {
  if (shape.expiresAt === null) return true;
  const at = Date.parse(shape.expiresAt);
  // An unparseable expiry is treated as lapsed rather than eternal: a cordon
  // nobody can clear is worse than one that has to be redrawn.
  return Number.isNaN(at) ? false : at > now;
}
