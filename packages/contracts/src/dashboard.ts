import type { MapOrganizationRef } from './map';
import type {
  DispatchCapabilities, DispatchIncidentSummary, DispatchSelfState, DispatchUnit,
  OperationalStatusMeta, PanicAlert,
} from './dispatch';

/**
 * Operational dashboard contracts.
 *
 * The dashboard's whole job is to be TRUE AT A GLANCE. That puts an unusual
 * weight on how it represents things it does not know: a figure that is actually
 * unavailable must not render as `0`, because `0` is itself a claim — "no
 * incidents today" and "we cannot count incidents today" look identical on a tile
 * and mean opposite things.
 *
 * So every derived statistic is a `Metric`, which can be unavailable with a
 * reason, and the UI is forced by the type system to handle that case.
 */

// ── Metrics ────────────────────────────────────────────────────────────────

/**
 * Why a metric has no value.
 *
 * `not-measured` is the important one: it means the system does not record the
 * data this metric would need. That is a capability gap, not a temporary
 * absence, and the UI says so rather than showing a dash that reads as "quiet
 * today".
 */
export type MetricUnavailableReason =
  | 'no-data'              // nothing has happened yet in the window
  | 'insufficient-sample'  // too few observations for the number to mean anything
  | 'not-measured';        // the system does not capture what this would need

export type Metric =
  | { available: true; value: number; sampleSize: number }
  | { available: false; reason: MetricUnavailableReason; sampleSize: number; detail?: string };

export function metric(value: number, sampleSize: number): Metric {
  return { available: true, value, sampleSize };
}

export function unavailable(
  reason: MetricUnavailableReason,
  sampleSize = 0,
  detail?: string,
): Metric {
  return detail === undefined
    ? { available: false, reason, sampleSize }
    : { available: false, reason, sampleSize, detail };
}

/**
 * Below this many observations a duration statistic is not reported.
 *
 * Three calls is not an average, it is three calls — and a dashboard tile
 * carrying "4m" derived from one sample invites decisions the number cannot
 * support.
 */
export const MIN_METRIC_SAMPLE = 5;

// ── Statistics ─────────────────────────────────────────────────────────────

/**
 * Counts. These are exact — they are `count(*)` over rows the caller may see,
 * not estimates — so they are plain numbers rather than `Metric`.
 */
export interface DashboardCounts {
  activeIncidents: number;
  unassignedIncidents: number;
  criticalIncidents: number;

  unitsAvailable: number;
  unitsBusy: number;
  unitsInOperation: number;
  unitsAtHq: number;
  unitsPanic: number;
  unitsOffline: number;
  unitsTotal: number;

  /**
   * PERSONNEL, measured two ways, because "online" alone is ambiguous and the
   * two numbers disagree badly in practice.
   *
   * `onDuty` is members whose current operational status is an on-duty one. It
   * is what the duty board means, and it does NOT imply the person is present —
   * a status stays where it was left.
   *
   * `signedIn` is members with a live, unrevoked, unexpired session. That is the
   * closest thing the system has to "actually here".
   *
   * Both are exact counts, both are labelled precisely on screen, and neither is
   * presented as the other.
   */
  personnelOnDuty: number;
  personnelSignedIn: number;
  /** Members currently crewing a unit. */
  personnelInUnits: number;
  /** Active memberships in the organization, whatever their status. */
  personnelTotal: number;
}

/**
 * Time-based statistics.
 *
 * Every one carries its own window and sample size, because "average" without
 * either is not a statistic.
 */
export interface DashboardStatistics {
  /** Server-local calendar day. The window is stated in the payload, not assumed. */
  windowStart: string;
  windowEnd: string;

  incidentsToday: number;
  incidentsClosedToday: number;

  /**
   * Median seconds from a call being created to the first unit being assigned.
   *
   * This is TIME TO DISPATCH, and it is labelled as such. It is not "response
   * time" in the emergency-services sense — see `responseTime` below.
   */
  timeToFirstUnit: Metric;

  /**
   * Median seconds from a call being created to it being marked Active.
   *
   * Derived from the timeline's status transitions, so it reflects when a
   * dispatcher marked the call active rather than when a unit physically
   * arrived.
   */
  timeToActive: Metric;

  /**
   * TRUE RESPONSE TIME — dispatch to arrival on scene.
   *
   * Always unavailable with `not-measured`, and deliberately present in the
   * payload rather than omitted: the dashboard states that this is not being
   * measured, which is honest, instead of quietly showing one of the two proxies
   * above under a name that implies arrival. Nothing writes an `arrival` entry
   * to the incident timeline — that needs the FiveM bridge or an explicit
   * "on scene" action by the responding unit.
   */
  responseTime: Metric;
}

// ── Alerts ─────────────────────────────────────────────────────────────────

export type DashboardAlertKind =
  | 'panic'              // a live panic event
  | 'critical-incident'  // an open P1
  | 'unassigned'         // an open call with no unit, past a threshold
  | 'system';            // an integration that is not connected

export type DashboardAlertTone = 'danger' | 'warning' | 'info';

export interface DashboardAlert {
  id: string;
  kind: DashboardAlertKind;
  tone: DashboardAlertTone;
  title: string;
  detail: string | null;
  /**
   * Where to go to act on it, as a NAMED SCREEN rather than a URL.
   *
   * The API has no business knowing the web app's routing table — that is a
   * frontend concern and it changes independently. Naming the screen also keeps
   * the links typed end to end instead of casting a string at the render site.
   */
  target: 'dispatch' | 'map' | null;
  /** When the underlying thing started, for an age display. */
  since: string | null;
}

/**
 * How many alerts are listed before the rest are summarised.
 *
 * A busy shift can have a dozen open criticals. Listing all of them turns the
 * alert panel into a second incident queue and buries the panic at the top —
 * which is the precise failure the brief warns about: prominent without becoming
 * overwhelming.
 */
export const MAX_LISTED_ALERTS = 6;

/**
 * An open call with no unit becomes an alert after this long.
 *
 * Immediately would be wrong — every call is unassigned for the first few
 * seconds of its life, and an alert that fires on every new call is an alert
 * nobody reads.
 */
export const UNASSIGNED_ALERT_AFTER_MS = 3 * 60_000;

// ── The payload ────────────────────────────────────────────────────────────

export interface DashboardSelf extends DispatchSelfState {
  displayName: string;
  organization: MapOrganizationRef | null;
  /** Role name, from the member's highest role. */
  rankName: string | null;
  /**
   * The member's OWN callsign, from their membership.
   *
   * Distinct from `unitCallsign`, which is the unit they are crewing. An officer
   * has a personal callsign whether or not they are in a car, and showing the
   * unit's under both labels made the panel repeat itself while hiding the one
   * the operator is actually identified by on the radio.
   */
  memberCallsign: string | null;
  employeeNumber: string | null;
  /** The call the member's unit is currently on. */
  assignment: {
    incidentId: string;
    number: string;
    title: string;
    priority: number;
    status: string;
  } | null;
}

export interface DashboardSnapshot {
  serverTime: string;
  /** Shared with dispatch: the same events change both screens. */
  revision: string;
  self: DashboardSelf;
  counts: DashboardCounts;
  statistics: DashboardStatistics;
  alerts: DashboardAlert[];
  /** Alerts beyond `MAX_LISTED_ALERTS`, summarised rather than listed. */
  alertOverflow: number;
  /** Open calls, already ordered by operational importance. */
  incidents: DispatchIncidentSummary[];
  units: DispatchUnit[];
  panics: PanicAlert[];
  statuses: OperationalStatusMeta[];
  capabilities: DispatchCapabilities;
}

export type DashboardDelta =
  | { changed: false; revision: string; serverTime: string }
  | ({ changed: true } & DashboardSnapshot);

/** Dashboard is a glance surface; it does not need the dispatch board's rate. */
export const DASHBOARD_POLL_MS = 5_000;

// ── Ordering ───────────────────────────────────────────────────────────────

/**
 * Operational importance.
 *
 * Not the same as the dispatch queue's order, deliberately. The queue is worked
 * top to bottom, so it is strictly worst-first-oldest-first. The dashboard is
 * SCANNED, so a P1 that nobody has picked up outranks a P1 that three units are
 * already on — the first needs a decision, the second is being handled.
 */
export function compareIncidentsForDashboard(
  a: DispatchIncidentSummary,
  b: DispatchIncidentSummary,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const aUnassigned = a.assignedUnitIds.length === 0;
  const bUnassigned = b.assignedUnitIds.length === 0;
  if (aUnassigned !== bUnassigned) return aUnassigned ? -1 : 1;

  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** Formats a duration metric the way an operations lead reads it. */
export function formatDurationMetric(seconds: number): string {
  // "0s" reads as broken rather than fast, and rounding 0.4s to zero is a claim
  // the measurement does not make.
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** The sentence shown in place of a metric that has no value. */
export function explainUnavailable(m: Extract<Metric, { available: false }>): string {
  if (m.detail !== undefined) return m.detail;
  switch (m.reason) {
    case 'no-data':
      return 'Nothing recorded in this window yet.';
    case 'insufficient-sample':
      return `Too few to average (${m.sampleSize} of ${MIN_METRIC_SAMPLE} needed).`;
    case 'not-measured':
      return 'Not measured by this system.';
  }
}
