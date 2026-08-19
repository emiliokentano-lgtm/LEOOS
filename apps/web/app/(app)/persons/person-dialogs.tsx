'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/auth-action-types';
import {
  addAliasAction, addFlagAction, archivePersonAction, createPersonAction,
  issueWarrantAction, updateMedicalAction, updatePersonAction,
} from '@/lib/record-actions';
import type { PersonProfile } from '@/lib/persons';

/**
 * Person dialogs.
 *
 * Every field is CONTROLLED. A form action re-renders the form, so an
 * uncontrolled input resets to its default on a refusal — which is precisely the
 * moment the operator most needs what they typed to still be there.
 */

const STATUS_OPTIONS = [
  { value: 'alive', label: 'Alive' },
  { value: 'deceased', label: 'Deceased' },
  { value: 'missing', label: 'Missing' },
  { value: 'incarcerated', label: 'Incarcerated' },
];

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

function Footer({
  pending, onClose, label, disabled, danger,
}: {
  pending: boolean; onClose: () => void; label: string; disabled?: boolean; danger?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      <Button
        type="submit" size="sm" loading={pending} disabled={disabled}
        variant={danger ? 'danger' : 'primary'}
      >
        {danger ? <AlertTriangle aria-hidden /> : null} {label}
      </Button>
    </div>
  );
}

// ── Identity fields, shared by create and edit ─────────────────────────────

interface IdentityState {
  firstName: string; lastName: string; dateOfBirth: string; gender: string;
  phoneNumber: string; address: string; heightCm: string; weightKg: string;
  eyeColor: string; hairColor: string; notes: string; status: string;
}

function useIdentity(initial: Partial<IdentityState> = {}) {
  const [value, setValue] = React.useState<IdentityState>({
    firstName: initial.firstName ?? '',
    lastName: initial.lastName ?? '',
    dateOfBirth: initial.dateOfBirth ?? '',
    gender: initial.gender ?? '',
    phoneNumber: initial.phoneNumber ?? '',
    address: initial.address ?? '',
    heightCm: initial.heightCm ?? '',
    weightKg: initial.weightKg ?? '',
    eyeColor: initial.eyeColor ?? '',
    hairColor: initial.hairColor ?? '',
    notes: initial.notes ?? '',
    status: initial.status ?? 'alive',
  });
  const set = (key: keyof IdentityState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => setValue((prev) => ({ ...prev, [key]: e.target.value }));
  return { value, set, setValue };
}

function IdentityFields({
  id, state, set, setValue, pending,
}: {
  id: string;
  state: IdentityState;
  set: (key: keyof IdentityState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  setValue: React.Dispatch<React.SetStateAction<IdentityState>>;
  pending: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" htmlFor={`${id}-first`} required>
          <Input id={`${id}-first`} name="firstName" maxLength={80}
            value={state.firstName} onChange={set('firstName')} disabled={pending} />
        </Field>
        <Field label="Last name" htmlFor={`${id}-last`} required>
          <Input id={`${id}-last`} name="lastName" maxLength={80}
            value={state.lastName} onChange={set('lastName')} disabled={pending} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date of birth" htmlFor={`${id}-dob`} hint="YYYY-MM-DD">
          <Input id={`${id}-dob`} name="dateOfBirth" type="date"
            value={state.dateOfBirth} onChange={set('dateOfBirth')} disabled={pending} />
        </Field>
        <Field label="Status" htmlFor={`${id}-status`}>
          <Select
            id={`${id}-status`}
            value={state.status}
            onValueChange={(v) => setValue((prev) => ({ ...prev, status: v }))}
            options={STATUS_OPTIONS}
          />
        </Field>
        <input type="hidden" name="status" value={state.status} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone" htmlFor={`${id}-phone`}>
          <Input id={`${id}-phone`} name="phoneNumber" maxLength={32}
            value={state.phoneNumber} onChange={set('phoneNumber')} disabled={pending} />
        </Field>
        <Field label="Gender" htmlFor={`${id}-gender`}>
          <Input id={`${id}-gender`} name="gender" maxLength={40}
            value={state.gender} onChange={set('gender')} disabled={pending} />
        </Field>
      </div>

      <Field label="Address" htmlFor={`${id}-address`}>
        <Input id={`${id}-address`} name="address" maxLength={240}
          value={state.address} onChange={set('address')} disabled={pending} />
      </Field>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Height (cm)" htmlFor={`${id}-height`}>
          <Input id={`${id}-height`} name="heightCm" type="number" min={50} max={280}
            value={state.heightCm} onChange={set('heightCm')} disabled={pending} />
        </Field>
        <Field label="Weight (kg)" htmlFor={`${id}-weight`}>
          <Input id={`${id}-weight`} name="weightKg" type="number" min={20} max={400}
            value={state.weightKg} onChange={set('weightKg')} disabled={pending} />
        </Field>
        <Field label="Eyes" htmlFor={`${id}-eyes`}>
          <Input id={`${id}-eyes`} name="eyeColor" maxLength={40}
            value={state.eyeColor} onChange={set('eyeColor')} disabled={pending} />
        </Field>
        <Field label="Hair" htmlFor={`${id}-hair`}>
          <Input id={`${id}-hair`} name="hairColor" maxLength={40}
            value={state.hairColor} onChange={set('hairColor')} disabled={pending} />
        </Field>
      </div>

      <Field label="Notes" htmlFor={`${id}-notes`}>
        <Textarea id={`${id}-notes`} name="notes" rows={3} maxLength={4000}
          value={state.notes} onChange={set('notes')} disabled={pending} />
      </Field>
    </>
  );
}

// ── Create ─────────────────────────────────────────────────────────────────

export function CreatePersonDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = React.useActionState(createPersonAction, IDLE);
  const identity = useIdentity();
  useCloseOnSuccess(state, onClose);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="New person record"
      description="A citizen record, shared across every organization."
      size="lg"
    >
      <form action={formAction} className="flex max-h-[70vh] flex-col gap-3 overflow-auto">
        <DialogError state={state} />
        <IdentityFields id="new-person" state={identity.value} set={identity.set}
          setValue={identity.setValue} pending={pending} />
        <Footer pending={pending} onClose={onClose} label="Create record"
          disabled={identity.value.firstName.trim() === '' || identity.value.lastName.trim() === ''} />
      </form>
    </Modal>
  );
}

// ── Edit ───────────────────────────────────────────────────────────────────

export function EditPersonDialog({
  profile, onClose, onSaved,
}: {
  profile: PersonProfile; onClose: () => void; onSaved: () => void;
}) {
  const action = updatePersonAction.bind(null, profile.person.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const p = profile.person;
  const identity = useIdentity({
    firstName: p.firstName, lastName: p.lastName,
    dateOfBirth: p.dateOfBirth ?? '', gender: p.gender ?? '',
    phoneNumber: p.phoneNumber ?? '', address: p.address ?? '',
    heightCm: p.heightCm ? String(p.heightCm) : '',
    weightKg: p.weightKg ? String(p.weightKg) : '',
    eyeColor: p.eyeColor ?? '', hairColor: p.hairColor ?? '',
    notes: p.notes ?? '', status: p.status,
  });

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`Edit ${p.firstName} ${p.lastName}`}
      size="lg"
    >
      <form action={formAction} className="flex max-h-[70vh] flex-col gap-3 overflow-auto">
        <DialogError state={state} />
        <IdentityFields id="edit-person" state={identity.value} set={identity.set}
          setValue={identity.setValue} pending={pending} />
        <Footer pending={pending} onClose={onClose} label="Save changes" />
      </form>
    </Modal>
  );
}

// ── Alias ──────────────────────────────────────────────────────────────────

export function AddAliasDialog({
  personId, onClose, onSaved,
}: {
  personId: string; onClose: () => void; onSaved: () => void;
}) {
  const action = addAliasAction.bind(null, personId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [alias, setAlias] = React.useState('');
  const [note, setNote] = React.useState('');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal open onOpenChange={(n) => { if (!n) onClose(); }} title="Add an alias" size="md">
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} />
        <Field label="Alias" htmlFor="alias-value" required
          hint="Searched alongside the legal name.">
          <Input id="alias-value" name="alias" maxLength={80}
            value={alias} onChange={(e) => setAlias(e.target.value)} disabled={pending} />
        </Field>
        <Field label="Note" htmlFor="alias-note">
          <Input id="alias-note" name="note" maxLength={240}
            value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} />
        </Field>
        <Footer pending={pending} onClose={onClose} label="Add alias"
          disabled={alias.trim() === ''} />
      </form>
    </Modal>
  );
}

// ── Flag ───────────────────────────────────────────────────────────────────

export function AddFlagDialog({
  personId, onClose, onSaved,
}: {
  personId: string; onClose: () => void; onSaved: () => void;
}) {
  const action = addFlagAction.bind(null, personId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [type, setType] = React.useState('');
  const [severity, setSeverity] = React.useState('caution');
  const [note, setNote] = React.useState('');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal open onOpenChange={(n) => { if (!n) onClose(); }} title="Add a flag" size="md">
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} />
        <Field label="Flag" htmlFor="flag-type" required
          hint="e.g. armed and dangerous, known to flee, mental health caution.">
          <Input id="flag-type" name="type" maxLength={60}
            value={type} onChange={(e) => setType(e.target.value)} disabled={pending} />
        </Field>
        <Field label="Severity" htmlFor="flag-severity" required>
          <Select
            id="flag-severity" value={severity} onValueChange={setSeverity}
            options={[
              { value: 'info', label: 'Information' },
              { value: 'caution', label: 'Caution' },
              { value: 'critical', label: 'Critical — shown as a banner' },
            ]}
          />
        </Field>
        <input type="hidden" name="severity" value={severity} />
        <Field label="Note" htmlFor="flag-note">
          <Textarea id="flag-note" name="note" rows={2} maxLength={500}
            value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} />
        </Field>
        <Footer pending={pending} onClose={onClose} label="Add flag"
          disabled={type.trim().length < 2} />
      </form>
    </Modal>
  );
}

// ── Warrant ────────────────────────────────────────────────────────────────

export function IssueWarrantDialog({
  personId, onClose, onSaved,
}: {
  personId: string; onClose: () => void; onSaved: () => void;
}) {
  const action = issueWarrantAction.bind(null, personId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [type, setType] = React.useState('arrest');
  const [reason, setReason] = React.useState('');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal open onOpenChange={(n) => { if (!n) onClose(); }} title="Issue a warrant" size="md">
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} />
        <Alert tone="info" title="Filed under your organization">
          The warrant is recorded against the organization you are signed in to. Only that
          organization can revoke it later — any organization can mark it served.
        </Alert>
        <Field label="Type" htmlFor="warrant-type" required>
          <Select
            id="warrant-type" value={type} onValueChange={setType}
            options={[
              { value: 'arrest', label: 'Arrest' },
              { value: 'search', label: 'Search' },
              { value: 'bench', label: 'Bench' },
            ]}
          />
        </Field>
        <input type="hidden" name="type" value={type} />
        <Field label="Grounds" htmlFor="warrant-reason" required
          hint="Written to the audit log and shown on the record.">
          <Textarea id="warrant-reason" name="reason" rows={3} maxLength={500}
            value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} />
        </Field>
        <Footer pending={pending} onClose={onClose} label="Issue warrant"
          disabled={reason.trim().length < 3} />
      </form>
    </Modal>
  );
}

// ── Medical ────────────────────────────────────────────────────────────────

export function EditMedicalDialog({
  profile, onClose, onSaved,
}: {
  profile: PersonProfile; onClose: () => void; onSaved: () => void;
}) {
  const action = updateMedicalAction.bind(null, profile.person.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const m = profile.medical ?? null;

  const [bloodType, setBloodType] = React.useState(m?.bloodType ?? '');
  const [allergies, setAllergies] = React.useState((m?.allergies ?? []).join(', '));
  const [conditions, setConditions] = React.useState((m?.conditions ?? []).join(', '));
  const [medications, setMedications] = React.useState((m?.medications ?? []).join(', '));
  const [emergencyContact, setEmergencyContact] = React.useState(m?.emergencyContact ?? '');
  const [notes, setNotes] = React.useState(m?.notes ?? '');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  return (
    <Modal open onOpenChange={(n) => { if (!n) onClose(); }} title="Medical record" size="md">
      <form action={formAction} className="flex max-h-[70vh] flex-col gap-3 overflow-auto">
        <DialogError state={state} />
        <Alert tone="warning" title="This change is recorded">
          The audit log records that you changed this record and which fields — never their
          contents, which would put the record back where the permission was meant to keep it.
        </Alert>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Blood type" htmlFor="med-blood">
            <Input id="med-blood" name="bloodType" maxLength={8}
              value={bloodType} onChange={(e) => setBloodType(e.target.value)} disabled={pending} />
          </Field>
          <Field label="Emergency contact" htmlFor="med-contact">
            <Input id="med-contact" name="emergencyContact" maxLength={160}
              value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)}
              disabled={pending} />
          </Field>
        </div>

        <Field label="Allergies" htmlFor="med-allergies" hint="Comma separated.">
          <Input id="med-allergies" name="allergies"
            value={allergies} onChange={(e) => setAllergies(e.target.value)} disabled={pending} />
        </Field>
        <Field label="Conditions" htmlFor="med-conditions" hint="Comma separated.">
          <Input id="med-conditions" name="conditions"
            value={conditions} onChange={(e) => setConditions(e.target.value)} disabled={pending} />
        </Field>
        <Field label="Medications" htmlFor="med-medications" hint="Comma separated.">
          <Input id="med-medications" name="medications"
            value={medications} onChange={(e) => setMedications(e.target.value)} disabled={pending} />
        </Field>
        <Field label="Notes" htmlFor="med-notes">
          <Textarea id="med-notes" name="notes" rows={3} maxLength={4000}
            value={notes} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
        </Field>

        <Footer pending={pending} onClose={onClose} label="Save medical record" />
      </form>
    </Modal>
  );
}

// ── Archive ────────────────────────────────────────────────────────────────

export function ArchivePersonDialog({
  profile, onClose, onSaved,
}: {
  profile: PersonProfile; onClose: () => void; onSaved: () => void;
}) {
  const action = archivePersonAction.bind(null, profile.person.id);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [reason, setReason] = React.useState('');

  useCloseOnSuccess(state, () => { onSaved(); onClose(); });

  const openWarrants = profile.warrants.filter((w) => w.status === 'active').length;

  return (
    <Modal
      open
      onOpenChange={(n) => { if (!n) onClose(); }}
      title={`Archive ${profile.person.firstName} ${profile.person.lastName}`}
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} />

        <Alert tone="warning" title="What archiving does">
          <ul className="ml-4 list-disc space-y-0.5">
            <li>The record is retained in full — <strong>nothing is deleted</strong>.</li>
            <li>Aliases, flags, warrants, charges and vehicles all stay attached.</li>
            <li>It disappears from ordinary lookup and needs a separate permission to see.</li>
          </ul>
        </Alert>

        {openWarrants > 0 ? (
          <Alert tone="danger" title="Active warrants">
            This person has {openWarrants} active warrant(s). Archiving would take them off every
            wanted list without anyone revoking it, so the server will refuse — resolve them first.
          </Alert>
        ) : null}

        <Field label="Reason" htmlFor="archive-person-reason" required
          hint="Written to the audit log and kept on the record.">
          <Input id="archive-person-reason" name="reason" maxLength={280} minLength={3} required
            value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. duplicate of an existing record" disabled={pending} />
        </Field>

        <Footer pending={pending} onClose={onClose} label="Archive record" danger
          disabled={reason.trim().length < 3 || openWarrants > 0} />
      </form>
    </Modal>
  );
}
