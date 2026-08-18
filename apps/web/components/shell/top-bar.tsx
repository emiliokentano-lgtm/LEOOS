'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Bell, FlaskConical, Search, TriangleAlert } from 'lucide-react';
import {
  Badge, Breadcrumb, Button, DutyStatusBadge, IconButton, Tooltip,
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator,
  ConfirmationDialog, type Crumb,
} from '@/components/ui';
import { PAGE_META } from '@/lib/navigation';
import { IS_DEMO_DATA } from '@/lib/mock-flag';
import { cn, timeAgo } from '@/lib/utils';
import { useDutyStatus } from './duty-status-context';
import { useCommandPalette } from './command-palette';
import { MOCK_NOW } from '@/mocks/operations';

interface Notification {
  id: string;
  title: string;
  detail: string;
  at: Date;
  tone: 'default' | 'warning' | 'danger';
}

const MOCK_NOTIFICATIONS: Notification[] = [
  { id: 'n1', title: 'Assigned to #2026-08-000431', detail: 'Armed robbery — Legion Square', at: new Date(MOCK_NOW.getTime() - 4 * 60000), tone: 'danger' },
  { id: 'n2', title: 'Unit 2-LINCOLN-4 now available', detail: 'Cleared from #2026-08-000424', at: new Date(MOCK_NOW.getTime() - 18 * 60000), tone: 'default' },
  { id: 'n3', title: 'Warrant issued', detail: 'D. Castellanos — arrest warrant active', at: new Date(MOCK_NOW.getTime() - 41 * 60000), tone: 'warning' },
];

export function TopBar() {
  const pathname = usePathname();
  const { status, panic, triggerPanic, clearPanic } = useDutyStatus();
  const { open: openPalette } = useCommandPalette();
  const [panicOpen, setPanicOpen] = React.useState(false);

  const segments = pathname.split('/').filter(Boolean);
  const root = segments[0] ?? 'dashboard';
  const meta = PAGE_META[root] ?? { title: root };

  const crumbs: Crumb[] = [];
  if (meta.parent) crumbs.push({ label: meta.parent });
  crumbs.push({ label: meta.title, href: `/${root}` });
  for (const extra of segments.slice(1)) {
    crumbs.push({ label: decodeURIComponent(extra) });
  }

  const unread = MOCK_NOTIFICATIONS.length;

  return (
    <header className="flex h-(--spacing-topbar) shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-3">
      {/* Page identity */}
      <div className="flex min-w-0 flex-col justify-center">
        <h1 className="truncate text-sm font-semibold leading-tight text-text-primary">
          {meta.title}
        </h1>
        {crumbs.length > 1 ? <Breadcrumb items={crumbs} className="leading-tight" /> : null}
      </div>

      {/* Global search — a button, not an input: it opens the command palette,
          and pretending to be an input would mislead about where typing goes. */}
      <button
        type="button"
        onClick={openPalette}
        className={cn(
          // Hidden below lg: at tablet widths the label competes with the status
          // controls, and Ctrl+K still opens the palette.
          'ml-4 hidden h-7 max-w-[320px] flex-1 items-center gap-2 rounded-xs border border-border',
          'bg-raised px-2.5 text-xs text-text-tertiary transition-colors lg:flex',
          'hover:border-border-strong hover:text-text-secondary',
        )}
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate whitespace-nowrap">Search persons, vehicles, incidents…</span>
        <kbd className="ml-auto shrink-0 rounded-xs border border-border bg-surface px-1 font-mono text-2xs">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        {IS_DEMO_DATA ? (
          <Tooltip content="Screens are backed by fixture data. No backend is connected.">
            <Badge variant="warning" className="gap-1">
              <FlaskConical aria-hidden />
              Demo data
            </Badge>
          </Tooltip>
        ) : null}

        {/* Operational status */}
        <DutyStatusBadge status={status} />

        {/* Panic — always reachable, never behind a menu. */}
        {panic ? (
          <Button variant="danger" size="sm" className="animate-panic" onClick={clearPanic}>
            <TriangleAlert aria-hidden />
            Clear panic
          </Button>
        ) : (
          <Button variant="danger-outline" size="sm" onClick={() => setPanicOpen(true)}>
            <TriangleAlert aria-hidden />
            Panic
          </Button>
        )}

        {/* Notifications */}
        <Dropdown>
          <DropdownTrigger asChild>
            <span className="relative inline-flex">
              <IconButton label="Notifications" size="sm" tooltip={false}>
                <Bell aria-hidden />
              </IconButton>
              {unread > 0 ? (
                <span
                  className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-danger"
                  aria-hidden
                />
              ) : null}
            </span>
          </DropdownTrigger>
          <DropdownContent className="w-[300px] p-0">
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownLabel className="px-0">Notifications</DropdownLabel>
              <span className="font-mono text-2xs text-text-tertiary">{unread} new</span>
            </div>
            <DropdownSeparator className="mx-0" />
            {MOCK_NOTIFICATIONS.map((n) => (
              <DropdownItem key={n.id} className="flex-col items-start gap-0.5 py-2">
                <div className="flex w-full items-center gap-2">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      n.tone === 'danger' && 'bg-danger',
                      n.tone === 'warning' && 'bg-warning',
                      n.tone === 'default' && 'bg-text-disabled',
                    )}
                    aria-hidden
                  />
                  <span className="truncate text-xs font-medium text-text-primary">{n.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-2xs text-text-tertiary">
                    {timeAgo(n.at, MOCK_NOW)}
                  </span>
                </div>
                <span className="pl-3.5 text-2xs text-text-tertiary">{n.detail}</span>
              </DropdownItem>
            ))}
          </DropdownContent>
        </Dropdown>
      </div>

      <ConfirmationDialog
        open={panicOpen}
        onOpenChange={setPanicOpen}
        title="Trigger panic alert?"
        tone="danger"
        confirmLabel="Trigger panic"
        description="This broadcasts your position and identity to every dispatcher and unit in your organization."
        consequences={
          <ul className="list-inside list-disc space-y-0.5">
            <li>Set your status to Panic</li>
            <li>Alert all on-duty units with your last known position</li>
            <li>Create a priority-1 incident</li>
          </ul>
        }
        onConfirm={() => triggerPanic()}
      />
    </header>
  );
}
