'use client';

import * as React from 'react';
import {
  DEFAULT_CLUSTER_CELL, MAP, MAP_TICK_MS, UNIT_STALE_AFTER_MS, WORLD_BOUNDS,
  boundsOf, centerViewport, clusterByScreenGrid, fitViewport, panViewport, projectToScreen,
  resizeViewport, screenToWorld, worldViewport, zoomViewportAt,
  type MapIncidentMarker, type MapMarker, type MapUnit, type ScreenPoint, type Viewport,
  type WorldPosition,
} from '@leoos/contracts';
import { MapInterpolator } from '@/lib/map/interpolation';
import { cn } from '@/lib/utils';

/**
 * The map rendering surface.
 *
 * Units render on a SINGLE CANVAS, not as DOM markers. Leaflet-style DOM markers
 * do not hold frame rate at 300 units updating every second, and retrofitting a
 * canvas layer later means rewriting hit-testing, labelling and z-ordering
 * anyway — so ADR-0005 commits to it and this is that layer.
 *
 * TWO THINGS THIS COMPONENT DELIBERATELY DOES NOT DO.
 *
 *   It does not know where its data comes from. It takes units, incidents and
 *   markers as props. The live feed, the poller, and eventually the WebSocket,
 *   all live behind `MapDataSource` in lib/map/map-source.ts.
 *
 *   It does not do coordinate maths. Every world→screen conversion goes through
 *   `@leoos/contracts` (`projectToScreen` / `screenToWorld`), which is the
 *   single transform shared with the server. A private projection in here is
 *   exactly how a marker placed by clicking ends up somewhere else than the same
 *   marker loaded back from the database.
 *
 * BASE LAYER: a coordinate grid, not the GTA map. The raster tile pyramid is
 * blocked on asset licensing (docs/architecture/05-map.md §3), and drawing an
 * unlicensed render or a vague approximation and calling it the map would be
 * worse than drawing scaffolding that is obviously scaffolding. Positions
 * already use the real transform, so dropping tiles in moves nothing.
 */

export interface MapCanvasHandle {
  /** Frames a set of world positions. Used by "fit to units" and by follow mode. */
  fitTo(positions: readonly WorldPosition[]): void;
  zoomBy(factor: number): void;
  reset(): void;
}

export interface MapCanvasProps {
  units: MapUnit[];
  incidents: MapIncidentMarker[];
  markers: MapMarker[];
  selectedUnitId: string | null;
  selectedIncidentId: string | null;
  selectedMarkerId: string | null;
  /** Locks the viewport to this unit. */
  followUnitId: string | null;
  onSelectUnit: (unit: MapUnit | null) => void;
  onSelectIncident: (incident: MapIncidentMarker) => void;
  onSelectMarker: (marker: MapMarker) => void;
  /** Right-click, in world coordinates. Null when the caller may not place things. */
  onContextMenu?: (position: WorldPosition, at: ScreenPoint) => void;
  className?: string;
}

/** Hit radius in css pixels. Generous: operators click under time pressure. */
const HIT_RADIUS = 16;
const LABEL_OFFSET = 22;

/**
 * Below this scale, callsign labels are drawn only for the selected unit.
 *
 * Zoomed out, labels collide into an unreadable smear that obscures the very
 * markers they are annotating — and the side panel already lists every unit by
 * callsign, so nothing is lost. Deliberately the same threshold at which
 * clustering switches off, so the two behaviours change together instead of
 * producing a middle zoom where markers are clustered but also labelled.
 */
const LABEL_MIN_SCALE = 0.09;

interface HitTarget {
  kind: 'unit' | 'incident' | 'marker' | 'cluster';
  id: string;
  point: ScreenPoint;
  /** For a cluster, the members to fit when it is clicked. */
  positions?: WorldPosition[];
}

/** Resolves a CSS custom property to a real colour. Canvas cannot read `var()`. */
function useTokenResolver(): (token: string, fallback: string) => string {
  const cache = React.useRef(new Map<string, string>());

  return React.useCallback((token: string, fallback: string) => {
    const hit = cache.current.get(token);
    if (hit !== undefined) return hit;
    if (typeof window === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(token).trim() || fallback;
    cache.current.set(token, value);
    return value;
  }, []);
}

export const MapCanvas = React.forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas({
  units, incidents, markers,
  selectedUnitId, selectedIncidentId, selectedMarkerId, followUnitId,
  onSelectUnit, onSelectIncident, onSelectMarker, onContextMenu, className,
}, ref) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const [viewport, setViewport] = React.useState<Viewport | null>(null);
  const [hovered, setHovered] = React.useState<HitTarget | null>(null);
  /**
   * Whether the fleet has been framed once.
   *
   * State rather than a ref because it is read during render to decide the
   * viewport, and a ref read during render is a value React cannot see changing.
   */
  const [framed, setFramed] = React.useState(false);

  const resolveToken = useTokenResolver();
  const interpolator = React.useRef(new MapInterpolator());
  const hitTargets = React.useRef<HitTarget[]>([]);
  const dragState = React.useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const frameRef = React.useRef<number | null>(null);

  // ── Sizing ──────────────────────────────────────────────────────────────
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Viewport initialisation and resize, adjusted DURING RENDER rather than in an
   * effect.
   *
   * React documents this pattern for state that has to track a changing input,
   * and it is the right shape here: an effect would paint one frame at the old
   * size — a visible flash of a stretched map on every panel toggle — and then
   * correct it. Adjusting during render means the very first paint is correct.
   *
   * The `hasFitted` ref makes the initial framing happen exactly once. The GTA
   * world is mostly water and desert, so opening at full extent shows an empty
   * grid with the units too small to read; framing the fleet is what an operator
   * wants on arrival, and zooming out is one gesture away.
   */
  let workingViewport = viewport;
  if (size.width > 0 && size.height > 0) {
    if (workingViewport === null) {
      const positions = units
        .map((u) => u.location)
        .filter((l): l is NonNullable<typeof l> => l !== null);
      const bounds = positions.length > 0 ? boundsOf(positions) : null;

      workingViewport = bounds === null
        ? worldViewport(size.width, size.height)
        : fitViewport(bounds, size.width, size.height);
      // Only treat it as framed once there was something to frame; otherwise a
      // fleet arriving a moment later would never get its initial fit.
      if (bounds !== null) setFramed(true);
      setViewport(workingViewport);
    } else if (workingViewport.width !== size.width || workingViewport.height !== size.height) {
      workingViewport = resizeViewport(workingViewport, size.width, size.height);
      setViewport(workingViewport);
    } else if (!framed) {
      const positions = units
        .map((u) => u.location)
        .filter((l): l is NonNullable<typeof l> => l !== null);
      const bounds = positions.length > 0 ? boundsOf(positions) : null;
      if (bounds !== null) {
        setFramed(true);
        workingViewport = fitViewport(bounds, size.width, size.height);
        setViewport(workingViewport);
      }
    }
  }

  /**
   * Follow mode is DERIVED, not stored.
   *
   * Writing the followed unit's position into viewport state would mean a
   * setState per tick, a render per tick, and a camera that fights any pan the
   * operator attempts. As a lens over the viewport it is one recomputation and
   * releasing follow leaves the operator exactly where the camera was.
   */
  const followed = followUnitId === null
    ? null
    : units.find((u) => u.id === followUnitId) ?? null;

  const effectiveViewport = React.useMemo(() => {
    if (workingViewport === null) return null;
    if (followed?.location == null) return workingViewport;
    return centerViewport(workingViewport, {
      x: followed.location.x, y: followed.location.y,
    });
    // `workingViewport` is derived above during this same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingViewport, followed?.location?.x, followed?.location?.y]);

  // ── Interpolation ───────────────────────────────────────────────────────
  React.useEffect(() => {
    interpolator.current.update(units, performance.now(), MAP_TICK_MS);
  }, [units]);

  // Tracks are per-mount; a remount must not resurrect positions from a feed
  // the operator has since navigated away from.
  React.useEffect(() => {
    const tracks = interpolator.current;
    return () => tracks.clear();
  }, []);

  const imperative = React.useMemo<MapCanvasHandle>(() => ({
    fitTo(positions) {
      const bounds = boundsOf(positions);
      if (bounds === null || size.width === 0) return;
      setViewport(fitViewport(bounds, size.width, size.height));
    },
    zoomBy(factor) {
      setViewport((current) => (current === null ? current : zoomViewportAt(
        current, { x: current.width / 2, y: current.height / 2 }, factor,
      )));
    },
    reset() {
      if (size.width === 0) return;
      setViewport(worldViewport(size.width, size.height));
    },
  }), [size]);
  React.useImperativeHandle(ref, () => imperative, [imperative]);

  // ── Draw loop ───────────────────────────────────────────────────────────
  /**
   * Frame scheduling.
   *
   * The loop runs only while something is moving: `requestDraw` schedules one
   * frame if none is pending, and the draw re-schedules itself while the
   * interpolator still has work. A map of parked units therefore costs nothing
   * to display, and a pan, a selection or a filter change repaints exactly once.
   *
   * The draw function is held in a ref, ASSIGNED IN AN EFFECT, so a scheduled
   * frame always runs the current one without the effect being torn down and
   * rebuilt every time a position arrives — which is once a second, and would
   * restart the animation each time.
   */
  const drawRef = React.useRef<() => void>(() => {});

  const requestDraw = React.useCallback(() => {
    if (frameRef.current !== null) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      drawRef.current();
    });
  }, []);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || effectiveViewport === null) return;
    if (size.width === 0 || size.height === 0) return;

    const now = performance.now();
    const wallClock = Date.now();
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(size.width * dpr)) {
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const targets: HitTarget[] = [];

    drawBaseGrid(ctx, effectiveViewport, size, resolveToken);
    drawMarkers(ctx, effectiveViewport, markers, selectedMarkerId, targets, resolveToken);
    drawIncidents(ctx, effectiveViewport, incidents, selectedIncidentId, targets, resolveToken);
    drawUnits(
      ctx, effectiveViewport, units, selectedUnitId, interpolator.current,
      now, wallClock, targets, resolveToken,
    );

    hitTargets.current = targets;

    if (interpolator.current.isAnimating(now)) requestDraw();
  }, [
    effectiveViewport, size, units, incidents, markers,
    selectedUnitId, selectedIncidentId, selectedMarkerId, resolveToken, requestDraw,
  ]);

  React.useEffect(() => {
    drawRef.current = draw;
    requestDraw();
  }, [draw, requestDraw]);

  // A hidden tab does not render at all (05-map.md §4). It repaints once on
  // return so the operator is not looking at a blank canvas while the next
  // snapshot arrives.
  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestDraw();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [requestDraw]);

  // ── Interaction ─────────────────────────────────────────────────────────
  function pointerPosition(e: React.PointerEvent | React.MouseEvent): ScreenPoint {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitTest(point: ScreenPoint): HitTarget | null {
    let best: { target: HitTarget; distance: number } | null = null;
    // Iterated in reverse so the topmost drawn thing wins the click, matching
    // what the operator can actually see.
    for (let i = hitTargets.current.length - 1; i >= 0; i -= 1) {
      const target = hitTargets.current[i]!;
      const distance = Math.hypot(target.point.x - point.x, target.point.y - point.y);
      if (distance <= HIT_RADIUS && (best === null || distance < best.distance)) {
        best = { target, distance };
      }
    }
    return best?.target ?? null;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    const point = pointerPosition(e);
    dragState.current = { x: point.x, y: point.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const point = pointerPosition(e);
    const drag = dragState.current;

    if (drag === null) {
      const target = hitTest(point);
      setHovered((current) => (current?.id === target?.id ? current : target));
      return;
    }

    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    // A few pixels of movement during a click is a click, not a drag — pointer
    // devices are not that precise and neither are people in a hurry.
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;

    drag.moved = true;
    drag.x = point.x;
    drag.y = point.y;
    setViewport((current) => (current === null ? current : panViewport(current, dx, dy)));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragState.current;
    dragState.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (drag === null || drag.moved) return;

    const target = hitTest(pointerPosition(e));
    if (target === null) { onSelectUnit(null); return; }

    if (target.kind === 'cluster') {
      // Clicking a cluster zooms into it rather than picking an arbitrary
      // member. Which one would it have picked?
      imperative.fitTo(target.positions ?? []);
      return;
    }
    if (target.kind === 'unit') {
      onSelectUnit(units.find((u) => u.id === target.id) ?? null);
      return;
    }
    if (target.kind === 'incident') {
      const incident = incidents.find((i) => i.id === target.id);
      if (incident) onSelectIncident(incident);
      return;
    }
    const marker = markers.find((m) => m.id === target.id);
    if (marker) onSelectMarker(marker);
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (effectiveViewport === null) return;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setViewport(zoomViewportAt(effectiveViewport, pointerPosition(e), factor));
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!onContextMenu || effectiveViewport === null) return;
    e.preventDefault();
    const point = pointerPosition(e);
    // Unprojected through the SHARED transform, so a marker placed by clicking
    // and the same marker loaded back from the database land in one place.
    onContextMenu(screenToWorld(effectiveViewport, point), point);
  }

  const hoveredIsInteractive = hovered !== null;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHovered(null)}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        style={{ width: size.width, height: size.height, touchAction: 'none' }}
        className={cn(
          'block',
          hoveredIsInteractive ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        )}
        /**
         * The canvas is not the only way to reach this information: the side
         * panel lists every visible unit as focusable rows, and selecting one
         * there does everything selecting it here does. That list is the
         * accessible path, and this describes what the picture shows.
         */
        role="img"
        aria-label={
          `Tactical map: ${units.length} unit${units.length === 1 ? '' : 's'}, ` +
          `${incidents.length} incident${incidents.length === 1 ? '' : 's'}, ` +
          `${markers.length} marker${markers.length === 1 ? '' : 's'}. ` +
          'The same units are listed in the side panel.'
        }
      />
    </div>
  );
});

// ── Drawing ────────────────────────────────────────────────────────────────

type Resolver = (token: string, fallback: string) => string;

/**
 * The placeholder base layer.
 *
 * A coordinate grid at a spacing that adapts to zoom, plus the world boundary
 * and the origin. It is deliberately drawn as scaffolding: nobody should be able
 * to mistake it for a map of Los Santos, and the banner above it says so in
 * words as well.
 */
function drawBaseGrid(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  size: { width: number; height: number },
  resolve: Resolver,
): void {
  ctx.fillStyle = resolve('--color-base', '#0b0e14');
  ctx.fillRect(0, 0, size.width, size.height);

  // Grid spacing that keeps lines roughly 80 px apart at any zoom, so the grid
  // stays readable instead of turning into a solid block when zoomed out.
  const targetPixels = 80;
  const rawStep = targetPixels / vp.scale;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? magnitude * 10;

  const grid = resolve('--color-border-subtle', '#1a2030');
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();

  const startX = Math.ceil(WORLD_BOUNDS.minX / step) * step;
  for (let wx = startX; wx <= WORLD_BOUNDS.maxX; wx += step) {
    const a = projectToScreen(vp, { x: wx, y: WORLD_BOUNDS.minY });
    const b = projectToScreen(vp, { x: wx, y: WORLD_BOUNDS.maxY });
    ctx.moveTo(Math.round(a.x) + 0.5, a.y);
    ctx.lineTo(Math.round(b.x) + 0.5, b.y);
  }
  const startY = Math.ceil(WORLD_BOUNDS.minY / step) * step;
  for (let wy = startY; wy <= WORLD_BOUNDS.maxY; wy += step) {
    const a = projectToScreen(vp, { x: WORLD_BOUNDS.minX, y: wy });
    const b = projectToScreen(vp, { x: WORLD_BOUNDS.maxX, y: wy });
    ctx.moveTo(a.x, Math.round(a.y) + 0.5);
    ctx.lineTo(b.x, Math.round(b.y) + 0.5);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // World boundary.
  const topLeft = projectToScreen(vp, { x: MAP.worldMinX, y: MAP.worldMaxY });
  const bottomRight = projectToScreen(vp, { x: MAP.worldMaxX, y: MAP.worldMinY });
  ctx.strokeStyle = resolve('--color-border', '#2a3242');
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y,
  );

  // Origin crosshair — the one fixed reference on a grid with no landmarks.
  const origin = projectToScreen(vp, { x: 0, y: 0 });
  ctx.strokeStyle = resolve('--color-text-disabled', '#3a4459');
  ctx.beginPath();
  ctx.moveTo(origin.x - 7, origin.y); ctx.lineTo(origin.x + 7, origin.y);
  ctx.moveTo(origin.x, origin.y - 7); ctx.lineTo(origin.x, origin.y + 7);
  ctx.stroke();
}

function drawMarkers(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  markers: readonly MapMarker[],
  selectedId: string | null,
  targets: HitTarget[],
  resolve: Resolver,
): void {
  const fallback = resolve('--color-text-secondary', '#9aa4b8');

  for (const marker of markers) {
    const point = projectToScreen(vp, { x: marker.x, y: marker.y });
    if (point.x < -40 || point.y < -40 || point.x > vp.width + 40 || point.y > vp.height + 40) {
      continue;
    }

    const color = marker.color ?? marker.organization?.color ?? fallback;

    // A square, so a marker is distinguishable from a unit (chevron) and an
    // incident (triangle) without relying on colour.
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(-5, -5, 10, 10);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = resolve('--color-base', '#0b0e14');
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-5, -5, 10, 10);
    ctx.restore();

    if (marker.id === selectedId) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = resolve('--color-accent', '#4d8ee8');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    targets.push({ kind: 'marker', id: marker.id, point });
  }
}

function drawIncidents(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  incidents: readonly MapIncidentMarker[],
  selectedId: string | null,
  targets: HitTarget[],
  resolve: Resolver,
): void {
  for (const incident of incidents) {
    const point = projectToScreen(vp, { x: incident.x, y: incident.y });
    if (point.x < -40 || point.y < -40 || point.x > vp.width + 40 || point.y > vp.height + 40) {
      continue;
    }

    const color = resolve(`--priority-${incident.priority}`, '#d94141');

    // Triangle. Shape carries "incident"; colour carries priority.
    ctx.beginPath();
    ctx.moveTo(point.x, point.y - 9);
    ctx.lineTo(point.x + 8, point.y + 6);
    ctx.lineTo(point.x - 8, point.y + 6);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = resolve('--color-base', '#0b0e14');
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // A P1 gets a ring. Not an animation: a pulsing marker on a map an operator
    // stares at for eight hours is fatiguing, and the ring reads at a glance.
    if (incident.priority === 1) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (incident.id === selectedId) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 17, 0, Math.PI * 2);
      ctx.strokeStyle = resolve('--color-accent', '#4d8ee8');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    targets.push({ kind: 'incident', id: incident.id, point });
  }
}

function drawUnits(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  units: readonly MapUnit[],
  selectedId: string | null,
  interpolator: MapInterpolator,
  now: number,
  wallClock: number,
  targets: HitTarget[],
  resolve: Resolver,
): void {
  // Interpolated pose per unit, so clustering, hit-testing and drawing all agree
  // on where a unit is at this instant.
  const positioned = units.flatMap((unit) => {
    if (unit.location === null) return [];
    const pose = interpolator.poseOf(unit.id, now)
      ?? { x: unit.location.x, y: unit.location.y, heading: unit.location.heading ?? 0 };
    return [{ id: unit.id, unit, position: { x: pose.x, y: pose.y }, heading: pose.heading }];
  });

  const { singles, clusters } = clusterByScreenGrid(positioned, vp, {
    cellSize: DEFAULT_CLUSTER_CELL,
    disableAboveScale: LABEL_MIN_SCALE,
  });

  const showLabels = vp.scale >= LABEL_MIN_SCALE;

  for (const cluster of clusters) {
    drawCluster(ctx, cluster.point, cluster.members.length, resolve);
    targets.push({
      kind: 'cluster',
      id: cluster.key,
      point: cluster.point,
      positions: cluster.members.map((m) => m.position),
    });
  }

  const base = resolve('--color-base', '#0b0e14');
  const accent = resolve('--color-accent', '#4d8ee8');
  const panic = resolve('--status-panic', '#ff3b3b');
  const labelColor = resolve('--color-text-primary', '#e6eaf2');

  for (const entry of singles) {
    const { unit, heading } = entry.item;
    const point = entry.point;
    if (point.x < -60 || point.y < -60 || point.x > vp.width + 60 || point.y > vp.height + 60) {
      continue;
    }

    const stale = unit.location !== null
      && wallClock - Date.parse(unit.location.updatedAt) > UNIT_STALE_AFTER_MS;
    const selected = unit.id === selectedId;
    const orgColor = unit.organization.color;

    ctx.save();
    // A stale position is drawn faded. The position is no longer something to
    // act on, and that has to be visible without reading the panel.
    if (stale) ctx.globalAlpha = 0.4;

    ctx.translate(point.x, point.y);
    ctx.rotate(((heading - 90) * Math.PI) / 180);

    // Chevron: shape carries heading, fill carries availability, outline carries
    // organization. Colour is never the only signal.
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, 6.5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -6.5);
    ctx.closePath();
    ctx.fillStyle = unit.status.isAvailable ? orgColor : base;
    ctx.fill();
    ctx.strokeStyle = orgColor;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();

    // A covert unit gets a broken outline — only viewers cleared to see one ever
    // receive it, and when they do they should be able to tell at a glance.
    if (unit.isCovert) {
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.strokeStyle = orgColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    if (unit.status.key === 'panic') {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 16, 0, Math.PI * 2);
      ctx.strokeStyle = panic;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    if (selected) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 18, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Callsign, outlined so it stays readable over any base colour. The
    // selected unit is always labelled — that is the one the operator is
    // actively tracking, and losing its identity on zoom-out is the one case
    // where the decluttering would cost something.
    if (showLabels || selected) {
      ctx.save();
      if (stale) ctx.globalAlpha = 0.5;
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = base;
      ctx.strokeText(unit.callsign, point.x, point.y + LABEL_OFFSET);
      ctx.fillStyle = labelColor;
      ctx.fillText(unit.callsign, point.x, point.y + LABEL_OFFSET);
      ctx.restore();
    }

    targets.push({ kind: 'unit', id: unit.id, point });
  }
}

function drawCluster(
  ctx: CanvasRenderingContext2D,
  point: ScreenPoint,
  count: number,
  resolve: Resolver,
): void {
  const radius = count < 5 ? 12 : count < 15 ? 15 : 18;

  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = resolve('--color-surface', '#12161f');
  ctx.globalAlpha = 0.92;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = resolve('--color-border', '#2a3242');
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = resolve('--color-text-primary', '#e6eaf2');
  ctx.fillText(String(count), point.x, point.y);
  ctx.textBaseline = 'alphabetic';
}
