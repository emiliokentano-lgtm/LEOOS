'use client';

import * as React from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import {
  Alert, Button, Checkbox, Field, Input, Modal, Select, Textarea,
} from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/auth-action-types';
import {
  addVehicleFlagAction, archiveVehicleAction, createVehicleAction,
  searchOwnersAction, updateVehicleAction,
} from '@/lib/record-actions';
import type { OrganizationOption, VehicleListItem } from '@/lib/vehicles';

/**
 * Vehicle dialogs.
 *
 * Fields are controlled so a refusal does not discard what was typed.
 *
 * The owner picker SEARCHES rather than listing: the person register is the
 * largest table in the system and must never be shipped to a dropdown.
 */

function useCloseOnSuccess(state: ActionState, onDone: () => void): void {
  React.useEffect(() => {
    if (state.status === 'success') onDone();
  }, [state.status, onDone]);
}

function DialogError({ state }: { state: ActionState }) {
  if (state.status !== 'error') return null;
  return (
    <Alert tone="danger" title="Could not save">
      {state.message}
      {state.requestId ? (
        <span className="mt-1 block font-mono text-2xs text-text-tertiary">
          Reference {state.requestId}
        </span>
      ) : null}
    </Alert>
  );
}

type OwnerKind = 'none' | 'person' | 'organization';

export function VehicleFormDialog({
  open, vehicle, organizations, actorOrganizationId, onClose, onSaved,
}: {
  open: boolean;
  vehicle?: VehicleListItem;
  organizations: OrganizationOption[];
  actorOrganizationId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const editing = Boolean(vehicle);
  const action = vehicle
    ? updateVehicleAction.bind(null, vehicle.id)
    : createVehicleAction;
  const [state, formAction, pending] = React.useActionState(action, IDLE);

  const [plate, setPlate] = React.useState(vehicle?.plate ?? '');
  const [model, setModel] = React.useState(vehicle?.model ?? '');
  const [displayName, setDisplayName] = React.useState(vehicle?.displayName ?? '');
  const [color, setColor] = React.useState(vehicle?.color ?? '');
  const [vehicleClass, setVehicleClass] = React.useState(vehicle?.vehicleClass ?? '');
  const [registration, setRegistration] = React.useState(vehicle?.registrationStatus ?? 'registered');
  const [insurance, setInsurance] = React.useState(vehicle?.insuranceStatus ?? 'uninsured');
  const [notes, setNotes] = React.useState('');

  const [ownerKind, setOwnerKind] = React.useState<OwnerKind>(
    vehicle?.ownerOrganizationId ? 'organization' : vehicle?.ownerPersonId ? 'person' : 'none',
  );
  const [ownerPersonId, setOwnerPersonId] = React.useState(vehicle?.ownerPersonId ?? '');
  const [ownerName, setOwnerName] = React.useState(vehicle?.ownerName ?? '');
  const [ownerOrganizationId, setOwnerOrganizationId] = React.useState(
    vehicle?.ownerOrganizationId ?? actorOrganizationId ?? '',
  );
  const [isFleet, setIsFleet] = React.useState(vehicle?.isFleet ?? false);

  useCloseOnSuccess(state, () => { onSaved?.(); onClose(); });

  /**
   * Only the actor's own organization is offered.
   *
   * The API refuses an assignment to anyone else's fleet, so listing them here
   * would be an invitation to a refusal. A global administrator's context has no
   * single organization, so they see the full list.
   */
  const assignable = actorOrganizationId
    ? organizations.filter((o) => o.id === actorOrganizationId
      || o.id === vehicle?.ownerOrganizationId)
    : organizations;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={editing ? `Edit ${vehicle!.plate}` : 'Register a vehicle'}
      description={editing ? undefined : 'A plate in the shared register.'}
      size="lg"
    >
      <form action={formAction} className="flex max-h-[70vh] flex-col gap-3 overflow-auto">
        <DialogError state={state} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Plate" htmlFor="veh-plate" required
            hint="Unique among live records. Case is not significant.">
            <Input id="veh-plate" name="plate" maxLength={12}
              value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder="e.g. 46EEK572" disabled={pending} className="font-mono" />
          </Field>
          <Field label="Model" htmlFor="veh-model" required hint="The game model name.">
            <Input id="veh-model" name="model" maxLength={60}
              value={model} onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. sultan" disabled={pending} />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Display name" htmlFor="veh-display">
            <Input id="veh-display" name="displayName" maxLength={80}
              value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              disabled={pending} />
          </Field>
          <Field label="Colour" htmlFor="veh-color">
            <Input id="veh-color" name="color" maxLength={40}
              value={color} onChange={(e) => setColor(e.target.value)} disabled={pending} />
          </Field>
          <Field label="Class" htmlFor="veh-class">
            <Input id="veh-class" name="vehicleClass" maxLength={40}
              value={vehicleClass} onChange={(e) => setVehicleClass(e.target.value)}
              disabled={pending} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Registration" htmlFor="veh-registration">
            <Select id="veh-registration" value={registration} onValueChange={setRegistration}
              options={[
                { value: 'registered', label: 'Registered' },
                { value: 'expired', label: 'Expired' },
                { value: 'unregistered', label: 'Unregistered' },
              ]} />
          </Field>
          <input type="hidden" name="registrationStatus" value={registration} />
          <Field label="Insurance" htmlFor="veh-insurance">
            <Select id="veh-insurance" value={insurance} onValueChange={setInsurance}
              options={[
                { value: 'insured', label: 'Insured' },
                { value: 'uninsured', label: 'Uninsured' },
                { value: 'expired', label: 'Expired' },
              ]} />
          </Field>
          <input type="hidden" name="insuranceStatus" value={insurance} />
        </div>

        <Field label="Registered owner" htmlFor="veh-owner-kind"
          hint="A vehicle has a person owner or an organization owner, never both.">
          <Select
            id="veh-owner-kind"
            value={ownerKind}
            onValueChange={(v) => setOwnerKind(v as OwnerKind)}
            options={[
              { value: 'none', label: 'No registered owner' },
              { value: 'person', label: 'A person' },
              { value: 'organization', label: 'An organization' },
            ]}
          />
        </Field>
        <input type="hidden" name="ownerKind" value={ownerKind} />

        {ownerKind === 'person' ? (
          <OwnerPicker
            selectedId={ownerPersonId}
            selectedName={ownerName}
            onSelect={(id, name) => { setOwnerPersonId(id); setOwnerName(name); }}
            disabled={pending}
          />
        ) : null}

        {ownerKind === 'organization' ? (
          <>
            <Field label="Organization" htmlFor="veh-org" required>
              <Select
                id="veh-org"
                value={ownerOrganizationId}
                onValueChange={setOwnerOrganizationId}
                placeholder="Choose an organization…"
                options={assignable.map((o) => ({ value: o.id, label: o.name }))}
              />
            </Field>
            <input type="hidden" name="ownerOrganizationId" value={ownerOrganizationId} />
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <Checkbox checked={isFleet} onCheckedChange={(v) => setIsFleet(v === true)}
                disabled={pending} aria-label="Fleet vehicle" />
              Operational fleet vehicle
            </label>
            <input type="hidden" name="isFleet" value={isFleet ? 'on' : ''} />
            {actorOrganizationId && assignable.length === 1 ? (
              <p className="text-2xs text-text-tertiary">
                Only your own organization is offered — the server refuses an assignment to
                anyone else&apos;s fleet.
              </p>
            ) : null}
          </>
        ) : null}

        <Field label="Notes" htmlFor="veh-notes">
          <Textarea id="veh-notes" name="notes" rows={2} maxLength={4000}
            value={notes} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" loading={pending}
            disabled={plate.trim() === '' || model.trim() === ''}>
            {editing ? 'Save changes' : 'Register vehicle'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Owner picker.
 *
 * Searches on demand rather than rendering the register as options: the person
 * table is the largest in the system, and a dropdown is not a reason to send it
 * to the browser (engineering rule 21).
 */
function OwnerPicker({
  selectedId, selectedName, onSelect, disabled,
}: {
  selectedId: string;
  selectedName: string;
  onSelect: (id: string, name: string) => void;
  disabled: boolean;
}) {
  const [term, setTerm] = React.useState('');
  const [results, setResults] = React.useState<{ id: string; name: string; dateOfBirth: string | null }[]>([]);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    if (term.trim().length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchOwnersAction(term)
        .then((rows) => { if (!cancelled) setResults(rows); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [term]);

  return (
    <div className="flex flex-col gap-2">
      <Field label="Owner" htmlFor="veh-owner-search" required
        hint="Type at least two letters to search the person register.">
        <Input
          id="veh-owner-search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by name…"
          disabled={disabled}
        />
      </Field>
      <input type="hidden" name="ownerPersonId" value={selectedId} />

      {selectedId ? (
        <p className="text-2xs text-text-secondary">
          Selected: <span className="text-text-primary">{selectedName}</span>
        </p>
      ) : null}

      {term.trim().length >= 2 ? (
        <ul className="max-h-40 overflow-auto rounded-md border border-border-subtle">
          {searching ? (
            <li className="flex items-center gap-2 px-2.5 py-2 text-2xs text-text-tertiary">
              <Search className="size-3" aria-hidden /> Searching…
            </li>
          ) : results.length === 0 ? (
            <li className="px-2.5 py-2 text-2xs text-text-tertiary">No match.</li>
          ) : (
            results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect(r.id, r.name)}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-hover ${
                    r.id === selectedId ? 'bg-hover text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  <span className="truncate">{r.name}</span>
                  {r.dateOfBirth ? (
                    <span className="shrink-0 font-mono text-2xs text-text-tertiary">
                      {r.dateOfBirth}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function AddVehicleFlagDialog({
  vehicleId, onClose, onSaved,
}: {
  vehicleId: string; onClose: () => void; onSaved: () => void;
}) {
  const action = addVehicleFlagAction.bind(null, vehicleId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [type, setType] = React.useState('');
  const [note, setNote] = React.useState('');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal open onOpenChange={(n) => { if (!n) onClose(); }} title="Flag this vehicle" size="md">
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} />
        <Alert tone="info" title="Any organization can flag any vehicle">
          Reporting another organization&apos;s vehicle as stolen or of interest is exactly what
          a shared register is for, so flagging is not restricted to the owner.
        </Alert>
        <Field label="Flag" htmlFor="vflag-type" required
          hint="e.g. stolen, of interest, impounded.">
          <Input id="vflag-type" name="type" maxLength={60}
            value={type} onChange={(e) => setType(e.target.value)} disabled={pending} />
        </Field>
        <Field label="Note" htmlFor="vflag-note">
          <Textarea id="vflag-note" name="note" rows={2} maxLength={500}
            value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" loading={pending}
            disabled={type.trim().length < 2}>
            Add flag
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ArchiveVehicleDialog({
  vehicle, onClose, onSaved,
}: {
  vehicle: VehicleListItem; onClose: () => void; onSaved: () => void;
}) {
  const action = archiveVehicleAction.bind(null, vehicle.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [reason, setReason] = React.useState('');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal open onOpenChange={(n) => { if (!n) onClose(); }}
      title={`Archive ${vehicle.plate}`} size="md">
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} />
        <Alert tone="warning" title="What archiving does">
          <ul className="ml-4 list-disc space-y-0.5">
            <li>The record is retained in full — <strong>nothing is deleted</strong>.</li>
            <li>Its flags and history stay attached.</li>
            <li>The plate becomes free to reissue to another vehicle.</li>
          </ul>
        </Alert>
        <Field label="Reason" htmlFor="varchive-reason" required
          hint="Written to the audit log and kept on the record.">
          <Input id="varchive-reason" name="reason" maxLength={280} minLength={3} required
            value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. scrapped after collision" disabled={pending} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" size="sm" loading={pending}
            disabled={reason.trim().length < 3}>
            <AlertTriangle aria-hidden /> Archive vehicle
          </Button>
        </div>
      </form>
    </Modal>
  );
}
