import type { OperationalStatusMeta } from '@leoos/contracts';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';

/**
 * One operational status, rendered from its catalogue row.
 *
 * Takes the META rather than a key, deliberately: statuses are database rows so
 * an organization can add its own (engineering rules 5-7), and a component that
 * looked the key up in a hardcoded map would silently render nothing for one.
 *
 * Colour is never the only signal — the icon and the label carry it too.
 */
export function StatusChip({
  status, display = 'full', className,
}: {
  status: OperationalStatusMeta | null;
  display?: 'full' | 'short';
  className?: string;
}) {
  if (status === null) {
    return (
      <span className={cn('text-2xs text-text-disabled', className)}>Off duty</span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 text-2xs font-medium',
        status.isPanic && 'animate-panic',
        className,
      )}
      style={{
        borderColor: `var(${status.colorToken})`,
        color: `var(${status.colorToken})`,
      }}
    >
      <Icon name={status.icon} className="size-3" />
      {display === 'short' ? (status.shortLabel || status.label) : status.label}
    </span>
  );
}
