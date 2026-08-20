'use client';


import { TriangleAlert } from 'lucide-react';
import {
  formatWorldPosition, projectToScreen,
  type MapUnit, type Viewport,
} from '@leoos/contracts';
import { Button } from '@/components/ui';
import type { MapUnitStore } from '@/lib/map/unit-store';
import { useUnitPosition } from '@/lib/map/use-unit-store';
import { cn } from '@/lib/utils';

/**
 * Making a panic impossible to miss WITHOUT relying on animation.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY NOT JUST FLASH IT
 *
 * A blinking marker is invisible for half its duty cycle, and an operator
 * glancing at a wall display has a fair chance of glancing during the off half.
 * It also fails three ways that matter here: a colour-blind operator may not
 * read the red at all; `prefers-reduced-motion` disables it outright; and if the
 * unit is off the current viewport there is nothing to flash.
 *
 * So there are three static mechanisms, and each works on its own:
 *
 *   1. THIS BAR — a standing, unfilterable row naming every unit in panic, with
 *      its position and a button that takes the camera there. Present whether or
 *      not the marker is on screen, and readable in monochrome.
 *   2. AN OFF-SCREEN ARROW — when the unit is outside the viewport, an arrow
 *      pinned to the edge pointing at it, with the distance. "Obvious without
 *      relying on flashing" means an operator must be able to find the location,
 *      and a marker they cannot see does not help them.
 *   3. THE MARKER ITSELF — halo, double ring, crosshair ticks and a permanent
 *      label, drawn statically in map-canvas.tsx.
 * ────────────────────────────────────────────────────────────────────────────
 */

export function PanicBar({
  units, store, onLocate,
}: {
  units: MapUnit[];
  store: MapUnitStore;
  onLocate: (unit: MapUnit) => void;
}) {
  if (units.length === 0) return null;

  return (
    <div
      // `alert`, so a screen reader announces it the moment it appears rather
      // than when the operator next happens to tab through the page.
      role="alert"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5',
        'border-[var(--status-panic)] bg-danger-subtle',
      )}
    >
      <span className="flex items-center gap-1.5 font-semibold text-danger">
        <TriangleAlert className="size-3.5" aria-hidden />
        <span className="text-xs uppercase tracking-wide">
          Panic · {units.length}
        </span>
      </span>

      {units.map((unit) => (
        <PanicEntry key={unit.id} unit={unit} store={store} onLocate={onLocate} />
      ))}
    </div>
  );
}

function PanicEntry({
  unit, store, onLocate,
}: {
  unit: MapUnit;
  store: MapUnitStore;
  onLocate: (unit: MapUnit) => void;
}) {
  // Subscribes to THIS unit only. A panic bar showing live coordinates is worth
  // a render per second; the 150-row list behind it is not, which is why they
  // read the store at different granularities.
  const position = useUnitPosition(store, unit.id);

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className="font-mono font-semibold text-text-primary">{unit.callsign}</span>
      <span
        className="rounded-[2px] border px-1 text-[9px]"
        style={{ borderColor: unit.organization.color, color: unit.organization.color }}
      >
        {unit.organization.shortName}
      </span>
      {unit.crew.length > 0 ? (
        <span className="text-text-secondary">{unit.crew.map((c) => c.name).join(', ')}</span>
      ) : null}
      <span className="font-mono text-2xs text-text-tertiary">
        {position === null ? 'position unknown' : formatWorldPosition(position)}
      </span>
      <Button
        size="xs"
        variant="danger"
        onClick={() => onLocate(unit)}
        disabled={position === null}
      >
        Locate
      </Button>
    </span>
  );
}

/**
 * An arrow at the edge of the map pointing at an off-screen panic.
 *
 * Rendered in DOM rather than on the canvas deliberately: it is chrome, not
 * data, it needs to be readable by a screen reader, and it must survive the
 * canvas being mid-repaint.
 */
export function OffScreenPanicMarkers({
  units, store, viewport, onLocate,
}: {
  units: MapUnit[];
  store: MapUnitStore;
  viewport: Viewport | null;
  onLocate: (unit: MapUnit) => void;
}) {
  if (viewport === null || units.length === 0) return null;

  return (
    <>
      {units.map((unit) => (
        <OffScreenArrow
          key={unit.id}
          unit={unit}
          store={store}
          viewport={viewport}
          onLocate={onLocate}
        />
      ))}
    </>
  );
}

/** Inset from the edge, so the arrow is not clipped by the map's own border. */
const EDGE_INSET = 26;

function OffScreenArrow({
  unit, store, viewport, onLocate,
}: {
  unit: MapUnit;
  store: MapUnitStore;
  viewport: Viewport;
  onLocate: (unit: MapUnit) => void;
}) {
  const position = useUnitPosition(store, unit.id);
  if (position === null) return null;

  const point = projectToScreen(viewport, position);
  const onScreen = point.x >= 0 && point.y >= 0
    && point.x <= viewport.width && point.y <= viewport.height;

  // On screen, the marker speaks for itself — a second indicator on top of it
  // would just be clutter over the thing it is pointing at.
  if (onScreen) return null;

  /**
   * Clamped to the edge, along the line from the centre.
   *
   * The arrow sits where that line crosses the inset rectangle, so its position
   * on the border encodes the bearing: an operator can read which way to pan
   * without reading any text.
   */
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;

  const halfW = Math.max(1, cx - EDGE_INSET);
  const halfH = Math.max(1, cy - EDGE_INSET);
  const scale = Math.min(
    halfW / Math.max(Math.abs(dx), 0.001),
    halfH / Math.max(Math.abs(dy), 0.001),
  );

  const edgeX = cx + dx * scale;
  const edgeY = cy + dy * scale;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  // Metres, from the viewport's own scale — the same transform the markers use.
  const metres = Math.hypot(dx, dy) / viewport.scale;
  const distance = metres > 1000
    ? `${(metres / 1000).toFixed(1)} km`
    : `${Math.round(metres)} m`;

  return (
    <button
      type="button"
      onClick={() => onLocate(unit)}
      style={{ left: edgeX, top: edgeY }}
      className={cn(
        'absolute z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1',
        'rounded-full border-2 border-[var(--status-panic)] bg-base px-1.5 py-0.5',
        'text-2xs font-semibold text-danger shadow-lg',
      )}
      aria-label={`Panic: ${unit.callsign}, ${distance} off screen. Activate to centre the map.`}
    >
      <span
        aria-hidden
        style={{ transform: `rotate(${angle}deg)` }}
        className="inline-block leading-none"
      >
        ➤
      </span>
      <span className="font-mono">{unit.callsign}</span>
      <span className="font-mono text-text-tertiary">{distance}</span>
    </button>
  );
}
