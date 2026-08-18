import { cn } from '@/lib/utils';

/**
 * Shape-matched loading placeholder.
 *
 * Never a spinner inside a table or list — a spinner tells the operator nothing
 * about what is arriving, and the layout jumps when it resolves. Skeletons hold
 * the final layout so nothing moves.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-skeleton rounded-xs bg-hover', className)}
      aria-hidden
      {...props}
    />
  );
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-3 border-b border-border-subtle px-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 flex-1 max-w-[220px]" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}
