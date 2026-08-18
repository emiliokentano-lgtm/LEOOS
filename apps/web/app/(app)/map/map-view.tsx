'use client';

import * as React from 'react';
import { Crosshair, Layers, PanelRightClose, PanelRightOpen, TriangleAlert } from 'lucide-react';
import { DUTY_STATUS_LIST, DUTY_STATUSES, UNIT_TYPES, formatWorldPosition, headingToCompass } from '@leoos/contracts';
import {
  Alert, Badge, Button, DutyStatusBadge, FilterBar, FilterChip, IconButton,
  OrgBadge, Panel, PanelHeader, PriorityBadge, SearchInput, EmptyState, Tooltip,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { MapCanvas } from '@/components/domain/map-canvas';
import { UnitRow } from '@/components/domain/unit-row';
import { cn, timeAgo } from '@/lib/utils';
import { MOCK_INCIDENTS, MOCK_NOW, MOCK_UNITS, type MockIncident, type MockUnit } from '@/mocks/operations';
import { MOCK_ORGANIZATIONS, mockOrg } from '@/mocks/organizations';

/**
 * Map screen.
 *
 * Full-bleed map with overlaid chrome — the map is the tool, so panels float on
 * top of it rather than shrinking it. Left: filters. Right: unit list and
 * selection detail, collapsible for a clean operational view.
 */
export function MapView() {
  const [orgFilter, setOrgFilter] = React.useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = React.useState<Set<string>>(new Set());
  const [query, setQuery] = React.useState('');
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [selectedUnit, setSelectedUnit] = React.useState<MockUnit | null>(null);
  const [selectedIncident, setSelectedIncident] = React.useState<MockIncident | null>(null);

  const visibleUnits = React.useMemo(() => {
    return MOCK_UNITS.filter((u) => {
      if (!DUTY_STATUSES[u.status].isOnDuty) return false;
      if (orgFilter.size > 0 && !orgFilter.has(u.organizationId)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(u.status)) return false;
      if (query && !`${u.callsign} ${u.memberNames.join(' ')}`.toLowerCase().includes(query.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [orgFilter, statusFilter, query]);

  const visibleIncidents = React.useMemo(
    () => MOCK_INCIDENTS.filter((i) => i.status !== 'closed' && i.status !== 'cancelled'),
    [],
  );

  const activeFilters = orgFilter.size + statusFilter.size;

  function toggle(set: Set<string>, key: string, apply: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    apply(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={() => { setOrgFilter(new Set()); setStatusFilter(new Set()); }}
        trailing={
          <>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              placeholder="Find unit or officer…"
              inputSize="sm"
              className="w-[200px]"
            />
            <IconButton
              label={panelOpen ? 'Hide side panel' : 'Show side panel'}
              size="sm"
              onClick={() => setPanelOpen((p) => !p)}
            >
              {panelOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
            </IconButton>
          </>
        }
      >
        <span className="mr-1 flex items-center gap-1 text-2xs uppercase tracking-wide text-text-disabled">
          <Layers className="size-3" aria-hidden /> Organizations
        </span>
        {MOCK_ORGANIZATIONS.map((org) => (
          <FilterChip
            key={org.id}
            label={org.shortName}
            color={org.color}
            active={orgFilter.has(org.id)}
            count={MOCK_UNITS.filter((u) => u.organizationId === org.id && DUTY_STATUSES[u.status].isOnDuty).length}
            onToggle={() => toggle(orgFilter, org.id, setOrgFilter)}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <span className="mr-1 text-2xs uppercase tracking-wide text-text-disabled">Status</span>
        {DUTY_STATUS_LIST.filter((s) => s.isOnDuty).map((s) => (
          <FilterChip
            key={s.key}
            label={s.label}
            color={`var(${s.token})`}
            active={statusFilter.has(s.key)}
            onToggle={() => toggle(statusFilter, s.key, setStatusFilter)}
          />
        ))}
      </FilterBar>

      <div className="relative flex min-h-0 flex-1">
        {/* Map surface */}
        <div className="relative min-w-0 flex-1 bg-base">
          <MapCanvas
            units={visibleUnits}
            incidents={visibleIncidents}
            selectedUnitId={selectedUnit?.id ?? null}
            onSelectUnit={(u) => { setSelectedUnit(u); if (u) setSelectedIncident(null); }}
            onSelectIncident={(i) => { setSelectedIncident(i); setSelectedUnit(null); }}
            className="absolute inset-0"
          />

          {/* Honest state banner: the base layer is not the real map yet. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
            <Alert
              tone="warning"
              title="Placeholder base layer"
              className="pointer-events-auto max-w-lg shadow-(--shadow-overlay)"
            >
              Unit and incident positions use the real coordinate transform, but the GTA V
              raster tiles are not yet licensed, so the background is a coordinate grid.
              Live FiveM data is not connected.
            </Alert>
          </div>

          {/* Legend — colour is never the only signal, so the legend explains
              shape and fill too. */}
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border-subtle bg-surface/95 p-2.5 text-2xs">
            <p className="mb-1.5 font-semibold uppercase tracking-wide text-text-tertiary">Legend</p>
            <ul className="flex flex-col gap-1 text-text-secondary">
              <li className="flex items-center gap-2"><span className="text-text-primary">▶</span> Unit — points to heading</li>
              <li className="flex items-center gap-2"><span className="text-text-primary">▲</span> Incident — colour is priority</li>
              <li className="flex items-center gap-2"><span className="inline-block size-2 rounded-full bg-status-available" aria-hidden /> Filled = available</li>
              <li className="flex items-center gap-2"><span className="inline-block size-2 rounded-full border border-status-busy" aria-hidden /> Hollow = engaged</li>
            </ul>
          </div>
        </div>

        {/* Right panel */}
        {panelOpen ? (
          <div className="flex w-[320px] shrink-0 flex-col gap-3 overflow-auto border-l border-border-subtle bg-base p-3">
            {selectedUnit ? (
              <UnitDetail unit={selectedUnit} onClose={() => setSelectedUnit(null)} />
            ) : selectedIncident ? (
              <IncidentDetail incident={selectedIncident} onClose={() => setSelectedIncident(null)} />
            ) : null}

            <Panel flush className="min-h-0 flex-1">
              <PanelHeader
                title="Units on map"
                actions={<Badge variant="neutral" mono>{visibleUnits.length}</Badge>}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                {visibleUnits.length === 0 ? (
                  <EmptyState
                    variant="filtered"
                    title="No units match"
                    description="Adjust the organization or status filters."
                  />
                ) : (
                  visibleUnits.map((unit) => (
                    <UnitRow
                      key={unit.id}
                      unit={unit}
                      selected={selectedUnit?.id === unit.id}
                      onSelect={(u) => { setSelectedUnit(u); setSelectedIncident(null); }}
                    />
                  ))
                )}
              </div>
            </Panel>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UnitDetail({ unit, onClose }: { unit: MockUnit; onClose: () => void }) {
  const org = mockOrg(unit.organizationId);
  const type = UNIT_TYPES[unit.unitType];
  const incident = unit.incidentId ? MOCK_INCIDENTS.find((i) => i.id === unit.incidentId) : undefined;

  return (
    <Panel flush>
      <PanelHeader
        title={<span className="font-mono">{unit.callsign}</span>}
        icon={<Icon name={type.icon} />}
        actions={<IconButton label="Close" size="xs" onClick={onClose}><PanelRightClose aria-hidden /></IconButton>}
      />
      <dl className="flex flex-col gap-2 p-3 text-xs">
        <Row label="Organization"><OrgBadge shortName={org.shortName} color={org.color} /></Row>
        <Row label="Status"><DutyStatusBadge status={unit.status} /></Row>
        <Row label="Type">{type.label}</Row>
        <Row label="Crew">
          <span className="text-right">{unit.memberNames.join(', ')}</span>
        </Row>
        {unit.vehicle ? (
          <>
            <Row label="Vehicle">{unit.vehicle}</Row>
            <Row label="Plate"><span className="font-mono">{unit.vehiclePlate}</span></Row>
          </>
        ) : null}
        <Row label="Position">
          <span className="font-mono">{formatWorldPosition({ x: unit.x, y: unit.y })}</span>
        </Row>
        <Row label="Heading">
          <span className="font-mono">
            {unit.heading.toFixed(0)}° {headingToCompass(unit.heading)}
          </span>
        </Row>
        <Row label="Last update">
          <span className="font-mono">{timeAgo(unit.lastUpdate, MOCK_NOW)}</span>
        </Row>
        {incident ? (
          <Row label="Assignment">
            <span className="flex items-center gap-1.5">
              <PriorityBadge priority={incident.priority} />
              <span className="font-mono">{incident.number}</span>
            </span>
          </Row>
        ) : null}
      </dl>
      <div className="flex gap-1.5 border-t border-border-subtle p-2">
        <Button variant="secondary" size="sm" className="flex-1">
          <Crosshair aria-hidden /> Follow
        </Button>
        <Tooltip content="Assignment requires the dispatch module (Phase 5)">
          <Button variant="secondary" size="sm" className="flex-1" disabled>Assign</Button>
        </Tooltip>
      </div>
    </Panel>
  );
}

function IncidentDetail({ incident, onClose }: { incident: MockIncident; onClose: () => void }) {
  const org = mockOrg(incident.organizationId);
  return (
    <Panel flush>
      <PanelHeader
        title={<span className="font-mono">{incident.number}</span>}
        icon={<TriangleAlert />}
        actions={<IconButton label="Close" size="xs" onClick={onClose}><PanelRightClose aria-hidden /></IconButton>}
      />
      <dl className="flex flex-col gap-2 p-3 text-xs">
        <Row label="Priority"><PriorityBadge priority={incident.priority} /></Row>
        <Row label="Type">{incident.type}</Row>
        <Row label="Organization"><OrgBadge shortName={org.shortName} color={org.color} /></Row>
        <Row label="Location"><span className="text-right">{incident.locationText}</span></Row>
        <Row label="Units">{incident.assignedUnitIds.length || 'None'}</Row>
      </dl>
      <p className="border-t border-border-subtle px-3 py-2 text-xs text-text-secondary">
        {incident.title}
      </p>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className={cn('min-w-0 text-right text-text-primary')}>{children}</dd>
    </div>
  );
}
