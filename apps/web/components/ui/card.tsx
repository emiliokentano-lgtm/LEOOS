import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Panel is the only "card" in the system.
 *
 * Deliberately flat: one border, one background step, no shadow by default, no
 * nested panels. Elevation is expressed by the surface scale, not by drop
 * shadows, which keeps a dense screen readable.
 */

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Removes internal padding — for tables and maps that manage their own. */
  flush?: boolean;
}

export function Panel({ className, flush, ...props }: PanelProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col rounded-md border border-border-subtle bg-surface',
        !flush && 'p-3',
        className,
      )}
      {...props}
    />
  );
}

export interface PanelHeaderProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned controls — filters, buttons, counts. */
  actions?: React.ReactNode;
  /** Small leading icon. */
  icon?: React.ReactNode;
}

export function PanelHeader({
  title, description, actions, icon, className, ...props
}: PanelHeaderProps) {
  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon ? <span className="text-text-tertiary [&_svg]:size-3.5">{icon}</span> : null}
        <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {title}
        </h2>
        {description ? (
          <span className="truncate text-xs text-text-tertiary">{description}</span>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-auto p-3', className)} {...props} />;
}

export function PanelFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-3 py-2',
        className,
      )}
      {...props}
    />
  );
}

/** Compact metric tile for the dashboard. No sparklines, no decorative icons —
 *  a number, a label, and optionally a delta. */
export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  /** Tints the value. Use only when the number itself carries status meaning. */
  tone?: 'default' | 'danger' | 'warning' | 'success';
  icon?: React.ReactNode;
  className?: string;
}

export function StatTile({ label, value, hint, tone = 'default', icon, className }: StatTileProps) {
  const toneClass = {
    default: 'text-text-primary',
    danger: 'text-danger',
    warning: 'text-warning',
    success: 'text-success',
  }[tone];

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2.5',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-text-tertiary">
          {label}
        </span>
        {icon ? <span className="text-text-tertiary [&_svg]:size-3.5">{icon}</span> : null}
      </div>
      <span className={cn('font-mono text-2xl font-semibold leading-none tabular', toneClass)}>
        {value}
      </span>
      {hint ? <span className="text-2xs text-text-tertiary">{hint}</span> : null}
    </div>
  );
}
