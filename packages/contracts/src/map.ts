import type { IncidentPriority, IncidentStatusKey } from './statuses';

/**
 * Map subsystem contracts.
 *
 * These types are the seam between the map UI and whatever is feeding it. Today
 * that is a REST snapshot plus a polled tick, driven by a MOCK position source
 * because no FiveM bridge exists yet; later it is the `map:units` WebSocket topic
 * (docs/architecture/03-realtime.md §3) driven by the game server. Neither the
 * canvas renderer nor the map screen knows which — they consume `MapSnapshot`
 * and `MapTick`, and the source is chosen behind `MapDataSource`.
 *
 * Two deliberate decisions worth stating, because they are the ones that make
 * the swap safe:
 *
 *   • POSITIONS ARE WORLD COORDINATES, not latitude/longitude. The brief sketched
 *     a `{ latitude, longitude }` shape; GTA has neither. Storing world metres
 *     means the transform can be re-calibrated, or the tile set replaced, without
 *     touching a single stored or in-flight coordinate. Conversion happens at the
 *     render edge, through `geo.ts`.
 *
 *   • WHAT IS ABSENT FROM THESE OBJECTS IS THE SECURITY BOUNDARY. A unit the
 *     caller may not see is not marked hidden — it is not in the array. Filtering
 *     happens server-side before serialisation (docs/architecture/05-map.md §5),
 *     because anything sent to a browser is readable regardless of what the UI
 *     does with it.
 */

// ── Live position ──────────────────────────────────────────────────────────

/**
 * One unit's last known position.
 *
 * `updatedAt` is the sample time, not the send time: staleness is a property of
 * the data, and a marker that stopped updating four minutes ago must read as
 * stale even though the socket delivering it is perfectly healthy.
 */
export interface UnitLocation {
  unitId: string;
  organizationId: string;
  /** World metres. */
  x: number;
  y: number;
  z: number | null;
  /** Degrees, 0 = north, clockwise. Null when the source does not report it. */
  heading: number | null;
  /** Metres per second, when known. Drives interpolation confidence. */
  speed: number | null;
  updatedAt: string;
}

// ── Map entities ───────────────────────────────────────────────────────────

export interface MapOrganizationRef {
  id: string;
  key: string;
  shortName: string;
  color: string;
}

export interface MapCrewMember {
  memberId: string;
  name: string;
  callsign: string | null;
  isLeader: boolean;
}

export interface MapVehicleRef {
  id: string;
  plate: string;
  model: string;
  displayName: string | null;
  vehicleClass: string | null;
}

export interface MapIncidentRef {
  id: string;
  number: string;
  title: string;
  priority: IncidentPriority;
  status: IncidentStatusKey;
}

export interface MapUnit {
  id: string;
  callsign: string;
  name: string | null;
  unitType: string;
  organization: MapOrganizationRef;
  status: {
    key: string;
    label: string;
    shortLabel: string;
    colorToken: string;
    icon: string;
    isAvailable: boolean;
    isOnDuty: boolean;
  };
  crew: MapCrewMember[];
  vehicle: MapVehicleRef | null;
  incident: MapIncidentRef | null;
  /** Null when the unit has never reported a position. */
  location: UnitLocation | null;
  /**
   * True only in payloads sent to viewers cleared to see covert units at all.
   * It is a rendering hint, never an access decision — a viewer who may not see
   * the unit never receives the object.
   */
  isCovert: boolean;
}

export interface MapIncidentMarker {
  id: string;
  number: string;
  title: string;
  typeKey: string | null;
  typeLabel: string | null;
  priority: IncidentPriority;
  status: IncidentStatusKey;
  organization: MapOrganizationRef | null;
  locationText: string | null;
  x: number;
  y: number;
  assignedUnitCount: number;
  openedAt: string;
}

export type MapMarkerType =
  | 'hazard' | 'roadblock' | 'staging' | 'command_post' | 'poi' | 'custom';

export interface MapMarker {
  id: string;
  type: MapMarkerType;
  label: string;
  description: string | null;
  x: number;
  y: number;
  z: number | null;
  color: string | null;
  /** Null for a marker shared across every organization. */
  organization: MapOrganizationRef | null;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export const MAP_MARKER_TYPES: Record<MapMarkerType, { label: string; icon: string }> = {
  hazard: { label: 'Hazard', icon: 'TriangleAlert' },
  roadblock: { label: 'Roadblock', icon: 'Construction' },
  staging: { label: 'Staging area', icon: 'Flag' },
  command_post: { label: 'Command post', icon: 'Radio' },
  poi: { label: 'Point of interest', icon: 'MapPin' },
  custom: { label: 'Marker', icon: 'Pin' },
};

// ── Capabilities and source status ─────────────────────────────────────────

/**
 * What the caller may do on the map, decided by the API.
 *
 * The UI uses this only to decide what to draw. Every action it enables is
 * re-authorized server-side when invoked (engineering rule 9) — this object
 * exists so the screen does not offer a button that is going to be refused.
 */
export interface MapCapabilities {
  canViewMap: boolean;
  canTrackUnits: boolean;
  canTrackAllOrganizations: boolean;
  canViewMarkers: boolean;
  canManageMarkers: boolean;
  canViewHistory: boolean;
  canViewIncidents: boolean;
  canCreateIncident: boolean;
  canAssignUnits: boolean;
}

/**
 * Honest reporting of where positions are coming from (engineering rules 34, 35, 45).
 *
 * `kind: 'mock'` is surfaced in the UI as simulated movement, never as a live
 * feed. When the FiveM bridge lands this becomes `'fivem'` and the same banner
 * reports its real connection state.
 */
export interface MapSourceStatus {
  kind: 'mock' | 'fivem';
  connected: boolean;
  label: string;
  detail: string;
  /** Nominal update interval, so the client can size its poll and its staleness. */
  tickMs: number;
  /** True while the base raster pyramid is unavailable and a grid is drawn instead. */
  placeholderBaseLayer: boolean;
}

// ── Transport payloads ─────────────────────────────────────────────────────

export interface MapSnapshot {
  serverTime: string;
  units: MapUnit[];
  incidents: MapIncidentMarker[];
  markers: MapMarker[];
  /** Organizations the caller may filter by — the ones that can appear at all. */
  organizations: MapOrganizationRef[];
  capabilities: MapCapabilities;
  source: MapSourceStatus;
}

/**
 * An incremental position update.
 *
 * Deliberately minimal: 300 units × ~60 bytes keeps a tick under the 5 KB target
 * in docs/architecture/05-map.md §7. Anything that changes rarely — crew,
 * vehicle, callsign — is not in here; a client that sees an unknown unit id
 * requests a fresh snapshot rather than trying to reconstruct one.
 */
export interface UnitPositionDelta {
  unitId: string;
  x: number;
  y: number;
  heading: number | null;
  speed: number | null;
  statusKey: string;
  incidentId: string | null;
  updatedAt: string;
}

export interface MapTick {
  serverTime: string;
  positions: UnitPositionDelta[];
  /** Units that went off duty, were disbanded, or left the caller's visibility. */
  removed: string[];
  /** Set when a unit id appeared that the client has no record of. */
  resyncRequired: boolean;
}

// ── Timing constants ───────────────────────────────────────────────────────

/** Nominal position update interval. */
export const MAP_TICK_MS = 1_000;

/**
 * Beyond this gap a marker is drawn desaturated: the position is no longer
 * something to act on. 15 s is roughly a city block at speed.
 */
export const UNIT_STALE_AFTER_MS = 15_000;

/**
 * Interpolation is capped, so a unit that reappears after a gap SNAPS rather
 * than gliding across half the map — a smooth slide down a coastline the unit
 * never drove is a lie the renderer would be telling.
 */
export const INTERPOLATION_CAP_MS = 3_000;

/** A hidden tab stops rendering immediately and drops its feed after this long. */
export const HIDDEN_TAB_UNSUBSCRIBE_MS = 5 * 60_000;

// ── Client-side filtering ──────────────────────────────────────────────────

/**
 * Filter state.
 *
 * This is a VIEW filter and nothing more. Everything it can hide has already
 * passed the server's visibility check; clearing every filter cannot reveal a
 * unit the caller was not entitled to. Empty arrays mean "no restriction",
 * which is what a filter bar with nothing selected should mean.
 */
export interface MapFilterState {
  organizationIds: string[];
  statusKeys: string[];
  unitTypes: string[];
  vehicleClasses: string[];
  incidentPriorities: IncidentPriority[];
  /** Only units currently assigned to a call. */
  onlyAssigned: boolean;
  /** Off-duty units are hidden by default; they are not operationally on the map. */
  includeOffDuty: boolean;
  showUnits: boolean;
  showIncidents: boolean;
  showMarkers: boolean;
  /** Free text over callsign, unit name, crew names and plate. */
  query: string;
}

export const EMPTY_MAP_FILTER: MapFilterState = {
  organizationIds: [],
  statusKeys: [],
  unitTypes: [],
  vehicleClasses: [],
  incidentPriorities: [],
  onlyAssigned: false,
  includeOffDuty: false,
  showUnits: true,
  showIncidents: true,
  showMarkers: true,
  query: '',
};

export function countActiveMapFilters(filter: MapFilterState): number {
  return (
    filter.organizationIds.length +
    filter.statusKeys.length +
    filter.unitTypes.length +
    filter.vehicleClasses.length +
    filter.incidentPriorities.length +
    (filter.onlyAssigned ? 1 : 0) +
    (filter.includeOffDuty ? 1 : 0) +
    (filter.showUnits ? 0 : 1) +
    (filter.showIncidents ? 0 : 1) +
    (filter.showMarkers ? 0 : 1)
  );
}

/**
 * One predicate, used by both the canvas and the side list.
 *
 * Two views of the same filtered set disagreeing about what is in it is a
 * genuinely confusing bug to be looking at during an incident, so they share
 * this function rather than each re-deriving the condition.
 */
export function matchesUnitFilter(unit: MapUnit, filter: MapFilterState): boolean {
  if (!filter.showUnits) return false;
  if (!unit.status.isOnDuty && !filter.includeOffDuty) return false;

  if (filter.organizationIds.length > 0
    && !filter.organizationIds.includes(unit.organization.id)) return false;

  if (filter.statusKeys.length > 0 && !filter.statusKeys.includes(unit.status.key)) return false;
  if (filter.unitTypes.length > 0 && !filter.unitTypes.includes(unit.unitType)) return false;

  if (filter.vehicleClasses.length > 0) {
    const cls = unit.vehicle?.vehicleClass ?? null;
    if (cls === null || !filter.vehicleClasses.includes(cls)) return false;
  }

  if (filter.onlyAssigned && unit.incident === null) return false;

  if (filter.query.trim() !== '') {
    const needle = filter.query.trim().toLowerCase();
    const haystack = [
      unit.callsign,
      unit.name ?? '',
      unit.vehicle?.plate ?? '',
      unit.vehicle?.model ?? '',
      ...unit.crew.map((c) => c.name),
    ].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

export function matchesIncidentFilter(
  incident: MapIncidentMarker,
  filter: MapFilterState,
): boolean {
  if (!filter.showIncidents) return false;

  if (filter.organizationIds.length > 0) {
    // A multi-agency call carries no owning organization; hiding it whenever any
    // organization filter is on would remove exactly the calls that matter most.
    if (incident.organization !== null
      && !filter.organizationIds.includes(incident.organization.id)) return false;
  }

  if (filter.incidentPriorities.length > 0
    && !filter.incidentPriorities.includes(incident.priority)) return false;

  if (filter.query.trim() !== '') {
    const needle = filter.query.trim().toLowerCase();
    const haystack = `${incident.number} ${incident.title} ${incident.locationText ?? ''}`;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }

  return true;
}

export function matchesMarkerFilter(marker: MapMarker, filter: MapFilterState): boolean {
  if (!filter.showMarkers) return false;
  if (filter.organizationIds.length > 0
    && marker.organization !== null
    && !filter.organizationIds.includes(marker.organization.id)) return false;
  if (filter.query.trim() !== '') {
    const needle = filter.query.trim().toLowerCase();
    if (!`${marker.label} ${marker.description ?? ''}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}

// ── Staleness ──────────────────────────────────────────────────────────────

export type LocationFreshness = 'live' | 'stale' | 'unknown';

export function freshnessOf(
  location: UnitLocation | null,
  now: number,
  staleAfterMs = UNIT_STALE_AFTER_MS,
): LocationFreshness {
  if (location === null) return 'unknown';
  const age = now - Date.parse(location.updatedAt);
  return Number.isNaN(age) || age > staleAfterMs ? 'stale' : 'live';
}
