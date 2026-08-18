'use client';

import * as React from 'react';
import { Plus, Radio, TriangleAlert } from 'lucide-react';
import { DUTY_STATUSES, PRIORITY_LIST } from '@leoos/contracts';
import {
  Badge, Button, EmptyState, FilterBar, FilterChip, OrgBadge,
  Panel, PanelHeader, PriorityBadge, IncidentStatusBadge, Tabs, TabsList, TabsTrigger,
  Tooltip,
} from '@/components/ui';
import { IncidentRow } from '@/components/domain/incident-row';
import { UnitRow } from '@/components/domain/unit-row';
import { formatDateTime, formatElapsed } from '@/lib/utils';
import {
  MOCK_INCIDENTS, MOCK_NOW, MOCK_UNITS, type MockIncident,
} from '@/mocks/operations';
import { mockOrg } from '@/mocks/organizations';

/**
 * The Leitstelle — the densest screen in the product.
 *
 * Three columns on one 1920×1080 display without scrolling the page:
 *   queue (left) · selected incident + timeline (centre) · unit board (right)
 *
 * Each column scrolls independently. Nothing here performs a mutation in this
 * phase; the controls are present so the layout and affordances are settled.
 */
export function DispatchView() {
  const [selectedId, setSelectedId] = React.useState<string | null>(MOCK_INCIDENTS[0]?.id ?? null);
  const [priorityFilter, setPriorityFilter] = React.useState<Set<number>>(new Set());
  const [tab, setTab] = React.useState('open');

  const incidents = React.useMemo(() => {
    return MOCK_INCIDENTS.filter((i) => {
      const isOpen = i.status !== 'closed' && i.status !== 'cancelled';
      if (tab === 'open' && !isOpen) return false;
      if (tab === 'unassigned' && (!isOpen || i.assignedUnitIds.length > 0)) return false;
      if (tab === 'closed' && isOpen) return false;
      if (priorityFilter.size > 0 && !priorityFilter.has(i.priority)) return false;
      return true;
    }).sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  }, [tab, priorityFilter]);

  const selected = MOCK_INCIDENTS.find((i) => i.id === selectedId) ?? null;
  const assignedUnits = selected
    ? MOCK_UNITS.filter((u) => selected.assignedUnitIds.includes(u.id))
    : [];
  const availableUnits = MOCK_UNITS.filter((u) => DUTY_STATUSES[u.status].isAvailable);

  const openCount = MOCK_INCIDENTS.filter((i) => i.status !== 'closed' && i.status !== 'cancelled').length;
  const unassignedCount = MOCK_INCIDENTS.filter(
    (i) => i.status !== 'closed' && i.status !== 'cancelled' && i.assignedUnitIds.length === 0,
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={priorityFilter.size}
        onClearAll={() => setPriorityFilter(new Set())}
        trailing={
          <Tooltip content="Incident creation lands with the dispatch module (Phase 5)">
            <Button variant="primary" size="sm" disabled>
              <Plus aria-hidden /> New incident
            </Button>
          </Tooltip>
        }
      >
        <span className="mr-1 text-2xs uppercase tracking-wide text-text-disabled">Priority</span>
        {PRIORITY_LIST.map((p) => (
          <FilterChip
            key={p.value}
            label={p.label}
            color={`var(${p.token})`}
            active={priorityFilter.has(p.value)}
            onToggle={() => {
              const next = new Set(priorityFilter);
              if (next.has(p.value)) next.delete(p.value); else next.add(p.value);
              setPriorityFilter(next);
            }}
          />
        ))}
      </FilterBar>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(300px,1fr)_minmax(0,1.5fr)] xl:grid-cols-[minmax(320px,1fr)_minmax(0,1.6fr)_minmax(280px,1fr)]">
        {/* Queue */}
        <Panel flush className="min-h-0">
          <div className="shrink-0 border-b border-border-subtle px-1">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="border-b-0">
                <TabsTrigger value="open" count={openCount}>Open</TabsTrigger>
                <TabsTrigger value="unassigned" count={unassignedCount}>Unassigned</TabsTrigger>
                <TabsTrigger value="closed">Closed</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {incidents.length === 0 ? (
              <EmptyState
                variant="filtered"
                title="No incidents in this view"
                description="Adjust the tab or priority filters."
              />
            ) : (
              incidents.map((incident) => (
                <IncidentRow
                  key={incident.id}
                  incident={incident}
                  selected={incident.id === selectedId}
                  onSelect={(i) => setSelectedId(i.id)}
                />
              ))
            )}
          </div>
        </Panel>

        {/* Selected incident */}
        <Panel flush className="min-h-0">
          {selected ? (
            <IncidentDetailPanel incident={selected} />
          ) : (
            <EmptyState title="No incident selected" description="Choose a call from the queue." />
          )}
        </Panel>

        {/* Unit board */}
        <Panel flush className="hidden min-h-0 xl:flex">
          <PanelHeader
            title="Unit board"
            icon={<Radio />}
            actions={<Badge variant="neutral" mono>{availableUnits.length} avail</Badge>}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {assignedUnits.length > 0 ? (
              <>
                <p className="bg-raised px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
                  Assigned to this call
                </p>
                {assignedUnits.map((u) => <UnitRow key={u.id} unit={u} />)}
              </>
            ) : null}
            <p className="bg-raised px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
              Available
            </p>
            {availableUnits.length === 0 ? (
              <EmptyState title="No available units" description="Every unit is currently engaged." />
            ) : (
              availableUnits.map((u) => <UnitRow key={u.id} unit={u} />)
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function IncidentDetailPanel({ incident }: { incident: MockIncident }) {
  const org = mockOrg(incident.organizationId);
  const units = MOCK_UNITS.filter((u) => incident.assignedUnitIds.includes(u.id));

  // Illustrative timeline — the real one is the append-only incident_log.
  const timeline = [
    { at: incident.createdAt, actor: 'System', text: `Incident created from ${incident.callerName ? 'caller report' : 'dispatch'}` },
    ...(units.length > 0
      ? [{ at: new Date(incident.createdAt.getTime() + 45_000), actor: 'Dispatch', text: `Assigned ${units.map((u) => u.callsign).join(', ')}` }]
      : []),
    ...(incident.status === 'on_scene'
      ? [{ at: new Date(incident.createdAt.getTime() + 180_000), actor: units[0]?.callsign ?? 'Unit', text: 'Arrived on scene' }]
      : []),
  ];

  return (
    <>
      <PanelHeader
        title={<span className="font-mono">{incident.number}</span>}
        icon={<TriangleAlert />}
        actions={
          <>
            <PriorityBadge priority={incident.priority} />
            <IncidentStatusBadge status={incident.status} />
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="border-b border-border-subtle p-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary">{incident.type}</h3>
            <OrgBadge shortName={org.shortName} color={org.color} />
          </div>
          <p className="mt-1 text-sm text-text-secondary">{incident.title}</p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Field label="Location" value={incident.locationText} />
            <Field label="Coordinates" value={`${incident.x.toFixed(0)}, ${incident.y.toFixed(0)}`} mono />
            <Field label="Elapsed" value={formatElapsed(incident.createdAt, MOCK_NOW)} mono />
            <Field label="Received" value={formatDateTime(incident.createdAt)} />
            <Field label="Caller" value={incident.callerName ?? '—'} />
            <Field label="Units" value={String(incident.assignedUnitIds.length)} mono />
          </dl>
        </div>

        <div className="border-b border-border-subtle">
          <p className="bg-raised px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
            Assigned units
          </p>
          {units.length === 0 ? (
            <EmptyState title="No units assigned" description="This call is waiting for a unit." />
          ) : (
            units.map((u) => <UnitRow key={u.id} unit={u} />)
          )}
        </div>

        <div>
          <p className="bg-raised px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
            Timeline
          </p>
          <ol className="p-3">
            {timeline.map((entry, i) => (
              <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                <div className="flex flex-col items-center">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden />
                  {i < timeline.length - 1 ? (
                    <span className="w-px flex-1 bg-border-subtle" aria-hidden />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <p className="text-xs text-text-primary">{entry.text}</p>
                  <p className="mt-0.5 font-mono text-2xs text-text-tertiary">
                    {formatDateTime(entry.at)} · {entry.actor}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="flex shrink-0 gap-1.5 border-t border-border-subtle p-2">
        <Tooltip content="Dispatch actions land in Phase 5">
          <Button variant="secondary" size="sm" disabled className="flex-1">Assign unit</Button>
        </Tooltip>
        <Tooltip content="Dispatch actions land in Phase 5">
          <Button variant="secondary" size="sm" disabled className="flex-1">Add note</Button>
        </Tooltip>
        <Tooltip content="Dispatch actions land in Phase 5">
          <Button variant="danger-outline" size="sm" disabled className="flex-1">Close call</Button>
        </Tooltip>
      </div>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className={`truncate text-xs text-text-primary ${mono ? 'font-mono tabular' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
