'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { UNIT_TYPES, type DispatchUnit } from '@leoos/contracts';
import {
  Badge, Button, EmptyState, Field, Input, Modal, Panel, PanelHeader, useToast,
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
  units, selfUnitId, canManage, onChanged, onSelectIncident,
}: {
  units: DispatchUnit[];
  selfUnitId: string | null;
  canManage: boolean;
  onChanged: () => void;
  onSelectIncident: (incidentId: string) => void;
}) {
  const [creating, setCreating] = React.useState(false);

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
                <UnitRow
                  key={unit.id}
                  unit={unit}
                  isMine={unit.id === selfUnitId}
                  canManage={canManage}
                  onChanged={onChanged}
                  onSelectIncident={onSelectIncident}
                />
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
          <span
            className="rounded-[2px] border px-1 text-[9px] font-medium"
            style={{ borderColor: unit.organization.color, color: unit.organization.color }}
          >
            {unit.organization.shortName}
          </span>
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
            className="text-text-disabled transition-colors hover:text-danger disabled:opacity-50"
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
