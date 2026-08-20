import { DISPATCH_POLL_MS, type DispatchBoard } from '@leoos/contracts';
import { PollingSource, type ConnectionState, type PollingEvents } from '../polling-source';

/**
 * The dispatch board's feed.
 *
 * A thin binding of the shared `PollingSource` to the dispatch endpoint.
 *
 * The WebSocket did NOT replace this — it demoted it. Live updates arrive on the
 * `org:{id}:incidents` / `:units` / `:panic` topics and trigger a refresh here,
 * and the poll drops to `BACKSTOP_POLL_MS`. Keeping the poll is deliberate: it
 * is the only thing that would notice a socket that believes it is healthy while
 * delivering nothing, and it is what the board runs on for a caller whose socket
 * cannot connect at all.
 */

export type DispatchConnectionState = ConnectionState;

export interface DispatchSourceEvents {
  onBoard(board: DispatchBoard): void;
  onStateChange(state: DispatchConnectionState, detail: string | null): void;
}

export class HttpDispatchSource {
  private readonly source: PollingSource<DispatchBoard>;
  private includeClosed = false;

  constructor(options: { pollMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.source = new PollingSource<DispatchBoard>({
      url: '/api/dispatch/poll',
      intervalMs: options.pollMs ?? DISPATCH_POLL_MS,
      body: { includeClosed: false },
      lostMessage: 'Lost contact with dispatch — the board may be out of date.',
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  start(events: DispatchSourceEvents): void {
    const bound: PollingEvents<DispatchBoard> = {
      onSnapshot: events.onBoard,
      onStateChange: events.onStateChange,
    };
    this.source.start(bound);
  }

  stop(): void { this.source.stop(); }
  refresh(): void { this.source.refresh(); }

  /** Drops to a slow backstop while the WebSocket carries the board. */
  setPollMs(intervalMs: number): void { this.source.setIntervalMs(intervalMs); }

  setIncludeClosed(includeClosed: boolean): void {
    if (this.includeClosed === includeClosed) return;
    this.includeClosed = includeClosed;
    this.source.setBody({ includeClosed });
  }
}

/** Applies a tick to a unit map. Unchanged by the extraction; kept for callers. */
export { backoffDelay } from '../polling-source';
