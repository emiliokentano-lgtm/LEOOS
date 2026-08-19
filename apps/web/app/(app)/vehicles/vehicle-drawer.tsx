'use client';

import * as React from 'react';
import {
  Building2, Car, FileText, IdCard, Phone, ShieldAlert, TriangleAlert, User,
} from 'lucide-react';
import {
  Alert, Badge, Button, Drawer, LoadingState, Tabs, TabsList, TabsTrigger, Tooltip,
} from '@/components/ui';
import { formatDateTime, timeAgo } from '@/lib/utils';
import type { ActionState } from '@/lib/auth-action-types';
import { resolveVehicleFlagAction } from '@/lib/record-actions';
import type { OrganizationOption, VehicleProfile } from '@/lib/vehicles';
import { AddVehicleFlagDialog, ArchiveVehicleDialog, VehicleFormDialog } from './vehicle-dialogs';

/**
 * A vehicle's full record.
 *
 * The history tab is read from the AUDIT LOG rather than a second history
 * table, so the two cannot disagree — and a refused attempt to change a
 * registration appears there alongside the ones that succeeded.
 */

const REG_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  registered: 'success', expired: 'warning', unregistered: 'danger',
};

export function VehicleDrawer({
  vehicleId, organizations, onClose, onChanged,
}: {
  vehicleId: string | null;
  organizations: OrganizationOption[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [loaded, setLoaded] = React.useState<
    { vehicleId: string; profile: VehicleProfile | null } | null
  >(null);
  const [tab, setTab] = React.useState('overview');
  const [dialog, setDialog] = React.useState<'edit' | 'flag' | 'archive' | null>(null);
  const [notice, setNotice] = React.useState<ActionState | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!vehicleId) return;
    let cancelled = false;

    fetch(`/api/records/vehicle/${vehicleId}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: VehicleProfile) => {
        if (!cancelled) setLoaded({ vehicleId, profile: body });
      })
      .catch(() => { if (!cancelled) setLoaded({ vehicleId, profile: null }); });

    return () => { cancelled = true; };
  }, [vehicleId, reloadKey]);

  const current = vehicleId && loaded?.vehicleId === vehicleId ? loaded : null;
  const profile = current?.profile ?? null;
  const state: 'idle' | 'loading' | 'error' =
    !vehicleId ? 'idle' : !current ? 'loading' : current.profile ? 'idle' : 'error';

  const refresh = React.useCallback(() => {
    setReloadKey((k) => k + 1);
    onChanged();
  }, [onChanged]);

  async function run(action: () => Promise<ActionState>) {
    const result = await action();
    setNotice(result);
    if (result.status === 'success') refresh();
  }

  const v = profile?.vehicle;

  return (
    <>
      <Drawer
        open={vehicleId !== null}
        onOpenChange={(next) => { if (!next) { onClose(); setNotice(null); setTab('overview'); } }}
        title={v ? v.plate : 'Vehicle record'}
        description={v ? `${v.displayName ?? v.model}${v.color ? ` · ${v.color}` : ''}` : undefined}
        width="lg"
      >
        {state === 'loading' ? <LoadingState label="Loading record…" /> : null}
        {state === 'error' ? (
          <Alert tone="danger" title="Could not load this record">
            It may have been archived, or may not be visible to you.
          </Alert>
        ) : null}

        {profile && v ? (
          <div className="flex flex-col gap-3">
            {notice ? (
              <Alert
                tone={notice.status === 'error' ? 'danger' : 'success'}
                title={notice.status === 'error' ? 'Refused' : 'Saved'}
              >
                {notice.message}
              </Alert>
            ) : null}

            {v.isArchived ? (
              <Alert tone="warning" title="This vehicle is archived">
                The record is retained; the plate is free to reissue.
                {v.archivedReason ? ` Reason: ${v.archivedReason}` : null}
              </Alert>
            ) : null}

            {v.ownerHasWarrant ? (
              <Alert tone="danger" title="The registered owner is wanted">
                Check the person record before approaching.
              </Alert>
            ) : null}

            {profile.flags.some((f) => !f.resolvedAt) ? (
              <Alert tone="danger" title="Active flags">
                {profile.flags.filter((f) => !f.resolvedAt).map((f) => f.type).join(', ')}
              </Alert>
            ) : null}

            {!v.manageable && v.lockedReason ? (
              <Alert tone="info" title="Read only">
                {v.lockedReason}. You can still flag it — reporting another
                organization&apos;s vehicle is exactly what the shared register is for.
              </Alert>
            ) : null}

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="flags" count={profile.flags.filter((f) => !f.resolvedAt).length}>
                  Flags
                </TabsTrigger>
                <TabsTrigger value="history" count={profile.history.length}>History</TabsTrigger>
              </TabsList>
            </Tabs>

            {tab === 'overview' ? (
              <div className="flex flex-col gap-4">
                <section className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <Fact icon={<Car />} label="Plate" value={v.plate} mono />
                  <Fact icon={<Car />} label="Model" value={v.model} mono />
                  <Fact icon={<IdCard />} label="Registration"
                    value={<Badge size="sm" variant={REG_TONE[v.registrationStatus] ?? 'neutral'}>
                      {v.registrationStatus}
                    </Badge>} />
                  <Fact icon={<IdCard />} label="Insurance"
                    value={<Badge size="sm" variant={v.insuranceStatus === 'insured' ? 'success' : 'warning'}>
                      {v.insuranceStatus}
                    </Badge>} />
                  <Fact icon={<Car />} label="Colour" value={v.color ?? '—'} />
                  <Fact icon={<Car />} label="Class" value={v.vehicleClass ?? '—'} />
                </section>

                <section className="flex flex-col gap-2">
                  <SectionHeader title="Registered owner" />
                  {v.ownerOrganizationId ? (
                    <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-raised p-2.5">
                      <Building2 className="size-4 shrink-0 text-text-tertiary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-text-primary">
                          {v.ownerOrganizationName ?? v.ownerOrganizationKey}
                        </span>
                        <span className="block text-2xs text-text-tertiary">
                          {v.isFleet ? 'Fleet vehicle' : 'Organization owned'}
                        </span>
                      </span>
                      {v.ownerOrganizationColor ? (
                        <span className="size-3 shrink-0 rounded-full"
                          style={{ backgroundColor: v.ownerOrganizationColor }} aria-hidden />
                      ) : null}
                    </div>
                  ) : v.ownerPersonId ? (
                    <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-raised p-2.5">
                      <User className="size-4 shrink-0 text-text-tertiary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-text-primary">
                            {v.ownerName}
                          </span>
                          {v.ownerHasWarrant ? (
                            <Tooltip content="Active warrant">
                              <TriangleAlert className="size-3.5 text-danger" aria-label="Wanted" />
                            </Tooltip>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-2 text-2xs text-text-tertiary">
                          {v.ownerStatus ? <span>{v.ownerStatus}</span> : null}
                          {v.ownerPhone ? (
                            <span className="flex items-center gap-1">
                              <Phone className="size-3" aria-hidden />{v.ownerPhone}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-text-tertiary">No registered owner on file.</p>
                  )}
                </section>

                {v.notes ? (
                  <section className="flex flex-col gap-2">
                    <SectionHeader title="Notes" />
                    <p className="flex gap-2 whitespace-pre-wrap rounded-md border border-border-subtle bg-surface-raised p-2.5 text-xs text-text-secondary">
                      <FileText className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                      {v.notes}
                    </p>
                  </section>
                ) : null}

                <p className="text-2xs text-text-tertiary">
                  Registered {formatDateTime(v.createdAt)}
                  {v.createdByName ? ` by ${v.createdByName}` : ''}
                </p>

                <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-3">
                  {profile.capabilities.canEdit && !v.isArchived ? (
                    <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>
                      Edit vehicle
                    </Button>
                  ) : null}
                  {profile.capabilities.canArchive && !v.isArchived ? (
                    <Button size="sm" variant="danger-outline" onClick={() => setDialog('archive')}>
                      Archive
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab === 'flags' ? (
              <div className="flex flex-col gap-3">
                <SectionHeader
                  title="Flags"
                  action={profile.capabilities.canManageFlags && !v.isArchived
                    ? <Button size="xs" variant="ghost" onClick={() => setDialog('flag')}>Add flag</Button>
                    : null}
                />
                {profile.flags.length === 0 ? (
                  <p className="text-xs text-text-tertiary">None on record.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {profile.flags.map((f) => (
                      <li key={f.id}
                        className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-raised p-2">
                        <ShieldAlert
                          className={`mt-0.5 size-3.5 shrink-0 ${f.resolvedAt ? 'text-text-disabled' : 'text-danger'}`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-xs font-medium ${f.resolvedAt ? 'text-text-tertiary line-through' : 'text-text-primary'}`}>
                            {f.type}
                          </span>
                          {f.note ? (
                            <span className="block text-2xs text-text-secondary">{f.note}</span>
                          ) : null}
                          <span className="block text-2xs text-text-tertiary">
                            {formatDateTime(f.createdAt)}
                            {f.createdByName ? ` · ${f.createdByName}` : ''}
                          </span>
                        </span>
                        {!f.resolvedAt && profile.capabilities.canManageFlags ? (
                          <Button size="xs" variant="ghost"
                            onClick={() => run(() => resolveVehicleFlagAction(v.id, f.id))}>
                            Clear
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {tab === 'history' ? (
              <div className="flex flex-col gap-2">
                <SectionHeader title="Record history" />
                <p className="text-2xs text-text-tertiary">
                  Read from the audit log — refused attempts included.
                </p>
                {profile.history.length === 0 ? (
                  <p className="text-xs text-text-tertiary">Nothing recorded yet.</p>
                ) : (
                  <ol className="flex flex-col">
                    {profile.history.map((entry, index) => (
                      <li key={`${entry.at}-${index}`}
                        className="flex items-baseline gap-2 border-b border-border-subtle py-1.5 last:border-b-0">
                        <Badge size="sm" className="shrink-0"
                          variant={entry.outcome === 'denied' ? 'danger' : 'neutral'}>
                          {entry.outcome === 'denied' ? 'Refused' : 'Done'}
                        </Badge>
                        <span className="min-w-0 flex-1 break-words">
                          <span className="text-xs text-text-primary">
                            {humanize(entry.action)}
                          </span>
                          {entry.summary ? (
                            <span className="ml-1.5 text-2xs text-text-tertiary">{entry.summary}</span>
                          ) : null}
                          {entry.actorName ? (
                            <span className="ml-1.5 text-2xs text-text-tertiary">
                              by {entry.actorName}
                            </span>
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
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      {profile && dialog === 'edit' ? (
        <VehicleFormDialog
          open
          vehicle={profile.vehicle}
          organizations={organizations}
          actorOrganizationId={profile.vehicle.ownerOrganizationId}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      ) : null}
      {profile && dialog === 'flag' ? (
        <AddVehicleFlagDialog
          vehicleId={profile.vehicle.id}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      ) : null}
      {profile && dialog === 'archive' ? (
        <ArchiveVehicleDialog
          vehicle={profile.vehicle}
          onClose={() => setDialog(null)}
          onSaved={() => { refresh(); onClose(); }}
        />
      ) : null}
    </>
  );
}

function humanize(action: string): string {
  const known: Record<string, string> = {
    'vehicle.created': 'Registered',
    'vehicle.updated': 'Record updated',
    'vehicle.archived': 'Archived',
    'vehicle.viewed': 'Looked up',
  };
  return known[action] ?? action.replace(/^[a-z_]+\./, '').replace(/_/g, ' ');
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">{title}</h3>
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
