'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { UNIT_TYPES, type DispatchUnit } from '@leoos/contracts';
import {
  Badge, Button, EmptyState, Field, Input, Modal, OrgTag, Panel, PanelHeader, useToast,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { createUnit, disbandUnit } from '@/lib/dispatch-actions';
import { cn } from '@/lib/utils';

/**
 * The unit board.
 *
 * Grouped by status rather than listed flat: the question a dispatcher asks is
 * "who is free", not "who exists", and a flat list makes them scan for it.
 */
export function UnitBoard({
  units, selfUnitId, focusedUnitId, canManage, onChanged, onSelectIncident,
}: {
  units: DispatchUnit[];
  selfUnitId: string | null;
  /**
   * A unit arrived at from elsewhere — the map's "View unit", today.
   *
   * Scrolled to and highlighted rather than filtered to: an operator who came
   * here to look at one unit still needs the rest of the board around it to do
   * anything useful with what they find.
   */
  focusedUnitId: string | null;
  canManage: boolean;
  onChanged: () => void;
  onSelectIncident: (incidentId: string) => void;
}) {
  const [creating, setCreating] = React.useState(false);
  const focusedRef = React.useRef<HTMLDivElement>(null);

  /**
   * Scrolls the focused unit into view, once it exists.
   *
   * Keyed on the id AND on the unit count, because arriving from the map often
   * beats the first board load — without the second dependency the effect would
   * run against an empty list and never run again.
   */
  React.useEffect(() => {
    if (focusedUnitId === null) return;
    focusedRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedUnitId, units.length]);

  const groups = React.useMemo(() => {
    const available = units.filter((u) => u.status.isAvailable && !u.status.isPanic);
    const panic = units.filter((u) => u.status.isPanic);
    const engaged = units.filter((u) => !u.status.isAvailable && !u.status.isPanic
      && u.status.isOnDuty);
    const off = units.filter((u) => !u.status.isOnDuty);
    // Panic first: if a unit is in trouble it outranks everything else here.
    return [
      { key: 'panic', label: 'Panic', units: panic },
      { key: 'available', label: 'Available', units: available },
      { key: 'engaged', label: 'Engaged', units: engaged },
      { key: 'off', label: 'Off duty', units: off },
    ].filter((g) => g.units.length > 0);
  }, [units]);

  return (
    <Panel flush className="min-h-0 flex-1">
      <PanelHeader
        title="Units"
        actions={
          <div className="flex items-center gap-1.5">
            <Badge variant="neutral" mono>{units.length}</Badge>
            {canManage ? (
              <Button variant="secondary" size="xs" onClick={() => setCreating(true)}>
                <Plus aria-hidden /> Unit
              </Button>
            ) : null}
          </div>
        }
      />
      {/*
        * A unit was followed here that this board does not contain.
        *
        * Reachable when the link is stale, when the unit went off the board
        * between the two screens, or when it belongs to another organization —
        * the map shows those, the board does not. Silently doing nothing would
        * leave the operator hunting a row that is not there (engineering rules
        * 26, 45).
        */}
      {focusedUnitId !== null && !units.some((u) => u.id === focusedUnitId) ? (
        <p className="border-b border-border-subtle bg-raised px-3 py-1.5 text-2xs text-text-tertiary">
          The unit you followed is not on this board — it may belong to another
          organization or have gone off duty.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {units.length === 0 ? (
          <EmptyState title="No units" description="No unit is currently on the board." />
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <p className="sticky top-0 z-1 bg-raised px-3 py-1 text-2xs uppercase tracking-wide text-text-tertiary">
                {group.label} · {group.units.length}
              </p>
              {group.units.map((unit) => (
                <div
                  key={unit.id}
                  ref={unit.id === focusedUnitId ? focusedRef : undefined}
                  className={cn(
                    unit.id === focusedUnitId
                      && 'bg-active ring-1 ring-inset ring-[var(--color-accent)]',
                  )}
                >
                  <UnitRow
                    unit={unit}
                    isMine={unit.id === selfUnitId}
                    canManage={canManage}
                    onChanged={onChanged}
                    onSelectIncident={onSelectIncident}
                  />
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {creating ? (
        <NewUnitDialog onClose={() => setCreating(false)} onCreated={() => {
          setCreating(false);
          onChanged();
        }} />
      ) : null}
    </Panel>
  );
}

function UnitRow({
  unit, isMine, canManage, onChanged, onSelectIncident,
}: {
  unit: DispatchUnit;
  isMine: boolean;
  canManage: boolean;
  onChanged: () => void;
  onSelectIncident: (incidentId: string) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const toast = useToast();
  const type = UNIT_TYPES[unit.unitType as keyof typeof UNIT_TYPES];

  async function remove() {
    setPending(true);
    const result = await disbandUnit(unit.id);
    setPending(false);
    if (!result.ok) {
      toast.push({ tone: 'danger', title: 'Could not disband', description: result.error });
      return;
    }
    onChanged();
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border-subtle px-3 py-1.5',
        isMine && 'bg-active/40',
        unit.status.isPanic && 'bg-danger/10',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-text-tertiary">
        <Icon name={type?.icon ?? 'Car'} className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold text-text-primary">
            {unit.callsign}
          </span>
          <OrgTag
            shortName={unit.organization.shortName}
            color={unit.organization.color}
            size="xs"
          />
          {isMine ? (
            <span className="text-[9px] uppercase tracking-wide text-accent">you</span>
          ) : null}
        </div>
        <p className="truncate text-2xs text-text-tertiary">
          {unit.crew.length === 0
            ? 'Uncrewed'
            : unit.crew.map((c) => c.name).join(', ')}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {unit.incident !== null ? (
          <button
            type="button"
            onClick={() => onSelectIncident(unit.incident!.id)}
            className="font-mono text-2xs text-accent hover:underline"
          >
            {unit.incident.number}
          </button>
        ) : null}
        <span
          className="rounded-xs border px-1 text-[10px]"
          style={{
            borderColor: `var(${unit.status.colorToken})`,
            color: `var(${unit.status.colorToken})`,
          }}
        >
          {unit.status.shortLabel || unit.status.label}
        </span>
        {canManage ? (
          <button
            type="button"
            onClick={() => { void remove(); }}
            disabled={pending}
            aria-label={`Disband ${unit.callsign}`}
            className="text-text-tertiary transition-colors hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NewUnitDialog({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [callsign, setCallsign] = React.useState('');
  const [name, setName] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await createUnit({
      callsign: callsign.trim(),
      name: name.trim() === '' ? null : name.trim(),
    });
    setSaving(false);
    // The typed values survive a refusal — a taken callsign should not cost the
    // operator the rest of the form.
    if (!result.ok) { setError(result.error ?? 'The unit could not be created.'); return; }
    onCreated();
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Create a unit">
      <form onSubmit={(e) => { void submit(e); }} className="flex flex-col gap-3">
        <Field label="Callsign" htmlFor="unit-callsign" required>
          <Input
            id="unit-callsign"
            value={callsign}
            onChange={(e) => setCallsign(e.target.value)}
            placeholder="2-ADAM-12"
            maxLength={20}
            autoFocus
          />
        </Field>
        <Field label="Name" htmlFor="unit-name" hint="Optional.">
          <Input
            id="unit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Adam Twelve"
            maxLength={60}
          />
        </Field>
        <p className="text-xs text-text-tertiary">You will be crewed into the unit.</p>
        {error !== null ? <p className="text-xs text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || callsign.trim() === ''}>
            {saving ? 'Creating…' : 'Create unit'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
