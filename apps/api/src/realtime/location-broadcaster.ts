import { LOCATION_BROADCAST_MS } from '@leoos/contracts';
import type { LivePositionStore } from '../modules/map/sources/live-positions.js';
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

export class LocationBroadcaster {
  private readonly hub: RealtimeHub;
  private readonly store: LivePositionStore;
  private readonly visibleUnitsFor: LocationBroadcasterOptions['visibleUnitsFor'];
  private readonly tickMs: number;
  private readonly visibilityTtlMs: number;
  private readonly log: (message: string) => void;

  /** Cached visible sets, keyed by connection. */
  private readonly visibility = new Map<string, { at: number; units: Set<string> }>();
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

  /** Drops a connection's cached visibility. Called when it closes. */
  forget(connectionId: string): void {
    this.visibility.delete(connectionId);
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
  }

  private async visibleFor(connection: Connection): Promise<Set<string>> {
    const cached = this.visibility.get(connection.id);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < this.visibilityTtlMs) return cached.units;

    const units = await this.visibleUnitsFor(connection.userId, connection.organizationId);
    this.visibility.set(connection.id, { at: now, units });
    return units;
  }

  /**
   * One broadcast tick.
   *
   * Guarded against overlap: a slow visibility query must not cause two ticks to
   * interleave and send a subscriber two batches out of order.
   */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const samples = this.store.all();
      if (samples.length === 0) {
        this.hub.flushPositions();
        return;
      }

      const subscribers = this.hub.connectionsWithTopic('map:units');
      if (subscribers.length === 0) {
        // Nobody is watching. The store keeps filling — that is the point of it
        // — but nothing is serialised or sent.
        this.visibility.clear();
        return;
      }

      for (const connection of subscribers) {
        const visible = await this.visibleFor(connection);

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
      }

      this.hub.flushPositions();
    } catch (error) {
      this.log(`realtime: location broadcast failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
