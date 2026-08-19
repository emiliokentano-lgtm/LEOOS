'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * Horizontal filter strip above a table or map.
 *
 * Filters are chips rather than a form: they read as current state, and clearing
 * one is a single click. A "Clear all" appears only when something is active, so
 * the bar stays quiet in its default condition.
 */

export interface FilterBarProps {
  children: React.ReactNode;
  /** Right-aligned — usually a search field and view controls. */
  trailing?: React.ReactNode;
  activeCount?: number;
  onClearAll?: () => void;
  className?: string;
}

export function FilterBar({ children, trailing, activeCount = 0, onClearAll, className }: FilterBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface px-3 py-2',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      {activeCount > 0 && onClearAll ? (
        <Button variant="ghost" size="xs" onClick={onClearAll} className="text-text-tertiary">
          <X aria-hidden />
          Clear {activeCount}
        </Button>
      ) : null}
      {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
    </div>
  );
}

export interface FilterChipProps {
  label: React.ReactNode;
  active?: boolean;
  onToggle?: () => void;
  /** Swatch shown before the label — organization colour, status colour. */
  color?: string;
  count?: number;
  /** Native tooltip. Used for a keyboard shortcut hint that would clutter the label. */
  title?: string;
  className?: string;
}

export function FilterChip({
  label, active, onToggle, color, count, title, className,
}: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={title}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-xs border px-2 text-xs',
        'transition-colors duration-(--duration-fast)',
        active
          ? 'border-border-strong bg-active text-text-primary'
          : 'border-border bg-raised text-text-tertiary hover:border-border-strong hover:text-text-secondary',
        className,
      )}
    >
      {color ? (
        <span
          className="size-2 shrink-0 rounded-[1px]"
          style={{ backgroundColor: active ? color : 'transparent', border: `1px solid ${color}` }}
          aria-hidden
        />
      ) : null}
      {label}
      {typeof count === 'number' ? (
        <span className="font-mono text-2xs text-text-tertiary tabular">{count}</span>
      ) : null}
    </button>
  );
}
