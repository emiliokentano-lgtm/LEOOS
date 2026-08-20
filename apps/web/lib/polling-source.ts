/**
 * A revision-polled data source.
 *
 * Extracted at its SECOND real use (dispatch and the dashboard), not its first —
 * the map's unit feed has different needs entirely and deliberately does not use
 * this.
 *
 * The shape is built for the WEBSOCKET this replaces, not for the poller that
 * implements it: `start(events)` with callbacks rather than `getState()`. A
 * pull-shaped interface would force the eventual socket implementation to fake a
 * request/response cycle. See docs/architecture/03-realtime.md §3.
 *
 * The protocol is: the client sends the last `revision` it saw, and the server
 * either answers "nothing changed" cheaply or returns a full snapshot. That
 * keeps a several-second poll from costing a full render on a quiet shift.
 */

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'failed';

/** What the endpoint returns. `changed: false` carries no payload. */
export type PollResponse<TSnapshot> =
  | { changed: false; revision: string; serverTime: string }
  | ({ changed: true } & TSnapshot);

export interface PollingEvents<TSnapshot> {
  onSnapshot(snapshot: TSnapshot): void;
  onStateChange(state: ConnectionState, detail: string | null): void;
}

export interface PollingSourceOptions {
  /** Endpoint that accepts `{ revision }` and returns a `PollResponse`. */
  url: string;
  intervalMs: number;
  /** Extra fields sent with every poll. */
  body?: Record<string, unknown>;
  /** Shown when the feed is struggling. */
  lostMessage: string;
  fetchImpl?: typeof fetch;
}

export class PollingSource<TSnapshot extends { revision: string }> {
  private events: PollingEvents<TSnapshot> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private revision: string | null = null;
  private failures = 0;
  private stopped = true;
  private extra: Record<string, unknown>;
  private intervalMs: number;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PollingSourceOptions) {
    this.extra = options.body ?? {};
    this.intervalMs = options.intervalMs;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  start(events: PollingEvents<TSnapshot>): void {
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

  /** Forces a full snapshot on the next poll. Used right after a mutation. */
  refresh(): void {
    this.revision = null;
    this.schedule(0);
  }

  /**
   * Changes the poll interval.
   *
   * Used to drop to a slow backstop once the WebSocket is live, and to return to
   * the working rate when it is not. Applied on the NEXT poll rather than by
   * rescheduling the pending one, so flapping between the two rates cannot
   * produce a burst of requests.
   */
  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
  }

  /** Changes what is sent with each poll; refreshes if it actually differs. */
  setBody(body: Record<string, unknown>): void {
    const changed = JSON.stringify(body) !== JSON.stringify(this.extra);
    this.extra = body;
    if (changed) this.refresh();
  }

  /**
   * A hidden tab stops polling and resumes on return.
   *
   * No gap handling is needed: the revision is still valid, so the next poll
   * either says nothing changed or returns the current state. There is nothing
   * to reconstruct.
   */
  private readonly handleVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (!this.stopped) this.schedule(0);
  };

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll(); }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    // One request at a time. Overlapping polls on a slow connection deliver
    // snapshots out of order, which shows as the screen flickering backwards.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...this.extra, revision: this.revision }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`poll ${response.status}`);

      const payload = (await response.json()) as PollResponse<TSnapshot>;
      this.failures = 0;
      this.revision = payload.revision;
      this.events?.onStateChange('live', null);

      if (payload.changed) {
        // The discriminant belongs to the wire, not to the snapshot type.
        const snapshot = { ...payload } as Partial<typeof payload> & TSnapshot;
        delete (snapshot as { changed?: unknown }).changed;
        this.events?.onSnapshot(snapshot);
      }

      this.schedule(this.intervalMs);
    } catch (error) {
      if (controller.signal.aborted) return;
      void error;
      this.recordFailure();
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private recordFailure(): void {
    this.failures += 1;

    if (this.failures >= 8) {
      // Said out loud. A screen that quietly stopped updating is more dangerous
      // than one that admits it has.
      this.events?.onStateChange('failed', `${this.options.lostMessage} Reload to try again.`);
      return;
    }

    this.events?.onStateChange('reconnecting', this.options.lostMessage);
    this.schedule(backoffDelay(this.failures, this.intervalMs));
  }
}

/**
 * Exponential backoff with jitter, capped at 30 s (03-realtime.md §2).
 *
 * The jitter matters at shift change: forty consoles reconnecting on the same
 * schedule after a brief outage is a self-inflicted thundering herd.
 */
export function backoffDelay(failures: number, baseMs: number): number {
  const exponential = Math.min(30_000, baseMs * 2 ** Math.min(failures, 5));
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}
