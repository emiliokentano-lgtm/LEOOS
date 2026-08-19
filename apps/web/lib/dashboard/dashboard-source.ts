import { DASHBOARD_POLL_MS, type DashboardSnapshot } from '@leoos/contracts';
import { PollingSource, type ConnectionState, type PollingEvents } from '../polling-source';

/**
 * The dashboard's feed.
 *
 * Shares the dispatch revision, so a dashboard open beside a board cannot lag
 * it: the same events move both markers.
 *
 * The brief asks the dashboard to update on incident creation, incident updates,
 * unit status changes, unit join/leave, panic, and personnel status changes.
 * Every one of those moves the revision (see the marker in
 * `apps/api/src/modules/dispatch/dispatch.read.ts`), so all six are covered by
 * one mechanism rather than six subscriptions.
 */

export type DashboardConnectionState = ConnectionState;

export interface DashboardSourceEvents {
  onSnapshot(snapshot: DashboardSnapshot): void;
  onStateChange(state: DashboardConnectionState, detail: string | null): void;
}

export class HttpDashboardSource {
  private readonly source: PollingSource<DashboardSnapshot>;

  constructor(options: { pollMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.source = new PollingSource<DashboardSnapshot>({
      url: '/api/dashboard/poll',
      intervalMs: options.pollMs ?? DASHBOARD_POLL_MS,
      lostMessage: 'Lost contact with the server — these figures may be out of date.',
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  start(events: DashboardSourceEvents): void {
    const bound: PollingEvents<DashboardSnapshot> = {
      onSnapshot: events.onSnapshot,
      onStateChange: events.onStateChange,
    };
    this.source.start(bound);
  }

  stop(): void { this.source.stop(); }
  refresh(): void { this.source.refresh(); }
}
