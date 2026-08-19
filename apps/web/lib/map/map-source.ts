import {
  MAP_TICK_MS, type MapSnapshot, type MapTick, type UnitPositionDelta,
} from '@leoos/contracts';

/**
 * The client's view of where map data comes from.
 *
 * THIS IS THE SEAM the brief asks for: the map screen and the canvas renderer
 * depend on this interface, never on how the data arrives. Today the only
 * implementation polls the tick endpoint. The destination is the `map:units`
 * WebSocket topic (docs/architecture/03-realtime.md §3), and swapping to it
 * means writing a second implementation of this interface — not touching the
 * renderer, the filters, the detail panel, or the follow-mode camera.
 *
 * The interface is shaped for the socket rather than for the poller, which is
 * why it is push-based (`subscribe` with a callback) rather than pull-based
 * (`getPositions()`). Building it around polling and adapting later is how you
 * end up with a socket implementation that has to fake a request/response cycle.
 */

export type MapConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'failed';

export interface MapSourceEvents {
  /** A full replacement of map state. Always the first event. */
  onSnapshot(snapshot: MapSnapshot): void;
  /** Incremental positions. */
  onTick(tick: MapTick): void;
  onStateChange(state: MapConnectionState, detail: string | null): void;
}

export interface MapDataSource {
  start(events: MapSourceEvents): void;
  stop(): void;
  /**
   * Tells the source which units the client holds metadata for, so it can report
   * removals. Advisory only — the server re-derives visibility every tick.
   */
  setKnownUnits(unitIds: string[]): void;
  /** Forces a fresh snapshot, e.g. after the server signals a resync. */
  refresh(): void;
}

export interface HttpMapSourceOptions {
  /** Poll interval. Defaults to the map's nominal 1 Hz. */
  tickMs?: number;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Polling implementation.
 *
 * Deliberately conservative about what it does when things go wrong, because
 * the failure that matters is not "the map went blank" — it is "the map kept
 * drawing units that stopped updating half an hour ago". So:
 *
 *   • A failed tick backs off exponentially with jitter rather than hammering,
 *     and reports `reconnecting` so the UI can say so.
 *   • It never invents a position. When ticks stop, positions simply stop
 *     updating, and the renderer's own staleness rule desaturates them.
 *   • A hidden tab stops polling entirely (docs/architecture/05-map.md §4): a
 *     backgrounded map must not hold a feed slot or burn a request a second.
 */
export class HttpMapSource implements MapDataSource {
  private readonly tickMs: number;
  private readonly fetchImpl: typeof fetch;

  private events: MapSourceEvents | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private knownUnitIds: string[] = [];
  private failures = 0;
  private stopped = true;
  private inFlight: AbortController | null = null;
  private hiddenSince: number | null = null;

  constructor(options: HttpMapSourceOptions = {}) {
    this.tickMs = options.tickMs ?? MAP_TICK_MS;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  start(events: MapSourceEvents): void {
    this.events = events;
    this.stopped = false;
    this.failures = 0;
    events.onStateChange('connecting', null);
    this.schedule(0);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    this.events?.onStateChange('stopped', null);
  }

  setKnownUnits(unitIds: string[]): void {
    this.knownUnitIds = unitIds;
  }

  refresh(): void {
    void this.loadSnapshot();
  }

  private readonly handleVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.hiddenSince = Date.now();
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      return;
    }

    // Coming back, the client's positions are as old as the time it spent
    // hidden. A snapshot is both cheaper to reason about and always correct —
    // there is no attempt to replay the gap (03-realtime.md §2).
    const wasHidden = this.hiddenSince;
    this.hiddenSince = null;
    if (this.stopped) return;
    if (wasHidden !== null && Date.now() - wasHidden > this.tickMs * 3) {
      void this.loadSnapshot();
    } else {
      this.schedule(0);
    }
  };

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll(); }, delayMs);
  }

  private async loadSnapshot(): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await this.fetchImpl('/api/map/snapshot', { cache: 'no-store' });
      if (!response.ok) throw new Error(`snapshot ${response.status}`);
      const snapshot = (await response.json()) as MapSnapshot;
      this.failures = 0;
      this.events?.onSnapshot(snapshot);
      this.events?.onStateChange('live', null);
      this.schedule(this.tickMs);
    } catch {
      this.recordFailure('Could not refresh the map.');
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    // One request at a time. Overlapping polls on a slow connection deliver
    // positions out of order, which shows as units twitching backwards.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const response = await this.fetchImpl('/api/map/tick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ knownUnitIds: this.knownUnitIds }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`tick ${response.status}`);

      const tick = (await response.json()) as MapTick;
      this.failures = 0;
      this.events?.onStateChange('live', null);

      if (tick.resyncRequired) {
        this.events?.onTick(tick);
        await this.loadSnapshot();
        return;
      }

      this.events?.onTick(tick);
      this.schedule(this.tickMs);
    } catch (error) {
      if (controller.signal.aborted) return;
      void error;
      this.recordFailure('Lost contact with the map feed.');
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private recordFailure(detail: string): void {
    this.failures += 1;

    if (this.failures >= 8) {
      // Giving up is stated, not silent. A map that quietly stopped updating is
      // more dangerous than one that says it has.
      this.events?.onStateChange('failed', `${detail} Reload to try again.`);
      return;
    }

    this.events?.onStateChange('reconnecting', detail);
    this.schedule(backoffDelay(this.failures, this.tickMs));
  }
}

/**
 * Exponential backoff with jitter, capped at 30 s (03-realtime.md §2).
 *
 * The jitter matters at shift change: forty consoles reconnecting on the same
 * schedule after a brief outage is a self-inflicted thundering herd.
 */
export function backoffDelay(failures: number, baseMs: number): number {
  const exponential = Math.min(30_000, baseMs * 2 ** Math.min(failures, 6));
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}

/**
 * Applies a tick to a unit map, in place of the caller's previous state.
 *
 * Lives here rather than in the component so the merge is the same whatever the
 * transport is, and so the socket implementation cannot merge differently.
 */
export function applyTick<T extends { id: string }>(
  units: readonly T[],
  tick: MapTick,
  merge: (unit: T, delta: UnitPositionDelta) => T,
): T[] {
  const removed = new Set(tick.removed);
  const byId = new Map(tick.positions.map((p) => [p.unitId, p]));

  return units
    .filter((u) => !removed.has(u.id))
    .map((u) => {
      const delta = byId.get(u.id);
      return delta === undefined ? u : merge(u, delta);
    });
}
