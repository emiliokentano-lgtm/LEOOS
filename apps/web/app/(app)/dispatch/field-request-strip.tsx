'use client';

import * as React from 'react';
import { Siren, MapPin, X } from 'lucide-react';
import { isFieldRequestLive, type FieldRequestDto } from '@leoos/contracts';
import { Button, OrgTag } from '@/components/ui';
import { cn } from '@/lib/utils';
import { cancelFieldRequest, respondToFieldRequest } from '@/lib/dispatch-actions';

/**
 * Live field requests, above the board.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BELOW PANIC, ABOVE EVERYTHING ELSE
 *
 * Panic keeps the top of the screen: it is the only thing that outranks
 * whatever the operator is doing. A backup request sits directly under it,
 * because somebody asking for help is the second most urgent thing a dispatch
 * console can be showing — and above the filters, because a filter must never
 * be able to hide it.
 *
 * A location share is quieter by design. Same strip, different weight: no
 * accent border, an info tone, and no implication that anybody has to act.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * EXPIRY IS COMPUTED, NOT POLLED. `isFieldRequestLive` is the same predicate
 * the API uses, given a clock rather than reading one, so a card cannot linger
 * offering an "Accept" the server would refuse. The tick below is only what
 * moves the clock forward; it re-renders this strip and nothing else.
 */
export function FieldRequestStrip({
  requests,
  onChanged,
}: {
  requests: FieldRequestDto[];
  onChanged: () => void;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  const [pending, setPending] = React.useState<string | null>(null);

  React.useEffect(() => {
    // One second, and only while something is on screen. A dispatch console
    // that ticks all shift for an empty strip is a console spending frames on
    // nothing.
    if (requests.length === 0) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [requests.length]);

  const live = requests.filter((request) => isFieldRequestLive(request, now));
  if (live.length === 0) return null;

  async function act(id: string, run: () => Promise<unknown>) {
    setPending(id);
    try {
      await run();
      onChanged();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-px border-b border-border-subtle" role="region"
      aria-label="Live field requests">
      {live.map((request) => {
        const isBackup = request.kind === 'backup';
        const secondsLeft = Math.max(0, Math.round((Date.parse(request.expiresAt) - now) / 1000));

        return (
          <div
            key={request.id}
            className={cn(
              'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs',
              isBackup
                ? 'border-l-2 border-l-warning bg-warning/8'
                : 'border-l-2 border-l-accent bg-raised',
            )}
          >
            {isBackup
              ? <Siren className="size-4 shrink-0 text-warning" aria-hidden />
              : <MapPin className="size-4 shrink-0 text-accent" aria-hidden />}

            {/* The kind is stated in WORDS as well as by colour and icon —
                status must never be communicated by colour alone. */}
            <span className={cn('font-semibold', isBackup ? 'text-warning' : 'text-accent')}>
              {isBackup ? 'BACKUP' : 'LOCATION'}
            </span>

            <OrgTag
              shortName={request.organization.shortName}
              name={request.organization.name}
              color={request.organization.color}
              size="xs"
            />

            <span className="min-w-0 text-text-primary">
              {request.asker.callsign ? (
                <span className="font-mono">{request.asker.callsign}</span>
              ) : null}
              {request.asker.callsign ? ' · ' : ''}
              {request.asker.displayName}
              {request.asker.rankLabel ? (
                <span className="text-text-tertiary"> · {request.asker.rankLabel}</span>
              ) : null}
            </span>

            {request.incidentNumber ? (
              <span className="font-mono text-2xs text-text-tertiary">
                on {request.incidentNumber}
              </span>
            ) : null}

            {request.note ? (
              <span className="min-w-0 truncate text-text-secondary">“{request.note}”</span>
            ) : null}

            {/* The count is shown because "eight people passed" and "nobody
                saw it" are different facts, and only one of them is a reason
                to send somebody yourself. */}
            {request.declinedCount > 0 ? (
              <span className="text-2xs text-text-tertiary">
                {request.declinedCount} passed
              </span>
            ) : null}

            <span className="ml-auto flex items-center gap-2">
              <span className="font-mono tabular text-2xs text-text-tertiary">
                {secondsLeft}s
              </span>

              {request.viewerIsAsker ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending === request.id}
                  onClick={() => void act(request.id, () => cancelFieldRequest(request.id))}
                >
                  <X aria-hidden /> Cancel
                </Button>
              ) : request.viewerResponse !== null ? (
                /* Already answered. The card stays — it is still live for
                   everybody else — but this operator is told what they did
                   rather than being offered the buttons again. */
                <span className="text-2xs text-text-tertiary">
                  You {request.viewerResponse === 'accepted' ? 'responded' : 'passed'}
                </span>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={pending === request.id}
                    onClick={() => void act(
                      request.id, () => respondToFieldRequest(request.id, 'accept'),
                    )}
                  >
                    {isBackup ? 'Respond' : 'Mark on map'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending === request.id}
                    onClick={() => void act(
                      request.id, () => respondToFieldRequest(request.id, 'decline'),
                    )}
                  >
                    Pass
                  </Button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
