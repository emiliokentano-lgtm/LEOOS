import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center', className)}>
      <ol className="flex min-w-0 items-center gap-1">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {item.href && !last ? (
                <Link
                  href={item.href as never}
                  className="truncate text-xs text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={cn('truncate text-xs', last ? 'text-text-secondary' : 'text-text-tertiary')}
                  aria-current={last ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
              {!last ? (
                <ChevronRight className="size-3 shrink-0 text-text-disabled" aria-hidden />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
