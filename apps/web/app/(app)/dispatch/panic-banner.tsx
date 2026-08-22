'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import { formatWorldPosition, type PanicAlert } from '@leoos/contracts';
import { Button, OrgTag, useToast } from '@/components/ui';
import { acknowledgePanic, resolvePanic } from '@/lib/dispatch-actions';
import { useNow } from '@/lib/map/use-now';
import { formatElapsed } from '@/lib/utils';

/**
 * Live panic alerts.
 *
 * Sits above everything else on the screen and cannot be dismissed from the
 * client — it disappears when the underlying `panic_event` is resolved, which is
 * a server-side fact. An operator cannot make it go away by closing something.
 *
 * ACKNOWLEDGING DOES NOT CLEAR IT. That is the whole point of having two
 * actions: acknowledging records that a dispatcher has seen it, and the alert
 * stays up because the officer is still in trouble. Only standing it down
 * removes it.
 */
export function PanicBanner({
  panics, canAcknowledge, onChanged,
}: {
  panics: PanicAlert[];
  canAcknowledge: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const now = useNow();
  const toast = useToast();

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(id);
    const result = await fn();
    setPending(null);
    if (!result.ok) {
      toast.push({ tone: 'danger', title: 'Refused', description: result.error });
      return;
    }
    onChanged();
  }

  return (
    <div
      className="flex flex-col gap-1 border-b-2 border-danger bg-danger/10 px-3 py-2"
      role="alert"
      aria-live="assertive"
    >
      {panics.map((panic) => (
        <div key={panic.id} className="flex flex-wrap items-center gap-2 text-xs">
          <TriangleAlert className="size-4 shrink-0 text-danger animate-panic" aria-hidden />
          <span className="font-semibold uppercase tracking-wide text-danger">Panic</span>

          <span className="font-medium text-text-primary">{panic.memberName}</span>
          {panic.callsign ? (
            <span className="font-mono text-text-secondary">{panic.callsign}</span>
          ) : null}
          <OrgTag
            shortName={panic.organization.shortName}
            color={panic.organization.color}
          />
          {panic.unitCallsign ? (
            <span className="text-text-secondary">in <span className="font-mono">{panic.unitCallsign}</span></span>
          ) : null}
          {panic.position ? (
            <span className="font-mono text-text-tertiary">
              {formatWorldPosition(panic.position)}
            </span>
          ) : (
            <span className="text-text-tertiary">position unknown</span>
          )}
          <span className="font-mono text-text-tertiary">
            {now === 0 ? '—' : formatElapsed(new Date(panic.createdAt), new Date(now))}
          </span>

          {panic.acknowledgedAt !== null ? (
            <span className="text-text-tertiary">
              acknowledged by {panic.acknowledgedByName ?? 'a dispatcher'}
            </span>
          ) : null}

          <div className="ml-auto flex gap-1.5">
            {canAcknowledge && panic.acknowledgedAt === null ? (
              <Button
                variant="secondary" size="sm"
                disabled={pending === panic.id}
                onClick={() => { void run(panic.id, () => acknowledgePanic(panic.id)); }}
              >
                Acknowledge
              </Button>
            ) : null}
            {/* Stand-down is offered to dispatchers and to the officer who raised
                it; the API decides which of the two the caller is. */}
            <Button
              variant="danger" size="sm"
              disabled={pending === panic.id}
              onClick={() => { void run(panic.id, () => resolvePanic(panic.id)); }}
            >
              Stand down
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
