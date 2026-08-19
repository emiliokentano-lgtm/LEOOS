'use client';

import * as React from 'react';
import {
  Building2, Car, IdCard, Radio, Settings, Shield, ShieldCheck,
} from 'lucide-react';
import { ORGANIZATION_CATEGORIES } from '@leoos/contracts';
import {
  Alert, Badge, DataTable, DutyStatusBadge, EmptyState, OrgBadge, Panel,
  PanelHeader, StatTile, Tabs, TabsList, TabsTrigger, Tooltip,
  type AsyncResource, type Column,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { formatDateTime } from '@/lib/utils';
import type {
  OrganizationDetail, OrgMemberRow, OrgRoleRow, OrgUnitRow, OrgVehicleRow, LeadCandidate,
} from '@/lib/organizations';
import type { DutyStatusKey } from '@leoos/contracts';
import { OrganizationSettingsForm } from './settings-form';
import { LeadManager } from './lead-manager';

/**
 * Organization admin screen.
 *
 * `capabilities` comes from the API and decides what to RENDER. It is cosmetic:
 * every action it reveals is authorized again server-side, and a section it
 * hides is also refused by the API if requested directly.
 */
export function OrganizationView({
  detail, members, roles, units, vehicles, candidates,
}: {
  detail: OrganizationDetail;
  members: OrgMemberRow[] | null;
  roles: OrgRoleRow[] | null;
  units: OrgUnitRow[] | null;
  vehicles: OrgVehicleRow[] | null;
  candidates: LeadCandidate[];
}) {
  const { organization: org, stats, leads, capabilities } = detail;
  const [tab, setTab] = React.useState('overview');
  const category = ORGANIZATION_CATEGORIES[org.category];

  return (
    <PageContainer>
      <div className="flex flex-col gap-3">
        {!org.isActive ? (
          <Alert tone="warning" title="This organization is disabled">
            Members keep their records, but it is excluded from operational views. Only a
            global administrator can re-enable it.
          </Alert>
        ) : null}

        {/* Identity header */}
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div
                className="flex size-11 shrink-0 items-center justify-center rounded-md font-mono text-sm font-bold"
                style={{ backgroundColor: org.color, color: '#0b0e14' }}
                aria-hidden
              >
                {org.shortName.slice(0, 3)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-text-primary">{org.name}</h2>
                  <OrgBadge shortName={org.key} color={org.color} />
                  <Badge variant="outline">{category.label}</Badge>
                  {org.isActive
                    ? <Badge variant="success">Active</Badge>
                    : <Badge variant="danger">Disabled</Badge>}
                </div>
                {org.description ? (
                  <p className="mt-1 max-w-2xl text-xs text-text-secondary">{org.description}</p>
                ) : null}
                <p className="mt-1 font-mono text-2xs text-text-tertiary">
                  Created {formatDateTime(org.createdAt)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {leads.length > 0 ? (
                <Tooltip content={leads.map((l) => l.displayName).join(', ')}>
                  <Badge variant="accent" className="gap-1">
                    <ShieldCheck aria-hidden />
                    {leads.length === 1 ? leads[0]!.displayName : `${leads.length} leads`}
                  </Badge>
                </Tooltip>
              ) : (
                <Badge variant="warning">No organization lead</Badge>
              )}
            </div>
          </div>
        </Panel>

        {/* Statistics */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatTile label="Active members" value={stats.activeMembers}
            hint={`${stats.totalMembers} total`} icon={<IdCard />} />
          <StatTile label="Roles" value={stats.roles} icon={<Shield />} />
          <StatTile label="Active units" value={stats.activeUnits} icon={<Radio />} />
          <StatTile label="Fleet vehicles" value={stats.fleetVehicles} icon={<Car />} />
          <StatTile label="Organization leads" value={stats.leads}
            tone={stats.leads === 0 ? 'warning' : 'default'} icon={<ShieldCheck />} />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="leads" count={leads.length}>Leads</TabsTrigger>
            <TabsTrigger value="personnel" count={members?.length}>Personnel</TabsTrigger>
            <TabsTrigger value="roles" count={roles?.length}>Roles</TabsTrigger>
            <TabsTrigger value="units" count={units?.length}>Units</TabsTrigger>
            <TabsTrigger value="vehicles" count={vehicles?.length}>Vehicles</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'overview' ? <Overview detail={detail} /> : null}
        {tab === 'leads' ? (
          <LeadManager
            organizationId={org.id}
            organizationName={org.name}
            leads={leads}
            candidates={candidates}
            canManage={capabilities.canManageLeads}
          />
        ) : null}
        {tab === 'personnel' ? <MembersPanel rows={members} /> : null}
        {tab === 'roles' ? <RolesPanel rows={roles} /> : null}
        {tab === 'units' ? <UnitsPanel rows={units} /> : null}
        {tab === 'vehicles' ? <VehiclesPanel rows={vehicles} /> : null}
        {tab === 'settings' ? (
          <OrganizationSettingsForm organization={org} canEdit={capabilities.canEdit} />
        ) : null}
      </div>
    </PageContainer>
  );
}

/** An overview panel summarises; it never becomes the whole page. */
const OVERVIEW_LEAD_LIMIT = 3;

function Overview({ detail }: { detail: OrganizationDetail }) {
  const { organization: org, leads } = detail;
  const category = ORGANIZATION_CATEGORIES[org.category];
  const settings = org.settings as Record<string, boolean | undefined>;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Panel flush>
        <PanelHeader title="Organization information" icon={<Building2 />} />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-3 sm:grid-cols-2">
          <Field label="Name" value={org.name} />
          <Field label="Short name" value={org.shortName} mono />
          <Field label="Key" value={org.key} mono />
          <Field label="Category" value={category.label} />
          <div className="flex flex-col gap-1">
            <dt className="text-2xs uppercase tracking-wide text-text-tertiary">Identity colour</dt>
            <dd className="flex items-center gap-2">
              <span className="size-4 rounded-xs border border-border"
                style={{ backgroundColor: org.color }} aria-hidden />
              <span className="font-mono text-xs text-text-primary">{org.color}</span>
            </dd>
          </div>
          <Field label="Status" value={org.isActive ? 'Active' : 'Disabled'} />
        </dl>
      </Panel>

      <div className="flex flex-col gap-3">
        <Panel flush>
          <PanelHeader
            title="Organization lead"
            icon={<ShieldCheck />}
            actions={leads.length > 0 ? <Badge variant="neutral" mono>{leads.length}</Badge> : null}
          />
          {leads.length === 0 ? (
            <EmptyState
              title="No lead appointed"
              description="Only a global administrator can appoint one."
            />
          ) : (
            <ul>
              {/* Capped: an overview panel must not grow without bound. The
                  Leads tab holds the full list. */}
              {leads.slice(0, OVERVIEW_LEAD_LIMIT).map((lead) => (
                <li key={lead.userId}
                  className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-b-0">
                  <ShieldCheck className="size-4 shrink-0 text-accent" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-text-primary">{lead.displayName}</p>
                    <p className="truncate font-mono text-2xs text-text-tertiary">{lead.username}</p>
                  </div>
                  <span className="shrink-0 text-2xs text-text-tertiary">
                    since {formatDateTime(lead.grantedAt)}
                  </span>
                </li>
              ))}
              {leads.length > OVERVIEW_LEAD_LIMIT ? (
                <li className="px-3 py-2 text-2xs text-text-tertiary">
                  and {leads.length - OVERVIEW_LEAD_LIMIT} more — see the Leads tab
                </li>
              ) : null}
            </ul>
          )}
        </Panel>

        <Panel flush>
          <PanelHeader title="Operational settings" icon={<Settings />} />
          <ul className="p-3 text-xs">
            <SettingRow label="Share units on the public map" on={settings.shareOnPublicMap} />
            <SettingRow label="Allow self-dispatch" on={settings.allowSelfDispatch} />
            <SettingRow label="Require a callsign to go on duty" on={settings.requireCallsignOnDuty} />
            <SettingRow label="Panic notifies all organizations" on={settings.panicNotifiesAllOrganizations} />
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function SettingRow({ label, on }: { label: string; on: boolean | undefined }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border-subtle py-1.5 last:border-b-0">
      <span className="text-text-secondary">{label}</span>
      <Badge size="sm" variant={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>
    </li>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className={`text-xs text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

/** A section the caller may not read. Says so rather than rendering empty. */
function Unavailable({ what }: { what: string }) {
  return (
    <Panel flush>
      <EmptyState
        title={`${what} unavailable`}
        description="Your role does not include permission to view this."
      />
    </Panel>
  );
}

function MembersPanel({ rows }: { rows: OrgMemberRow[] | null }) {
  if (rows === null) return <Unavailable what="Personnel" />;
  const resource: AsyncResource<OrgMemberRow[]> = { status: 'success', data: rows };

  const columns: Column<OrgMemberRow>[] = [
    { id: 'name', header: 'Member', cell: (m) => (
      <span className="flex items-center gap-1.5">
        {m.isLead ? (
          <Tooltip content="Organization Lead">
            <ShieldCheck className="size-3.5 shrink-0 text-accent" aria-label="Organization Lead" />
          </Tooltip>
        ) : null}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{m.displayName}</span>
          <span className="truncate font-mono text-2xs text-text-tertiary">{m.username}</span>
        </span>
      </span>
    ) },
    { id: 'role', header: 'Rank', width: '170px', cell: (m) => (
      <span className="flex items-center gap-1.5">
        <span>{m.roleName ?? '—'}</span>
        {m.hierarchyLevel > 0 ? <Badge size="sm" variant="outline" mono>L{m.hierarchyLevel}</Badge> : null}
      </span>
    ) },
    { id: 'callsign', header: 'Callsign', mono: true, width: '130px', hideBelow: 'md',
      cell: (m) => m.callsign ?? '—' },
    { id: 'status', header: 'Membership', width: '120px', cell: (m) => (
      <Badge size="sm" variant={m.status === 'active' ? 'success' : m.status === 'terminated' ? 'danger' : 'warning'}>
        {m.status}
      </Badge>
    ) },
    { id: 'duty', header: 'Duty', width: '130px', hideBelow: 'lg', cell: (m) =>
      m.dutyStatus ? <DutyStatusBadge status={m.dutyStatus as DutyStatusKey} size="sm" /> : <span className="text-text-tertiary">—</span> },
  ];

  return (
    <Panel flush className="min-h-[320px]">
      <PanelHeader title="Personnel" icon={<IdCard />}
        actions={<Badge variant="neutral" mono>{rows.length}</Badge>} />
      <DataTable caption="Organization personnel" columns={columns} resource={resource}
        rowKey={(m) => m.memberId}
        empty={<EmptyState title="No members yet" description="Nobody has been hired into this organization." />} />
    </Panel>
  );
}

function RolesPanel({ rows }: { rows: OrgRoleRow[] | null }) {
  if (rows === null) return <Unavailable what="Roles" />;
  const resource: AsyncResource<OrgRoleRow[]> = { status: 'success', data: rows };

  const columns: Column<OrgRoleRow>[] = [
    { id: 'level', header: 'Level', mono: true, align: 'right', width: '70px',
      cell: (r) => <span className="font-semibold">{r.hierarchyLevel}</span> },
    { id: 'name', header: 'Role', cell: (r) => (
      <span className="flex items-center gap-1.5">
        <span className="truncate font-medium">{r.name}</span>
        {r.isDefault ? <Badge size="sm" variant="info">Default</Badge> : null}
        {r.isSystem ? <Badge size="sm" variant="outline">System</Badge> : null}
      </span>
    ) },
    { id: 'members', header: 'Members', mono: true, align: 'right', width: '90px', cell: (r) => r.memberCount },
    { id: 'perms', header: 'Permissions', mono: true, align: 'right', width: '110px',
      hideBelow: 'md', cell: (r) => r.permissionCount },
  ];

  return (
    <Panel flush className="min-h-[320px]">
      <PanelHeader title="Roles" icon={<Shield />}
        description="Higher level means more senior"
        actions={<Badge variant="neutral" mono>{rows.length}</Badge>} />
      <DataTable caption="Organization roles" columns={columns} resource={resource} rowKey={(r) => r.id} />
    </Panel>
  );
}

function UnitsPanel({ rows }: { rows: OrgUnitRow[] | null }) {
  if (rows === null) return <Unavailable what="Units" />;
  const resource: AsyncResource<OrgUnitRow[]> = { status: 'success', data: rows };

  const columns: Column<OrgUnitRow>[] = [
    { id: 'callsign', header: 'Callsign', mono: true, width: '150px',
      cell: (u) => <span className="font-semibold">{u.callsign}</span> },
    { id: 'type', header: 'Type', width: '140px', cell: (u) => u.unitType },
    { id: 'status', header: 'Status', width: '140px',
      cell: (u) => <DutyStatusBadge status={u.statusKey as DutyStatusKey} size="sm" /> },
    { id: 'members', header: 'Crew', mono: true, align: 'right', width: '80px', cell: (u) => u.memberCount },
  ];

  return (
    <Panel flush className="min-h-[320px]">
      <PanelHeader title="Active units" icon={<Radio />}
        actions={<Badge variant="neutral" mono>{rows.length}</Badge>} />
      <DataTable caption="Active units" columns={columns} resource={resource} rowKey={(u) => u.id}
        empty={<EmptyState title="No active units" description="No patrols are currently formed." />} />
    </Panel>
  );
}

function VehiclesPanel({ rows }: { rows: OrgVehicleRow[] | null }) {
  if (rows === null) return <Unavailable what="Vehicles" />;
  const resource: AsyncResource<OrgVehicleRow[]> = { status: 'success', data: rows };

  const columns: Column<OrgVehicleRow>[] = [
    { id: 'plate', header: 'Plate', mono: true, width: '120px',
      cell: (v) => <span className="font-semibold">{v.plate}</span> },
    { id: 'vehicle', header: 'Vehicle', cell: (v) => v.displayName ?? v.model },
    { id: 'color', header: 'Colour', width: '120px', hideBelow: 'md',
      cell: (v) => v.color ?? '—' },
    { id: 'registration', header: 'Registration', width: '130px', cell: (v) => (
      <Badge size="sm" variant={v.registrationStatus === 'registered' ? 'success' : 'warning'}>
        {v.registrationStatus}
      </Badge>
    ) },
  ];

  return (
    <Panel flush className="min-h-[320px]">
      <PanelHeader title="Fleet vehicles" icon={<Car />}
        actions={<Badge variant="neutral" mono>{rows.length}</Badge>} />
      <DataTable caption="Fleet vehicles" columns={columns} resource={resource} rowKey={(v) => v.id}
        empty={<EmptyState title="No fleet vehicles" description="No vehicles are registered to this organization." />} />
    </Panel>
  );
}

