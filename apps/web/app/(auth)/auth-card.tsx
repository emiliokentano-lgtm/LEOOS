import { cn } from '@/lib/utils';

/** Shared frame for every authentication screen, so they cannot drift apart. */
export function AuthCard({
  title, description, children, footer, className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-md border border-border-subtle bg-surface', className)}>
      <div className="border-b border-border-subtle px-5 py-4">
        <h1 className="text-base font-semibold text-text-primary">{title}</h1>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
        ) : null}
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer ? (
        <div className="border-t border-border-subtle px-5 py-3 text-xs text-text-tertiary">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
