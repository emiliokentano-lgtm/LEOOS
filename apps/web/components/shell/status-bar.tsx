'use client';

import * as React from 'react';
import { Radio, Wifi, WifiOff } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import { DUTY_STATUSES } from '@leoos/contracts';
import { cn, formatTime } from '@/lib/utils';
import { Tooltip } from '@/components/ui';
import { INTEGRATION_STATUS } from '@/lib/mock-flag';
import type { Session } from '@/lib/session';
import { useDutyStatus } from './duty-status-context';

/**
 * Always-visible bottom status bar.
 *
 * Shows organization, unit, duty status, live-feed state and the clock. An
 * operator must never have to navigate to find out whether the system still
 * thinks they are on duty, or whether the live feed is actually live.
 */
export function StatusBar({
  session, organization,
}: {
  session: Session;
  organization: OrganizationSummary;
}) {
  const { status } = useDutyStatus();
  const meta = DUTY_STATUSES[status];
  const [clock, setClock] = React.useState<string | null>(null);

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
          style={{ backgroundColor: organization.color }}
          aria-hidden
        />
        <span className="text-text-secondary">{organization.shortName}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <Radio className="size-3" aria-hidden />
        <span className="font-mono text-text-secondary">{session.callsign}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <span
          className={cn('size-2 rounded-full', status === 'panic' && 'animate-panic')}
          style={{ backgroundColor: `var(${meta.token})` }}
          aria-hidden
        />
        <span className="text-text-secondary">{meta.label}</span>
      </span>

      <div className="ml-auto flex items-center gap-4">
        {/* Live feed state — reported honestly. No backend exists in this phase,
            so this shows "offline", never a green light. */}
        <Tooltip content={INTEGRATION_STATUS.liveFeed.detail}>
          <span className="flex items-center gap-1.5">
            <WifiOff className="size-3 text-text-disabled" aria-hidden />
            <span>Live feed offline</span>
          </span>
        </Tooltip>

        <Tooltip content={INTEGRATION_STATUS.fivem.detail}>
          <span className="flex items-center gap-1.5">
            <Wifi className="size-3 text-text-disabled" aria-hidden />
            <span>FiveM not connected</span>
          </span>
        </Tooltip>

        <span className="font-mono tabular text-text-secondary" suppressHydrationWarning>
          {clock ?? '--:--'}
        </span>
      </div>
    </footer>
  );
}
