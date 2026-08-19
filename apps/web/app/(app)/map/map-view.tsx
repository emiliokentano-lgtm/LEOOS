'use client';

import * as React from 'react';
import {
  Crosshair, Layers, Maximize2, Minimize2, PanelRightClose, PanelRightOpen,
  RefreshCw, ZoomIn, ZoomOut,
} from 'lucide-react';
import {
  EMPTY_MAP_FILTER, UNIT_TYPES, countActiveMapFilters, freshnessOf,
  matchesIncidentFilter, matchesMarkerFilter, matchesUnitFilter,
  type MapFilterState, type MapSnapshot, type MapUnit,
  type UnitPositionDelta, type WorldPosition,
} from '@leoos/contracts';
import {
  Alert, Badge, EmptyState, FilterBar, FilterChip, IconButton, Panel, PanelHeader,
  SearchInput,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { MapCanvas, type MapCanvasHandle } from '@/components/domain/map-canvas';
import { HttpMapSource, applyTick, type MapConnectionState } from '@/lib/map/map-source';
import { useNow } from '@/lib/map/use-now';
import { cn, timeAgo } from '@/lib/utils';
import { MarkerDialog } from './marker-dialog';
import { UnitDetail, IncidentDetail, MarkerDetail } from './map-details';

/**
 * Live map screen.
 *
 * Full-bleed map with floating chrome: the map is the tool, so panels sit on top
 * of it rather than shrinking it. Left, the filter bar. Right, the unit list and
 * the selection detail — collapsible, because during a pursuit the map is the
 * only thing worth looking at.
 *
 * THE DATA FLOW, which is the part that has to survive the FiveM integration:
 *
 *   server-rendered snapshot ─┐
 *                             ├─▶ units/incidents/markers state ─▶ canvas
 *   MapDataSource ticks ──────┘
 *
 * Nothing in this file knows how positions arrive. `HttpMapSource` polls today;
 * a `SocketMapSource` will push tomorrow. Swapping them is one constructor call
 * — see lib/map/map-source.ts.
 */

export function MapView({ initialSnapshot }: { initialSnapshot: MapSnapshot | null }) {
  const [snapshot, setSnapshot] = React.useState<MapSnapshot | null>(initialSnapshot);
  const [units, setUnits] = React.useState<MapUnit[]>(initialSnapshot?.units ?? []);
  const [connection, setConnection] = React.useState<MapConnectionState>('connecting');
  const [connectionDetail, setConnectionDetail] = React.useState<string | null>(null);

  const [filter, setFilter] = React.useState<MapFilterState>(EMPTY_MAP_FILTER);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [fullscreen, setFullscreen] = React.useState(false);

  const [selectedUnitId, setSelectedUnitId] = React.useState<string | null>(null);
  const [selectedIncidentId, setSelectedIncidentId] = React.useState<string | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = React.useState<string | null>(null);
  const [followUnitId, setFollowUnitId] = React.useState<string | null>(null);
  const [pendingMarker, setPendingMarker] = React.useState<WorldPosition | null>(null);

  const canvasRef = React.useRef<MapCanvasHandle>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const sourceRef = React.useRef<HttpMapSource | null>(null);

  const capabilities = snapshot?.capabilities ?? null;
  const source = snapshot?.source ?? null;

  // ── Live feed ───────────────────────────────────────────────────────────
  React.useEffect(() => {
    const feed = new HttpMapSource();
    sourceRef.current = feed;

    feed.start({
      onSnapshot(next) {
        setSnapshot(next);
        setUnits(next.units);
      },
      onTick(tick) {
        // The merge lives in the source module so the socket implementation
        // cannot merge differently from the poller.
        setUnits((current) => {
          if (needsMetadataRefresh(current, tick.positions)) {
            // A unit was assigned to a call this client has never seen. Pull a
            // snapshot rather than guess at the incident's number and priority.
            sourceRef.current?.refresh();
          }
          return applyTick(current, tick, mergeDelta);
        });
      },
      onStateChange(state, detail) {
        setConnection(state);
        setConnectionDetail(detail);
      },
    });

    return () => feed.stop();
  }, []);

  // The source needs to know what the client holds so it can report removals.
  React.useEffect(() => {
    sourceRef.current?.setKnownUnits(units.map((u) => u.id));
  }, [units]);

  // ── Derived state ───────────────────────────────────────────────────────
  const visibleUnits = React.useMemo(
    () => units.filter((u) => matchesUnitFilter(u, filter)),
    [units, filter],
  );
  const visibleIncidents = React.useMemo(
    () => (snapshot?.incidents ?? []).filter((i) => matchesIncidentFilter(i, filter)),
    [snapshot, filter],
  );
  const visibleMarkers = React.useMemo(
    () => (snapshot?.markers ?? []).filter((m) => matchesMarkerFilter(m, filter)),
    [snapshot, filter],
  );

  const selectedUnit = visibleUnits.find((u) => u.id === selectedUnitId)
    ?? units.find((u) => u.id === selectedUnitId) ?? null;
  const selectedIncident = (snapshot?.incidents ?? []).find((i) => i.id === selectedIncidentId)
    ?? null;
  const selectedMarker = (snapshot?.markers ?? []).find((m) => m.id === selectedMarkerId) ?? null;

  const activeFilters = countActiveMapFilters(filter);

  // Memoised: a fresh array identity each render would re-bind the keyboard
  // handler on every tick, which is once a second.
  const organizations = React.useMemo(
    () => snapshot?.organizations ?? [], [snapshot],
  );
  const statusOptions = React.useMemo(() => {
    // Statuses come from the data, not from a hardcoded list — an organization
    // can define its own (engineering rules 5-7), and a filter bar built from a
    // constant would silently omit them.
    const seen = new Map<string, { key: string; label: string; token: string }>();
    for (const unit of units) {
      if (!seen.has(unit.status.key)) {
        seen.set(unit.status.key, {
          key: unit.status.key,
          label: unit.status.shortLabel || unit.status.label,
          token: unit.status.colorToken,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [units]);

  const unitTypeOptions = React.useMemo(() => {
    const seen = new Set(units.map((u) => u.unitType));
    return [...seen].sort();
  }, [units]);

  const vehicleClassOptions = React.useMemo(() => {
    const seen = new Set(
      units.map((u) => u.vehicle?.vehicleClass).filter((c): c is string => Boolean(c)),
    );
    return [...seen].sort();
  }, [units]);

  // ── Selection ───────────────────────────────────────────────────────────
  const selectUnit = React.useCallback((unit: MapUnit | null) => {
    setSelectedUnitId(unit?.id ?? null);
    if (unit) { setSelectedIncidentId(null); setSelectedMarkerId(null); }
    if (unit === null) setFollowUnitId(null);
  }, []);

  const clearSelection = React.useCallback(() => {
    setSelectedUnitId(null);
    setSelectedIncidentId(null);
    setSelectedMarkerId(null);
    setFollowUnitId(null);
  }, []);

  // ── Keyboard ────────────────────────────────────────────────────────────
  /**
   * Dispatchers work by keyboard, not by mouse (05-map.md §6).
   *
   * `F` follows, `Esc` deselects, `1`–`9` toggle organization filters in the
   * order they are drawn in the filter bar. Typing in an input is excluded, or
   * searching for a unit called "Fox" would start following something.
   */
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (pendingMarker !== null) { setPendingMarker(null); return; }
        clearSelection();
        return;
      }

      if (event.key === 'f' || event.key === 'F') {
        if (selectedUnitId === null) return;
        event.preventDefault();
        setFollowUnitId((current) => (current === selectedUnitId ? null : selectedUnitId));
        return;
      }

      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= organizations.length) {
        event.preventDefault();
        const org = organizations[digit - 1]!;
        setFilter((current) => ({
          ...current,
          organizationIds: current.organizationIds.includes(org.id)
            ? current.organizationIds.filter((id) => id !== org.id)
            : [...current.organizationIds, org.id],
        }));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, organizations, pendingMarker, selectedUnitId]);

  // ── Fullscreen ──────────────────────────────────────────────────────────
  React.useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  async function toggleFullscreen() {
    if (document.fullscreenElement !== null) {
      await document.exitFullscreen();
      return;
    }
    // Not fatal if refused — some browsers and embedded contexts decline.
    await containerRef.current?.requestFullscreen().catch(() => {});
  }

  function toggleIn<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  const followedUnit = followUnitId === null
    ? null
    : units.find((u) => u.id === followUnitId) ?? null;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-base">
      <FilterBar
        activeCount={activeFilters}
        onClearAll={() => setFilter(EMPTY_MAP_FILTER)}
        trailing={
          <>
            <SearchInput
              value={filter.query}
              onValueChange={(query) => setFilter((f) => ({ ...f, query }))}
              placeholder="Find unit, officer or plate…"
              inputSize="sm"
              className="w-[210px]"
            />
            <IconButton
              label={fullscreen ? 'Exit full screen' : 'Full screen'}
              size="sm"
              onClick={() => { void toggleFullscreen(); }}
            >
              {fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </IconButton>
            <IconButton
              label={panelOpen ? 'Hide side panel' : 'Show side panel'}
              size="sm"
              onClick={() => setPanelOpen((open) => !open)}
            >
              {panelOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
            </IconButton>
          </>
        }
      >
        <span className="mr-1 flex items-center gap-1 text-2xs uppercase tracking-wide text-text-disabled">
          <Layers className="size-3" aria-hidden /> Organizations
        </span>
        {organizations.map((org, index) => (
          <FilterChip
            key={org.id}
            // The chip shows the unit count only. It previously also carried the
            // keyboard index, which put two unrelated numbers side by side —
            // "ARMY 1 1" reads as neither. The shortcut is in the legend.
            label={org.shortName}
            title={`Toggle ${org.shortName} — key ${index + 1}`}
            color={org.color}
            active={filter.organizationIds.includes(org.id)}
            count={units.filter((u) => u.organization.id === org.id).length}
            onToggle={() => setFilter((f) => ({
              ...f, organizationIds: toggleIn(f.organizationIds, org.id),
            }))}
          />
        ))}

        {statusOptions.length > 0 ? (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <span className="mr-1 text-2xs uppercase tracking-wide text-text-disabled">Status</span>
            {statusOptions.map((status) => (
              <FilterChip
                key={status.key}
                label={status.label}
                color={`var(${status.token})`}
                active={filter.statusKeys.includes(status.key)}
                onToggle={() => setFilter((f) => ({
                  ...f, statusKeys: toggleIn(f.statusKeys, status.key),
                }))}
              />
            ))}
          </>
        ) : null}

        {unitTypeOptions.length > 0 ? (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <span className="mr-1 text-2xs uppercase tracking-wide text-text-disabled">Type</span>
            {unitTypeOptions.map((type) => (
              <FilterChip
                key={type}
                label={UNIT_TYPES[type as keyof typeof UNIT_TYPES]?.label ?? type}
                active={filter.unitTypes.includes(type)}
                onToggle={() => setFilter((f) => ({
                  ...f, unitTypes: toggleIn(f.unitTypes, type),
                }))}
              />
            ))}
          </>
        ) : null}

        {vehicleClassOptions.length > 0 ? (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <span className="mr-1 text-2xs uppercase tracking-wide text-text-disabled">Vehicle</span>
            {vehicleClassOptions.map((cls) => (
              <FilterChip
                key={cls}
                label={cls}
                active={filter.vehicleClasses.includes(cls)}
                onToggle={() => setFilter((f) => ({
                  ...f, vehicleClasses: toggleIn(f.vehicleClasses, cls),
                }))}
              />
            ))}
          </>
        ) : null}

        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <FilterChip
          label="Assigned only"
          active={filter.onlyAssigned}
          onToggle={() => setFilter((f) => ({ ...f, onlyAssigned: !f.onlyAssigned }))}
        />
        <FilterChip
          label="Incidents"
          active={filter.showIncidents}
          count={snapshot?.incidents.length ?? 0}
          onToggle={() => setFilter((f) => ({ ...f, showIncidents: !f.showIncidents }))}
        />
        <FilterChip
          label="Markers"
          active={filter.showMarkers}
          count={snapshot?.markers.length ?? 0}
          onToggle={() => setFilter((f) => ({ ...f, showMarkers: !f.showMarkers }))}
        />
      </FilterBar>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <MapCanvas
            ref={canvasRef}
            units={visibleUnits}
            incidents={visibleIncidents}
            markers={visibleMarkers}
            selectedUnitId={selectedUnitId}
            selectedIncidentId={selectedIncidentId}
            selectedMarkerId={selectedMarkerId}
            followUnitId={followUnitId}
            onSelectUnit={selectUnit}
            onSelectIncident={(incident) => {
              setSelectedIncidentId(incident.id);
              setSelectedUnitId(null);
              setSelectedMarkerId(null);
            }}
            onSelectMarker={(marker) => {
              setSelectedMarkerId(marker.id);
              setSelectedUnitId(null);
              setSelectedIncidentId(null);
            }}
            onContextMenu={capabilities?.canManageMarkers
              ? (position) => setPendingMarker(position)
              : undefined}
            className="absolute inset-0"
          />

          {/* One overlay column at the top, so the banner and the follow chip
              stack instead of drawing on top of each other. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 p-3">
            <MapStatusBanner
              source={source}
              connection={connection}
              detail={connectionDetail}
              unavailable={snapshot === null}
            />
            {followedUnit ? (
              <button
                type="button"
                onClick={() => setFollowUnitId(null)}
                className="pointer-events-auto flex items-center gap-2 rounded-xs border border-accent bg-surface/95 px-2.5 py-1 text-xs text-text-primary"
              >
                <Crosshair className="size-3 text-accent" aria-hidden />
                Following <span className="font-mono">{followedUnit.callsign}</span>
                <kbd className="text-[10px] text-text-disabled">Esc</kbd>
              </button>
            ) : null}
          </div>

          {/* Viewport controls. Zoom buttons matter on trackpads, where wheel
              zoom is easy to overshoot. */}
          <div className="absolute right-3 top-3 flex flex-col gap-1">
            <IconButton
              label="Zoom in" size="sm" variant="secondary"
              onClick={() => canvasRef.current?.zoomBy(1.4)}
            >
              <ZoomIn aria-hidden />
            </IconButton>
            <IconButton
              label="Zoom out" size="sm" variant="secondary"
              onClick={() => canvasRef.current?.zoomBy(1 / 1.4)}
            >
              <ZoomOut aria-hidden />
            </IconButton>
            <IconButton
              label="Fit to units" size="sm" variant="secondary"
              onClick={() => canvasRef.current?.fitTo(
                visibleUnits
                  .map((u) => u.location)
                  .filter((l): l is NonNullable<typeof l> => l !== null),
              )}
            >
              <Crosshair aria-hidden />
            </IconButton>
            <IconButton
              label="Whole map" size="sm" variant="secondary"
              onClick={() => canvasRef.current?.reset()}
            >
              <RefreshCw aria-hidden />
            </IconButton>
          </div>

          <MapLegend />
        </div>

        {panelOpen ? (
          <div className="flex w-[330px] shrink-0 flex-col gap-3 overflow-auto border-l border-border-subtle bg-base p-3">
            {selectedUnit ? (
              <UnitDetail
                unit={selectedUnit}
                following={followUnitId === selectedUnit.id}
                canAssign={capabilities?.canAssignUnits ?? false}
                onToggleFollow={() => setFollowUnitId(
                  (current) => (current === selectedUnit.id ? null : selectedUnit.id),
                )}
                onClose={() => selectUnit(null)}
              />
            ) : selectedIncident ? (
              <IncidentDetail
                incident={selectedIncident}
                onClose={() => setSelectedIncidentId(null)}
              />
            ) : selectedMarker ? (
              <MarkerDetail
                marker={selectedMarker}
                canManage={capabilities?.canManageMarkers ?? false}
                onClose={() => setSelectedMarkerId(null)}
              />
            ) : null}

            <Panel flush className="min-h-0 flex-1">
              <PanelHeader
                title="Units on map"
                actions={
                  <Badge variant="neutral" mono>
                    {visibleUnits.length}
                    {visibleUnits.length !== units.length ? ` / ${units.length}` : ''}
                  </Badge>
                }
              />
              <div className="min-h-0 flex-1 overflow-auto">
                {units.length === 0 ? (
                  <EmptyState
                    title="No units on the map"
                    description={
                      capabilities?.canTrackUnits === false
                        ? 'You can view the map but not track unit positions.'
                        : 'No unit is currently reporting a position.'
                    }
                  />
                ) : visibleUnits.length === 0 ? (
                  <EmptyState
                    variant="filtered"
                    title="No units match"
                    description="Adjust the filters above."
                  />
                ) : (
                  visibleUnits.map((unit) => (
                    <MapUnitRow
                      key={unit.id}
                      unit={unit}
                      selected={unit.id === selectedUnitId}
                      onSelect={() => selectUnit(unit)}
                    />
                  ))
                )}
              </div>
            </Panel>
          </div>
        ) : null}
      </div>

      {pendingMarker !== null ? (
        <MarkerDialog
          position={pendingMarker}
          organizations={organizations}
          canPlaceGlobal={capabilities?.canTrackAllOrganizations ?? false}
          onClose={() => setPendingMarker(null)}
          onPlaced={() => {
            setPendingMarker(null);
            sourceRef.current?.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Applies one position delta to a unit.
 *
 * TWO THINGS THE TICK CANNOT DO ON ITS OWN, both deliberate:
 *
 *   The status LABEL and colour are not in the delta — only the key is, to keep
 *   a 300-unit tick under 5 KB. A key whose presentation the client does not
 *   know keeps the old label rather than rendering an empty badge, and the next
 *   snapshot corrects it.
 *
 *   An incident the client has no metadata for cannot be rendered from a delta
 *   either. The previous assignment is kept rather than blanked, and
 *   `needsMetadataRefresh` below tells the screen to pull a snapshot — which is
 *   a sub-second correction instead of a flicker to "unassigned" and back.
 */
function mergeDelta(unit: MapUnit, delta: UnitPositionDelta): MapUnit {
  return {
    ...unit,
    status: unit.status.key === delta.statusKey
      ? unit.status
      : { ...unit.status, key: delta.statusKey },
    incident: delta.incidentId === null ? null : unit.incident,
    location: {
      unitId: unit.id,
      organizationId: unit.organization.id,
      x: delta.x,
      y: delta.y,
      z: unit.location?.z ?? null,
      heading: delta.heading,
      speed: delta.speed,
      updatedAt: delta.updatedAt,
    },
  };
}

/**
 * Whether any delta references an incident the client cannot describe.
 *
 * Called during a state update, so it is a pure read of both arguments — the
 * refresh it triggers is a side effect on the source, not on React state.
 */
function needsMetadataRefresh(
  units: readonly MapUnit[],
  positions: readonly UnitPositionDelta[],
): boolean {
  const byId = new Map(units.map((u) => [u.id, u]));
  return positions.some((delta) => {
    if (delta.incidentId === null) return false;
    const unit = byId.get(delta.unitId);
    return unit !== undefined && unit.incident?.id !== delta.incidentId;
  });
}

/**
 * States the truth about the feed, in one place.
 *
 * Two independent facts, and conflating them would be misleading: the BASE LAYER
 * is a placeholder because tiles are unlicensed, and the POSITION FEED is a
 * simulator because no FiveM bridge exists. Either can be resolved without the
 * other, so each is stated separately (engineering rules 34, 35, 45).
 */
function MapStatusBanner({
  source, connection, detail, unavailable,
}: {
  source: MapSnapshot['source'] | null;
  connection: MapConnectionState;
  detail: string | null;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <Alert tone="danger" title="The map is unavailable" className="pointer-events-auto max-w-lg">
        The map service could not be reached. Positions shown elsewhere may be out of date.
      </Alert>
    );
  }

  const simulated = source?.kind === 'mock';
  const feedTrouble = connection === 'reconnecting' || connection === 'failed';

  return (
    <>
      {feedTrouble ? (
        <Alert
          tone={connection === 'failed' ? 'danger' : 'warning'}
          title={connection === 'failed' ? 'Position feed stopped' : 'Reconnecting to the feed'}
          className="pointer-events-auto max-w-lg"
        >
          {detail ?? 'Positions are not updating. Markers show the last known location.'}
        </Alert>
      ) : null}

      <Alert
        tone="warning"
        title={simulated ? 'Simulated map' : 'Placeholder base layer'}
        className="pointer-events-auto max-w-lg shadow-(--shadow-overlay)"
      >
        {simulated
          ? 'No FiveM bridge is connected — unit movement is simulated, not live. '
          : ''}
        The GTA V raster tiles are not licensed yet, so the background is a coordinate
        grid. Positions use the real world transform, so nothing moves when tiles arrive.
      </Alert>
    </>
  );
}

/** Colour is never the only signal, so the legend explains shape and fill too. */
function MapLegend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border-subtle bg-surface/95 p-2.5 text-2xs">
      <p className="mb-1.5 font-semibold uppercase tracking-wide text-text-tertiary">Legend</p>
      <ul className="flex flex-col gap-1 text-text-secondary">
        <li>▶ Unit — points to heading</li>
        <li>▲ Incident — colour is priority</li>
        <li>◆ Marker — hazard, roadblock, staging</li>
        <li>Filled = available · hollow = engaged</li>
        <li>Faded = no update in 15s · dashed ring = covert</li>
        <li>Numbered circle = several units, click to zoom</li>
        <li className="pt-1 text-text-tertiary">
          Keys: <kbd>F</kbd> follow · <kbd>Esc</kbd> deselect · <kbd>1</kbd>–<kbd>9</kbd> organizations
        </li>
      </ul>
    </div>
  );
}

function MapUnitRow({
  unit, selected, onSelect,
}: {
  unit: MapUnit;
  selected: boolean;
  onSelect: () => void;
}) {
  const now = useNow();
  const freshness = freshnessOf(unit.location, now);
  const type = UNIT_TYPES[unit.unitType as keyof typeof UNIT_TYPES];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-1.5 text-left',
        'transition-colors duration-(--duration-fast)',
        selected ? 'bg-active' : 'hover:bg-hover',
        freshness !== 'live' && 'opacity-60',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-text-tertiary">
        <Icon name={type?.icon ?? 'Car'} className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold text-text-primary">{unit.callsign}</span>
          <span
            className="rounded-[2px] border px-1 text-[9px] font-medium"
            style={{ borderColor: unit.organization.color, color: unit.organization.color }}
          >
            {unit.organization.shortName}
          </span>
          {unit.isCovert ? (
            <span className="text-[9px] uppercase tracking-wide text-text-disabled">covert</span>
          ) : null}
        </div>
        <p className="truncate text-2xs text-text-tertiary">
          {unit.crew.length > 0 ? unit.crew.map((c) => c.name).join(', ') : 'No crew'}
          {unit.vehicle ? ` · ${unit.vehicle.displayName ?? unit.vehicle.model}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className="rounded-xs border px-1 text-[10px]"
          style={{
            borderColor: `var(${unit.status.colorToken})`,
            color: `var(${unit.status.colorToken})`,
          }}
        >
          {unit.status.shortLabel || unit.status.label}
        </span>
        <span className="font-mono text-2xs text-text-tertiary">
          {unit.location === null || now === 0
            ? 'no fix'
            : timeAgo(new Date(unit.location.updatedAt), new Date(now))}
        </span>
      </div>
    </button>
  );
}
