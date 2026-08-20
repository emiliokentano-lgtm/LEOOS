'use client';

import * as React from 'react';
import {
  DEFAULT_CLUSTER_CELL, MAP, MAP_TICK_MS, WORLD_BOUNDS,
  boundsOf, centerViewport, clusterByScreenGrid, fitViewport, freshnessOf, matchesUnitFilter,
  panViewport, projectToScreen, resizeViewport, screenToWorld, worldViewport, zoomViewportAt,
  type MapFilterState, type MapIncidentMarker, type MapMarker,
  type MapUnit, type ScreenPoint, type Viewport, type WorldPosition,
} from '@leoos/contracts';
import { MapInterpolator } from '@/lib/map/interpolation';
import type { MapUnitStore } from '@/lib/map/unit-store';
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
  /**
   * Centres on one point WITHOUT changing zoom.
   *
   * Distinct from `fitTo` with a single position, which would frame a
   * zero-area box and zoom to an arbitrary extreme. Used by "locate", where the
   * operator wants to be taken to a place and keep the scale they were reading.
   */
  centerOn(position: WorldPosition): void;
  zoomBy(factor: number): void;
  reset(): void;
}

export interface MapCanvasProps {
  /**
   * The unit store, subscribed to DIRECTLY rather than passed as a prop array.
   *
   * Positions arrive once a second. Handing them in as a prop would mean a React
   * render per second to move pixels this component repaints on its own
   * animation frame anyway — so the canvas reads them from the store inside the
   * draw loop and React is never involved. See lib/map/unit-store.ts.
   */
  store: MapUnitStore;
  /** Applied inside the draw loop, so a filter change costs one repaint. */
  filter: MapFilterState;
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
  /**
   * Reports the viewport whenever it changes.
   *
   * The off-screen panic indicators are DOM, not canvas — they need to be
   * readable by a screen reader and to survive a repaint — so they need the same
   * transform the canvas is drawing with. Fired on pan, zoom and resize only,
   * not per frame.
   */
  onViewportChange?: (viewport: Viewport | null) => void;
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
  store, filter, incidents, markers, onViewportChange,
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
  /**
   * Held in a ref because the position subscription is set up ABOVE the draw
   * loop's declaration, and reordering them would put the subscription after the
   * first frame — losing the batch that arrives during mount.
   */
  const requestDrawRef = React.useRef<() => void>(() => {});

  /**
   * The live, filtered set that the draw loop reads.
   *
   * A ref rather than state: it is refreshed by the store subscription below and
   * never triggers a render, which is the whole reason positions were taken out
   * of React. Declared here, above the framing block, because that block runs
   * during render and reads it to decide the initial viewport.
   */
  const unitsRef = React.useRef<MapUnit[]>([]);

  /**
   * How many units are drawn, and whether any has a position yet.
   *
   * The only two facts about the live set that RENDER needs — the accessible
   * label, and whether there is anything to frame. Both change rarely, so
   * holding them in state costs a render when a unit joins or leaves and nothing
   * at all when one moves.
   */
  const [drawn, setDrawn] = React.useState({ count: 0, positioned: 0 });
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
      // Full extent to begin with. Framing the fleet needs the unit positions,
      // which live in a ref — and reading a ref during render is exactly the
      // unstable-result hazard React's compiler rejects — so that happens in the
      // effect below instead, on the first batch that has something to frame.
      workingViewport = worldViewport(size.width, size.height);
      setViewport(workingViewport);
    } else if (workingViewport.width !== size.width || workingViewport.height !== size.height) {
      workingViewport = resizeViewport(workingViewport, size.width, size.height);
      setViewport(workingViewport);
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
  /**
   * Follow mode re-centres inside the DRAW LOOP, not in a memo.
   *
   * The followed unit's position now changes without a render, so a memo keyed
   * on it would never re-run and the camera would lock to wherever the unit was
   * when follow was switched on. Applying it per frame also means the camera
   * tracks the INTERPOLATED position, so following is as smooth as the marker.
   */
  const followRef = React.useRef(followUnitId);

  const effectiveViewport = workingViewport;

  /**
   * Follow is mirrored into a ref for the draw loop, and the loop is kicked.
   *
   * Both in an effect rather than during render: the draw loop reads the ref
   * from an animation frame, so it needs the COMMITTED value, and writing it
   * during render would set it from a pass React may discard.
   */
  React.useEffect(() => {
    followRef.current = followUnitId;
    requestDrawRef.current();
  }, [followUnitId]);

  // Reported in an effect rather than during render: calling a parent's setState
  // mid-render is the "cannot update a component while rendering another" error.
  React.useEffect(() => {
    onViewportChange?.(effectiveViewport);
  }, [effectiveViewport, onViewportChange]);

  const refreshUnits = React.useCallback(() => {
    const now = Date.now();
    const next = store.livingUnits().filter(
      (unit) => matchesUnitFilter(unit, filter, freshnessOf(unit.location, now)),
    );
    unitsRef.current = next;
    interpolator.current.update(next, performance.now(), MAP_TICK_MS);

    // Only when it actually differs: this runs once a second, and setting state
    // unconditionally here would undo the entire point of the store.
    const positioned = next.reduce((n, u) => (u.location === null ? n : n + 1), 0);
    setDrawn((current) => (
      current.count === next.length && current.positioned === positioned
        ? current
        : { count: next.length, positioned }
    ));
  }, [store, filter]);

  /**
   * Positions, straight from the store.
   *
   * One subscription, no state, no render. A batch arrives, the interpolator is
   * given new targets, and a frame is scheduled — the same path a pan or a zoom
   * takes.
   */
  React.useEffect(() => {
    /**
     * The priming call is deferred one frame; the subscription is not.
     *
     * `refreshUnits` may set the drawn-count state, and doing that synchronously
     * inside an effect is the cascading-render pattern. Batches arriving later
     * are already outside the render cycle, so they refresh immediately — only
     * the first pull waits, and a frame is imperceptible.
     */
    const primed = requestAnimationFrame(() => {
      refreshUnits();
      requestDrawRef.current();
    });

    const release = store.subscribePositions(() => {
      refreshUnits();
      requestDrawRef.current();
    });

    return () => {
      cancelAnimationFrame(primed);
      release();
    };
  }, [store, refreshUnits]);

  // A filter change is not a position change, but it does change what is drawn.
  React.useEffect(() => {
    const handle = requestAnimationFrame(() => {
      refreshUnits();
      requestDrawRef.current();
    });
    return () => cancelAnimationFrame(handle);
  }, [filter, refreshUnits]);

  /**
   * The initial fit, EXACTLY ONCE, on the first batch with something in it.
   *
   * The GTA world is mostly water and desert, so opening at full extent shows an
   * empty grid with the units too small to read; framing the fleet is what an
   * operator wants on arrival, and zooming out is one gesture away. `framed`
   * makes it happen once — re-fitting on every roster change would yank the
   * camera away from wherever the operator had panned to.
   */
  React.useEffect(() => {
    if (framed || drawn.positioned === 0) return;
    if (size.width === 0 || size.height === 0) return;

    const positions = unitsRef.current
      .map((u) => u.location)
      .filter((l): l is NonNullable<typeof l> => l !== null);
    const bounds = boundsOf(positions);
    if (bounds === null) return;

    /**
     * Deferred by one frame.
     *
     * Setting state synchronously inside an effect that just ran because of a
     * state change is the cascading-render pattern React's compiler warns about.
     * A frame's delay is imperceptible for a one-off camera fit, and it lets the
     * commit that produced these positions finish first.
     */
    const handle = requestAnimationFrame(() => {
      setFramed(true);
      setViewport(fitViewport(bounds, size.width, size.height));
    });
    return () => cancelAnimationFrame(handle);
  }, [framed, drawn.positioned, size.width, size.height]);

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
    centerOn(position) {
      setViewport((current) => (current === null ? current : centerViewport(current, position)));
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

  React.useEffect(() => { requestDrawRef.current = requestDraw; }, [requestDraw]);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || effectiveViewport === null) return;
    if (size.width === 0 || size.height === 0) return;

    const now = performance.now();
    const wallClock = Date.now();

    /**
     * Follow mode, applied per frame against the INTERPOLATED pose.
     *
     * Centring on the raw sample would move the camera in one-second steps while
     * the marker glided between them — the unit would visibly slide away from
     * the middle of the screen and snap back. Reading the same pose the marker is
     * drawn at keeps them locked together.
     */
    let viewportForFrame = effectiveViewport;
    const following = followRef.current;
    if (following !== null) {
      const pose = interpolator.current.poseOf(following, now);
      const fallback = unitsRef.current.find((u) => u.id === following)?.location ?? null;
      const at = pose ?? (fallback === null ? null : { x: fallback.x, y: fallback.y });
      if (at !== null) viewportForFrame = centerViewport(effectiveViewport, at);
    }
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== Math.round(size.width * dpr)) {
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const targets: HitTarget[] = [];

    drawBaseGrid(ctx, viewportForFrame, size, resolveToken);
    drawMarkers(ctx, viewportForFrame, markers, selectedMarkerId, targets, resolveToken);
    drawIncidents(ctx, viewportForFrame, incidents, selectedIncidentId, targets, resolveToken);
    drawUnits(
      ctx, viewportForFrame, unitsRef.current, selectedUnitId, interpolator.current,
      now, wallClock, targets, resolveToken,
    );

    hitTargets.current = targets;

    if (interpolator.current.isAnimating(now) || followRef.current !== null) requestDraw();
    // `unitsRef` is deliberately absent: it is a ref, refreshed by the store
    // subscription, and depending on it would be depending on nothing.
  }, [
    effectiveViewport, size, incidents, markers,
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
      onSelectUnit(unitsRef.current.find((u) => u.id === target.id) ?? null);
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
          `Tactical map: ${drawn.count} unit${drawn.count === 1 ? '' : 's'}, ` +
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

    const freshness = freshnessOf(unit.location, wallClock);
    const selected = unit.id === selectedId;
    const orgColor = unit.organization.color;

    ctx.save();

    /**
     * FRESHNESS IS DRAWN AS SHAPE, NOT ONLY AS OPACITY.
     *
     *   live     a solid chevron pointing where the unit is heading
     *   stale    the same chevron, faded — where it WAS
     *   offline  a hollow ring with NO heading at all
     *
     * The offline case drops the chevron deliberately. A chevron asserts a
     * direction, and for a position the feed abandoned a minute ago we have no
     * idea which way the unit is facing — drawing one would be the map stating
     * something it does not know. A ring says "it was around here" and says
     * nothing else.
     */
    if (freshness === 'stale') ctx.globalAlpha = 0.45;
    if (freshness === 'offline') ctx.globalAlpha = 0.3;

    ctx.translate(point.x, point.y);

    if (freshness === 'offline') {
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.strokeStyle = orgColor;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.stroke();
      // A cross through it: unmistakable at a glance and legible to anyone who
      // cannot distinguish the outline colour from a live unit's.
      ctx.beginPath();
      ctx.moveTo(-3.5, -3.5); ctx.lineTo(3.5, 3.5);
      ctx.moveTo(3.5, -3.5); ctx.lineTo(-3.5, 3.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.rotate(((heading - 90) * Math.PI) / 180);

      // Chevron: shape carries heading, fill carries availability, outline
      // carries organization. Colour is never the only signal.
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
    }

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

    /**
     * PANIC, drawn to be found — with no animation involved.
     *
     * The brief is explicit that the location must be obvious without relying on
     * flashing, and it is right to be: an operator scanning a wall display sees
     * a blink for half its duty cycle, a colour-blind operator may not read the
     * red at all, and `prefers-reduced-motion` turns animation off entirely.
     *
     * So the emphasis is STATIC and layered, and each layer works alone:
     *   · a filled halo, visible in peripheral vision
     *   · two concentric rings, a shape nothing else on the map uses
     *   · crosshair ticks pointing at the exact position
     *   · an always-drawn label, even zoomed out past the labelling threshold
     *
     * The standing panic bar above the map and the off-screen bearing arrow do
     * the rest — see map-view.tsx.
     */
    if (unit.status.key === 'panic') {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 26, 0, Math.PI * 2);
      ctx.fillStyle = panic;
      ctx.fill();
      ctx.restore();

      for (const radius of [15, 21]) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = panic;
        ctx.lineWidth = radius === 15 ? 2.5 : 1.25;
        ctx.stroke();
      }

      ctx.beginPath();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        ctx.moveTo(point.x + dx * 24, point.y + dy * 24);
        ctx.lineTo(point.x + dx * 31, point.y + dy * 31);
      }
      ctx.strokeStyle = panic;
      ctx.lineWidth = 2;
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
    // A panic unit is ALWAYS labelled. Zoomed out is exactly when an operator
    // needs to know which unit it is, and the decluttering rule is the wrong
    // trade for the one marker on the map that matters most.
    if (showLabels || selected || unit.status.key === 'panic') {
      ctx.save();
      if (freshness === 'stale') ctx.globalAlpha = 0.5;
      if (freshness === 'offline') ctx.globalAlpha = 0.4;
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
