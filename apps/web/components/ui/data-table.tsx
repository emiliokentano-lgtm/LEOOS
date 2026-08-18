'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AsyncBoundary, EmptyState, type AsyncResource } from './states';
import { SkeletonRows } from './skeleton';

/**
 * The single table implementation.
 *
 * Persons, vehicles, personnel, incidents, units, audit logs and search results
 * are all the same interaction, so this is built once and well rather than
 * re-invented per screen (engineering rule 27).
 *
 * Deliberately NOT virtualised yet: virtualisation constrains row height and
 * complicates sticky headers, and no screen in this phase renders more than a few
 * hundred rows. It is introduced at the first screen that actually needs it —
 * the column API below is designed so that swap is internal (rule 28).
 */

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  /** Cell renderer. Receives the row and its index. */
  cell: (row: T, index: number) => React.ReactNode;
  /** Fixed width, e.g. '120px' or '1fr'. Defaults to 'auto'. */
  width?: string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Hidden below this viewport width — keeps tables usable on laptops without
   *  horizontal scrolling for secondary columns. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  /** Numeric/code content gets tabular figures and the mono face. */
  mono?: boolean;
}

export type SortDirection = 'asc' | 'desc';
export interface SortState { columnId: string; direction: SortDirection }

export interface DataTableProps<T> {
  columns: Column<T>[];
  resource: AsyncResource<T[]>;
  rowKey: (row: T) => string;
  /** Row click — opens a detail view. Rows become keyboard-focusable when set. */
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  density?: 'compact' | 'comfortable';
  /** Tints an entire row — used for panic, overdue incidents, flagged persons. */
  rowTone?: (row: T) => 'default' | 'danger' | 'warning';
  empty?: React.ReactNode;
  stickyHeader?: boolean;
  className?: string;
  /** Accessible caption. Required — a bare grid of numbers is unreadable to a
   *  screen reader without one. */
  caption: string;
}

const hideBelowClass = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

export function DataTable<T>({
  columns, resource, rowKey, onRowClick, selectedKey, sort, onSortChange,
  density = 'compact', rowTone, empty, stickyHeader = true, className, caption,
}: DataTableProps<T>) {
  const rowHeight = density === 'compact' ? 'h-8' : 'h-10';

  function toggleSort(col: Column<T>) {
    if (!col.sortable || !onSortChange) return;
    const dir: SortDirection =
      sort?.columnId === col.id && sort.direction === 'asc' ? 'desc' : 'asc';
    onSortChange({ columnId: col.id, direction: dir });
  }

  return (
    <AsyncBoundary
      resource={resource}
      loading={<SkeletonRows rows={8} />}
      empty={empty ?? <EmptyState title="No records" description="Nothing matches this view yet." />}
    >
      {(rows) => (
        <div className={cn('table-scroll min-h-0 flex-1', className)}>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className={cn(stickyHeader && 'sticky top-0 z-10')}>
              <tr className="bg-raised">
                {columns.map((col) => {
                  const active = sort?.columnId === col.id;
                  return (
                    <th
                      key={col.id}
                      scope="col"
                      style={col.width ? { width: col.width } : undefined}
                      aria-sort={
                        active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                      }
                      className={cn(
                        'h-8 border-b border-border px-3 text-2xs font-semibold uppercase tracking-wide',
                        'whitespace-nowrap text-text-tertiary',
                        col.align === 'right' && 'text-right',
                        col.align === 'center' && 'text-center',
                        !col.align && 'text-left',
                        col.hideBelow && hideBelowClass[col.hideBelow],
                      )}
                    >
                      {col.sortable && onSortChange ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-xs transition-colors',
                            'hover:text-text-secondary',
                            active && 'text-text-primary',
                            col.align === 'right' && 'flex-row-reverse',
                          )}
                        >
                          {col.header}
                          {active ? (
                            sort.direction === 'asc'
                              ? <ArrowUp className="size-3" aria-hidden />
                              : <ArrowDown className="size-3" aria-hidden />
                          ) : (
                            <ChevronsUpDown className="size-3 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        col.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const key = rowKey(row);
                const tone = rowTone?.(row) ?? 'default';
                const selected = selectedKey === key;
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(row);
                            }
                          }
                        : undefined
                    }
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-selected={onRowClick ? selected : undefined}
                    className={cn(
                      rowHeight,
                      'border-b border-border-subtle transition-colors duration-(--duration-fast)',
                      onRowClick && 'cursor-pointer',
                      selected ? 'bg-active' : 'hover:bg-hover',
                      // Row tone is a left border plus a wash — not a full
                      // background fill, which would fight the text contrast.
                      tone === 'danger' && 'border-l-2 border-l-danger bg-danger/6',
                      tone === 'warning' && 'border-l-2 border-l-warning bg-warning/6',
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={cn(
                          'px-3 align-middle text-text-primary',
                          col.align === 'right' && 'text-right',
                          col.align === 'center' && 'text-center',
                          col.mono && 'font-mono text-xs tabular',
                          col.hideBelow && hideBelowClass[col.hideBelow],
                        )}
                      >
                        {col.cell(row, index)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AsyncBoundary>
  );
}
