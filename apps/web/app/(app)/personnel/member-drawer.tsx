'use client';

import * as React from 'react';
import {
  Building2, Car, IdCard, Mail, NotebookPen, Radio, ShieldCheck, UserMinus,
} from 'lucide-react';
import {
  PERMISSION_KEYS, permissionMeta, type DutyStatusKey, type PermissionKey,
} from '@leoos/contracts';
import {
  Alert, Badge, Button, Drawer, DutyStatusBadge, Field, Input, LoadingState, Select, Tooltip,
  useToast,
} from '@/components/ui';
import { formatDateTime, timeAgo } from '@/lib/utils';
import { clearOverrideAction, setOverrideAction } from '@/lib/personnel-actions';
import type {
  PersonnelCapabilities, PersonnelListItem, PersonnelOverride, PersonnelProfile,
} from '@/lib/personnel';
import type { PersonnelDialog } from './personnel-view';

/**
 * A member's full record.
 *
 * Fetched on open rather than shipped with the roster: the profile carries an
 * email address and an activity trail, and forty of those in the list payload
 * would be forty records the operator never asked to see.
 *
 * The activity list is the AUDIT TRAIL, read from `audit_log`, so it cannot
 * disagree with what was actually recorded — including refused attempts.
 */
export function MemberDrawer({
  organizationId, memberId, onClose, capabilities, onAction,
}: {
  organizationId: string;
  memberId: string | null;
  onClose: () => void;
  capabilities: PersonnelCapabilities;
  onAction: (dialog: PersonnelDialog) => void;
}) {
  /**
   * One state slot, tagged with the member it belongs to.
   *
   * Resetting on close in the effect body would be a synchronous setState
   * inside an effect — a cascading render, and a lint error. Tagging the loaded
   * record with its member id makes "which member is this for" derivable
   * instead: a result for a member other than the open one is simply stale, so
   * the loading and reset cases fall out of the comparison and the only
   * setState left is the one in the fetch callback.
   */
  const [loaded, setLoaded] = React.useState<
    { memberId: string; profile: PersonnelProfile | null } | null
  >(null);

  /**
   * Bumped by anything that changes the record from inside the drawer, so the
   * profile is re-read rather than patched locally. The server is the only
   * thing that knows what the change actually produced — a refused override
   * leaves the list exactly as it was, and a local patch would show it applied.
   */
  const [revision, setRevision] = React.useState(0);
  const reload = React.useCallback(() => { setRevision((n) => n + 1); }, []);

  React.useEffect(() => {
    if (!memberId) return;

    let cancelled = false;
    fetch(`/api/personnel/${organizationId}/${memberId}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { member: PersonnelProfile }) => {
        if (!cancelled) setLoaded({ memberId, profile: body.member });
      })
      .catch(() => { if (!cancelled) setLoaded({ memberId, profile: null }); });

    return () => { cancelled = true; };
  }, [organizationId, memberId, revision]);

  const current = memberId && loaded?.memberId === memberId ? loaded : null;
  const profile = current?.profile ?? null;
  const state: 'idle' | 'loading' | 'error' =
    !memberId ? 'idle' : !current ? 'loading' : current.profile ? 'idle' : 'error';

  const open = memberId !== null;

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={profile?.displayName ?? 'Personnel record'}
      description={profile ? `${profile.rankName ?? 'No rank'} · ${profile.organizationName}` : undefined}
      width="lg"
      footer={profile ? (
        <DrawerActions member={profile} capabilities={capabilities} onAction={onAction} />
      ) : undefined}
    >
      {state === 'loading' ? <LoadingState label="Loading personnel record…" /> : null}

      {state === 'error' ? (
        <Alert tone="danger" title="Could not load this record">
          The record may have been changed or may no longer be visible to you. Close the panel
          and refresh the roster.
        </Alert>
      ) : null}

      {profile ? (
        <ProfileBody
          profile={profile}
          organizationId={organizationId}
          capabilities={capabilities}
          onChanged={reload}
        />
      ) : null}
    </Drawer>
  );
}

function ProfileBody({
  profile, organizationId, capabilities, onChanged,
}: {
  profile: PersonnelProfile;
  organizationId: string;
  capabilities: PersonnelCapabilities;
  onChanged: () => void;
}) {
  const terminated = profile.status === 'terminated';

  return (
    <div className="flex flex-col gap-4">
      {terminated ? (
        <Alert tone="warning" title="This membership is terminated">
          The record is retained in full — roles, callsign, join date and audit trail.
          {profile.leftAt ? ` Left ${formatDateTime(profile.leftAt)}.` : null}
          {profile.terminatedByName ? ` Terminated by ${profile.terminatedByName}.` : null}
          {profile.terminationReason ? ` Reason: ${profile.terminationReason}` : null}
        </Alert>
      ) : null}

      {profile.isOrgLead ? (
        <Alert tone="info" title="Organization Lead">
          Full authority inside {profile.organizationName}, and nowhere else. Only a global
          administrator can grant or revoke this.
        </Alert>
      ) : null}

      <section className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact icon={<Building2 />} label="Organization" value={profile.organizationName} />
        <Fact
          icon={<ShieldCheck />}
          label="Rank"
          value={
            <span className="flex items-center gap-1.5">
              {profile.rankName ?? '—'}
              <Badge size="sm" variant="outline" mono>L{profile.hierarchyLevel}</Badge>
            </span>
          }
        />
        <Fact icon={<Radio />} label="Callsign" value={profile.callsign ?? '—'} mono />
        <Fact icon={<IdCard />} label="Employee number" value={profile.employeeNumber ?? '—'} mono />
        <Fact icon={<Mail />} label="Account" value={profile.email} mono />
        <Fact
          icon={<IdCard />}
          label="Joined"
          value={`${formatDateTime(profile.joinedAt)}${profile.hiredByName ? ` · by ${profile.hiredByName}` : ''}`}
        />
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Current assignment</SectionTitle>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact
            icon={<Radio />}
            label="Duty status"
            value={
              terminated
                ? <span className="text-text-disabled">—</span>
                : <DutyStatusBadge status={(profile.dutyStatus ?? 'off_duty') as DutyStatusKey} size="sm" />
            }
          />
          <Fact icon={<Radio />} label="Unit" value={profile.unitCallsign ?? 'Not assigned'} mono />
          <Fact
            icon={<Car />}
            label="Vehicle"
            value={profile.currentVehicle
              ? `${profile.currentVehicle.plate}${profile.currentVehicle.displayName ? ` · ${profile.currentVehicle.displayName}` : ''}`
              : 'None'}
            mono
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Roles</SectionTitle>
        {profile.roles.length === 0 ? (
          <p className="text-xs text-text-tertiary">No roles held.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {profile.roles.map((role) => (
              <li key={role.id}>
                <Badge variant="outline" className="gap-1">
                  {role.name}
                  <span className="font-mono text-text-tertiary">L{role.hierarchyLevel}</span>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {profile.roles.length > 1 ? (
          <p className="text-2xs text-text-tertiary">
            Effective rank is the HIGHEST level held — L{profile.hierarchyLevel} — never the sum.
          </p>
        ) : null}
      </section>

      {profile.notes ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Notes</SectionTitle>
          <p className="flex gap-2 whitespace-pre-wrap rounded-md border border-border-subtle bg-surface-raised p-2.5 text-xs text-text-secondary">
            <NotebookPen className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
            {profile.notes}
          </p>
        </section>
      ) : null}

      <OverridesSection
        organizationId={organizationId}
        memberId={profile.memberId}
        overrides={profile.overrides}
        capabilities={capabilities}
        isSelf={capabilities.actorUserId === profile.userId}
        onChanged={onChanged}
      />

      <section className="flex flex-col gap-2">
        <SectionTitle>Activity</SectionTitle>
        <p className="text-2xs text-text-tertiary">
          Read from the audit log, refused attempts included.
        </p>
        {profile.activity.length === 0 ? (
          <p className="text-xs text-text-tertiary">Nothing recorded yet.</p>
        ) : (
          <ol className="flex flex-col">
            {profile.activity.map((entry, index) => (
              <li
                key={`${entry.at}-${index}`}
                className="flex items-baseline gap-2 border-b border-border-subtle py-1.5 last:border-b-0"
              >
                {/* Both ends are shrink-0 so a long reason wraps in the middle
                    rather than shoving the timestamp past the drawer edge. */}
                <Badge
                  size="sm"
                  className="shrink-0"
                  variant={entry.outcome === 'denied' ? 'danger' : 'neutral'}
                >
                  {entry.outcome === 'denied' ? 'Refused' : 'Done'}
                </Badge>
                <span className="min-w-0 flex-1 break-words">
                  <span className="text-xs text-text-primary">{humanizeAction(entry.action)}</span>
                  {entry.summary ? (
                    <span className="ml-1.5 text-2xs text-text-tertiary">{entry.summary}</span>
                  ) : null}
                  {entry.actorName ? (
                    <span className="ml-1.5 text-2xs text-text-tertiary">by {entry.actorName}</span>
                  ) : null}
                </span>
                <Tooltip content={formatDateTime(entry.at)}>
                  <span className="shrink-0 font-mono text-2xs text-text-disabled">
                    {timeAgo(entry.at)}
                  </span>
                </Tooltip>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function DrawerActions({
  member, capabilities, onAction,
}: {
  member: PersonnelProfile;
  capabilities: PersonnelCapabilities;
  onAction: (dialog: PersonnelDialog) => void;
}) {
  if (!member.manageable) {
    return (
      <p className="text-2xs text-text-tertiary">
        {member.userId === capabilities.actorUserId
          ? 'You cannot manage your own membership.'
          : `Managing this record requires a rank above L${member.hierarchyLevel}.`}
      </p>
    );
  }

  // The drawer holds the full profile; the dialogs take the list shape, which
  // the profile extends.
  const asListItem = member as PersonnelListItem;
  const terminated = member.status === 'terminated';

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {(capabilities.canEdit || capabilities.canSetCallsign) ? (
        <Button variant="secondary" size="sm" onClick={() => onAction({ kind: 'edit', member: asListItem })}>
          Edit details
        </Button>
      ) : null}
      {capabilities.canAssignRoles && !terminated ? (
        <Button variant="secondary" size="sm" onClick={() => onAction({ kind: 'role', member: asListItem })}>
          Assign a role
        </Button>
      ) : null}
      {(capabilities.canPromote || capabilities.canDemote) && !terminated ? (
        <Button variant="primary" size="sm" onClick={() => onAction({ kind: 'rank', member: asListItem })}>
          Change rank
        </Button>
      ) : null}
      {capabilities.canFire && !terminated ? (
        <Button variant="danger-outline" size="sm" onClick={() => onAction({ kind: 'terminate', member: asListItem })}>
          <UserMinus aria-hidden /> Terminate
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Standing exceptions to what this member's roles say.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SCREEN'S JOB HERE IS TO MAKE THE EXCEPTION VISIBLE, NOT TO ENFORCE IT
 *
 * Every rule below is decided server-side, inside the transaction, with both
 * membership rows locked — the rank check, the subset rule, the global-scope
 * refusal. Nothing here is a security control (engineering rule 9), and the
 * list is deliberately shown to anyone who can read the profile even when they
 * cannot change it: an exception nobody can see is how a quiet grant survives.
 *
 * What the screen DOES add is the ceiling. The permission picker offers only
 * what the caller may actually hand out, and says so — offering a control the
 * server will refuse is worse than offering none.
 * ────────────────────────────────────────────────────────────────────────────
 */
function OverridesSection({
  organizationId, memberId, overrides, capabilities, isSelf, onChanged,
}: {
  organizationId: string;
  memberId: string;
  overrides: PersonnelOverride[];
  capabilities: PersonnelCapabilities;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [permissionKey, setPermissionKey] = React.useState('');
  const [effect, setEffect] = React.useState('grant');
  const [reason, setReason] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');

  // H6 again, cosmetically: nobody writes an exception for themselves, and the
  // form is not offered rather than being offered and refused.
  const mayEdit = capabilities.canSetOverrides && !isSelf;

  const options = React.useMemo(() => {
    const held = new Set(overrides.map((o) => o.permissionKey));
    return capabilities.grantablePermissions
      .filter((key) => !held.has(key))
      .map((key) => ({ value: key, label: labelFor(key) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [capabilities.grantablePermissions, overrides]);

  const reset = () => {
    setAdding(false); setPermissionKey(''); setEffect('grant');
    setReason(''); setExpiresAt(''); setError(null);
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError(null);
    const data = new FormData();
    data.set('permissionKey', permissionKey);
    data.set('effect', effect);
    data.set('reason', reason);
    data.set('expiresAt', expiresAt);
    const result = await setOverrideAction(
      organizationId, memberId, { status: 'idle' }, data,
    );
    setPending(false);
    if (result.status === 'error') { setError(result.message ?? 'Request failed.'); return; }
    toast.push({ tone: 'success', title: result.message ?? 'Exception saved.' });
    reset();
    onChanged();
  }

  async function remove(key: string) {
    setPending(true); setError(null);
    const result = await clearOverrideAction(organizationId, memberId, key);
    setPending(false);
    if (result.status === 'error') { setError(result.message ?? 'Request failed.'); return; }
    toast.push({ tone: 'success', title: result.message ?? 'Exception removed.' });
    onChanged();
  }

  return (
    <section className="flex flex-col gap-2" data-section="overrides">
      <div className="flex items-baseline justify-between gap-2">
        <SectionTitle>Permission exceptions</SectionTitle>
        {mayEdit && !adding ? (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>Add</Button>
        ) : null}
      </div>
      <p className="text-2xs text-text-tertiary">
        Granted or withheld for this person specifically, on top of what their rank carries.
      </p>

      {overrides.length === 0 ? (
        <p className="text-xs text-text-tertiary">None — this member holds exactly what their roles give them.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {overrides.map((o) => (
            <li
              key={o.permissionKey}
              className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-raised p-2"
            >
              <div className="flex items-baseline gap-2">
                <Badge size="sm" variant={o.effect === 'grant' ? 'success' : 'danger'}>
                  {o.effect === 'grant' ? 'Granted' : 'Denied'}
                </Badge>
                <span className="min-w-0 flex-1 break-words text-xs text-text-primary">
                  {labelFor(o.permissionKey)}
                </span>
                {mayEdit ? (
                  <Button
                    size="sm" variant="ghost" disabled={pending}
                    onClick={() => { void remove(o.permissionKey); }}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              <p className="break-words text-2xs text-text-secondary">{o.reason}</p>
              <p className="text-2xs text-text-tertiary">
                {o.grantedByName ? `by ${o.grantedByName} · ` : ''}
                {timeAgo(o.createdAt)}
                {o.expiresAt ? ` · lapses ${formatDateTime(o.expiresAt)}` : ' · until removed'}
              </p>
            </li>
          ))}
        </ul>
      )}

      {error ? <Alert tone="danger" title="Could not change the exception">{error}</Alert> : null}

      {mayEdit && adding ? (
        <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border-subtle p-2">
          <Field label="Permission" htmlFor="override-permission" required>
            <Select
              id="override-permission"
              value={permissionKey}
              onValueChange={setPermissionKey}
              placeholder={options.length === 0 ? 'Nothing left to add' : 'Choose a permission…'}
              options={options}
            />
          </Field>
          <Field
            label="Effect"
            htmlFor="override-effect"
            hint="Deny removes it even when their rank carries it."
          >
            <Select
              id="override-effect"
              value={effect}
              onValueChange={setEffect}
              options={[
                { value: 'grant', label: 'Grant to this person' },
                { value: 'deny', label: 'Deny to this person' },
              ]}
            />
          </Field>
          <Field
            label="Reason"
            htmlFor="override-reason"
            required
            hint="Recorded in the audit log. Six months from now this is the only thing separating an approval from a mistake."
          >
            <Input
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Vinewood case, approved by the chief"
            />
          </Field>
          <Field
            label="Lapses"
            htmlFor="override-expires"
            hint="Optional. Left blank the exception stands until somebody removes it."
          >
            <Input
              id="override-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={reset} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || !permissionKey}>
              {pending ? 'Saving…' : 'Save exception'}
            </Button>
          </div>
        </form>
      ) : null}

      {capabilities.canSetOverrides && isSelf ? (
        <p className="text-2xs text-text-tertiary">
          You cannot write an exception for your own record.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The catalogue's own words where it has them, the raw key where it does not.
 *
 * A client can meet a key its catalogue does not know — a server ahead of a
 * cached bundle — and showing the key is a worse label but a better outcome
 * than crashing the drawer.
 */
const KNOWN_PERMISSIONS = new Set<string>(PERMISSION_KEYS);

function labelFor(key: string): string {
  return KNOWN_PERMISSIONS.has(key) ? permissionMeta(key as PermissionKey).label : key;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
      {children}
    </h3>
  );
}

function Fact({
  icon, label, value, mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="mt-0.5 shrink-0 text-text-tertiary [&>svg]:size-3.5" aria-hidden>{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</span>
        <span className={`truncate text-xs text-text-primary${mono ? ' font-mono' : ''}`}>{value}</span>
      </span>
    </div>
  );
}

/** `personnel.callsign_changed` reads badly in a timeline. */
function humanizeAction(action: string): string {
  const known: Record<string, string> = {
    'personnel.hired': 'Hired',
    'personnel.terminated': 'Terminated',
    'personnel.promoted': 'Promoted',
    'personnel.demoted': 'Demoted',
    'personnel.updated': 'Record updated',
    'personnel.callsign_changed': 'Callsign changed',
    'role.assigned': 'Role assigned',
    'role.unassigned': 'Role removed',
    'permission.override_set': 'Permission exception set',
    'permission.override_cleared': 'Permission exception removed',
  };
  return known[action] ?? action.replace(/^[a-z_]+\./, '').replace(/_/g, ' ');
}
