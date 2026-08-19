'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Bell, FlaskConical, Search, TriangleAlert } from 'lucide-react';
import {
  Badge, Breadcrumb, Button, IconButton, Tooltip,
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator,
  ConfirmationDialog, useToast, type Crumb,
} from '@/components/ui';
import { PAGE_META } from '@/lib/navigation';
import { IS_DEMO_DATA } from '@/lib/mock-flag';
import { cn, timeAgo } from '@/lib/utils';
import { StatusChip } from '@/components/domain/status-chip';
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
  const { currentStatus, panic, triggerPanic, clearPanic, self } = useDutyStatus();
  const { open: openPalette } = useCommandPalette();
  const [panicOpen, setPanicOpen] = React.useState(false);
  const [panicPending, setPanicPending] = React.useState(false);
  const toast = useToast();

  /**
   * Runs a panic action and surfaces a refusal.
   *
   * A silent failure here is the worst possible outcome: the operator believes
   * an alert went out and it did not.
   */
  async function runPanic(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPanicPending(true);
    const result = await fn();
    setPanicPending(false);
    if (!result.ok) {
      toast.push({
        tone: 'danger',
        title: 'The alert was not sent',
        description: result.error,
      });
    }
  }

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

        {/* Operational status — from the server, not from a click. */}
        {self !== null ? <StatusChip status={currentStatus} /> : null}

        {/*
          * Panic — always reachable, never behind a menu.
          *
          * Rendered only for an account that can actually operate: a decorative
          * panic button is worse than none, because somebody will press it in an
          * emergency and believe help is coming.
          */}
        {self?.canOperate ? (
          panic ? (
            <Button
              variant="danger" size="sm" className="animate-panic"
              disabled={panicPending}
              onClick={() => { void runPanic(clearPanic); }}
            >
              <TriangleAlert aria-hidden />
              Stand down
            </Button>
          ) : (
            <Button variant="danger-outline" size="sm" onClick={() => setPanicOpen(true)}>
              <TriangleAlert aria-hidden />
              Panic
            </Button>
          )
        ) : null}

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

      {/*
        * The consequences listed are exactly what the server does — no more.
        * An earlier version of this dialog promised a priority-1 incident, which
        * the panic service does not create. A confirmation that overstates what
        * will happen is a confirmation nobody can rely on.
        */}
      <ConfirmationDialog
        open={panicOpen}
        onOpenChange={setPanicOpen}
        title="Raise a panic alert?"
        tone="danger"
        confirmLabel="Raise panic"
        description="This broadcasts your identity and last known position to every dispatcher who can see your organization."
        consequences={
          <ul className="list-inside list-disc space-y-0.5">
            <li>Set your status to Panic, on every board</li>
            <li>Raise a standing alert until a dispatcher stands it down</li>
            <li>Record the alert against your name</li>
          </ul>
        }
        onConfirm={() => { void runPanic(triggerPanic); }}
      />
    </header>
  );
}
