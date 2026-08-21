'use client';

import { ChevronsUpDown } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import {
  Avatar, Dropdown, DropdownTrigger, DropdownContent,
  DropdownItem, DropdownLabel, DropdownSeparator, Tooltip, useToast,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { logoutAction } from '@/lib/auth-actions';
import type { Session } from '@/lib/session';
import { StatusChip } from '@/components/domain/status-chip';
import { useDutyStatus } from './duty-status-context';

/**
 * Current user block at the foot of the sidebar.
 *
 * Shows identity, rank, callsign and — most importantly — the current
 * operational status, which is directly changeable here. An operator must never
 * have to navigate to find out or change whether the system thinks they are on
 * duty.
 */
export function UserCard({
  session, organization, collapsed,
}: {
  session: Session;
  organization: OrganizationSummary | null;
  collapsed: boolean;
}) {
  const { currentStatus, statuses, setStatus, self } = useDutyStatus();
  const toast = useToast();

  const dot = currentStatus === null
    ? 'var(--status-offline)'
    : `var(${currentStatus.colorToken})`;

  async function pick(statusKey: string) {
    const result = await setStatus(statusKey);
    if (!result.ok) {
      toast.push({
        tone: 'danger',
        title: 'Status not changed',
        description: result.error,
      });
    }
  }

  if (collapsed) {
    return (
      <Tooltip
        side="right"
        content={
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{session.displayName}</span>
            <span className="text-text-tertiary">
              {session.roleName} · {currentStatus?.label ?? 'Off duty'}
            </span>
          </div>
        }
      >
        <div className="flex justify-center">
          <span className="relative">
            <Avatar name={session.displayName} size="md" ringColor={organization?.color} />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface',
                currentStatus?.isPanic && 'animate-panic',
              )}
              style={{ backgroundColor: dot }}
              aria-hidden
            />
          </span>
        </div>
      </Tooltip>
    );
  }

  return (
    <Dropdown>
      <DropdownTrigger
        className={cn(
          'flex w-full items-center gap-2 rounded-xs px-1.5 py-1.5 text-left',
          'transition-colors hover:bg-hover',
        )}
      >
        <Avatar name={session.displayName} size="md" ringColor={organization?.color} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight text-text-primary">
            {session.displayName}
          </p>
          <p className="truncate text-2xs leading-tight text-text-tertiary">
            {session.roleName} · <span className="font-mono">{session.callsign}</span>
          </p>
        </div>
        <ChevronsUpDown className="size-3 shrink-0 text-text-tertiary" aria-hidden />
      </DropdownTrigger>

      <DropdownContent align="start" side="top" className="w-[236px]">
        <div className="px-2 py-1.5">
          <p className="text-xs font-medium text-text-primary">{session.displayName}</p>
          <p className="text-2xs text-text-tertiary">{session.email}</p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <StatusChip status={currentStatus} />
            <span className="font-mono text-2xs text-text-tertiary">
              Badge {session.badgeNumber}
            </span>
          </div>
        </div>
        {/*
          * The status list comes from the CATALOGUE the server returned, not from
          * a constant: `operational_status` is a table so an organization can add
          * its own (engineering rules 5-7). Panic is excluded — it is a separate
          * action with its own confirmation, not a status you pick from a menu.
          */}
        {self?.canOperate && statuses.length > 0 ? (
          <>
            <DropdownSeparator />
            <DropdownLabel>Set operational status</DropdownLabel>
            {statuses.filter((s) => !s.isPanic).map((s) => (
              <DropdownItem
                key={s.key}
                onSelect={() => { void pick(s.key); }}
                className="gap-2"
              >
                <span style={{ color: `var(${s.colorToken})` }} className="flex">
                  <Icon name={s.icon} className="size-3.5" />
                </span>
                <span>{s.label}</span>
                {s.key === self?.statusKey ? (
                  <span className="ml-auto font-mono text-2xs text-accent">ACTIVE</span>
                ) : null}
              </DropdownItem>
            ))}
          </>
        ) : null}
        <DropdownSeparator />
        <DropdownItem>Account settings</DropdownItem>
        <DropdownItem>Active sessions</DropdownItem>
        <DropdownSeparator />
        <DropdownItem destructive onSelect={() => { void logoutAction(); }}>
          Sign out
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
