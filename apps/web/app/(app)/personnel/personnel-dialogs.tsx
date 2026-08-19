'use client';

import * as React from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import {
  Alert, Badge, Button, Field, Input, Modal, Select, Textarea,
} from '@/components/ui';
import { IDLE, type ActionState } from '@/lib/auth-action-types';
import {
  assignRoleAction, changeRankAction, editMemberAction, hireMemberAction,
  terminateMemberAction,
} from '@/lib/personnel-actions';
import type {
  AssignableRole, HireCandidate, PersonnelCapabilities, PersonnelListItem,
} from '@/lib/personnel';

/**
 * Personnel dialogs.
 *
 * Each one binds its organization id and member id at RENDER time, from data the
 * server already fetched. The browser submits a role choice, a callsign or a
 * reason — never an id that decides who is affected or in which organization
 * (engineering rule 12).
 *
 * Roles above the operator's own level are shown DISABLED rather than hidden.
 * Hiding them would leave an operator wondering why a rank they can see on the
 * roster is missing from the picker; disabling them, with the reason, teaches
 * the rule. Either way the server decides.
 */

type ActorLevel = number | 'unbounded';

/** H2: strictly below the actor. An unbounded actor — lead or admin — has no ceiling. */
function assignable(role: AssignableRole, actorLevel: ActorLevel): boolean {
  return actorLevel === 'unbounded' || actorLevel > role.hierarchyLevel;
}

function roleOptions(roles: AssignableRole[], actorLevel: ActorLevel, exclude: string[] = []) {
  return roles
    .filter((role) => !exclude.includes(role.id))
    .map((role) => ({
      value: role.id,
      label: `${role.name} · L${role.hierarchyLevel}`,
      disabled: !assignable(role, actorLevel),
    }));
}

function useCloseOnSuccess(state: ActionState, onClose: () => void): void {
  React.useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state.status, onClose]);
}

function DialogError({ state, title }: { state: ActionState; title: string }) {
  if (state.status !== 'error') return null;
  return (
    <Alert tone="danger" title={title}>
      {state.message}
      {state.requestId ? (
        <span className="mt-1 block font-mono text-2xs text-text-tertiary">
          Reference {state.requestId}
        </span>
      ) : null}
    </Alert>
  );
}

function CeilingNote({ actorLevel }: { actorLevel: ActorLevel }) {
  if (actorLevel === 'unbounded') {
    return (
      <p className="text-2xs text-text-tertiary">
        You have no rank ceiling in this organization.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 text-2xs text-text-tertiary">
      <Lock className="size-3" aria-hidden />
      Ranks at or above your own (L{actorLevel}) are unavailable — you cannot place
      anyone level with yourself or above.
    </p>
  );
}

// ── Hire ───────────────────────────────────────────────────────────────────

export function HireDialog({
  open, onClose, organizationId, organizationName, candidates, roles, actorLevel,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  organizationName: string;
  candidates: HireCandidate[];
  roles: AssignableRole[];
  actorLevel: ActorLevel;
}) {
  const action = hireMemberAction.bind(null, organizationId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [userId, setUserId] = React.useState('');
  const [roleId, setRoleId] = React.useState('');
  /**
   * Controlled, not `defaultValue`.
   *
   * A form action re-renders the form, and an uncontrolled input resets to its
   * default — so a refusal (a callsign already in use, say) would silently erase
   * everything the operator typed and make them start again. The refusal is
   * exactly the moment the input matters most.
   */
  const [callsign, setCallsign] = React.useState('');
  const [employeeNumber, setEmployeeNumber] = React.useState('');
  const [notes, setNotes] = React.useState('');

  useCloseOnSuccess(state, onClose);

  const options = roleOptions(roles, actorLevel);
  const noneAssignable = options.every((option) => option.disabled);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`Hire into ${organizationName}`}
      description="The new member starts with exactly the rank you choose."
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} title="Could not hire" />

        {candidates.length === 0 ? (
          <Alert tone="warning" title="Nobody available to hire">
            Everyone with an account is already an active member here. A new person has to
            register first.
          </Alert>
        ) : noneAssignable ? (
          <Alert tone="warning" title="No rank is available to you">
            Every rank in this organization is at or above your own, so there is nothing you
            could hire someone into.
          </Alert>
        ) : (
          <>
            <Field label="Person" htmlFor="hire-user" required
              hint="Accounts without an active membership here.">
              <Select
                id="hire-user"
                value={userId}
                onValueChange={setUserId}
                placeholder="Choose a person…"
                options={candidates.map((c) => ({
                  value: c.userId,
                  label: `${c.displayName} · ${c.username}`,
                }))}
              />
            </Field>
            <input type="hidden" name="userId" value={userId} />

            <Field label="Starting rank" htmlFor="hire-role" required>
              <Select
                id="hire-role"
                value={roleId}
                onValueChange={setRoleId}
                placeholder="Choose a rank…"
                options={options}
              />
            </Field>
            <input type="hidden" name="roleId" value={roleId} />
            <CeilingNote actorLevel={actorLevel} />

            <div className="grid grid-cols-2 gap-3">
              <Field label="Callsign" htmlFor="hire-callsign"
                hint="Unique among active members.">
                <Input id="hire-callsign" name="callsign" maxLength={16}
                  value={callsign} onChange={(e) => setCallsign(e.target.value)}
                  placeholder="e.g. 1-ADAM-12" disabled={pending} />
              </Field>
              <Field label="Employee number" htmlFor="hire-number">
                <Input id="hire-number" name="employeeNumber" maxLength={24}
                  value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)}
                  placeholder="e.g. 4417" disabled={pending} />
              </Field>
            </div>

            <Field label="Notes" htmlFor="hire-notes"
              hint="Visible to anyone who can read this person's record.">
              <Textarea id="hire-notes" name="notes" rows={2} maxLength={2000}
                value={notes} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
            </Field>

            <p className="text-2xs text-text-tertiary">
              Re-hiring someone who was terminated here reuses their original record, so their
              employment history stays continuous. Their previous roles are not restored.
            </p>

            <Footer
              pending={pending}
              onClose={onClose}
              submitLabel="Hire"
              disabled={!userId || !roleId}
            />
          </>
        )}
      </form>
    </Modal>
  );
}

// ── Change rank ────────────────────────────────────────────────────────────

export function ChangeRankDialog({
  member, organizationId, roles, actorLevel, onClose,
}: {
  member: PersonnelListItem;
  organizationId: string;
  roles: AssignableRole[];
  actorLevel: ActorLevel;
  onClose: () => void;
}) {
  const action = changeRankAction.bind(null, organizationId, member.memberId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [roleId, setRoleId] = React.useState('');
  const [reason, setReason] = React.useState('');

  useCloseOnSuccess(state, onClose);

  const options = roleOptions(roles, actorLevel);
  const chosen = roles.find((role) => role.id === roleId);
  const direction = chosen
    ? chosen.hierarchyLevel >= member.hierarchyLevel ? 'promotion' : 'demotion'
    : null;

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`Change ${member.displayName}'s rank`}
      description={`Currently ${member.rankName ?? 'unranked'} (L${member.hierarchyLevel}).`}
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} title="Could not change rank" />

        <Field label="New rank" htmlFor="rank-role" required
          hint="This replaces every role the member currently holds.">
          <Select
            id="rank-role"
            value={roleId}
            onValueChange={setRoleId}
            placeholder="Choose a rank…"
            options={options}
          />
        </Field>
        <input type="hidden" name="roleId" value={roleId} />
        <CeilingNote actorLevel={actorLevel} />

        {direction ? (
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            Recorded as a <Badge size="sm" variant={direction === 'promotion' ? 'success' : 'warning'}>
              {direction}
            </Badge>
            <span className="font-mono text-2xs text-text-tertiary">
              L{member.hierarchyLevel} → L{chosen!.hierarchyLevel}
            </span>
          </p>
        ) : null}

        <Field label="Reason" htmlFor="rank-reason"
          hint="Written to the audit log alongside who made the change.">
          <Input id="rank-reason" name="reason" maxLength={280}
            value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. completed field training" disabled={pending} />
        </Field>

        <Footer pending={pending} onClose={onClose} submitLabel="Change rank" disabled={!roleId} />
      </form>
    </Modal>
  );
}

// ── Assign an individual role ──────────────────────────────────────────────

export function AssignRoleDialog({
  member, organizationId, roles, actorLevel, onClose,
}: {
  member: PersonnelListItem;
  organizationId: string;
  roles: AssignableRole[];
  actorLevel: ActorLevel;
  onClose: () => void;
}) {
  const action = assignRoleAction.bind(null, organizationId, member.memberId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [roleId, setRoleId] = React.useState('');

  useCloseOnSuccess(state, onClose);

  const held = member.roles.map((role) => role.id);
  const options = roleOptions(roles, actorLevel, held);

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`Assign a role to ${member.displayName}`}
      description="Added alongside their existing roles, not instead of them."
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} title="Could not assign the role" />

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs uppercase tracking-wide text-text-tertiary">Currently holds</span>
          {member.roles.map((role) => (
            <Badge key={role.id} size="sm" variant="outline">
              {role.name} <span className="font-mono text-text-tertiary">L{role.hierarchyLevel}</span>
            </Badge>
          ))}
        </div>

        {options.length === 0 ? (
          <Alert tone="warning" title="No further role to assign">
            This member already holds every role you are able to grant.
          </Alert>
        ) : (
          <>
            <Field label="Role" htmlFor="assign-role" required>
              <Select
                id="assign-role"
                value={roleId}
                onValueChange={setRoleId}
                placeholder="Choose a role…"
                options={options}
              />
            </Field>
            <input type="hidden" name="roleId" value={roleId} />
            <CeilingNote actorLevel={actorLevel} />

            <Alert tone="info" title="Effective rank is the highest role held">
              Holding several roles never adds their levels together. It does combine their
              permissions — and the server refuses a role carrying any permission you do not
              hold yourself.
            </Alert>

            <Footer pending={pending} onClose={onClose} submitLabel="Assign role" disabled={!roleId} />
          </>
        )}
      </form>
    </Modal>
  );
}

// ── Edit details ───────────────────────────────────────────────────────────

export function EditMemberDialog({
  member, organizationId, capabilities, onClose,
}: {
  member: PersonnelListItem;
  organizationId: string;
  capabilities: PersonnelCapabilities;
  onClose: () => void;
}) {
  const action = editMemberAction.bind(null, organizationId, member.memberId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [status, setStatus] = React.useState(member.status);
  // Controlled for the same reason as the hire form: a refused save must not
  // discard what the operator typed.
  const [callsign, setCallsign] = React.useState(member.callsign ?? '');
  const [employeeNumber, setEmployeeNumber] = React.useState(member.employeeNumber ?? '');
  const [notes, setNotes] = React.useState('');

  useCloseOnSuccess(state, onClose);

  // `personnel.callsign` alone permits a callsign change and nothing else, so a
  // supervisor who holds only that gets a callsign-only form rather than a form
  // whose other fields would be refused.
  const callsignOnly = !capabilities.canEdit && capabilities.canSetCallsign;

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={callsignOnly ? `Set ${member.displayName}'s callsign` : `Edit ${member.displayName}`}
      description={`${member.rankName ?? 'Unranked'} · L${member.hierarchyLevel}`}
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} title="Could not save" />

        <Field label="Callsign" htmlFor="edit-callsign"
          hint="Unique among active members. Leave empty to clear it.">
          <Input id="edit-callsign" name="callsign" maxLength={16}
            value={callsign} onChange={(e) => setCallsign(e.target.value)} disabled={pending} />
        </Field>

        {callsignOnly ? (
          <p className="text-2xs text-text-tertiary">
            Editing the rest of this record requires the “Edit personnel records” permission.
          </p>
        ) : (
          <>
            <Field label="Employee number" htmlFor="edit-number"
              hint="Unique among active members.">
              <Input id="edit-number" name="employeeNumber" maxLength={24}
                value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)}
                disabled={pending} />
            </Field>

            <Field label="Membership status" htmlFor="edit-status"
              hint="Suspending a member revokes their operational access immediately.">
              <Select
                id="edit-status"
                value={status}
                onValueChange={setStatus}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'on_leave', label: 'On leave' },
                  { value: 'suspended', label: 'Suspended' },
                ]}
              />
            </Field>
            <input type="hidden" name="status" value={status} />

            <Field label="Notes" htmlFor="edit-notes">
              <Textarea id="edit-notes" name="notes" rows={3} maxLength={2000}
                value={notes} onChange={(e) => setNotes(e.target.value)} disabled={pending} />
            </Field>

            <p className="text-2xs text-text-tertiary">
              To end someone&apos;s employment, use Terminate — it preserves the record. There is
              no delete.
            </p>
          </>
        )}

        <Footer pending={pending} onClose={onClose} submitLabel="Save changes" />
      </form>
    </Modal>
  );
}

// ── Terminate ──────────────────────────────────────────────────────────────

export function TerminateDialog({
  member, organizationId, organizationName, onClose,
}: {
  member: PersonnelListItem;
  organizationId: string;
  organizationName: string;
  onClose: () => void;
}) {
  const action = terminateMemberAction.bind(null, organizationId, member.memberId);
  const [state, formAction, pending] = React.useActionState(action, IDLE);
  const [confirmation, setConfirmation] = React.useState('');
  const [reason, setReason] = React.useState('');

  useCloseOnSuccess(state, onClose);

  // Deliberate friction, not decoration: the operator types the name of the
  // person they are about to remove from operational duty.
  const phrase = member.displayName;
  const confirmed = confirmation.trim() === phrase;

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`Terminate ${member.displayName}`}
      description={`${member.rankName ?? 'Unranked'} · L${member.hierarchyLevel} · ${organizationName}`}
      size="md"
    >
      <form action={formAction} className="flex flex-col gap-3">
        <DialogError state={state} title="Could not terminate" />

        <Alert tone="warning" title="What termination does">
          <ul className="ml-4 list-disc space-y-0.5">
            <li>Their membership becomes <strong>terminated</strong> — nothing is deleted.</li>
            <li>Employment history, previous roles, callsign and audit trail are kept.</li>
            <li>They are removed from any unit and go off duty.</li>
            <li>Their sessions end immediately; access stops now, not at expiry.</li>
          </ul>
        </Alert>

        <Field label="Reason" htmlFor="terminate-reason" required
          hint="Written to the audit log and shown on the retained record.">
          <Input id="terminate-reason" name="reason" maxLength={280} minLength={3} required
            value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. resigned, effective today" disabled={pending} />
        </Field>

        <Field label={`Type “${phrase}” to confirm`} htmlFor="terminate-confirm" required>
          <Input
            id="terminate-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={pending}
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" size="sm" loading={pending} disabled={!confirmed}>
            <AlertTriangle aria-hidden /> Terminate membership
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Footer({
  pending, onClose, submitLabel, disabled,
}: {
  pending: boolean;
  onClose: () => void;
  submitLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      <Button type="submit" variant="primary" size="sm" loading={pending} disabled={disabled}>
        {submitLabel}
      </Button>
    </div>
  );
}
