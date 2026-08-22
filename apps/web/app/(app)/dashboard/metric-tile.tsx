'use client';

import { HelpCircle } from 'lucide-react';
import {
  explainUnavailable, formatDurationMetric, type Metric,
} from '@leoos/contracts';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * A statistic that might not exist.
 *
 * THE POINT OF THIS COMPONENT is that it cannot render a number it does not
 * have. An unavailable metric shows a dash and says why — because on a tile,
 * `0` and "we cannot compute this" look identical and mean opposite things, and
 * an operator reading "0" for average response time would conclude the service
 * is instantaneous rather than unmeasured.
 */
export function MetricTile({
  label, metric, kind = 'duration', hint,
}: {
  label: string;
  metric: Metric;
  /** Durations are formatted; counts are shown as-is. */
  kind?: 'duration' | 'count';
  hint?: string;
}) {
  const body = metric.available ? (
    <>
      <span className="font-mono text-lg font-semibold tabular text-text-primary">
        {kind === 'duration'
          ? formatDurationMetric(metric.value)
          : Math.round(metric.value).toLocaleString()}
      </span>
      {/* The sample size is part of the number, not a footnote: a median over
          six calls and one over six hundred are different claims. */}
      <span className="text-2xs text-text-tertiary">n={metric.sampleSize}</span>
    </>
  ) : (
    <>
      <span className="font-mono text-lg font-semibold text-text-tertiary" aria-hidden>—</span>
      <span className="text-2xs text-text-tertiary">{explainUnavailable(metric)}</span>
    </>
  );

  return (
    <div className="flex flex-col gap-0.5 rounded-xs border border-border-subtle bg-raised p-2">
      <span className="flex items-center gap-1 text-2xs uppercase tracking-wide text-text-tertiary">
        {label}
        {hint !== undefined ? (
          <Tooltip content={hint}>
            <HelpCircle className="size-3 text-text-tertiary" aria-hidden />
          </Tooltip>
        ) : null}
      </span>
      <span className="flex items-baseline gap-1.5">{body}</span>
      {!metric.available ? (
        <span className="sr-only">{label} is unavailable: {explainUnavailable(metric)}</span>
      ) : null}
    </div>
  );
}

/** An exact count. Separate component because a count is never "unavailable". */
export function CountTile({
  label, value, tone, sub, onClick, active,
}: {
  label: string;
  value: number;
  tone?: 'danger' | 'warning' | 'accent';
  sub?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const content = (
    <>
      <span className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</span>
      <span
        className={cn(
          'font-mono text-xl font-semibold tabular',
          tone === 'danger' ? 'text-danger'
            : tone === 'warning' ? 'text-warning'
              : tone === 'accent' ? 'text-accent' : 'text-text-primary',
        )}
      >
        {value.toLocaleString()}
      </span>
      {sub !== undefined ? (
        <span className="text-2xs text-text-tertiary">{sub}</span>
      ) : null}
    </>
  );

  const className = cn(
    'flex flex-col gap-0.5 rounded-xs border p-2 text-left transition-colors',
    active
      ? 'border-border-strong bg-active'
      : 'border-border-subtle bg-raised',
    onClick !== undefined && 'hover:border-border-strong hover:bg-hover',
  );

  if (onClick === undefined) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={className}>
      {content}
    </button>
  );
}
