import { DISPATCH_POLL_MS, type DispatchBoard } from '@leoos/contracts';
import { PollingSource, type ConnectionState, type PollingEvents } from '../polling-source';

/**
 * The dispatch board's feed.
 *
 * A thin binding of the shared `PollingSource` to the dispatch endpoint. The
 * screen depends on this module, so replacing polling with the
 * `org:{id}:incidents` / `:units` / `:panic` topics
 * (docs/architecture/03-realtime.md §3) is a change here and nowhere else.
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

  setIncludeClosed(includeClosed: boolean): void {
    if (this.includeClosed === includeClosed) return;
    this.includeClosed = includeClosed;
    this.source.setBody({ includeClosed });
  }
}

/** Applies a tick to a unit map. Unchanged by the extraction; kept for callers. */
export { backoffDelay } from '../polling-source';
