import { DISPATCH_POLL_MS, type DispatchBoard, type DispatchDelta } from '@leoos/contracts';

/**
 * The client's view of where dispatch state comes from.
 *
 * The same seam the map uses, for the same reason: the screen depends on this
 * interface, never on how the data arrives. Today it polls; the destination is
 * the `org:{id}:incidents` / `:units` / `:panic` topics in
 * docs/architecture/03-realtime.md §3. Swapping is a second implementation of
 * this interface, not a rewrite of the board.
 *
 * Push-shaped rather than pull-shaped (`subscribe` with callbacks, not
 * `getBoard()`) so the socket implementation is natural rather than a faked
 * request/response cycle.
 */

export type DispatchConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'failed';

export interface DispatchSourceEvents {
  onBoard(board: DispatchBoard): void;
  onStateChange(state: DispatchConnectionState, detail: string | null): void;
}

export interface DispatchDataSource {
  start(events: DispatchSourceEvents): void;
  stop(): void;
  /** Forces an immediate refresh — used right after a mutation. */
  refresh(): void;
  setIncludeClosed(includeClosed: boolean): void;
}

export interface HttpDispatchSourceOptions {
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpDispatchSource implements DispatchDataSource {
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;

  private events: DispatchSourceEvents | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private revision: string | null = null;
  private includeClosed = false;
  private failures = 0;
  private stopped = true;

  constructor(options: HttpDispatchSourceOptions = {}) {
    this.pollMs = options.pollMs ?? DISPATCH_POLL_MS;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  start(events: DispatchSourceEvents): void {
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

  refresh(): void {
    // Drop the revision so the next poll cannot answer "nothing changed" —
    // the caller just changed something and needs to see it.
    this.revision = null;
    this.schedule(0);
  }

  setIncludeClosed(includeClosed: boolean): void {
    if (this.includeClosed === includeClosed) return;
    this.includeClosed = includeClosed;
    this.refresh();
  }

  /**
   * A hidden tab stops polling.
   *
   * Unlike the map, coming back does NOT need special handling: the revision is
   * still valid, so the next poll either says "nothing changed" or returns the
   * current board. There is no gap to reconstruct.
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

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const response = await this.fetchImpl('/api/dispatch/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: this.revision, includeClosed: this.includeClosed }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`poll ${response.status}`);

      const delta = (await response.json()) as DispatchDelta;
      this.failures = 0;
      this.revision = delta.revision;
      this.events?.onStateChange('live', null);

      if (delta.changed) {
        // The discriminant is not part of the board; strip it rather than
        // widening `DispatchBoard` to carry a field only the wire needs.
        const board = { ...delta } as Partial<typeof delta> & DispatchBoard;
        delete (board as { changed?: unknown }).changed;
        this.events?.onBoard(board);
      }

      this.schedule(this.pollMs);
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
      // Said out loud. A dispatch board that quietly stopped updating is more
      // dangerous than one that admits it has.
      this.events?.onStateChange(
        'failed', 'Lost contact with dispatch. Reload to try again.',
      );
      return;
    }

    this.events?.onStateChange(
      'reconnecting', 'Lost contact with dispatch — the board may be out of date.',
    );
    this.schedule(backoffDelay(this.failures, this.pollMs));
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
