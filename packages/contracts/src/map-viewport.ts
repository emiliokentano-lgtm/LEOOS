import {
  MAP, WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH,
  type WorldBounds, type WorldPosition,
} from './geo';

/**
 * Viewport maths: world metres ↔ screen pixels.
 *
 * This is layer 3 of the coordinate stack described in `geo.ts`, and it lives in
 * `@leoos/contracts` rather than in the web app for two reasons:
 *
 *   1. The engineering brief is explicit that coordinate conversion must not be
 *      scattered through UI components. Previously `project()` was a closure
 *      inside the canvas component, which meant hit-testing, drawing, clustering
 *      and the follow-mode camera each had their own idea of where a unit was.
 *      Here it is one set of pure functions with one inverse.
 *
 *   2. Pure maths with no DOM, no React and no canvas is testable in
 *      milliseconds, and this is the part that is easy to get subtly wrong.
 *
 * WHY THE PROJECTION IS BUILT FROM WORLD METRES, NOT FROM THE NORMALISED PLANE.
 * The map plane normalises each axis independently, so the world rectangle
 * (8500 m across, 13000 m tall) becomes a unit square. Rendering through it with
 * a single scale factor stretches the picture by a factor of 1.53 vertically:
 * circles become ellipses, a heading of 45° draws at 33°, and a distance
 * measured on screen is meaningless. Screen projection therefore uses metres
 * directly and one scale factor for both axes. The normalised plane keeps its
 * job — addressing tiles — and stays out of the render path.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Viewport {
  /** World position at the centre of the visible area. */
  center: WorldPosition;
  /** Screen pixels per world metre. */
  scale: number;
  /** Size of the visible area in css pixels. */
  width: number;
  height: number;
}

/**
 * Zoom limits, expressed as what they mean rather than as magic numbers.
 *
 * The lower bound is "the whole world just fits on screen". Zooming out further
 * only adds empty margin, and it is the point past which an operator has lost
 * every landmark — a dead end they cannot recover from without a reset button.
 */
export const MAX_SCALE = 0.6;          // ≈ 1.7 m per pixel: a street is legible
export const MIN_SCALE_FLOOR = 0.002;  // absolute floor for degenerate sizes

/**
 * The scale at which the entire world rectangle is visible.
 *
 * `min` of the two ratios, not `max`: `max` would be the scale at which the
 * world COVERS the viewport with no letterboxing, which sounds tidier but means
 * the long axis can never be seen in full. On a map whose whole point is
 * situational awareness, seeing everything wins over filling the frame.
 */
export function minScaleFor(width: number, height: number): number {
  if (width <= 0 || height <= 0) return MIN_SCALE_FLOOR;
  return Math.max(
    MIN_SCALE_FLOOR,
    Math.min(width / WORLD_WIDTH, height / WORLD_HEIGHT),
  );
}

export function clampScale(scale: number, width: number, height: number): number {
  return Math.min(MAX_SCALE, Math.max(minScaleFor(width, height), scale));
}

/**
 * World → screen.
 *
 * The Y axis is negated because GTA's y grows north while screen y grows down.
 */
export function projectToScreen(viewport: Viewport, pos: WorldPosition): ScreenPoint {
  return {
    x: (pos.x - viewport.center.x) * viewport.scale + viewport.width / 2,
    y: (viewport.center.y - pos.y) * viewport.scale + viewport.height / 2,
  };
}

/** Screen → world. Exact inverse of `projectToScreen`. */
export function screenToWorld(viewport: Viewport, point: ScreenPoint): WorldPosition {
  return {
    x: (point.x - viewport.width / 2) / viewport.scale + viewport.center.x,
    y: viewport.center.y - (point.y - viewport.height / 2) / viewport.scale,
  };
}

/**
 * Keeps the visible rectangle inside the world.
 *
 * Panning stops at the world edge rather than sailing off into blank space.
 * Once the viewport is wider than the world on an axis — which it always is on
 * at least one axis at minimum zoom — that axis is CENTRED instead of clamped:
 * there is no valid pan range left, and clamping to an empty interval would make
 * the map jitter against an edge it cannot reach.
 */
export function clampViewport(viewport: Viewport): Viewport {
  const scale = clampScale(viewport.scale, viewport.width, viewport.height);
  const halfW = viewport.width / 2 / scale;
  const halfH = viewport.height / 2 / scale;

  const centerX = halfW * 2 >= WORLD_WIDTH
    ? (WORLD_BOUNDS.minX + WORLD_BOUNDS.maxX) / 2
    : Math.min(Math.max(viewport.center.x, WORLD_BOUNDS.minX + halfW), WORLD_BOUNDS.maxX - halfW);

  const centerY = halfH * 2 >= WORLD_HEIGHT
    ? (WORLD_BOUNDS.minY + WORLD_BOUNDS.maxY) / 2
    : Math.min(Math.max(viewport.center.y, WORLD_BOUNDS.minY + halfH), WORLD_BOUNDS.maxY - halfH);

  return { ...viewport, scale, center: { x: centerX, y: centerY } };
}

/** Drags the map by a screen-space delta. */
export function panViewport(viewport: Viewport, dxPixels: number, dyPixels: number): Viewport {
  return clampViewport({
    ...viewport,
    center: {
      x: viewport.center.x - dxPixels / viewport.scale,
      y: viewport.center.y + dyPixels / viewport.scale,
    },
  });
}

/**
 * Zooms about a screen anchor, keeping the world point under the cursor fixed.
 *
 * Zooming about the centre instead is the difference between a map that follows
 * the pointer and one that has to be re-panned after every wheel notch.
 */
export function zoomViewportAt(
  viewport: Viewport,
  anchor: ScreenPoint,
  factor: number,
): Viewport {
  const nextScale = clampScale(viewport.scale * factor, viewport.width, viewport.height);
  if (nextScale === viewport.scale) return viewport;

  const anchorWorld = screenToWorld(viewport, anchor);
  const zoomed: Viewport = { ...viewport, scale: nextScale };
  const afterAnchor = screenToWorld(zoomed, anchor);

  return clampViewport({
    ...zoomed,
    center: {
      x: viewport.center.x + (anchorWorld.x - afterAnchor.x),
      y: viewport.center.y + (anchorWorld.y - afterAnchor.y),
    },
  });
}

export interface FitOptions {
  /** Fraction of the viewport left empty around the content. */
  padding?: number;
  /** Never zoom in past this, so a single unit does not fill the screen. */
  maxScale?: number;
  /** Smallest span, in metres, a fit is allowed to resolve to. */
  minSpan?: number;
}

/**
 * Frames a world rectangle.
 *
 * `minSpan` matters: fitting to one unit, or to a cluster parked at the same
 * station, otherwise produces an infinite scale. 400 m is roughly a city block —
 * enough context to see what is around the thing being framed.
 */
export function fitViewport(
  bounds: WorldBounds,
  width: number,
  height: number,
  options: FitOptions = {},
): Viewport {
  const { padding = 0.12, maxScale = 0.25, minSpan = 400 } = options;

  const spanX = Math.max(bounds.maxX - bounds.minX, minSpan);
  const spanY = Math.max(bounds.maxY - bounds.minY, minSpan);
  const usableW = Math.max(width * (1 - padding * 2), 1);
  const usableH = Math.max(height * (1 - padding * 2), 1);

  const scale = Math.min(maxScale, usableW / spanX, usableH / spanY);

  return clampViewport({
    center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    scale,
    width,
    height,
  });
}

/** The whole playable area, framed. The default view when there is nothing to fit. */
export function worldViewport(width: number, height: number): Viewport {
  return fitViewport(WORLD_BOUNDS, width, height, { padding: 0.02, maxScale: MAX_SCALE });
}

/** Recentres without changing zoom — the follow-mode camera. */
export function centerViewport(viewport: Viewport, pos: WorldPosition): Viewport {
  return clampViewport({ ...viewport, center: { x: pos.x, y: pos.y } });
}

/** Resizes in place, preserving the centre and re-clamping the scale. */
export function resizeViewport(viewport: Viewport, width: number, height: number): Viewport {
  return clampViewport({ ...viewport, width, height });
}

/** The world rectangle currently visible. Used to skip off-screen work. */
export function visibleBounds(viewport: Viewport, marginPixels = 0): WorldBounds {
  const halfW = (viewport.width / 2 + marginPixels) / viewport.scale;
  const halfH = (viewport.height / 2 + marginPixels) / viewport.scale;
  return {
    minX: viewport.center.x - halfW,
    maxX: viewport.center.x + halfW,
    minY: viewport.center.y - halfH,
    maxY: viewport.center.y + halfH,
  };
}

export function isVisible(viewport: Viewport, pos: WorldPosition, marginPixels = 32): boolean {
  const b = visibleBounds(viewport, marginPixels);
  return pos.x >= b.minX && pos.x <= b.maxX && pos.y >= b.minY && pos.y <= b.maxY;
}

/**
 * Leaflet zoom level equivalent to a scale, for when the tile layer lands.
 *
 * The pyramid's native zoom covers the whole world in `MAP_PLANE_SIZE` pixels,
 * so this is just the log2 of the ratio. Exposed here so nobody recomputes it
 * against a hardcoded tile count.
 */
export function scaleToTileZoom(scale: number): number {
  const nativeScale = (MAP.tileSize * 2 ** MAP.nativeZoom) / WORLD_WIDTH;
  const zoom = MAP.nativeZoom + Math.log2(scale / nativeScale);
  return Math.min(MAP.maxZoom, Math.max(MAP.minZoom, zoom));
}
