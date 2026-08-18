'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from './icon-button';
import { Select } from './select';

export interface PaginationProps {
  page: number;            // 1-indexed
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

export function Pagination({
  page, pageSize, totalItems, onPageChange, onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200], className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const first = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);

  return (
    <div className={cn('flex items-center justify-between gap-4 px-3 py-1.5', className)}>
      <p className="text-xs text-text-tertiary tabular">
        <span className="text-text-secondary">{first}–{last}</span> of{' '}
        <span className="text-text-secondary">{totalItems.toLocaleString()}</span>
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-tertiary">Rows</span>
            <Select
              aria-label="Rows per page"
              size="sm"
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
              className="w-[68px]"
            />
          </div>
        ) : null}

        <div className="flex items-center gap-0.5">
          <IconButton
            label="First page" size="sm" disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft aria-hidden />
          </IconButton>
          <IconButton
            label="Previous page" size="sm" disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft aria-hidden />
          </IconButton>
          <span className="px-2 text-xs text-text-secondary tabular">
            {page} / {totalPages}
          </span>
          <IconButton
            label="Next page" size="sm" disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight aria-hidden />
          </IconButton>
          <IconButton
            label="Last page" size="sm" disabled={page >= totalPages}
            onClick={() => onPageChange(totalPages)}
          >
            <ChevronsRight aria-hidden />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
