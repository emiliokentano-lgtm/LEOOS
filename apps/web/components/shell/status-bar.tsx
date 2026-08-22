'use client';

import * as React from 'react';
import { Radio, Wifi, WifiOff } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import { cn, formatTime } from '@/lib/utils';
import { Tooltip } from '@/components/ui';
import type { Session } from '@/lib/session';
import { useRealtimeStatus } from '@/lib/realtime/realtime-context';
import type { RealtimeState } from '@/lib/realtime/realtime-client';
import { useDutyStatus } from './duty-status-context';

/**
 * How each connection state is named to an operator.
 *
 * Plain words rather than protocol states: "reconnecting" and "polling" mean
 * something to the person on the console; "idle" and "failed" do not.
 */
/** Shown when the client has no detail of its own to report. */
const FEED_FALLBACK_DETAIL =
  'Live updates over WebSocket, with revision polling as the fallback.';

const FEED_LABELS: Record<RealtimeState, { label: string; tone: string }> = {
  idle: { label: 'Feed: polling', tone: 'text-text-tertiary' },
  connecting: { label: 'Feed: connecting', tone: 'text-text-tertiary' },
  live: { label: 'Feed: live', tone: 'text-status-available' },
  reconnecting: { label: 'Feed: polling', tone: 'text-status-busy' },
  failed: { label: 'Feed: polling only', tone: 'text-status-panic' },
};

/**
 * Always-visible bottom status bar.
 *
 * Shows organization, unit, duty status, live-feed state and the clock. An
 * operator must never have to navigate to find out whether the system still
 * thinks they are on duty, or whether the live feed is actually live.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* HERE: A FIVEM INDICATOR
 *
 * This bar used to carry a hard-coded "FiveM not connected" chip, with a
 * tooltip reading "Bridge lands in Phase 7". The bridge shipped, and the chip
 * did not change — so on an installation with a live game server the shell told
 * every operator the opposite of the truth, on the one screen furniture that is
 * visible from every page.
 *
 * The API does report the real state: `MapSourceStatus` carries `kind`,
 * `connected`, a label and a detail derived from heartbeats that actually
 * arrived. The map and the dashboard render it. The status bar has no map
 * snapshot and would need a request of its own on every page load to get one.
 *
 * So the rule applied here is the one that governs this whole product: an
 * indicator that has not earned its state does not get to show one. The feed
 * indicator beside this comment reports the socket, which this component
 * genuinely knows about. Bridge state is reported where the data lives.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function StatusBar({
  session, organization,
}: {
  session: Session;
  organization: OrganizationSummary | null;
}) {
  const { currentStatus } = useDutyStatus();
  const realtime = useRealtimeStatus();
  const [clock, setClock] = React.useState<string | null>(null);

  /**
   * The feed indicator reports the CONNECTION, not an aspiration.
   *
   * "Polling" is a truthful state, not a failure: every screen keeps working on
   * the revision poll when the socket is down. What must never happen is a green
   * light while nothing is arriving — an operator deciding whether to trust a
   * board needs this to be accurate more than they need it to be reassuring.
   */
  const feed = FEED_LABELS[realtime.state];

  // Rendered client-side only: a server-rendered clock would hydrate stale.
  React.useEffect(() => {
    const tick = () => setClock(formatTime(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <footer
      className={cn(
        'flex h-(--spacing-statusbar) shrink-0 items-center gap-4 border-t border-border-subtle',
        'bg-surface px-3 text-2xs text-text-tertiary',
      )}
    >
      <span className="flex items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-[1px]"
          style={{ backgroundColor: organization?.color ?? 'var(--color-border-strong)' }}
          aria-hidden
        />
        {/* An administrator with no membership is operating on the system, not
            inside an agency. Saying so beats borrowing an agency's badge. */}
        <span className="text-text-secondary">
          {organization ? organization.shortName : 'System'}
        </span>
      </span>

      <span className="flex items-center gap-1.5">
        <Radio className="size-3" aria-hidden />
        <span className="font-mono text-text-secondary">{session.callsign}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <span
          className={cn('size-2 rounded-full', currentStatus?.isPanic && 'animate-panic')}
          style={{
            backgroundColor: currentStatus === null
              ? 'var(--status-offline)'
              : `var(${currentStatus.colorToken})`,
          }}
          aria-hidden
        />
        <span className="text-text-secondary">{currentStatus?.label ?? 'Off duty'}</span>
      </span>

      <div className="ml-auto flex items-center gap-4">
        {/* Transport state — reported honestly, never a green light it has not
            earned. Per-screen connection health is shown on the screen that has
            a connection; this says which transport is carrying it. */}
        <Tooltip content={realtime.detail ?? FEED_FALLBACK_DETAIL}>
          <span className="flex items-center gap-1.5">
            {realtime.state === 'live'
              ? <Wifi className="size-3 text-status-available" aria-hidden />
              : <WifiOff className={cn('size-3', feed.tone)} aria-hidden />}
            <span>{feed.label}</span>
          </span>
        </Tooltip>


        <span className="font-mono tabular text-text-secondary" suppressHydrationWarning>
          {clock ?? '--:--'}
        </span>
      </div>
    </footer>
  );
}
