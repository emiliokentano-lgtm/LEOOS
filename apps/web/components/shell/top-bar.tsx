'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, CheckCheck, FlaskConical, Search, TriangleAlert } from 'lucide-react';
import {
  Badge, Breadcrumb, Button, IconButton, Tooltip,
  Dropdown, DropdownTrigger, DropdownContent, DropdownLabel, DropdownSeparator,
  ConfirmationDialog, useToast, type Crumb,
} from '@/components/ui';
import { PAGE_META } from '@/lib/navigation';
import { IS_DEMO_DATA } from '@/lib/mock-flag';
import { cn } from '@/lib/utils';
import { StatusChip } from '@/components/domain/status-chip';
import { NotificationItem } from '@/components/domain/notification-item';
import { useNow } from '@/lib/map/use-now';
import { useDutyStatus } from './duty-status-context';
import { useNotifications } from './notification-context';
import { useCommandPalette } from './command-palette';

export function TopBar() {
  const pathname = usePathname();
  const { currentStatus, panic, triggerPanic, clearPanic, self } = useDutyStatus();
  const notifications = useNotifications();
  const { open: openPalette } = useCommandPalette();
  const now = new Date(useNow());
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

        {/*
          * Notifications.
          *
          * The badge is a NUMBER, not a dot, and it turns red only when
          * something critical is unread. A single indistinguishable dot for
          * "there is something" makes a panic look exactly like a crew change,
          * which is the failure this whole subsystem exists to avoid.
          */}
        <Dropdown>
          <DropdownTrigger asChild>
            <span className="relative inline-flex">
              <IconButton
                label={
                  notifications.unread.total === 0
                    ? 'Notifications'
                    : `Notifications — ${notifications.unread.total} unread`
                }
                size="sm"
                tooltip={false}
              >
                <Bell aria-hidden />
              </IconButton>
              {notifications.unread.total > 0 ? (
                <span
                  className={cn(
                    'pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5',
                    'items-center justify-center rounded-full px-0.5',
                    'font-mono text-[9px] font-semibold leading-none text-white',
                    /* The *-solid tokens, not the plain ones. `bg-accent` and
                       `bg-danger` are tuned to be legible AS TEXT on the dark
                       surface; underneath white text at 9px they measure 3.19:1
                       and 3.08:1. The solid variants exist for exactly this
                       case and clear AA at 4.73:1 and 5.27:1. The badge escaped
                       the earlier pass because an account with nothing unread
                       does not render it. */
                    notifications.unread.critical > 0 ? 'bg-danger-solid' : 'bg-accent-solid',
                  )}
                  aria-hidden
                >
                  {notifications.unread.total > 99 ? '99+' : notifications.unread.total}
                </span>
              ) : null}
            </span>
          </DropdownTrigger>
          <DropdownContent className="w-[340px] p-0">
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownLabel className="px-0">Notifications</DropdownLabel>
              <span className="font-mono text-2xs text-text-tertiary">
                {notifications.unread.total === 0
                  ? 'all read'
                  : `${notifications.unread.total} unread`}
              </span>
            </div>
            <DropdownSeparator className="mx-0" />

            <div className="max-h-[360px] overflow-y-auto">
              {notifications.error !== null ? (
                <p className="px-2 py-4 text-center text-2xs text-warning">
                  {notifications.error}
                </p>
              ) : notifications.loading ? (
                <p className="px-2 py-4 text-center text-2xs text-text-tertiary">Loading…</p>
              ) : notifications.notifications.length === 0 ? (
                <p className="px-2 py-4 text-center text-2xs text-text-tertiary">
                  Nothing yet. Alerts will appear here.
                </p>
              ) : (
                // Capped at eight: the bell is a glance, the centre is the list.
                notifications.notifications.slice(0, 8).map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    now={now}
                    density="compact"
                    onOpen={(opened) => {
                      if (opened.readAt === null) void notifications.markRead([opened.id]);
                    }}
                  />
                ))
              )}
            </div>

            <DropdownSeparator className="mx-0" />
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <button
                type="button"
                disabled={notifications.unread.total === 0}
                onClick={() => { void notifications.markAllRead(); }}
                className={cn(
                  'inline-flex items-center gap-1 text-2xs text-text-tertiary transition-colors',
                  'hover:text-text-secondary disabled:opacity-40 disabled:hover:text-text-tertiary',
                )}
              >
                <CheckCheck className="size-3" aria-hidden />
                Mark all read
              </button>
              <Link
                href="/notifications"
                className="text-2xs text-accent transition-colors hover:underline"
              >
                Open notification centre
              </Link>
            </div>
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
