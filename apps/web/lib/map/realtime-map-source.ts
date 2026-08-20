import type { MapSnapshot, MapTick, RealtimeEvent, UnitPositionDelta } from '@leoos/contracts';
import type { RealtimeClient } from '../realtime/realtime-client';
import { HttpMapSource, type MapDataSource, type MapSourceEvents } from './map-source';

/**
 * The map's live feed.
 *
 * This is the implementation `MapDataSource` was designed for. The renderer, the
 * filters, the detail panel and the follow-mode camera are untouched by it —
 * they were built against the interface, and this is a second implementation of
 * that interface, exactly as `map-source.ts` said it would be.
 *
 * IT IS A COMPOSITION, NOT A REPLACEMENT. Snapshots still come over HTTP: a
 * snapshot is a large authorized read that the socket has no business carrying,
 * and the tick endpoint remains as the fallback for a console whose socket
 * cannot connect. What the socket replaces is the once-a-second POST.
 *
 * WHAT ARRIVES ON THE SOCKET, and what it deliberately does not carry.
 *
 *   A position batch carries coordinates, heading, speed and a sample time. It
 *   does NOT carry the unit's status or its current incident, because those
 *   change rarely and would otherwise be repeated for every unit every second
 *   for no reason. They live in the snapshot, and they move through
 *   `unit.status.updated` and the incident events — which is why this class
 *   keeps a small metadata cache and refetches when one of those arrives.
 *
 *   Nothing here invents a value. A unit whose metadata is unknown — one that
 *   appeared since the last snapshot — sets `resyncRequired`, and the map
 *   refetches rather than drawing a marker with a guessed status.
 */

/** The per-unit facts a position batch does not repeat. */
interface UnitMeta {
  statusKey: string;
  incidentId: string | null;
}

export interface RealtimeMapSourceOptions {
  /** The shared connection. Null falls back to polling entirely. */
  client: RealtimeClient | null;
  /** Topics to watch besides `map:units` — status and incident changes. */
  topics: readonly string[];
  tickMs?: number;
  fetchImpl?: typeof fetch;
}

export class RealtimeMapSource implements MapDataSource {
  private readonly http: HttpMapSource;
  private readonly client: RealtimeClient | null;
  private readonly topics: string[];

  private events: MapSourceEvents | null = null;
  private release: (() => void) | null = null;
  private readonly meta = new Map<string, UnitMeta>();
  private socketLive = false;

  constructor(options: RealtimeMapSourceOptions) {
    this.client = options.client;
    this.topics = [...options.topics];
    this.http = new HttpMapSource({
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  start(events: MapSourceEvents): void {
    this.events = events;

    /**
     * The HTTP source starts FIRST, and unconditionally.
     *
     * It loads the opening snapshot, and it is what the map runs on until the
     * socket reports live. Waiting for the socket before showing anything would
     * mean a blank map for however long the handshake takes — and forever, for
     * a network that blocks WebSockets.
     */
    this.http.start({
      onSnapshot: (snapshot) => {
        this.rememberSnapshot(snapshot);
        events.onSnapshot(snapshot);
      },
      onTick: (tick) => {
        this.rememberTick(tick);
        events.onTick(tick);
      },
      onStateChange: (state, detail) => {
        // While the socket is carrying positions the poller is paused, so its
        // state is not what the operator should be told about.
        if (this.socketLive) return;
        events.onStateChange(state, detail);
      },
    });

    if (this.client === null) return;

    this.release = this.client.subscribe(['map:units', ...this.topics], {
      onEvent: (event, topic) => this.handle(event, topic),
      onResync: () => {
        // Something was missed. A snapshot is the only correct answer: positions
        // are latest-state, so there is nothing to replay, and a unit could have
        // been created, disbanded or gone covert in the gap.
        this.http.refresh();
      },
      onState: (state) => {
        const live = state === 'live';
        if (live === this.socketLive) return;
        this.socketLive = live;

        if (live) {
          this.http.pauseTicks();
          // A fresh snapshot on connect, because the map may have been running
          // on a poller that just stopped, or on nothing at all.
          this.http.refresh();
          this.events?.onStateChange('live', null);
        } else {
          // Back to polling. Said out loud rather than silently degrading, so
          // "the map looks slow" has an answer on screen.
          this.http.resumeTicks();
          this.events?.onStateChange('reconnecting', 'Live feed lost — falling back to polling.');
        }
      },
    });
  }

  stop(): void {
    this.release?.();
    this.release = null;
    this.http.stop();
    this.meta.clear();
    this.events = null;
  }

  setKnownUnits(unitIds: string[]): void {
    this.http.setKnownUnits(unitIds);
  }

  refresh(): void {
    this.http.refresh();
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private handle(event: RealtimeEvent, topic: string): void {
    if (event.type === 'unit.location.updated' && topic === 'map:units') {
      this.applyPositions(event.payload.positions, event.payload.removed);
      return;
    }

    /**
     * Everything else changes how a marker is DRAWN rather than where it is:
     * a status, a callsign, an assignment, a covert flag, a panic. None of them
     * is frequent, and all of them need data this feed does not carry, so the
     * answer is the same in every case — refetch the snapshot.
     */
    this.http.refresh();
  }

  private applyPositions(
    positions: readonly { unitId: string; x: number; y: number;
      heading: number | null; speed: number | null; sampledAt: string }[],
    removed: readonly string[],
  ): void {
    const deltas: UnitPositionDelta[] = [];
    let resyncRequired = false;

    for (const position of positions) {
      const known = this.meta.get(position.unitId);
      if (known === undefined) {
        // A unit the client has never seen. Its status and callsign are unknown,
        // and inventing them would put a marker on an operational map that says
        // something nobody asserted. Refetch instead.
        resyncRequired = true;
        continue;
      }

      deltas.push({
        unitId: position.unitId,
        x: position.x,
        y: position.y,
        heading: position.heading,
        speed: position.speed,
        statusKey: known.statusKey,
        incidentId: known.incidentId,
        // The SAMPLE time, not the arrival time — the renderer's staleness rule
        // is about how old the position is, not how long it sat in a socket.
        updatedAt: position.sampledAt,
      });
    }

    for (const unitId of removed) this.meta.delete(unitId);

    const tick: MapTick = {
      serverTime: new Date().toISOString(),
      positions: deltas,
      removed: [...removed],
      resyncRequired,
    };

    this.events?.onTick(tick);
    if (resyncRequired) this.http.refresh();
  }

  private rememberSnapshot(snapshot: MapSnapshot): void {
    this.meta.clear();
    for (const unit of snapshot.units) {
      this.meta.set(unit.id, {
        statusKey: unit.status.key,
        incidentId: unit.incident?.id ?? null,
      });
    }
  }

  private rememberTick(tick: MapTick): void {
    for (const position of tick.positions) {
      this.meta.set(position.unitId, {
        statusKey: position.statusKey,
        incidentId: position.incidentId,
      });
    }
    for (const unitId of tick.removed) this.meta.delete(unitId);
  }
}
