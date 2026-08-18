'use client';

import { ChevronsUpDown } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import { DUTY_STATUS_LIST, DUTY_STATUSES, type DutyStatusKey } from '@leoos/contracts';
import {
  Avatar, DutyStatusBadge, Dropdown, DropdownTrigger, DropdownContent,
  DropdownItem, DropdownLabel, DropdownSeparator, Tooltip,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/session';
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
  organization: OrganizationSummary;
  collapsed: boolean;
}) {
  const { status, setStatus } = useDutyStatus();
  const meta = DUTY_STATUSES[status];

  if (collapsed) {
    return (
      <Tooltip
        side="right"
        content={
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{session.displayName}</span>
            <span className="text-text-tertiary">{session.roleName} · {meta.label}</span>
          </div>
        }
      >
        <div className="flex justify-center">
          <span className="relative">
            <Avatar name={session.displayName} size="md" ringColor={organization.color} />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface',
                status === 'panic' && 'animate-panic',
              )}
              style={{ backgroundColor: `var(${meta.token})` }}
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
        <Avatar name={session.displayName} size="md" ringColor={organization.color} />
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
            <DutyStatusBadge status={status} size="sm" />
            <span className="font-mono text-2xs text-text-tertiary">
              Badge {session.badgeNumber}
            </span>
          </div>
        </div>
        <DropdownSeparator />
        <DropdownLabel>Set operational status</DropdownLabel>
        {DUTY_STATUS_LIST.filter((s) => s.key !== 'panic').map((s) => (
          <DropdownItem
            key={s.key}
            onSelect={() => setStatus(s.key as DutyStatusKey)}
            className="gap-2"
          >
            <span style={{ color: `var(${s.token})` }} className="flex">
              <Icon name={s.icon} className="size-3.5" />
            </span>
            <span>{s.label}</span>
            {s.key === status ? (
              <span className="ml-auto font-mono text-2xs text-accent">ACTIVE</span>
            ) : null}
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem>Account settings</DropdownItem>
        <DropdownItem>Active sessions</DropdownItem>
        <DropdownSeparator />
        <DropdownItem destructive>Sign out</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
