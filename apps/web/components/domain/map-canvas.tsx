'use client';

import * as React from 'react';
import { MAP, worldToMap, type WorldPosition } from '@leoos/contracts';
import { DUTY_STATUSES } from '@leoos/contracts';
import type { MockIncident, MockUnit } from '@/mocks/operations';
import { mockOrg } from '@/mocks/organizations';
import { PRIORITIES } from '@leoos/contracts';

/**
 * Canvas rendering layer for map units and incidents.
 *
 * Units are drawn on a SINGLE canvas rather than as DOM markers. Leaflet-style
 * DOM markers do not hold 60fps at 300 units updating at 1Hz, and building the
 * canvas layer later would mean rewriting hit-testing and labelling. This is the
 * layer ADR-0005 commits to; it is written now so the performance property is
 * designed in rather than discovered.
 *
 * The BASE LAYER IS A PLACEHOLDER GRID, not the GTA map: the real raster tile
 * pyramid is blocked on asset licensing (docs/architecture/05-map.md §3).
 * Positions use the real world→map transform from @leoos/contracts, so swapping
 * the placeholder for tiles does not move anything.
 */

export interface MapCanvasProps {
  units: MockUnit[];
  incidents: MockIncident[];
  selectedUnitId?: string | null;
  onSelectUnit?: (unit: MockUnit | null) => void;
  onSelectIncident?: (incident: MockIncident) => void;
  className?: string;
}

interface Viewport { scale: number; offsetX: number; offsetY: number }

const UNIT_HIT_RADIUS = 14;

export function MapCanvas({
  units, incidents, selectedUnitId, onSelectUnit, onSelectIncident, className,
}: MapCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = React.useState<Viewport>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const dragState = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const hasFitted = React.useRef(false);

  // Track container size for the backing store.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Frame the active units on first paint.
   *
   * The GTA world is mostly water and desert; opening at full extent shows an
   * empty grid with a cluster of units too small to read. Fitting to the units
   * is what an operator wants on arrival — and panning out is one gesture away.
   */
  React.useEffect(() => {
    if (hasFitted.current || size.width === 0 || units.length === 0) return;
    hasFitted.current = true;

    const points = units.map((u) => worldToMap({ x: u.x, y: u.y }));
    const us = points.map((p) => p.u);
    const vs = points.map((p) => p.v);
    const minU = Math.min(...us), maxU = Math.max(...us);
    const minV = Math.min(...vs), maxV = Math.max(...vs);

    const base = Math.min(size.width, size.height);
    const padding = 0.06; // normalised breathing room around the cluster
    const spanU = Math.max(maxU - minU, 0.02) + padding * 2;
    const spanV = Math.max(maxV - minV, 0.02) + padding * 2;

    const scale = Math.min(size.width / (spanU * base), size.height / (spanV * base), 6);
    const centreU = (minU + maxU) / 2;
    const centreV = (minV + maxV) / 2;

    setViewport({
      scale,
      offsetX: size.width / 2 - centreU * base * scale - (size.width - base) / 2,
      offsetY: size.height / 2 - centreV * base * scale - (size.height - base) / 2,
    });
  }, [units, size]);

  /** World position → canvas pixel, through the shared transform. */
  const project = React.useCallback(
    (pos: WorldPosition): { x: number; y: number } => {
      const { u, v } = worldToMap(pos);
      const base = Math.min(size.width, size.height);
      return {
        x: u * base * viewport.scale + viewport.offsetX + (size.width - base) / 2,
        y: v * base * viewport.scale + viewport.offsetY + (size.height - base) / 2,
      };
    },
    [size, viewport],
  );

  // ── Draw ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    // Placeholder base: a coordinate grid. Explicitly not a map — it reads as
    // scaffolding so nobody mistakes it for the real thing.
    ctx.strokeStyle = '#1a2030';
    ctx.lineWidth = 1;
    const step = 500; // world metres
    ctx.beginPath();
    for (let wx = MAP.worldMinX; wx <= MAP.worldMaxX; wx += step) {
      const a = project({ x: wx, y: MAP.worldMinY });
      const b = project({ x: wx, y: MAP.worldMaxY });
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let wy = MAP.worldMinY; wy <= MAP.worldMaxY; wy += step) {
      const a = project({ x: MAP.worldMinX, y: wy });
      const b = project({ x: MAP.worldMaxX, y: wy });
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    // World bounds outline
    const tl = project({ x: MAP.worldMinX, y: MAP.worldMaxY });
    const br = project({ x: MAP.worldMaxX, y: MAP.worldMinY });
    ctx.strokeStyle = '#2a3242';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // Origin crosshair — a real landmark reference once tiles land.
    const origin = project({ x: 0, y: 0 });
    ctx.strokeStyle = '#3a4459';
    ctx.beginPath();
    ctx.moveTo(origin.x - 6, origin.y); ctx.lineTo(origin.x + 6, origin.y);
    ctx.moveTo(origin.x, origin.y - 6); ctx.lineTo(origin.x, origin.y + 6);
    ctx.stroke();

    // ── Incidents ──
    for (const incident of incidents) {
      const p = project({ x: incident.x, y: incident.y });
      const color = `var(${PRIORITIES[incident.priority].token})`;
      // Canvas cannot read CSS vars, so resolve against the document.
      const resolved = getComputedStyle(document.documentElement)
        .getPropertyValue(PRIORITIES[incident.priority].token).trim() || '#d94141';

      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 9);
      ctx.lineTo(p.x + 8, p.y + 5);
      ctx.lineTo(p.x - 8, p.y + 5);
      ctx.closePath();
      ctx.fillStyle = resolved;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0b0e14';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      void color;
    }

    // ── Units ──
    for (const unit of units) {
      const p = project({ x: unit.x, y: unit.y });
      const org = mockOrg(unit.organizationId);
      const statusMeta = DUTY_STATUSES[unit.status];
      const selected = unit.id === selectedUnitId;

      // Chevron oriented to heading. Shape carries direction; fill carries
      // organization; outline carries status — colour is never the only signal.
      const angle = ((unit.heading - 90) * Math.PI) / 180;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-6, 6);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-6, -6);
      ctx.closePath();
      ctx.fillStyle = statusMeta.isAvailable ? org.color : '#12161f';
      ctx.fill();
      ctx.strokeStyle = org.color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.stroke();
      ctx.restore();

      if (unit.status === 'panic') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff3b3b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (selected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
        ctx.strokeStyle = '#4d8ee8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Callsign label
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#0b0e14';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#0b0e14';
      ctx.strokeText(unit.callsign, p.x, p.y + 22);
      ctx.fillStyle = '#e6eaf2';
      ctx.fillText(unit.callsign, p.x, p.y + 22);
    }
  }, [units, incidents, project, size, selectedUnitId]);

  // ── Interaction ─────────────────────────────────────────────────────────
  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    let closest: { unit: MockUnit; dist: number } | null = null;
    for (const unit of units) {
      const p = project({ x: unit.x, y: unit.y });
      const dist = Math.hypot(p.x - cx, p.y - cy);
      if (dist <= UNIT_HIT_RADIUS && (!closest || dist < closest.dist)) {
        closest = { unit, dist };
      }
    }
    if (closest) { onSelectUnit?.(closest.unit); return; }

    for (const incident of incidents) {
      const p = project({ x: incident.x, y: incident.y });
      if (Math.hypot(p.x - cx, p.y - cy) <= UNIT_HIT_RADIUS) {
        onSelectIncident?.(incident);
        return;
      }
    }
    onSelectUnit?.(null);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    dragState.current = {
      x: e.clientX, y: e.clientY,
      ox: viewport.offsetX, oy: viewport.offsetY,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragState.current;
    if (!drag) return;
    setViewport((v) => ({
      ...v,
      offsetX: drag.ox + (e.clientX - drag.x),
      offsetY: drag.oy + (e.clientY - drag.y),
    }));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    dragState.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setViewport((v) => ({ ...v, scale: Math.min(8, Math.max(0.5, v.scale * factor)) }));
  }

  return (
    <div ref={containerRef} className={className}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        style={{ width: size.width, height: size.height, touchAction: 'none' }}
        className="cursor-grab active:cursor-grabbing"
        role="img"
        aria-label={`Tactical map showing ${units.length} units and ${incidents.length} incidents. A list view of the same data is available in the side panel.`}
      />
    </div>
  );
}
