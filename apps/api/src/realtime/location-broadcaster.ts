import { LOCATION_BROADCAST_MS } from '@leoos/contracts';
import type {
  LivePositionStore, PositionSample,
} from '../modules/map/sources/live-positions.js';
import type { Connection, RealtimeHub } from './hub.js';

/**
 * The location broadcast strategy.
 *
 * The brief asks for throttling, batching, latest-state storage, stale detection
 * and efficient broadcasting. Each is handled at a different layer, deliberately,
 * and this file is where they meet:
 *
 *   THROTTLING happens here. Positions arrive from the source at whatever rate
 *   it produces them — the mock runs at 1 Hz, a FiveM bridge could run at 5 Hz or
 *   faster. This reads the store on a fixed tick and ignores the input rate
 *   entirely, so the broadcast rate is a property of the server rather than of
 *   the game.
 *
 *   BATCHING happens in the hub. Each subscriber gets ONE message per tick
 *   carrying every changed unit, never one message per unit.
 *
 *   LATEST-STATE STORAGE is the `LivePositionStore` — a map keyed by unit, so a
 *   unit reporting ten times between ticks costs one entry. Nothing accumulates.
 *
 *   DATABASE LOAD is decoupled entirely: the store is flushed to Postgres at a
 *   fraction of the tick rate by the position source, into the `unit.pos_*`
 *   columns that are documented as a low-rate cache. 1 Hz of position writes is
 *   the ~13M rows/day that engineering rules 21 and 22 exist to prevent.
 *
 *   STALE DETECTION is the client's, from the sample timestamp that travels with
 *   each position. The server does not decide staleness, because a position that
 *   is fresh when sent may be stale by the time it is read, and only the reader
 *   knows when that is.
 *
 *   EFFICIENT BROADCASTING is the per-subscriber visibility set, refreshed on a
 *   slow cycle rather than per tick — see below.
 */

export interface LocationBroadcasterOptions {
  hub: RealtimeHub;
  store: LivePositionStore;
  /** Which units a subscriber may see. Applies the covert and sharing rules. */
  visibleUnitsFor: (userId: string, organizationId: string | null) => Promise<Set<string>>;
  tickMs?: number;
  /**
   * How often a subscriber's visible set is recomputed.
   *
   * Not per tick: that would be a database query per subscriber per second, for
   * a set that changes when a unit is created, disbanded or flagged covert —
   * which is rare. Ten seconds bounds how long a newly-covert unit could still
   * be broadcast, and that window is closed immediately by the `unit.updated`
   * event, which triggers a refresh.
   */
  visibilityTtlMs?: number;
  log?: (message: string) => void;
}

/** Set equality, for deciding whether a refreshed visible set actually moved. */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export class LocationBroadcaster {
  private readonly hub: RealtimeHub;
  private readonly store: LivePositionStore;
  private readonly visibleUnitsFor: LocationBroadcasterOptions['visibleUnitsFor'];
  private readonly tickMs: number;
  private readonly visibilityTtlMs: number;
  private readonly log: (message: string) => void;

  /** Cached visible sets, keyed by connection. */
  private readonly visibility = new Map<string, { at: number; units: Set<string> }>();

  /**
   * How far each connection has been brought up to date.
   *
   * A connection that has never been sent anything is absent, and gets the FULL
   * current set on its first tick — otherwise a browser that connected while
   * the fleet was parked would see an empty map until somebody moved. After
   * that it receives only what changed.
   *
   * Keyed by connection rather than by user: two tabs are two maps, and one
   * catching up must not consume the other's baseline.
   */
  private readonly deliveredRevision = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: LocationBroadcasterOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.visibleUnitsFor = options.visibleUnitsFor;
    this.tickMs = options.tickMs ?? LOCATION_BROADCAST_MS;
    this.visibilityTtlMs = options.visibilityTtlMs ?? 10_000;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.visibility.clear();
  }

  /** Drops a connection's cached state. Called when it closes. */
  forget(connectionId: string): void {
    this.visibility.delete(connectionId);
    this.deliveredRevision.delete(connectionId);
  }

  /**
   * Invalidates every cached visible set.
   *
   * Called when a unit is created, disbanded or its covert flag changes — the
   * events that can change who may see what. This is what keeps the ten-second
   * cache from being a ten-second window in which a newly-covert unit is still
   * broadcast.
   */
  invalidate(): void {
    this.visibility.clear();
    /**
     * The baselines go too, so the next tick re-sends everything.
     *
     * A unit that has just become visible to somebody has not CHANGED — its
     * position is whatever it already was — so a changed-only tick would skip
     * it and leave a hole on that operator's map until it next moved. The
     * cheapest correct answer to "who can see what just changed" is to treat
     * everyone as new.
     */
    this.deliveredRevision.clear();
  }

  private async visibleFor(connection: Connection): Promise<Set<string>> {
    const cached = this.visibility.get(connection.id);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < this.visibilityTtlMs) return cached.units;

    const units = await this.visibleUnitsFor(connection.userId, connection.organizationId);

    /**
     * A CHANGED VISIBLE SET RESETS THE BASELINE.
     *
     * Since the tick sends only what moved, a unit that becomes invisible
     * WITHOUT moving would otherwise never be revisited — no delta entry means
     * no chance to queue its removal, and the marker would sit frozen on that
     * operator's map. The same in reverse: a unit that becomes visible has not
     * changed position, so a delta-only tick would skip it and leave a hole.
     *
     * `invalidate()` covers the events the map module knows about (a unit
     * created, disbanded, or flagged covert). This covers the ones it does not:
     * the subscriber's own membership changing underneath a cache that was
     * about to expire anyway.
     */
    if (cached !== undefined && !sameSet(cached.units, units)) {
      this.deliveredRevision.delete(connection.id);
    }

    this.visibility.set(connection.id, { at: now, units });
    return units;
  }

  /**
   * One broadcast tick.
   *
   * Guarded against overlap: a slow visibility query must not cause two ticks to
   * interleave and send a subscriber two batches out of order.
   */
  /**
   * Runs one tick synchronously. For tests and benchmarks only.
   *
   * Exposed rather than reaching into the private method, so a measurement of
   * the broadcast strategy exercises the real one.
   */
  async tickForTest(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const subscribers = this.hub.connectionsWithTopic('map:units');
      if (subscribers.length === 0) {
        // Nobody is watching. The store keeps filling — that is the point of it
        // — but nothing is serialised or sent.
        this.visibility.clear();
        this.deliveredRevision.clear();
        return;
      }

      /**
       * ONLY WHAT MOVED.
       *
       * This used to read `store.all()` and queue every unit for every
       * subscriber on every tick — so a fleet of 500 parked units cost 500
       * position objects per subscriber per second, forever, and the cost
       * scaled with the size of the fleet rather than with how much of it was
       * doing anything. Measured at 500 units and 20 subscribers: 10 000
       * position objects serialised per second, of which typically a few
       * hundred carried new information.
       *
       * A subscriber that has never been brought up to date still gets the full
       * set — see `deliveredRevision`.
       */
      const current = this.store.revision;
      if (this.store.size === 0) {
        this.hub.flushPositions();
        return;
      }

      /**
       * Computed ONCE per distinct baseline, not once per subscriber.
       *
       * Subscribers move in lockstep after their first tick — they all sit at
       * the previous revision — so in the steady state this is a single call
       * whose result every connection shares. A subscriber that joined mid-tick
       * has its own baseline and gets its own answer.
       */
      const byBaseline = new Map<number | undefined, PositionSample[]>();
      const samplesFor = (baseline: number | undefined): PositionSample[] => {
        const cached = byBaseline.get(baseline);
        if (cached !== undefined) return cached;
        const computed = baseline === undefined
          ? this.store.all()
          : this.store.changedSince(baseline).samples;
        byBaseline.set(baseline, computed);
        return computed;
      };

      for (const connection of subscribers) {
        const visible = await this.visibleFor(connection);
        const samples = samplesFor(this.deliveredRevision.get(connection.id));

        for (const sample of samples) {
          if (!visible.has(sample.unitId)) {
            // Was visible, is not any more: tell the client to drop it rather
            // than leaving a marker frozen on the map forever.
            this.hub.queueRemoval(sample.unitId, connection);
            continue;
          }

          connection.pendingPositions.set(sample.unitId, {
            unitId: sample.unitId,
            x: sample.x,
            y: sample.y,
            heading: sample.heading,
            speed: sample.speed,
            sampledAt: sample.sampledAt.toISOString(),
          });
          connection.pendingRemovals.delete(sample.unitId);
          connection.visibleUnits.add(sample.unitId);
        }

        this.deliveredRevision.set(connection.id, current);
      }

      this.hub.flushPositions();
    } catch (error) {
      this.log(`realtime: location broadcast failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
