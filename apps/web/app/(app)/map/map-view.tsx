'use client';

import * as React from 'react';
import {
  Crosshair, Layers, Maximize2, Minimize2, PanelRightClose, PanelRightOpen,
  RefreshCw, ZoomIn, ZoomOut,
} from 'lucide-react';
import {
  EMPTY_MAP_FILTER, FRESHNESS_META, UNIT_TYPES, countActiveMapFilters,
  matchesIncidentFilter, matchesMarkerFilter, matchesUnitFilter,
  type LocationFreshness, type MapFilterState, type MapSnapshot, type MapUnit,
  type UnitPositionDelta, type Viewport, type WorldPosition,
} from '@leoos/contracts';
import {
  Alert, Badge, EmptyState, FilterBar, FilterChip, IconButton, Panel, PanelHeader,
  SearchInput,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { MapCanvas, type MapCanvasHandle } from '@/components/domain/map-canvas';
import { type MapDataSource, type MapConnectionState } from '@/lib/map/map-source';
import { MapUnitStore } from '@/lib/map/unit-store';
import { OffScreenPanicMarkers, PanicBar } from './panic-locator';
import { useRoster } from '@/lib/map/use-unit-store';
import { RealtimeMapSource } from '@/lib/map/realtime-map-source';

import { useRealtimeClient } from '@/lib/realtime/realtime-context';
import { mapTopics } from '@/lib/realtime/topics';
import { useAuth } from '@/components/shell/auth-context';
import { cn } from '@/lib/utils';
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
 * Nothing in this file knows how positions arrive. `RealtimeMapSource` takes
 * batched positions off the `map:units` topic and falls back to polling when the
 * socket is down; the swap was one constructor call, exactly as the interface
 * was designed for — see lib/map/map-source.ts and lib/map/realtime-map-source.ts.
 */

export function MapView({ initialSnapshot }: { initialSnapshot: MapSnapshot | null }) {
  const [snapshot, setSnapshot] = React.useState<MapSnapshot | null>(initialSnapshot);
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
  const [viewport, setViewport] = React.useState<Viewport | null>(null);

  const canvasRef = React.useRef<MapCanvasHandle>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const sourceRef = React.useRef<MapDataSource | null>(null);
  const auth = useAuth();
  const realtimeClient = useRealtimeClient();

  /**
   * Positions live HERE, not in React state.
   *
   * The store is created once and never replaced. Roster changes reach React
   * through `useRoster`; position batches reach only the canvas, which reads
   * them inside its own animation frame. That split is the reason a unit moving
   * does not re-render 150 list rows — see lib/map/unit-store.ts.
   */
  const [store] = React.useState(() => {
    const created = new MapUnitStore();
    if (initialSnapshot !== null) created.applySnapshot(initialSnapshot);
    return created;
  });
  React.useEffect(() => () => store.dispose(), [store]);

  const roster = useRoster(store);
  const units = roster.units;

  /**
   * Whether a unit could appear on THIS operator's dispatch board.
   *
   * The map shows units from every organization that shares on it; the dispatch
   * board shows the operator's own, unless they hold a global clearance. Used
   * only to decide whether offering "View unit" would be honest — the board
   * re-derives what it shows from the caller's scope server-side either way
   * (engineering rule 9).
   */
  const reachesDispatchBoard = React.useCallback(
    (unit: MapUnit) => unit.organization.id === auth.activeOrganizationId
      || auth.isGlobalAdmin
      || auth.globalCapabilities.includes('org_admin'),
    [auth.activeOrganizationId, auth.isGlobalAdmin, auth.globalCapabilities],
  );

  const capabilities = snapshot?.capabilities ?? null;
  const source = snapshot?.source ?? null;

  // ── Live feed ───────────────────────────────────────────────────────────
  //
  // The topic list is derived once from the operator's own identity. The server
  // authorizes each topic against their live permissions and silently drops the
  // ones they may not have, so nothing here is a permission check.
  const topics = React.useMemo(
    () => mapTopics({ userId: auth.userId, organizationId: auth.activeOrganizationId }),
    [auth.userId, auth.activeOrganizationId],
  );
  const topicKey = topics.join(' ');

  React.useEffect(() => {
    const feed = new RealtimeMapSource({
      client: realtimeClient,
      topics: topicKey === '' ? [] : topicKey.split(' '),
    });
    sourceRef.current = feed;

    feed.start({
      onSnapshot(next) {
        setSnapshot(next);
        store.applySnapshot(next);
      },
      onTick(tick) {
        /**
         * Straight into the store. NO setState.
         *
         * This is the line the whole architecture turns on: a position batch
         * updates the canvas and nothing else. Calling `setState` here — which
         * is what this used to do — re-rendered the entire screen once a second.
         */
        store.applyTick(tick);

        // A unit carrying an assignment this client has never seen needs the
        // richer read; the tick cannot describe an incident it does not carry.
        if (needsMetadataRefresh(store.getRosterSnapshot().units, tick.positions)) {
          sourceRef.current?.refresh();
        }
      },
      onStateChange(state, detail) {
        setConnection(state);
        setConnectionDetail(detail);
      },
    });

    return () => feed.stop();
  }, [realtimeClient, topicKey, store]);

  /**
   * The source needs to know what the client holds so it can report removals.
   *
   * Keyed on the roster VERSION, not on the array: the array is deliberately the
   * same object between roster changes, so depending on it would never fire.
   */
  React.useEffect(() => {
    sourceRef.current?.setKnownUnits(units.map((u) => u.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.version]);

  // ── Derived state ───────────────────────────────────────────────────────
  /**
   * The filtered list, recomputed on a ROSTER CHANGE, not on a position batch.
   *
   * Keyed on `roster.version` because the array is deliberately the same object
   * between roster changes — depending on the array would never invalidate, and
   * depending on positions would put us back where we started.
   *
   * Freshness comes from the store's precomputed levels rather than from a clock
   * read here, so this and the row badges cannot disagree about whether a unit
   * is stale.
   */
  const visibleUnits = React.useMemo(
    () => units.filter((u) => matchesUnitFilter(
      u,
      filter,
      // The store's precomputed level, not a clock read here. Its 1 Hz sweep is
      // what moves a unit across a threshold; this only reads the result.
      roster.freshness.get(u.id),
    )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roster.version, filter],
  );

  /** How many units sit at each level, for the filter chips' counts. */
  const freshnessCounts = React.useMemo(() => {
    const counts: Record<LocationFreshness, number> = {
      live: 0, stale: 0, offline: 0, unknown: 0,
    };
    for (const level of roster.freshness.values()) counts[level] += 1;
    return counts;
  }, [roster.freshness]);

  /**
   * Units in panic, and the ONE list the panic bar and the map agree on.
   *
   * Deliberately NOT filtered: a panic that an operator has hidden behind a
   * filter chip is a panic they will not see, and no filter should be able to do
   * that. Everything else on this screen is filterable; this is not.
   */
  const panicUnits = React.useMemo(
    () => units.filter((u) => u.status.key === 'panic'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roster.version],
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

  /**
   * Takes the operator to a unit.
   *
   * Centres rather than zooms: someone responding to a panic wants to be moved
   * to the place, not to have their scale changed underneath them. Selecting it
   * too means the detail panel is already open when they arrive.
   */
  const locateUnit = React.useCallback((unit: MapUnit) => {
    const at = store.positionOf(unit.id);
    if (at !== null) canvasRef.current?.centerOn(at);
    setSelectedUnitId(unit.id);
    setSelectedIncidentId(null);
    setSelectedMarkerId(null);
  }, [store]);

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
      {/*
        * ABOVE the filter bar, and unfilterable.
        *
        * A panic hidden behind a filter chip is a panic an operator will not
        * see, and no view control should be able to do that. Everything else on
        * this screen can be filtered away; this cannot.
        */}
      <PanicBar units={panicUnits} store={store} onLocate={locateUnit} />

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

        {/*
          * TRACKING, kept apart from Status on purpose.
          *
          * A unit's status is what the officer says they are doing; its
          * freshness is whether we still know where they are. They are different
          * kinds of fact, and a unit can perfectly well be "Available" and
          * offline — which is exactly the combination worth being able to find.
          */}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <span className="mr-1 text-2xs uppercase tracking-wide text-text-disabled">
          Tracking
        </span>
        {(['live', 'stale', 'offline'] as const).map((level) => (
          <FilterChip
            key={level}
            label={FRESHNESS_META[level].label}
            count={freshnessCounts[level]}
            active={filter.freshness.includes(level)}
            onToggle={() => setFilter((f) => ({
              ...f, freshness: toggleIn(f.freshness, level),
            }))}
          />
        ))}

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
          {/* Pinned to the map's edges, pointing at panics the viewport has cut
              off. Inside this relative container so the coordinates line up with
              the canvas rather than with the page. */}
          <OffScreenPanicMarkers
            units={panicUnits}
            store={store}
            viewport={viewport}
            onLocate={locateUnit}
          />
          <MapCanvas
            ref={canvasRef}
            store={store}
            filter={filter}
            onViewportChange={setViewport}
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
                store={store}
                onDispatchBoard={reachesDispatchBoard(selectedUnit)}
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
                      freshness={roster.freshness.get(unit.id) ?? 'unknown'}
                      onSelect={selectUnit}
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

/**
 * One row, MEMOISED, with freshness handed in.
 *
 * Two things were costing a render per second each, and both are gone:
 *
 *   Every row called `useNow()` to compute staleness, so 150 rows re-rendered
 *   once a second whether or not anything had changed. Freshness now arrives as
 *   a prop and only changes when a unit crosses a threshold.
 *
 *   The list rebuilt on every position batch. Positions no longer live in React
 *   state at all, so the array reaching this component is the same one until the
 *   roster genuinely changes.
 *
 * `React.memo` is what converts those into an actual saving: without it a parent
 * render still walks every child even when no prop differs.
 */
const MapUnitRow = React.memo(function MapUnitRow({
  unit, selected, freshness, onSelect,
}: {
  unit: MapUnit;
  selected: boolean;
  freshness: LocationFreshness;
  /**
   * Takes the unit, rather than being a closure over it.
   *
   * `onSelect={() => selectUnit(unit)}` builds a new function for every row on
   * every render, which makes `React.memo` compare unequal every time and does
   * precisely nothing. Passing the stable callback and letting the row supply
   * its own unit is what makes the memo real.
   */
  onSelect: (unit: MapUnit) => void;
}) {
  const type = UNIT_TYPES[unit.unitType as keyof typeof UNIT_TYPES];

  return (
    <button
      type="button"
      onClick={() => onSelect(unit)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-1.5 text-left',
        'transition-colors duration-(--duration-fast)',
        selected ? 'bg-active' : 'hover:bg-hover',
        freshness === 'stale' && 'opacity-70',
        freshness === 'offline' && 'opacity-50',
        // A panic row is marked structurally, not only by colour: a left rule
        // survives a monochrome display and a colour-blind reader.
        unit.status.key === 'panic' && 'border-l-2 border-l-[var(--status-panic)] bg-danger-subtle',
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
        {/* The LEVEL, not a ticking age. An age would re-render this row every
            second for a number nobody reads at that precision; the level is what
            an operator actually acts on, and it changes twice in a unit's life. */}
        <span
          className={cn(
            'font-mono text-2xs',
            freshness === 'live' && 'text-text-tertiary',
            freshness === 'stale' && 'text-warning',
            freshness === 'offline' && 'text-danger',
            freshness === 'unknown' && 'text-text-disabled',
          )}
        >
          {FRESHNESS_META[freshness].shortLabel}
        </span>
      </div>
    </button>
  );
});
