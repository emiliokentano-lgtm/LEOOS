'use client';

import * as React from 'react';
import { PanelRightClose, Plus, Send, X } from 'lucide-react';
import {
  INCIDENT_STATUSES, INCIDENT_STATUS_LIST, PRIORITY_LIST, canTransitionIncident,
  formatWorldPosition,
  type DispatchCapabilities, type DispatchIncidentDetail, type DispatchIncidentSummary,
  type DispatchUnit, type IncidentPriority, type IncidentStatusKey,
} from '@leoos/contracts';
import {
  Button, IconButton, Input, Panel, PanelHeader, Select, useToast,
} from '@/components/ui';
import {
  addIncidentNote, assignUnit, closeIncident, releaseUnit, reopenIncident,
  setIncidentPriority, setIncidentStatus,
} from '@/lib/dispatch-actions';
import { useNow } from '@/lib/map/use-now';
import { cn, formatElapsed, timeAgo } from '@/lib/utils';

/**
 * The selected call: everything about it, and everything you can do to it.
 *
 * The detail — description, timeline, released assignments — is fetched on
 * selection rather than carried on every poll: a long-running major incident
 * accumulates hundreds of timeline entries, and making the common case pay for
 * that would slow the whole board.
 *
 * Every control here is gated on a capability the API reported AND on the shared
 * transition table. Both are UX: the server re-decides on every call.
 */
export function IncidentDetailPanel({
  summary, units, capabilities, onChanged, onClose,
}: {
  summary: DispatchIncidentSummary;
  units: DispatchUnit[];
  capabilities: DispatchCapabilities | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<DispatchIncidentDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [assignTo, setAssignTo] = React.useState('');
  const [closeNotes, setCloseNotes] = React.useState('');
  const [closing, setClosing] = React.useState(false);
  const toast = useToast();
  const now = useNow();

  /**
   * Loads the detail for the selected call.
   *
   * State is set only in the promise callbacks, never synchronously in the
   * effect body — a synchronous `setLoading(true)` there is a cascading render
   * on every dependency change, and this effect re-runs whenever the summary
   * shows the call has moved.
   *
   * `loading` starts true and is never set back to true on a refetch:
   * the panel is mounted with `key={incident.id}`, so a NEW call gets a fresh
   * component and a genuine loading state, while a refetch of the SAME call
   * updates in place rather than flashing a spinner over a timeline the
   * operator is reading.
   */
  const [reloadToken, setReloadToken] = React.useState(0);

  // The summary arrives on every poll; the detail does not. Re-fetching when the
  // summary shows the call has moved keeps the timeline current without polling
  // it directly.
  const movedMarker = `${summary.status}:${summary.priority}:${summary.assignedUnitIds.join(',')}`;

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetch(`/api/dispatch/incident?id=${encodeURIComponent(summary.id)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: DispatchIncidentDetail | null) => {
        if (cancelled) return;
        setDetail(data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [summary.id, movedMarker, reloadToken]);

  const load = React.useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(label);
    const result = await fn();
    setPending(null);
    if (!result.ok) {
      toast.push({ tone: 'danger', title: 'Refused', description: result.error });
      return false;
    }
    onChanged();
    load();
    return true;
  }

  const status = INCIDENT_STATUSES[summary.status];
  const priority = PRIORITY_LIST[summary.priority - 1]!;
  const isOpen = status.isOpen;

  const assignedUnits = units.filter((u) => summary.assignedUnitIds.includes(u.id));
  const assignable = units.filter((u) => !summary.assignedUnitIds.includes(u.id)
    && u.status.isOnDuty);

  return (
    <Panel flush className="min-h-0 flex-1">
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{summary.number}</span>
            <span
              className="rounded-[2px] px-1 text-[11px] font-semibold"
              style={{ color: `var(${priority.token})` }}
            >
              {priority.label} {priority.name}
            </span>
            <span
              className="rounded-xs border px-1.5 text-[11px]"
              style={{ borderColor: `var(${status.token})`, color: `var(${status.token})` }}
            >
              {status.label}
            </span>
          </span>
        }
        actions={
          <IconButton label="Close panel" size="xs" onClick={onClose}>
            <PanelRightClose aria-hidden />
          </IconButton>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="border-b border-border-subtle p-3">
          <h2 className="text-sm font-semibold text-text-primary">{summary.title}</h2>
          {detail?.description ? (
            <p className="mt-1 whitespace-pre-wrap text-xs text-text-secondary">
              {detail.description}
            </p>
          ) : null}

          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <Fact label="Location">{summary.locationText ?? '—'}</Fact>
            <Fact label="Coordinates">
              {summary.position === null
                ? '—'
                : <span className="font-mono">{formatWorldPosition(summary.position)}</span>}
            </Fact>
            <Fact label="Type">{summary.typeLabel ?? summary.typeKey ?? '—'}</Fact>
            <Fact label="Organization">
              {summary.organization?.shortName ?? 'Multi-agency'}
            </Fact>
            <Fact label="Opened">
              {now === 0 ? '—' : `${formatElapsed(new Date(summary.createdAt), new Date(now))} ago`}
            </Fact>
            <Fact label="Opened by">{detail?.createdByName ?? '—'}</Fact>
            {summary.closedAt !== null ? (
              <>
                <Fact label="Closed">
                  {now === 0 ? '—' : timeAgo(new Date(summary.closedAt), new Date(now))}
                </Fact>
                <Fact label="Closed by">{detail?.closedByName ?? '—'}</Fact>
              </>
            ) : null}
          </dl>

          {detail?.closingNotes ? (
            <p className="mt-2 rounded-xs border border-border-subtle bg-raised p-2 text-xs text-text-secondary">
              <span className="text-text-tertiary">Closing notes: </span>
              {detail.closingNotes}
            </p>
          ) : null}
        </div>

        {/* Controls */}
        {isOpen ? (
          <div className="flex flex-col gap-2.5 border-b border-border-subtle p-3">
            {capabilities?.canManageIncident ? (
              <>
                <ControlRow label="Status">
                  <div className="flex flex-wrap gap-1">
                    {INCIDENT_STATUS_LIST
                      .filter((s) => s.isOpen && s.key !== summary.status)
                      .map((s) => {
                        const allowed = canTransitionIncident(summary.status, s.key);
                        return (
                          <Button
                            key={s.key}
                            variant="secondary"
                            size="xs"
                            // Greyed rather than hidden: seeing that a transition
                            // exists but is not available now is information.
                            disabled={!allowed || pending !== null}
                            title={allowed
                              ? `Move to ${s.label}`
                              : `Cannot move from ${status.label} to ${s.label}`}
                            onClick={() => {
                              void run('status', () => setIncidentStatus(
                                summary.id, s.key as Exclude<IncidentStatusKey, 'closed' | 'cancelled'>,
                              ));
                            }}
                          >
                            {s.label}
                          </Button>
                        );
                      })}
                  </div>
                </ControlRow>

                <ControlRow label="Priority">
                  <div className="flex flex-wrap gap-1">
                    {PRIORITY_LIST.map((p) => (
                      <Button
                        key={p.value}
                        variant={p.value === summary.priority ? 'primary' : 'secondary'}
                        size="xs"
                        disabled={pending !== null || p.value === summary.priority}
                        title={`${p.name} — ${p.description}`}
                        onClick={() => {
                          void run('priority', () => setIncidentPriority(
                            summary.id, p.value as IncidentPriority,
                          ));
                        }}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                </ControlRow>
              </>
            ) : null}

            {capabilities?.canAssignUnits ? (
              <ControlRow label="Assign">
                <div className="flex items-center gap-1.5">
                  <Select
                    value={assignTo}
                    onValueChange={setAssignTo}
                    options={assignable.map((u) => ({
                      value: u.id,
                      label: `${u.callsign} · ${u.organization.shortName} · ${u.status.shortLabel}`,
                    }))}
                    placeholder={assignable.length === 0 ? 'No units free' : 'Select a unit…'}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={pending !== null || assignTo === ''}
                    onClick={() => {
                      const unitId = assignTo;
                      setAssignTo('');
                      void run('assign', () => assignUnit(summary.id, unitId));
                    }}
                  >
                    <Send aria-hidden /> Dispatch
                  </Button>
                </div>
              </ControlRow>
            ) : null}
          </div>
        ) : null}

        {/* Assigned units */}
        <div className="border-b border-border-subtle p-3">
          <p className="mb-1.5 text-2xs uppercase tracking-wide text-text-disabled">
            Assigned units
          </p>
          {assignedUnits.length === 0 ? (
            <p className="text-xs text-text-tertiary">No units currently assigned.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {assignedUnits.map((unit) => (
                <div key={unit.id} className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-text-primary">
                    {unit.callsign}
                  </span>
                  <span
                    className="rounded-[2px] border px-1 text-[9px]"
                    style={{ borderColor: unit.organization.color, color: unit.organization.color }}
                  >
                    {unit.organization.shortName}
                  </span>
                  <span className="truncate text-text-tertiary">
                    {unit.crew.map((c) => c.name).join(', ') || 'Uncrewed'}
                  </span>
                  {capabilities?.canAssignUnits && isOpen ? (
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => { void run('release', () => releaseUnit(summary.id, unit.id)); }}
                      aria-label={`Release ${unit.callsign}`}
                      className="ml-auto text-text-disabled transition-colors hover:text-danger disabled:opacity-50"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {/* Units that attended and cleared are part of the record of the call. */}
          {detail !== null && detail.assignments.some((a) => a.releasedAt !== null) ? (
            <p className="mt-2 text-2xs text-text-tertiary">
              Previously:{' '}
              {detail.assignments
                .filter((a) => a.releasedAt !== null)
                .map((a) => a.callsign)
                .join(', ')}
            </p>
          ) : null}
        </div>

        {/* Timeline */}
        <div className="p-3">
          <p className="mb-1.5 text-2xs uppercase tracking-wide text-text-disabled">Timeline</p>
          {loading && detail === null ? (
            <p className="text-xs text-text-tertiary">Loading…</p>
          ) : detail === null ? (
            <p className="text-xs text-danger">The timeline could not be loaded.</p>
          ) : detail.timeline.length === 0 ? (
            <p className="text-xs text-text-tertiary">Nothing recorded yet.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {detail.timeline.map((entry) => (
                <li key={entry.id} className="flex gap-2 text-xs">
                  <span
                    className={cn(
                      'mt-1 size-1.5 shrink-0 rounded-full',
                      entry.kind === 'status_change' ? 'bg-accent'
                        : entry.kind === 'assignment' ? 'bg-status-onscene'
                          : entry.kind === 'clear' ? 'bg-status-available'
                            : entry.kind === 'note' ? 'bg-text-tertiary' : 'bg-border-strong',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-text-secondary">{entry.body}</p>
                    <p className="text-2xs text-text-tertiary">
                      {entry.actorLabel ?? 'System'}
                      {' · '}
                      {now === 0 ? '' : timeAgo(new Date(entry.createdAt), new Date(now))}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {isOpen ? (
            <form
              className="mt-2 flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const body = note.trim();
                if (body === '') return;
                setNote('');
                void run('note', () => addIncidentNote(summary.id, body));
              }}
            >
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note to the record…"
                maxLength={2000}
                inputSize="sm"
                className="flex-1"
              />
              <Button type="submit" size="sm" variant="secondary"
                disabled={pending !== null || note.trim() === ''}>
                <Plus aria-hidden />
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      {/* Close / reopen */}
      <div className="border-t border-border-subtle p-2">
        {isOpen ? (
          capabilities?.canCloseIncident ? (
            closing ? (
              <div className="flex flex-col gap-1.5">
                <Input
                  value={closeNotes}
                  onChange={(e) => setCloseNotes(e.target.value)}
                  placeholder="Closing notes (optional)"
                  maxLength={2000}
                  inputSize="sm"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm" className="flex-1"
                    disabled={pending !== null}
                    onClick={() => {
                      const notes = closeNotes.trim() === '' ? null : closeNotes.trim();
                      void run('close', () => closeIncident(summary.id, { notes }))
                        .then((ok) => { if (ok) { setClosing(false); setCloseNotes(''); } });
                    }}
                  >
                    Close call
                  </Button>
                  <Button
                    variant="secondary" size="sm"
                    disabled={pending !== null}
                    onClick={() => {
                      void run('cancel', () => closeIncident(summary.id, { cancelled: true }))
                        .then((ok) => { if (ok) setClosing(false); });
                    }}
                  >
                    Cancel call
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setClosing(false)}>
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" className="w-full" onClick={() => setClosing(true)}>
                Close this call
              </Button>
            )
          ) : null
        ) : capabilities?.canCloseIncident ? (
          <ReopenControl
            disabled={pending !== null}
            onReopen={(reason) => { void run('reopen', () => reopenIncident(summary.id, reason)); }}
          />
        ) : null}
      </div>
    </Panel>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-text-primary">{children}</dd>
    </div>
  );
}

function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-14 shrink-0 pt-1 text-2xs uppercase tracking-wide text-text-disabled">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Reopening asks for a reason.
 *
 * It is not a status change, and the reason goes into the timeline: un-finishing
 * a closed call is exactly the kind of thing somebody has to justify later.
 */
function ReopenControl({
  disabled, onReopen,
}: {
  disabled: boolean;
  onReopen: (reason: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');

  if (!open) {
    return (
      <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(true)}>
        Reopen this call
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length < 3) return;
        onReopen(reason.trim());
        setOpen(false);
        setReason('');
      }}
    >
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this being reopened?"
        maxLength={200}
        inputSize="sm"
        className="flex-1"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={disabled || reason.trim().length < 3}>
        Reopen
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
