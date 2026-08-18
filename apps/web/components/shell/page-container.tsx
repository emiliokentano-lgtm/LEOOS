import { cn } from '@/lib/utils';

/**
 * Standard page wrapper for scrolling content screens.
 *
 * Screens that manage their own layout (map, dispatch) do not use this — they
 * take the full height and split it themselves.
 */
export function PageContainer({
  children, className, padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={cn('h-full overflow-auto', padded && 'p-3', className)}>
      {children}
    </div>
  );
}

/** Full-height page that manages its own internal scroll regions. */
export function PageFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex h-full min-h-0 flex-col', className)}>{children}</div>;
}
