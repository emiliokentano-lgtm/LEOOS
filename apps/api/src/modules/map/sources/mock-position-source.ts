import { eq, sql } from 'drizzle-orm';
import { headingDelta, worldDistance, type MapSourceStatus } from '@leoos/contracts';
import { unit, type Database } from '@leoos/db';
import type { LivePositionStore, PositionSample } from './live-positions.js';
import { assertMockSourceAllowed, type PositionSource } from './position-source.js';

/**
 * Simulated unit movement — A MOCK, NOT A FEED (engineering rules 34, 35, 45).
 *
 * No FiveM bridge exists yet. Rather than draw a static map, or invent a fake
 * "connected" indicator, this walks the real units in the database between real
 * places on the map at plausible speeds, and reports itself as
 * `kind: 'mock'` so every surface that shows it says "simulated".
 *
 * It exists to make the map subsystem exercisable end to end — interpolation,
 * staleness, clustering, follow mode and the visibility rules all need units
 * that actually move to be worth anything. When the bridge lands, this class is
 * replaced by one that pushes real samples into the same store, and nothing
 * above it changes.
 *
 * WHAT IT WRITES WHERE, and why that split matters:
 *   • Every tick goes to the in-memory store. That is the live state.
 *   • Postgres is flushed at a fraction of the rate, into the `unit.pos_*`
 *     columns that are documented as a low-rate cache. 1 Hz of position writes
 *     across a shift is exactly the ~13M rows/day that engineering rules 21 and
 *     22 exist to prevent, so the tick rate and the write rate are deliberately
 *     not the same number.
 */

/**
 * Simulation anchors — approximate Los Santos and Blaine County landmarks.
 *
 * These are eyeballed positions used to make simulated patrols travel between
 * recognisable places instead of drifting through the ocean. They are NOT survey
 * data and nothing operational depends on them; the real coordinate calibration
 * is a separate Phase 6 task against the licensed tile set.
 */
const ANCHORS: readonly { name: string; x: number; y: number }[] = [
  { name: 'Legion Square', x: 195, y: -935 },
  { name: 'Mission Row', x: 441, y: -982 },
  { name: 'Pillbox Hill', x: 298, y: -584 },
  { name: 'La Mesa', x: 830, y: -1290 },
  { name: 'Davis', x: 100, y: -1900 },
  { name: 'Los Santos Airport', x: -1037, y: -2737 },
  { name: 'Vespucci Beach', x: -1200, y: -1500 },
  { name: 'Del Perro Pier', x: -1850, y: -1240 },
  { name: 'Vinewood Boulevard', x: 300, y: 180 },
  { name: 'Vinewood Hills', x: -300, y: 700 },
  { name: 'Route 68 / Harmony', x: 270, y: 2800 },
  { name: 'Fort Zancudo', x: -2100, y: 3200 },
  { name: 'Bolingbroke', x: 1700, y: 2600 },
  { name: 'Sandy Shores', x: 1960, y: 3740 },
  { name: 'Grapeseed', x: 1700, y: 4900 },
  { name: 'Mount Chiliad', x: 450, y: 5570 },
  { name: 'Paleto Bay', x: -100, y: 6430 },
];

/** Cruising speed in metres per second, by unit type. */
const SPEED_BY_TYPE: Record<string, number> = {
  air: 55,
  patrol: 22,
  supervisor: 20,
  k9: 20,
  swat: 18,
  ems: 24,
  fire: 16,
  investigation: 18,
  transport: 15,
};
const DEFAULT_SPEED = 18;

/** How sharply a unit may turn, in degrees per second. Air units turn wider. */
const TURN_RATE = 60;
const AIR_TURN_RATE = 25;

/** Within this distance the unit has arrived and picks a new destination. */
const ARRIVAL_RADIUS = 40;

interface SimulatedUnit {
  unitId: string;
  organizationId: string;
  unitType: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  targetIndex: number;
  /** A stationary unit is parked; it reports position but no movement. */
  parked: boolean;
  /** Ticks remaining before a parked unit sets off again. */
  parkedFor: number;
}

/**
 * Deterministic per-unit pseudo-randomness.
 *
 * Seeded from the unit id so a given unit behaves the same way across restarts.
 * `Math.random()` would make every reload produce a different simulation, which
 * turns "the map looks wrong" into an unreproducible report.
 */
function seedFrom(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function nextRandom(state: number): number {
  // xorshift32 — small, fast, and good enough to move a car around a map.
  let x = state;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5; x >>>= 0;
  return x >>> 0;
}

export interface MockPositionSourceOptions {
  db: Database;
  store: LivePositionStore;
  nodeEnv: string;
  log?: (message: string) => void;
  /** Simulation step. Defaults to the map's nominal 1 Hz. */
  tickMs?: number;
  /** How often the `unit.pos_*` cache is written. */
  flushMs?: number;
  /** How often new or disbanded units are picked up. */
  refreshMs?: number;
}

export class MockPositionSource implements PositionSource {
  private readonly db: Database;
  private readonly store: LivePositionStore;
  private readonly log: (message: string) => void;
  private readonly tickMs: number;
  private readonly flushMs: number;
  private readonly refreshMs: number;

  private readonly units = new Map<string, SimulatedUnit>();
  private readonly random = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: MockPositionSourceOptions) {
    assertMockSourceAllowed(options.nodeEnv);
    this.db = options.db;
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.tickMs = options.tickMs ?? 1_000;
    this.flushMs = options.flushMs ?? 30_000;
    this.refreshMs = options.refreshMs ?? 60_000;
  }

  status(): MapSourceStatus {
    return {
      kind: 'mock',
      connected: false,
      label: 'Simulated positions',
      detail: this.running
        ? `No FiveM bridge is connected. ${this.units.size} unit(s) are being moved by a simulator.`
        : 'No FiveM bridge is connected and the simulator is not running.',
      tickMs: this.tickMs,
      placeholderBaseLayer: true,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.log(
      'MAP: no FiveM bridge configured — unit positions are SIMULATED. ' +
        'Nothing on this map reflects a real game server.',
    );

    await this.refreshRoster();

    // `unref` so a simulated map never holds the process open: this is a
    // development convenience, and it must not be the reason a deploy hangs.
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();

    this.flushTimer = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        this.log(`MAP: position cache flush failed: ${String(error)}`);
      });
    }, this.flushMs);
    this.flushTimer.unref?.();

    this.refreshTimer = setInterval(() => {
      void this.refreshRoster().catch((error: unknown) => {
        this.log(`MAP: simulated roster refresh failed: ${String(error)}`);
      });
    }, this.refreshMs);
    this.refreshTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.timer = null;
    this.flushTimer = null;
    this.refreshTimer = null;
  }

  /**
   * Loads the active units and seeds any that are new.
   *
   * A unit that already has a stored position keeps it — restarting the API
   * should not teleport the whole fleet back to Legion Square.
   */
  private async refreshRoster(): Promise<void> {
    const rows = await this.db
      .select({
        id: unit.id,
        organizationId: unit.organizationId,
        unitType: unit.unitType,
        posX: unit.posX,
        posY: unit.posY,
        heading: unit.heading,
      })
      .from(unit)
      .where(eq(unit.status, 'active'));

    const live = new Set(rows.map((r) => r.id));

    for (const id of [...this.units.keys()]) {
      if (!live.has(id)) {
        this.units.delete(id);
        this.random.delete(id);
        this.store.delete(id);
      }
    }

    for (const row of rows) {
      if (this.units.has(row.id)) continue;

      const seed = seedFrom(row.id);
      this.random.set(row.id, seed);

      const start = row.posX !== null && row.posY !== null
        ? { x: row.posX, y: row.posY }
        : ANCHORS[seed % ANCHORS.length]!;

      this.units.set(row.id, {
        unitId: row.id,
        organizationId: row.organizationId,
        unitType: row.unitType,
        x: start.x,
        y: start.y,
        heading: row.heading ?? (seed % 360),
        speed: 0,
        targetIndex: (seed >>> 8) % ANCHORS.length,
        // Roughly a third of the fleet starts parked, which is what a real
        // shift looks like and gives clustering something to cluster.
        parked: seed % 3 === 0,
        parkedFor: seed % 40,
      });
    }
  }

  private roll(unitId: string): number {
    const next = nextRandom(this.random.get(unitId) ?? seedFrom(unitId));
    this.random.set(unitId, next);
    return next / 0xffffffff;
  }

  private tick(): void {
    const now = new Date();
    const dt = this.tickMs / 1_000;
    const samples: PositionSample[] = [];

    for (const sim of this.units.values()) {
      if (sim.parked) {
        sim.speed = 0;
        sim.parkedFor -= 1;
        if (sim.parkedFor <= 0) {
          sim.parked = false;
          sim.targetIndex = Math.floor(this.roll(sim.unitId) * ANCHORS.length) % ANCHORS.length;
        }
        samples.push(this.sampleOf(sim, now));
        continue;
      }

      const target = ANCHORS[sim.targetIndex] ?? ANCHORS[0]!;

      if (worldDistance(sim, target) <= ARRIVAL_RADIUS) {
        // Arrived. Most units head somewhere else; some stop for a while.
        if (this.roll(sim.unitId) < 0.35) {
          sim.parked = true;
          sim.parkedFor = 20 + Math.floor(this.roll(sim.unitId) * 90);
        } else {
          sim.targetIndex = Math.floor(this.roll(sim.unitId) * ANCHORS.length) % ANCHORS.length;
        }
        samples.push(this.sampleOf(sim, now));
        continue;
      }

      // Steer toward the target at a bounded turn rate, so a marker rotates
      // rather than snapping — a chevron that flips 180° in one frame reads as
      // a rendering glitch even when the position is correct.
      const desired = (Math.atan2(target.x - sim.x, target.y - sim.y) * 180) / Math.PI;
      const turnRate = sim.unitType === 'air' ? AIR_TURN_RATE : TURN_RATE;
      const delta = headingDelta(sim.heading, (desired + 360) % 360);
      const turn = Math.max(-turnRate * dt, Math.min(turnRate * dt, delta));
      sim.heading = ((sim.heading + turn) % 360 + 360) % 360;

      const cruise = SPEED_BY_TYPE[sim.unitType] ?? DEFAULT_SPEED;
      // ±20% so a convoy of the same type does not move in lockstep.
      sim.speed = cruise * (0.8 + this.roll(sim.unitId) * 0.4);

      const radians = (sim.heading * Math.PI) / 180;
      sim.x += Math.sin(radians) * sim.speed * dt;
      sim.y += Math.cos(radians) * sim.speed * dt;

      samples.push(this.sampleOf(sim, now));
    }

    this.store.setMany(samples);
  }

  private sampleOf(sim: SimulatedUnit, at: Date): PositionSample {
    return {
      unitId: sim.unitId,
      organizationId: sim.organizationId,
      x: sim.x,
      y: sim.y,
      z: null,
      heading: sim.heading,
      speed: sim.speed,
      sampledAt: at,
    };
  }

  /**
   * Writes the current positions into the `unit` cache columns.
   *
   * One statement for the whole fleet rather than one per unit: at 30-second
   * intervals the difference is invisible, but a per-unit loop is the shape that
   * quietly becomes a problem when the fleet grows, and there is no reason to
   * write it that way in the first place.
   */
  private async flush(): Promise<void> {
    const samples = this.store.all();
    if (samples.length === 0) return;

    const values = sql.join(
      samples.map((s) => sql`(${s.unitId}::uuid, ${s.x}::double precision,
        ${s.y}::double precision, ${s.heading}::double precision,
        ${s.speed}::double precision, ${s.sampledAt.toISOString()}::timestamptz)`),
      sql`, `,
    );

    await this.db.execute(sql`
      UPDATE "unit" AS u
         SET pos_x = v.pos_x,
             pos_y = v.pos_y,
             heading = v.heading,
             speed = v.speed,
             position_updated_at = v.updated_at
        FROM (VALUES ${values}) AS v(id, pos_x, pos_y, heading, speed, updated_at)
       WHERE u.id = v.id
    `);

    this.log(`MAP: flushed ${samples.length} simulated position(s) to the unit cache.`);
  }
}
