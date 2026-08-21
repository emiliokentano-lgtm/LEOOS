'use client';

import { Icon } from '@/components/icon';
import {
  DUTY_STATUSES, INCIDENT_STATUSES, PRIORITIES,
  type DutyStatusKey, type IncidentStatusKey, type IncidentPriority,
} from '@leoos/contracts';
import { cn } from '@/lib/utils';

/**
 * Status indicators.
 *
 * Every one of these renders THREE signals: colour, an icon, and a text label.
 * Colour is never the only indicator — that is a hard accessibility rule, and it
 * also matters operationally, because these are read on projected wall displays
 * where colour fidelity is poor.
 */

/**
 * Icons come from the shared registry, not from a namespace import.
 *
 * `import * as Icons from 'lucide-react'` is opaque to tree-shaking and pulled
 * the whole library into the client bundle — see `components/icon.tsx`.
 */
function LucideIcon({ name, className }: { name: string; className?: string }) {
  return <Icon name={name} className={className} />;
}

export interface DutyStatusBadgeProps {
  status: DutyStatusKey;
  /** `full` shows the label, `short` the radio abbreviation, `dot` icon only. */
  display?: 'full' | 'short' | 'dot';
  size?: 'sm' | 'md';
  className?: string;
}

export function DutyStatusBadge({
  status, display = 'full', size = 'md', className,
}: DutyStatusBadgeProps) {
  const meta = DUTY_STATUSES[status];
  const color = `var(${meta.token})`;
  const isPanic = status === 'panic';

  if (display === 'dot') {
    return (
      <span
        className={cn('inline-flex items-center', isPanic && 'animate-panic', className)}
        style={{ color }}
        title={meta.label}
      >
        <LucideIcon name={meta.icon} className="size-3.5" />
        <span className="sr-only">{meta.label}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-xs border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-4 px-1 text-2xs' : 'h-5 px-1.5 text-2xs',
        isPanic && 'animate-panic',
        className,
      )}
      style={{
        color,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
      }}
    >
      <LucideIcon name={meta.icon} className={size === 'sm' ? 'size-2.5' : 'size-3'} />
      {display === 'short' ? meta.short : meta.label}
    </span>
  );
}

export function IncidentStatusBadge({
  status, size = 'md', className,
}: { status: IncidentStatusKey; size?: 'sm' | 'md'; className?: string }) {
  const meta = INCIDENT_STATUSES[status];
  const color = `var(${meta.token})`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-xs border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-4 px-1 text-2xs' : 'h-5 px-1.5 text-2xs',
        className,
      )}
      style={{
        color,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
      }}
    >
      <LucideIcon name={meta.icon} className={size === 'sm' ? 'size-2.5' : 'size-3'} />
      {meta.label}
    </span>
  );
}

export interface PriorityBadgeProps {
  priority: IncidentPriority;
  /** Solid reads at a distance — used in the dispatch queue and on the map. */
  variant?: 'solid' | 'outline';
  className?: string;
}

export function PriorityBadge({ priority, variant = 'solid', className }: PriorityBadgeProps) {
  const meta = PRIORITIES[priority];
  const color = `var(${meta.token})`;
  const solid = variant === 'solid';
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-[26px] items-center justify-center rounded-xs border',
        'font-mono text-2xs font-semibold tracking-tight',
        className,
      )}
      style={
        solid
          ? { backgroundColor: color, borderColor: color, color: priority <= 2 ? '#fff' : '#0b0e14' }
          : {
              color,
              borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
              backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
            }
      }
      title={meta.description}
    >
      {meta.label}
    </span>
  );
}

/** Organization identity chip. Colour comes from the database row, never from a
 *  stylesheet — adding an organization must not require a CSS edit. */
export function OrgBadge({
  shortName, color, className, size = 'md',
}: { shortName: string; color: string; className?: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-xs border font-mono font-semibold tracking-tight whitespace-nowrap',
        size === 'sm' ? 'h-4 px-1 text-2xs' : 'h-5 px-1.5 text-2xs',
        className,
      )}
      style={{
        color,
        borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`,
      }}
    >
      {shortName}
    </span>
  );
}
