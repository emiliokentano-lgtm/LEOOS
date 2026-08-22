'use client';

import * as React from 'react';
import { AlertTriangle, Inbox, RotateCw, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { SkeletonRows } from './skeleton';

/**
 * The four async states. Every region that loads data renders all four.
 *
 * This is an operational system: an ambiguous blank panel during an incident is a
 * failure, because the operator cannot tell whether there is nothing to show or
 * whether the system is broken.
 */

// ── Loading ────────────────────────────────────────────────────────────────

export function LoadingState({
  rows = 6, variant = 'rows', label = 'Loading…', className,
}: {
  rows?: number;
  variant?: 'rows' | 'block';
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('w-full', className)} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {variant === 'rows' ? (
        <SkeletonRows rows={rows} />
      ) : (
        <div className="flex flex-col gap-2 p-3">
          <SkeletonRows rows={Math.min(rows, 3)} />
        </div>
      )}
    </div>
  );
}

// ── Empty ──────────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  title: string;
  /** One line. Never a paragraph, never an illustration. */
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  /** `filtered` distinguishes "no results for this filter" from "nothing exists
   *  yet" — different meaning, different remedy. */
  variant?: 'empty' | 'filtered';
  className?: string;
}

export function EmptyState({
  title, description, action, icon, variant = 'empty', className,
}: EmptyStateProps) {
  const defaultIcon = variant === 'filtered' ? <SearchX aria-hidden /> : <Inbox aria-hidden />;
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      <span className="text-text-tertiary [&_svg]:size-6">{icon ?? defaultIcon}</span>
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {description ? <p className="max-w-sm text-xs text-text-tertiary">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

// ── Error ──────────────────────────────────────────────────────────────────

export interface ErrorStateProps {
  title?: string;
  message?: string;
  /** Correlates with the API's audit and log records. Always surfaced — "contact
   *  support" is useless without it. */
  requestId?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'Could not load this data',
  message,
  requestId,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}
      role="alert"
    >
      <AlertTriangle className="size-6 text-danger" aria-hidden />
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {message ? <p className="max-w-md text-xs text-text-secondary">{message}</p> : null}
      {requestId ? (
        <p className="font-mono text-2xs text-text-tertiary">Request {requestId}</p>
      ) : null}
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-1">
          <RotateCw aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

// ── AsyncBoundary ──────────────────────────────────────────────────────────

/** Minimal query shape. Deliberately not tied to TanStack Query so the
 *  convention holds regardless of the fetching library added in a later phase. */
export interface AsyncResource<T> {
  status: 'loading' | 'error' | 'success';
  data?: T;
  error?: { message: string; requestId?: string };
  refetch?: () => void;
  /** Data is older than its refresh interval. Shown dimmed with a timestamp —
   *  silently showing stale unit status is worse than showing none. */
  isStale?: boolean;
  updatedAt?: Date;
}

export interface AsyncBoundaryProps<T> {
  resource: AsyncResource<T>;
  children: (data: T) => React.ReactNode;
  loading?: React.ReactNode;
  empty?: React.ReactNode;
  /** Treats a resolved value as empty. Defaults to empty arrays. */
  isEmpty?: (data: T) => boolean;
  className?: string;
}

export function AsyncBoundary<T>({
  resource, children, loading, empty, isEmpty, className,
}: AsyncBoundaryProps<T>) {
  if (resource.status === 'loading') {
    return <>{loading ?? <LoadingState />}</>;
  }

  if (resource.status === 'error' || resource.data === undefined) {
    return (
      <ErrorState
        message={resource.error?.message}
        requestId={resource.error?.requestId}
        onRetry={resource.refetch}
      />
    );
  }

  const data = resource.data;
  const emptyCheck = isEmpty ?? ((d: T) => Array.isArray(d) && d.length === 0);
  if (emptyCheck(data)) {
    return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  }

  return (
    <div className={cn(resource.isStale && 'opacity-60 transition-opacity', className)}>
      {children(data)}
    </div>
  );
}
