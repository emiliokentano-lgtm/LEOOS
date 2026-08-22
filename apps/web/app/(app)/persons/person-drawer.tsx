'use client';

import * as React from 'react';
import {
  Building2, Car, EyeOff, FileText, Gavel, HeartPulse, IdCard, Phone, ShieldAlert, X,
} from 'lucide-react';
import {
  Alert, Badge, Button, Drawer, LoadingState, Tabs, TabsList, TabsTrigger, Tooltip,
} from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/utils';
import type { ActionState } from '@/lib/auth-action-types';
import {
  removeAliasAction, resolveFlagAction, resolveWarrantAction,
} from '@/lib/record-actions';
import type { PersonProfile } from '@/lib/persons';
import {
  AddAliasDialog, AddFlagDialog, EditMedicalDialog, EditPersonDialog,
  IssueWarrantDialog, ArchivePersonDialog,
} from './person-dialogs';

/**
 * A person's full record.
 *
 * Fetched on open rather than shipped with the register: a profile carries a
 * phone number, an address, and — for those entitled to them — criminal and
 * medical sections. Loading forty of those into a list payload would put data in
 * the browser that nobody asked to see.
 *
 * WITHHELD SECTIONS ARE NAMED, NOT HIDDEN. A blank space invites the operator to
 * conclude there is nothing there; saying "you do not have access to this" is
 * both true and useful, and the permission catalogue is not a secret.
 */

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info'> = {
  critical: 'danger', caution: 'warning', info: 'info',
};

type PersonDialog =
  | { kind: 'edit' } | { kind: 'alias' } | { kind: 'flag' }
  | { kind: 'warrant' } | { kind: 'medical' } | { kind: 'archive' };

export function PersonDrawer({
  personId, onClose, onChanged,
}: {
  personId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [loaded, setLoaded] = React.useState<
    { personId: string; profile: PersonProfile | null } | null
  >(null);
  const [tab, setTab] = React.useState('overview');
  const [dialog, setDialog] = React.useState<PersonDialog | null>(null);
  const [notice, setNotice] = React.useState<ActionState | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!personId) return;
    let cancelled = false;

    fetch(`/api/records/person/${personId}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: PersonProfile) => {
        if (!cancelled) setLoaded({ personId, profile: body });
      })
      .catch(() => { if (!cancelled) setLoaded({ personId, profile: null }); });

    return () => { cancelled = true; };
  }, [personId, reloadKey]);

  const current = personId && loaded?.personId === personId ? loaded : null;
  const profile = current?.profile ?? null;
  const state: 'idle' | 'loading' | 'error' =
    !personId ? 'idle' : !current ? 'loading' : current.profile ? 'idle' : 'error';

  const refresh = React.useCallback(() => {
    setReloadKey((k) => k + 1);
    onChanged();
  }, [onChanged]);

  async function run(action: () => Promise<ActionState>) {
    const result = await action();
    setNotice(result);
    if (result.status === 'success') refresh();
  }

  return (
    <>
      <Drawer
        open={personId !== null}
        onOpenChange={(next) => { if (!next) { onClose(); setNotice(null); setTab('overview'); } }}
        title={profile
          ? `${profile.person.firstName} ${profile.person.lastName}`
          : 'Person record'}
        description={profile
          ? [
              profile.person.dateOfBirth ? `DOB ${formatDate(profile.person.dateOfBirth)}` : null,
              profile.person.phoneNumber,
            ].filter(Boolean).join(' · ') || undefined
          : undefined}
        width="lg"
      >
        {state === 'loading' ? <LoadingState label="Loading record…" /> : null}

        {state === 'error' ? (
          <Alert tone="danger" title="Could not load this record">
            It may have been archived, or may not be visible to you.
          </Alert>
        ) : null}

        {profile ? (
          <div className="flex flex-col gap-3">
            {notice ? (
              <Alert
                tone={notice.status === 'error' ? 'danger' : 'success'}
                title={notice.status === 'error' ? 'Refused' : 'Saved'}
              >
                {notice.message}
              </Alert>
            ) : null}

            <Banners profile={profile} />

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="flags" count={profile.flags.filter((f) => !f.resolvedAt).length}>
                  Flags
                </TabsTrigger>
                <TabsTrigger value="warrants" count={profile.warrants.length}>Warrants</TabsTrigger>
                <TabsTrigger value="vehicles" count={profile.vehicles.length}>Vehicles</TabsTrigger>
                <TabsTrigger value="criminal">Criminal</TabsTrigger>
                <TabsTrigger value="medical">Medical</TabsTrigger>
              </TabsList>
            </Tabs>

            {tab === 'overview' ? <Overview profile={profile} onEdit={() => setDialog({ kind: 'edit' })} onAlias={() => setDialog({ kind: 'alias' })} onRemoveAlias={(id) => run(() => removeAliasAction(profile.person.id, id))} onArchive={() => setDialog({ kind: 'archive' })} /> : null}
            {tab === 'flags' ? <Flags profile={profile} onAdd={() => setDialog({ kind: 'flag' })} onResolve={(id) => run(() => resolveFlagAction(profile.person.id, id))} /> : null}
            {tab === 'warrants' ? <Warrants profile={profile} onIssue={() => setDialog({ kind: 'warrant' })} onResolve={(id, outcome) => run(() => resolveWarrantAction(profile.person.id, id, outcome))} /> : null}
            {tab === 'vehicles' ? <Vehicles profile={profile} /> : null}
            {tab === 'criminal' ? <Criminal profile={profile} /> : null}
            {tab === 'medical' ? <Medical profile={profile} onEdit={() => setDialog({ kind: 'medical' })} /> : null}
          </div>
        ) : null}
      </Drawer>

      {profile && dialog?.kind === 'edit' ? (
        <EditPersonDialog profile={profile} onClose={() => setDialog(null)} onSaved={refresh} />
      ) : null}
      {profile && dialog?.kind === 'alias' ? (
        <AddAliasDialog personId={profile.person.id} onClose={() => setDialog(null)} onSaved={refresh} />
      ) : null}
      {profile && dialog?.kind === 'flag' ? (
        <AddFlagDialog personId={profile.person.id} onClose={() => setDialog(null)} onSaved={refresh} />
      ) : null}
      {profile && dialog?.kind === 'warrant' ? (
        <IssueWarrantDialog personId={profile.person.id} onClose={() => setDialog(null)} onSaved={refresh} />
      ) : null}
      {profile && dialog?.kind === 'medical' ? (
        <EditMedicalDialog profile={profile} onClose={() => setDialog(null)} onSaved={refresh} />
      ) : null}
      {profile && dialog?.kind === 'archive' ? (
        <ArchivePersonDialog
          profile={profile}
          onClose={() => setDialog(null)}
          onSaved={() => { refresh(); onClose(); }}
        />
      ) : null}
    </>
  );
}

function Banners({ profile }: { profile: PersonProfile }) {
  const activeWarrants = profile.warrants.filter((w) => w.status === 'active');
  const criticalFlags = profile.flags.filter((f) => !f.resolvedAt && f.severity === 'critical');

  return (
    <>
      {profile.person.isArchived ? (
        <Alert tone="warning" title="This record is archived">
          It is retained in full — aliases, flags, warrants and history.
          {profile.person.archivedReason ? ` Reason: ${profile.person.archivedReason}` : null}
        </Alert>
      ) : null}

      {activeWarrants.length > 0 ? (
        <Alert tone="danger" title={`${activeWarrants.length} active warrant(s)`}>
          {activeWarrants.map((w) => `${w.type} — ${w.reason} (${w.organizationKey})`).join('; ')}
        </Alert>
      ) : null}

      {criticalFlags.length > 0 ? (
        <Alert tone="danger" title="Critical flags">
          {criticalFlags.map((f) => f.type).join(', ')}
        </Alert>
      ) : null}
    </>
  );
}

function Overview({
  profile, onEdit, onAlias, onRemoveAlias, onArchive,
}: {
  profile: PersonProfile;
  onEdit: () => void;
  onAlias: () => void;
  onRemoveAlias: (aliasId: string) => void;
  onArchive: () => void;
}) {
  const p = profile.person;
  const caps = profile.capabilities;

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact icon={<IdCard />} label="Date of birth"
          value={p.dateOfBirth ? formatDate(p.dateOfBirth) : '—'} mono />
        <Fact icon={<IdCard />} label="Status" value={p.status} />
        <Fact icon={<Phone />} label="Phone" value={p.phoneNumber ?? '—'} mono />
        <Fact icon={<Building2 />} label="Address" value={p.address ?? '—'} />
        <Fact icon={<IdCard />} label="Gender" value={p.gender ?? '—'} />
        <Fact icon={<IdCard />} label="Description"
          value={[
            p.heightCm ? `${p.heightCm} cm` : null,
            p.weightKg ? `${p.weightKg} kg` : null,
            p.eyeColor ? `${p.eyeColor} eyes` : null,
            p.hairColor ? `${p.hairColor} hair` : null,
          ].filter(Boolean).join(' · ') || '—'} />
        <Fact icon={<IdCard />} label="Record id" value={p.id.slice(0, 8)} mono />
        <Fact icon={<IdCard />} label="Created"
          value={`${formatDateTime(p.createdAt)}${p.createdByName ? ` · ${p.createdByName}` : ''}`} />
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeader
          title="Aliases"
          action={caps.canEdit
            ? <Button size="xs" variant="ghost" onClick={onAlias}>Add alias</Button>
            : null}
        />
        {profile.aliases.length === 0 ? (
          <p className="text-xs text-text-tertiary">None recorded.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {profile.aliases.map((a) => (
              <li key={a.id}>
                <Badge variant="outline" className="gap-1">
                  {a.alias}
                  {caps.canEdit ? (
                    <button
                      type="button"
                      onClick={() => onRemoveAlias(a.id)}
                      aria-label={`Remove alias ${a.alias}`}
                      className="text-text-tertiary hover:text-danger"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  ) : null}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {profile.affiliations.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeader title="Organization affiliations" />
          <p className="text-2xs text-text-tertiary">
            Derived from the personnel roster — this is not a second record that can disagree
            with it.
          </p>
          <ul className="flex flex-col gap-1">
            {profile.affiliations.map((a) => (
              <li key={a.organizationId} className="flex items-center gap-2 text-xs">
                <span className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: a.organizationColor }} aria-hidden />
                <span className="text-text-primary">{a.organizationName}</span>
                {a.roleName ? <Badge size="sm" variant="outline">{a.roleName}</Badge> : null}
                {a.callsign ? (
                  <span className="font-mono text-2xs text-text-tertiary">{a.callsign}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {profile.licenses.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeader title="Licences" />
          <ul className="flex flex-wrap gap-1.5">
            {profile.licenses.map((l) => (
              <li key={l.id}>
                <Badge variant={l.status === 'valid' ? 'success' : 'danger'} className="gap-1">
                  {l.type}
                  <span className="text-2xs opacity-80">{l.status}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.notes ? (
        <section className="flex flex-col gap-2">
          <SectionHeader title="Notes" />
          <p className="flex gap-2 whitespace-pre-wrap rounded-md border border-border-subtle bg-surface-raised p-2.5 text-xs text-text-secondary">
            <FileText className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
            {p.notes}
          </p>
        </section>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border-subtle pt-3">
        {caps.canEdit && !p.isArchived ? (
          <Button size="sm" variant="secondary" onClick={onEdit}>Edit record</Button>
        ) : null}
        {caps.canArchive && !p.isArchived ? (
          <Button size="sm" variant="danger-outline" onClick={onArchive}>Archive</Button>
        ) : null}
      </div>
    </div>
  );
}

function Flags({
  profile, onAdd, onResolve,
}: {
  profile: PersonProfile;
  onAdd: () => void;
  onResolve: (flagId: string) => void;
}) {
  const live = profile.flags.filter((f) => !f.resolvedAt);
  const cleared = profile.flags.filter((f) => f.resolvedAt);

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Operational flags"
        action={profile.capabilities.canManageFlags
          ? <Button size="xs" variant="ghost" onClick={onAdd}>Add flag</Button>
          : null}
      />
      {live.length === 0 ? (
        <p className="text-xs text-text-tertiary">No active flags.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {live.map((f) => (
            <li key={f.id}
              className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-raised p-2">
              <Badge size="sm" variant={SEVERITY_TONE[f.severity] ?? 'info'}>{f.severity}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-text-primary">{f.type}</span>
                {f.note ? (
                  <span className="block text-2xs text-text-secondary">{f.note}</span>
                ) : null}
                <span className="block text-2xs text-text-tertiary">
                  {formatDateTime(f.createdAt)}{f.createdByName ? ` · ${f.createdByName}` : ''}
                </span>
              </span>
              {profile.capabilities.canManageFlags ? (
                <Button size="xs" variant="ghost" onClick={() => onResolve(f.id)}>Clear</Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {cleared.length > 0 ? (
        <>
          <SectionHeader title="Cleared" />
          <p className="text-2xs text-text-tertiary">
            Cleared, not deleted — that a flag was once raised is part of the record.
          </p>
          <ul className="flex flex-col gap-1">
            {cleared.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-2xs text-text-tertiary">
                <span className="line-through">{f.type}</span>
                <span>cleared {formatDateTime(f.resolvedAt!)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Warrants({
  profile, onIssue, onResolve,
}: {
  profile: PersonProfile;
  onIssue: () => void;
  onResolve: (warrantId: string, outcome: 'served' | 'revoked') => void;
}) {
  const caps = profile.capabilities;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Warrants"
        action={caps.canManageWarrants && !profile.person.isArchived
          ? <Button size="xs" variant="ghost" onClick={onIssue}>Issue warrant</Button>
          : null}
      />
      {profile.warrants.length === 0 ? (
        <p className="text-xs text-text-tertiary">None on record.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {profile.warrants.map((w) => (
            <li key={w.id}
              className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-raised p-2">
              <Gavel className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-xs font-medium capitalize text-text-primary">{w.type}</span>
                  <Badge size="sm" variant={w.status === 'active' ? 'danger' : 'neutral'}>
                    {w.status}
                  </Badge>
                  <Badge size="sm" variant="outline">{w.organizationKey}</Badge>
                </span>
                <span className="block text-2xs text-text-secondary">{w.reason}</span>
                <span className="block text-2xs text-text-tertiary">
                  {formatDateTime(w.issuedAt)}{w.issuedByName ? ` · ${w.issuedByName}` : ''}
                </span>
              </span>
              {w.status === 'active' && caps.canManageWarrants ? (
                <span className="flex shrink-0 gap-1">
                  <Button size="xs" variant="ghost" onClick={() => onResolve(w.id, 'served')}>
                    Served
                  </Button>
                  <Tooltip content="Only the issuing organization can revoke a warrant">
                    <span>
                      <Button size="xs" variant="ghost" onClick={() => onResolve(w.id, 'revoked')}>
                        Revoke
                      </Button>
                    </span>
                  </Tooltip>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Vehicles({ profile }: { profile: PersonProfile }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title="Registered vehicles" />
      {profile.vehicles.length === 0 ? (
        <p className="text-xs text-text-tertiary">None registered to this person.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {profile.vehicles.map((v) => (
            <li key={v.id}
              className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-raised p-2">
              <Car className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs text-text-primary">{v.plate}</span>
                <span className="block text-2xs text-text-tertiary">
                  {v.displayName ?? v.model}{v.color ? ` · ${v.color}` : ''}
                </span>
              </span>
              <Badge size="sm" variant={v.registrationStatus === 'registered' ? 'success' : 'warning'}>
                {v.registrationStatus}
              </Badge>
              {v.flagCount > 0 ? (
                <Badge size="sm" variant="danger">
                  <ShieldAlert aria-hidden /> {v.flagCount}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Criminal({ profile }: { profile: PersonProfile }) {
  if (!profile.criminal) return <Withheld section="Criminal history" permission="View criminal history" />;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title="Criminal history" />
      {profile.criminal.length === 0 ? (
        <p className="text-xs text-text-tertiary">No charges on record.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {profile.criminal.map((c) => (
            <li key={c.id}
              className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-raised p-2">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-text-primary">{c.title}</span>
                  <Badge size="sm" variant={c.severity === 'felony' ? 'danger' : 'warning'}>
                    {c.severity}
                  </Badge>
                  <Badge size="sm" variant="neutral">{c.status}</Badge>
                </span>
                <span className="block text-2xs text-text-tertiary">
                  {formatDateTime(c.filedAt)}
                  {c.statuteCode ? ` · ${c.statuteCode}` : ''}
                  {c.filedByName ? ` · ${c.filedByName}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Medical({ profile, onEdit }: { profile: PersonProfile; onEdit: () => void }) {
  if (profile.medical === undefined) {
    return <Withheld section="Medical record" permission="View medical records" />;
  }

  const m = profile.medical;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Medical record"
        action={profile.capabilities.canEditMedical
          ? <Button size="xs" variant="ghost" onClick={onEdit}>Edit</Button>
          : null}
      />
      <Alert tone="info" title="This read is recorded">
        Opening a medical record writes an audit entry naming you. That is the point of the
        permission, not a side effect of it.
      </Alert>

      {!m ? (
        <p className="text-xs text-text-tertiary">No medical record on file.</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact icon={<HeartPulse />} label="Blood type" value={m.bloodType ?? '—'} mono />
          <Fact icon={<Phone />} label="Emergency contact" value={m.emergencyContact ?? '—'} />
          <Fact icon={<HeartPulse />} label="Allergies"
            value={m.allergies.length > 0 ? m.allergies.join(', ') : '—'} />
          <Fact icon={<HeartPulse />} label="Conditions"
            value={m.conditions.length > 0 ? m.conditions.join(', ') : '—'} />
          <Fact icon={<HeartPulse />} label="Medications"
            value={m.medications.length > 0 ? m.medications.join(', ') : '—'} />
          <Fact icon={<FileText />} label="Notes" value={m.notes ?? '—'} />
        </div>
      )}
    </div>
  );
}

function Withheld({ section, permission }: { section: string; permission: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <EyeOff className="size-6 text-text-tertiary" aria-hidden />
      <p className="text-sm font-medium text-text-secondary">{section} is not available to you</p>
      <p className="max-w-sm text-xs text-text-tertiary">
        This section requires the “{permission}” permission. It was not sent to your browser —
        it is withheld at the server, not hidden here.
      </p>
    </div>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
        {title}
      </h3>
      {action}
    </div>
  );
}

function Fact({
  icon, label, value, mono,
}: {
  icon: React.ReactNode; label: string; value: React.ReactNode; mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="mt-0.5 shrink-0 text-text-tertiary [&>svg]:size-3.5" aria-hidden>{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</span>
        <span className={`truncate text-xs text-text-primary${mono ? ' font-mono' : ''}`}>
          {value}
        </span>
      </span>
    </div>
  );
}
