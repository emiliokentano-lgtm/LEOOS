'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import * as Icons from 'lucide-react';
import {
  NOTIFICATION_SEVERITIES, notificationTypeMeta, type NotificationDto,
} from '@leoos/contracts';
import { cn, timeAgo } from '@/lib/utils';
import { OrgBadge } from '@/components/ui';

/**
 * One notification, in a list.
 *
 * Shared between the bell dropdown and the full centre rather than written twice
 * (engineering rule 27): the two differ in density, not in what a notification
 * is, and two copies is how the badge in one of them stops matching the other.
 *
 * THE ICON AND THE TONE COME FROM THE CATALOGUE, not from a switch. A type added
 * to `NOTIFICATION_TYPES` renders correctly here the day it ships, and a type
 * this build has never heard of renders as a generic bell rather than crashing
 * the list (engineering rules 5–7).
 */

function LucideIcon({ name, className }: { name: string; className?: string }) {
  const Icon = (Icons as unknown as Record<
    string, React.ComponentType<{ className?: string }>
  >)[name];
  if (!Icon) return <Icons.Bell className={className} aria-hidden />;
  return <Icon className={className} aria-hidden />;
}

const TONE_DOT: Record<string, string> = {
  info: 'bg-text-disabled',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const TONE_ICON: Record<string, string> = {
  info: 'text-text-tertiary',
  warning: 'text-warning',
  danger: 'text-danger',
};

export interface NotificationItemProps {
  notification: NotificationDto;
  now: Date;
  density?: 'compact' | 'comfortable';
  /** Called when the operator opens it. Marks read; navigation is separate. */
  onOpen?: (notification: NotificationDto) => void;
  className?: string;
}

export function NotificationItem({
  notification, now, density = 'comfortable', onOpen, className,
}: NotificationItemProps) {
  const meta = notificationTypeMeta(notification.type);
  const severity = NOTIFICATION_SEVERITIES[notification.severity]
    ?? NOTIFICATION_SEVERITIES.info;
  const unread = notification.readAt === null;

  const body = (
    <>
      {/*
        * Three signals, never colour alone: the icon says what kind of thing
        * happened, the dot says unread, and the severity is spelled out in words
        * for anything above `info`. These lists are read on projected displays
        * where colour fidelity is poor.
        */}
      <span className={cn('mt-0.5 shrink-0', TONE_ICON[severity.tone])}>
        <LucideIcon name={meta.icon} className="size-3.5" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex w-full items-center gap-1.5">
          {unread ? (
            <span
              className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[severity.tone])}
              aria-label="Unread"
            />
          ) : null}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              unread ? 'font-medium text-text-primary' : 'text-text-secondary',
            )}
          >
            {notification.title}
          </span>
          <time
            className="ml-auto shrink-0 font-mono text-2xs text-text-tertiary"
            dateTime={notification.createdAt}
          >
            {timeAgo(new Date(notification.createdAt), now)}
          </time>
        </span>

        {notification.body ? (
          <span
            className={cn(
              'text-2xs text-text-tertiary',
              density === 'compact' ? 'line-clamp-1' : 'line-clamp-2',
            )}
          >
            {notification.body}
          </span>
        ) : null}

        <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="font-mono text-2xs uppercase tracking-wide text-text-disabled">
            {meta.label}
          </span>
          {notification.severity !== 'info' ? (
            <span
              className={cn(
                'font-mono text-2xs uppercase tracking-wide',
                TONE_ICON[severity.tone],
              )}
            >
              {severity.label}
            </span>
          ) : null}
          {notification.organization ? (
            <OrgBadge
              shortName={notification.organization.shortName}
              color={notification.organization.color}
              size="sm"
            />
          ) : null}
        </span>
      </span>
    </>
  );

  const shared = cn(
    'flex w-full items-start gap-2 rounded-xs px-2 text-left transition-colors',
    density === 'compact' ? 'py-1.5' : 'py-2',
    'hover:bg-raised focus-visible:bg-raised focus-visible:outline-none',
    className,
  );

  /**
   * The link is only rendered when the API gave us one.
   *
   * `href` is composed server-side because the API is what knows whether the
   * subject still exists; a client building `/dispatch?incident=${entityId}` for
   * itself would happily produce a route to a call that was purged an hour ago.
   * Without one this is a plain row, not a link that goes nowhere.
   */
  if (notification.href) {
    return (
      <Link
        href={notification.href as Route}
        className={shared}
        onClick={() => onOpen?.(notification)}
      >
        {body}
      </Link>
    );
  }

  return (
    <button type="button" className={shared} onClick={() => onOpen?.(notification)}>
      {body}
    </button>
  );
}
