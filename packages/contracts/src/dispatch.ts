import type { MapOrganizationRef } from './map';
import type { IncidentPriority, IncidentStatusKey } from './statuses';
import { INCIDENT_STATUSES } from './statuses';

/**
 * Dispatch subsystem contracts.
 *
 * The Leitstelle is the screen where a shift is actually run, and its defining
 * property is that everything on it is SERVER STATE. A status, an assignment, a
 * panic — each is a row that other people's screens read, not a local toggle.
 * That is why the transition rules below live here rather than in the UI: the
 * server decides, and the client uses the same table only to avoid offering a
 * button it knows will be refused.
 */

// ── Operational status ─────────────────────────────────────────────────────

/**
 * A status from the catalogue.
 *
 * `operational_status` is a TABLE, not an enum (engineering rules 5-7), so this
 * is whatever the database holds — the seeded six plus anything an organization
 * has added. Nothing in the UI branches on a specific key except panic, which is
 * a genuine special case and is marked as such by `isPanic` rather than by a
 * string comparison scattered through components.
 */
export interface OperationalStatusMeta {
  key: string;
  label: string;
  shortLabel: string;
  colorToken: string;
  icon: string;
  isAvailable: boolean;
  isOnDuty: boolean;
  isPanic: boolean;
  sortOrder: number;
}

// ── Units ──────────────────────────────────────────────────────────────────

export interface DispatchCrewMember {
  memberId: string;
  userId: string;
  name: string;
  callsign: string | null;
  isLeader: boolean;
  statusKey: string;
}

export interface DispatchUnit {
  id: string;
  callsign: string;
  name: string | null;
  unitType: string;
  organization: MapOrganizationRef;
  status: OperationalStatusMeta;
  crew: DispatchCrewMember[];
  vehicle: { id: string; plate: string; model: string; displayName: string | null } | null;
  incident: { id: string; number: string; priority: IncidentPriority } | null;
  position: { x: number; y: number; heading: number | null; updatedAt: string } | null;
  isCovert: boolean;
  createdAt: string;
}

// ── Incidents ──────────────────────────────────────────────────────────────

export interface DispatchIncidentSummary {
  id: string;
  number: string;
  title: string;
  typeKey: string | null;
  typeLabel: string | null;
  priority: IncidentPriority;
  status: IncidentStatusKey;
  organization: MapOrganizationRef | null;
  locationText: string | null;
  position: { x: number; y: number } | null;
  assignedUnitIds: string[];
  createdAt: string;
  /** Set only once closed; the queue shows elapsed time from `createdAt`. */
  closedAt: string | null;
}

export type IncidentTimelineKind =
  | 'note' | 'status_change' | 'assignment' | 'arrival' | 'clear' | 'attachment' | 'system';

export interface IncidentTimelineEntry {
  id: string;
  kind: IncidentTimelineKind;
  body: string | null;
  actorLabel: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DispatchIncidentDetail extends DispatchIncidentSummary {
  description: string | null;
  source: string;
  callerPhone: string | null;
  closingNotes: string | null;
  createdByName: string | null;
  closedByName: string | null;
  assignments: {
    unitId: string;
    callsign: string;
    organizationShortName: string;
    organizationColor: string;
    role: string | null;
    assignedAt: string;
    releasedAt: string | null;
  }[];
  timeline: IncidentTimelineEntry[];
}

// ── Panic ──────────────────────────────────────────────────────────────────

/**
 * A live panic.
 *
 * Present in the payload only while unresolved. This is deliberately NOT a flag
 * on the member: a panic is an event with its own lifecycle — raised,
 * acknowledged by someone, resolved — and each of those is a fact somebody will
 * later need to establish.
 */
export interface PanicAlert {
  id: string;
  memberId: string;
  memberName: string;
  callsign: string | null;
  organization: MapOrganizationRef;
  unitId: string | null;
  unitCallsign: string | null;
  incidentId: string | null;
  position: { x: number; y: number } | null;
  source: string;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
}

// ── The board ──────────────────────────────────────────────────────────────

/**
 * Counts for the board header.
 *
 * Computed server-side over exactly the rows the caller may see, for the same
 * reason search counts are: "MD: 12 available" tells you the size of another
 * service's shift even if you cannot list them.
 */
export interface DispatchCounts {
  openIncidents: number;
  unassignedIncidents: number;
  criticalIncidents: number;
  unitsAvailable: number;
  unitsBusy: number;
  unitsInOperation: number;
  unitsAtHq: number;
  unitsOffDuty: number;
  unitsPanic: number;
  livePanics: number;
}

/** What the signed-in operator can currently do to themselves. */
export interface DispatchSelfState {
  memberId: string | null;
  organizationId: string | null;
  statusKey: string | null;
  /** The unit this operator is crewing, if any. */
  unitId: string | null;
  unitCallsign: string | null;
  isUnitLeader: boolean;
  /** False for a terminated or suspended membership — they may watch, not act. */
  canOperate: boolean;
  /**
   * The caller's own unresolved panic, if any.
   *
   * Carried here so the shell can offer "stand down" without loading the whole
   * board: the top bar is present on every screen, and the person who raised an
   * alert must be able to clear it from wherever they are.
   */
  ownPanicId: string | null;
}

export interface DispatchCapabilities {
  canView: boolean;
  canCreateIncident: boolean;
  canManageIncident: boolean;
  canAssignUnits: boolean;
  canCloseIncident: boolean;
  canManageUnits: boolean;
  canTriggerPanic: boolean;
  canAcknowledgePanic: boolean;
  /** Asking for backup. A self-action — it commits the caller and nobody else. */
  canRequestBackup: boolean;
  /** Broadcasting your own position to your organization. Also a self-action. */
  canShareLocation: boolean;
}

export interface DispatchBoard {
  serverTime: string;
  /**
   * Monotonic marker for cheap change detection.
   *
   * The client sends back what it last saw; the server answers "nothing new"
   * without serialising the board. See the note on `DispatchDelta`.
   */
  revision: string;
  self: DispatchSelfState;
  counts: DispatchCounts;
  incidents: DispatchIncidentSummary[];
  units: DispatchUnit[];
  panics: PanicAlert[];
  statuses: OperationalStatusMeta[];
  organizations: MapOrganizationRef[];
  incidentTypes: { key: string; label: string; defaultPriority: IncidentPriority }[];
  capabilities: DispatchCapabilities;
}

/**
 * The polled response.
 *
 * `changed: false` is the common case on a quiet shift and carries no payload.
 * When the WebSocket lands (`org:{id}:units` / `:incidents` / `:panic` in
 * docs/architecture/03-realtime.md §3) this becomes push, and `revision` becomes
 * the per-topic `seq` the protocol already specifies — the client-side merge does
 * not change.
 */
export type DispatchDelta =
  | { changed: false; revision: string; serverTime: string }
  | ({ changed: true } & DispatchBoard);

/** Poll interval. Dispatch changes on human timescales, not at 1 Hz like positions. */
export const DISPATCH_POLL_MS = 4_000;

/** A panic must reach a dispatcher faster than that. */
export const DISPATCH_PANIC_POLL_MS = 2_000;

// ── Status transition rules ────────────────────────────────────────────────

/**
 * Which incident states may follow which.
 *
 * A table rather than scattered `if`s, in one place, used by BOTH sides: the
 * server enforces it inside the mutating transaction, and the client reads it to
 * grey out transitions rather than offering a button that will 400.
 *
 * The shape encodes three real rules:
 *   • A closed or cancelled call is terminal. Reopening is a separate action
 *     with its own permission, not a status change, because it has to justify
 *     itself in the timeline.
 *   • Anything open can be cancelled — a call that turns out never to have
 *     happened can be discovered at any point.
 *   • `contained` can go back to `on_scene`. Situations get worse again, and a
 *     lifecycle that only moves forward would force a dispatcher to lie.
 */
export const INCIDENT_TRANSITIONS: Record<IncidentStatusKey, IncidentStatusKey[]> = {
  pending: ['dispatched', 'on_scene', 'on_hold', 'closed', 'cancelled'],
  dispatched: ['on_scene', 'contained', 'on_hold', 'pending', 'closed', 'cancelled'],
  on_scene: ['contained', 'on_hold', 'dispatched', 'closed', 'cancelled'],
  contained: ['on_scene', 'on_hold', 'closed', 'cancelled'],
  on_hold: ['pending', 'dispatched', 'on_scene', 'contained', 'closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

export function canTransitionIncident(
  from: IncidentStatusKey,
  to: IncidentStatusKey,
): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export function isTerminalIncidentStatus(status: IncidentStatusKey): boolean {
  return !INCIDENT_STATUSES[status].isOpen;
}

// ── Filters ────────────────────────────────────────────────────────────────

export interface DispatchFilterState {
  /** Empty means no restriction. */
  priorities: IncidentPriority[];
  statuses: IncidentStatusKey[];
  organizationIds: string[];
  /** Open calls with no unit currently assigned. */
  onlyUnassigned: boolean;
  /** Calls this operator's own unit is on. */
  onlyMine: boolean;
  query: string;
}

export const EMPTY_DISPATCH_FILTER: DispatchFilterState = {
  priorities: [],
  statuses: [],
  organizationIds: [],
  onlyUnassigned: false,
  onlyMine: false,
  query: '',
};

export function countActiveDispatchFilters(filter: DispatchFilterState): number {
  return (
    filter.priorities.length +
    filter.statuses.length +
    filter.organizationIds.length +
    (filter.onlyUnassigned ? 1 : 0) +
    (filter.onlyMine ? 1 : 0)
  );
}

/**
 * One predicate for the queue, shared by the list and the counts on screen.
 *
 * Named distinctly from the map's `matchesIncidentFilter`: that one filters map
 * pins by priority and position, this one filters queue rows by assignment and
 * ownership. Same word, different question — so they get different names rather
 * than one overloaded one.
 *
 * `myUnitId` is passed rather than read from a store so the function stays pure
 * and testable; `onlyMine` with no unit matches nothing, which is the honest
 * reading of "calls my unit is on" when you are not in a unit.
 */
export function matchesDispatchIncident(
  incident: DispatchIncidentSummary,
  filter: DispatchFilterState,
  myUnitId: string | null,
): boolean {
  if (filter.priorities.length > 0 && !filter.priorities.includes(incident.priority)) return false;
  if (filter.statuses.length > 0 && !filter.statuses.includes(incident.status)) return false;

  if (filter.organizationIds.length > 0) {
    // A multi-agency call carries no owning organization and belongs to
    // everyone; hiding it under an organization filter would remove exactly the
    // calls that matter most.
    if (incident.organization !== null
      && !filter.organizationIds.includes(incident.organization.id)) return false;
  }

  if (filter.onlyUnassigned && incident.assignedUnitIds.length > 0) return false;

  if (filter.onlyMine) {
    if (myUnitId === null) return false;
    if (!incident.assignedUnitIds.includes(myUnitId)) return false;
  }

  if (filter.query.trim() !== '') {
    const needle = filter.query.trim().toLowerCase();
    const haystack = `${incident.number} ${incident.title} ${incident.locationText ?? ''}`;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }

  return true;
}

/** Queue order: worst first, then oldest first. The order a shift is worked in. */
export function compareIncidentsForQueue(
  a: DispatchIncidentSummary,
  b: DispatchIncidentSummary,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
