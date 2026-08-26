#!/usr/bin/env node
/**
 * What drawing areas and routes actually costs.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 * It measures the GEOMETRY WORK the shape layer adds to the map: the once-per-
 * change preparation (`shapeBounds`, `shapeLabelAnchor`) and the per-frame
 * decision and projection (`shapeRenderPlan`, `projectToScreen`). Those are the
 * parts written for this feature, and they run the REAL functions from
 * `@leoos/contracts` — the same ones `map-canvas.tsx` calls, not a copy.
 *
 * It does NOT measure canvas rasterisation. Filling and stroking paths is the
 * browser's work, it is proportional to pixels rather than to shapes, and a
 * Node process has no GPU to measure it on. Frame time on the real page is
 * covered by `live-map-check.mjs`, which measures DOM mutations under a live
 * feed. Reporting a number here that did not include rasterisation AS a frame
 * time would be a claim this script cannot make (engineering rule 45).
 *
 * Run:  pnpm --filter @leoos/contracts bench
 * ────────────────────────────────────────────────────────────────────────────
 */

import { MAP } from '../src/geo.ts';
import {
  MAX_SCALE, minScaleFor, projectToScreen, visibleBounds, type Viewport,
} from '../src/map-viewport.ts';
import {
  shapeBounds, shapeLabelAnchor, shapeRenderPlan,
  type MapShapeKind, type MapShapePoint,
} from '../src/map-shapes.ts';

const FRAMES = 600;          // ten seconds at 60 Hz
const VIEW = { width: 1600, height: 900 };

/** Deterministic, so two runs of this script are comparable. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface BenchShape { id: string; kind: MapShapeKind; points: MapShapePoint[] }

function makeShapes(count: number, pointsEach: number, seed: number): BenchShape[] {
  const random = makeRandom(seed);
  const spanX = MAP.worldMaxX - MAP.worldMinX;
  const spanY = MAP.worldMaxY - MAP.worldMinY;

  return Array.from({ length: count }, (_, i) => {
    const cx = MAP.worldMinX + random() * spanX;
    const cy = MAP.worldMinY + random() * spanY;
    // Radii from a city block to a district — the range a cordon or an approach
    // actually spans.
    const radius = 40 + random() * 600;
    const points = Array.from({ length: pointsEach }, (_, k) => {
      const angle = (k / pointsEach) * Math.PI * 2;
      return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
    });
    return { id: `s${i}`, kind: (i % 2 === 0 ? 'area' : 'route') as MapShapeKind, points };
  });
}

function prepare(shapes: BenchShape[]) {
  return shapes.map((shape) => ({
    shape,
    bounds: shapeBounds(shape.points),
    anchor: shapeLabelAnchor(shape.points),
  }));
}

/**
 * One frame of the shape layer's geometry work.
 *
 * Mirrors `drawShapes` exactly except for the canvas calls: cull, stride,
 * project every kept vertex, project the label anchor.
 */
function frame(
  prepared: ReturnType<typeof prepare>,
  viewport: Viewport,
  sink: { x: number },
) {
  const view = visibleBounds(viewport, 64);
  let drawnShapes = 0;
  let projections = 0;

  for (const { shape, bounds, anchor } of prepared) {
    const points = shape.points;
    const plan = shapeRenderPlan(bounds, view, points.length, viewport.scale);
    if (!plan.visible) continue;
    drawnShapes += 1;

    sink.x += projectToScreen(viewport, points[0]!).x;
    projections += 1;
    for (let i = plan.stride; i < points.length - 1; i += plan.stride) {
      sink.x += projectToScreen(viewport, points[i]!).x;
      projections += 1;
    }
    sink.x += projectToScreen(viewport, points[points.length - 1]!).x;
    projections += 1;

    if (anchor !== null) {
      sink.x += projectToScreen(viewport, anchor).x;
      projections += 1;
    }
  }

  return { drawnShapes, projections };
}

function bench(label: string, count: number, pointsEach: number, scale: number) {
  const shapes = makeShapes(count, pointsEach, count * 7919 + pointsEach);

  // Warm the JIT before timing, or the first case pays for compiling the
  // functions every later case then measures as fast.
  prepare(shapes);

  const PREP_RUNS = 20;
  const prepStart = performance.now();
  let prepared = prepare(shapes);
  for (let i = 1; i < PREP_RUNS; i += 1) prepared = prepare(shapes);
  const prepMs = (performance.now() - prepStart) / PREP_RUNS;

  const viewport = {
    center: { x: 0, y: 0 }, scale, width: VIEW.width, height: VIEW.height,
  };
  // Pan across the world as the frames run, so the cull is exercised at every
  // ratio rather than measured once at a lucky position.
  const sink = { x: 0 };
  let drawn = 0;
  let projections = 0;

  // One warm pass, discarded, for the same reason.
  frame(prepared, viewport, sink);

  const start = performance.now();
  for (let f = 0; f < FRAMES; f += 1) {
    viewport.center = {
      x: MAP.worldMinX + ((f / FRAMES) * (MAP.worldMaxX - MAP.worldMinX)),
      y: MAP.worldMinY + ((f / FRAMES) * (MAP.worldMaxY - MAP.worldMinY)),
    };
    const result = frame(prepared, viewport, sink);
    drawn += result.drawnShapes;
    projections += result.projections;
  }
  const totalMs = performance.now() - start;

  // Read the sink so the projections cannot be optimised away.
  if (!Number.isFinite(sink.x)) throw new Error('unreachable');

  return {
    label,
    count,
    pointsEach,
    scale,
    prepMs,
    perFrameMs: totalMs / FRAMES,
    drawnPerFrame: drawn / FRAMES,
    projectionsPerFrame: projections / FRAMES,
  };
}

/**
 * The two zoom levels that bound what an operator can be looking at.
 *
 * WHOLE MAP is the scale at which the world fits the viewport — the cull can
 * discard nothing, which is the honest worst case for the per-frame loop. STREET
 * is the renderer's maximum zoom, where most shapes fall outside the viewport
 * and the cull does its work. Taken from the viewport module rather than typed
 * as constants, so a change to the zoom limits changes this benchmark too.
 */
const WHOLE_MAP = minScaleFor(VIEW.width, VIEW.height);
const STREET = MAX_SCALE;

const CASES: Array<[string, number, number, number]> = [
  ['10 hand-drawn shapes (12 pts), whole map', 10, 12, WHOLE_MAP],
  ['50 hand-drawn shapes (12 pts), whole map', 50, 12, WHOLE_MAP],
  ['50 hand-drawn shapes (12 pts), street zoom', 50, 12, STREET],
  ['200 hand-drawn shapes (12 pts), whole map', 200, 12, WHOLE_MAP],
  ['50 shapes at the 500-point ceiling, whole map', 50, 500, WHOLE_MAP],
  ['200 shapes at the 500-point ceiling, whole map', 200, 500, WHOLE_MAP],
  ['200 shapes at the 500-point ceiling, street zoom', 200, 500, STREET],
];

console.log('Shape layer — geometry cost per frame');
console.log(`${FRAMES} frames, ${VIEW.width}×${VIEW.height}, panning across the world.`);
console.log('Rasterisation is NOT included; see the header of this file.\n');

const rows = CASES.map(([label, count, points, scale]) => bench(label, count, points, scale));

const pad = (value: string | number, width: number) => String(value).padStart(width);
console.log(
  `${'case'.padEnd(52)}${pad('prep ms', 9)}${pad('frame ms', 10)}`
  + `${pad('drawn', 8)}${pad('projections', 13)}`,
);
console.log('-'.repeat(92));
for (const row of rows) {
  console.log(
    row.label.padEnd(52)
    + pad(row.prepMs.toFixed(2), 9)
    + pad(row.perFrameMs.toFixed(3), 10)
    + pad(row.drawnPerFrame.toFixed(1), 8)
    + pad(Math.round(row.projectionsPerFrame), 13),
  );
}

/**
 * The budget.
 *
 * A 60 Hz frame is 16.7 ms and the unit layer is the one that must fit in it.
 * Shapes are context, so their geometry work is held to 1 ms — about 6% of a
 * frame — even in the worst case this benchmark constructs, which is 200 shapes
 * each at the 500-point ceiling: a hundred thousand points, and far more than
 * any real board carries.
 */
const worst = rows.reduce((a, b) => (a.perFrameMs > b.perFrameMs ? a : b));
console.log(`\nworst case: ${worst.label} — ${worst.perFrameMs.toFixed(3)} ms/frame`);

if (worst.perFrameMs > 1) {
  console.error('\nshape-render-bench: over the 1 ms budget.');
  process.exit(1);
}
console.log('shape-render-bench: within the 1 ms budget.');
