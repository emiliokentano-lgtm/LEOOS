import {
  MAX_LISTED_ALERTS, MIN_METRIC_SAMPLE, UNASSIGNED_ALERT_AFTER_MS,
  compareIncidentsForDashboard, metric, unavailable,
  type DashboardAlert, type DashboardCounts, type DashboardDelta, type DashboardSelf,
  type DashboardSnapshot, type DashboardStatistics, type DispatchIncidentSummary,
  type DispatchUnit, type Metric, type PanicAlert,
} from '@leoos/contracts';
import type { Database } from '@leoos/db';
import {
  getDispatchRevision, getSelfState, listAssignments, listCrew, listIncidents,
  listLivePanics, listOperationalStatuses, listUnits,
} from '../dispatch/dispatch.read.js';
import {
  toCapabilitiesDto, toIncidentSummaryDto, toPanicDto, toSelfDto, toStatusDto, toUnitDto,
} from '../dispatch/dispatch.dto.js';
import type { DispatchScope } from '../dispatch/dispatch.scope.js';
import {
  countPersonnel, countToday, getSelfDetail, measureTimeToActive, measureTimeToFirstUnit,
  type DurationSample,
} from './dashboard.read.js';

/**
 * Dashboard assembly.
 *
 * Composed from the DISPATCH reads rather than a parallel set of queries
 * (engineering rule 4). The dashboard and the dispatch board are two views of
 * one situation; two query paths would be two places for the scoping rules to
 * drift, and the first symptom would be a dashboard count that disagrees with
 * the board it links to.
 *
 * The statistics on top are genuinely dashboard-only, and they are the part that
 * needs care — see the note on `responseTime`.
 */

/** Turns a duration sample into a metric, refusing to average too few points. */
function durationMetric(sample: DurationSample): Metric {
  if (sample.sampleSize === 0 || sample.medianSeconds === null) {
    return unavailable('no-data', sample.sampleSize);
  }
  if (sample.sampleSize < MIN_METRIC_SAMPLE) {
    return unavailable('insufficient-sample', sample.sampleSize);
  }
  return metric(sample.medianSeconds, sample.sampleSize);
}

function countsFrom(
  incidents: DispatchIncidentSummary[],
  units: DispatchUnit[],
  personnel: { onDuty: number; signedIn: number; inUnits: number; total: number },
): DashboardCounts {
  const open = incidents.filter((i) => i.status !== 'closed' && i.status !== 'cancelled');

  return {
    activeIncidents: open.length,
    unassignedIncidents: open.filter((i) => i.assignedUnitIds.length === 0).length,
    criticalIncidents: open.filter((i) => i.priority === 1).length,

    // Availability comes from the status catalogue's own flags, never from a
    // hardcoded key list — an organization's custom status has to count.
    unitsAvailable: units.filter((u) => u.status.isAvailable && u.status.key !== 'at_hq').length,
    unitsBusy: units.filter((u) => u.status.key === 'busy').length,
    unitsInOperation: units.filter((u) => u.status.key === 'in_operation').length,
    unitsAtHq: units.filter((u) => u.status.key === 'at_hq').length,
    unitsPanic: units.filter((u) => u.status.isPanic).length,
    unitsOffline: units.filter((u) => !u.status.isOnDuty).length,
    unitsTotal: units.length,

    personnelOnDuty: personnel.onDuty,
    personnelSignedIn: personnel.signedIn,
    personnelInUnits: personnel.inUnits,
    personnelTotal: personnel.total,
  };
}

/**
 * What needs attention, in the order it needs it.
 *
 * Deliberately conservative about what becomes an alert. A dashboard that
 * decorates itself with warnings is one whose warnings get ignored, so this
 * raises exactly four things and each has to earn it: a live panic, an open P1,
 * a call left unassigned past a threshold, and an integration that is not
 * connected.
 */
function alertsFrom(
  panics: PanicAlert[],
  incidents: DispatchIncidentSummary[],
  now: number,
  source: { fivemConnected: boolean },
): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];

  for (const panic of panics) {
    alerts.push({
      id: `panic:${panic.id}`,
      kind: 'panic',
      tone: 'danger',
      title: `Panic — ${panic.memberName}${panic.callsign === null ? '' : ` (${panic.callsign})`}`,
      detail: panic.acknowledgedAt === null
        ? 'Not yet acknowledged'
        : `Acknowledged by ${panic.acknowledgedByName ?? 'a dispatcher'}`,
      target: 'dispatch',
      since: panic.createdAt,
    });
  }

  const open = incidents.filter((i) => i.status !== 'closed' && i.status !== 'cancelled');

  for (const call of open.filter((i) => i.priority === 1)) {
    alerts.push({
      id: `critical:${call.id}`,
      kind: 'critical-incident',
      tone: 'danger',
      title: `${call.number} — ${call.title}`,
      detail: call.assignedUnitIds.length === 0
        ? 'Critical, no units assigned'
        : `Critical, ${call.assignedUnitIds.length} unit(s) assigned`,
      target: 'dispatch',
      since: call.createdAt,
    });
  }

  for (const call of open) {
    // P1s are already covered above; this is for everything else left waiting.
    if (call.priority === 1) continue;
    if (call.assignedUnitIds.length > 0) continue;
    if (now - Date.parse(call.createdAt) < UNASSIGNED_ALERT_AFTER_MS) continue;

    alerts.push({
      id: `unassigned:${call.id}`,
      kind: 'unassigned',
      tone: 'warning',
      title: `${call.number} waiting for a unit`,
      detail: call.title,
      target: 'dispatch',
      since: call.createdAt,
    });
  }

  /**
   * System state, reported as fact.
   *
   * Not a decoration: an operator reading unit positions needs to know they are
   * simulated (engineering rules 34, 35, 45). It sits at the bottom because it
   * is a standing condition, not an event.
   */
  if (!source.fivemConnected) {
    alerts.push({
      id: 'system:fivem',
      kind: 'system',
      tone: 'info',
      title: 'FiveM bridge not connected',
      detail: 'Unit positions are simulated. Nothing on the map reflects a game server.',
      target: 'map',
      since: null,
    });
  }

  return alerts;
}

export interface DashboardDeps {
  db: Database;
  /** Reported honestly rather than assumed — see the system alert above. */
  fivemConnected: boolean;
}

export async function buildDashboard(
  deps: DashboardDeps,
  scope: DispatchScope,
): Promise<DashboardSnapshot> {
  const { db } = deps;

  const [
    incidentRows, unitRows, panicRows, statusRows, selfRow, selfDetail,
    personnel, today, firstUnit, active, revision,
  ] = await Promise.all([
    listIncidents(db, scope),
    listUnits(db, scope),
    listLivePanics(db, scope),
    listOperationalStatuses(db, scope),
    getSelfState(db, scope.actorUserId, scope.organizationId),
    getSelfDetail(db, scope.actorUserId, scope.organizationId),
    countPersonnel(db, scope),
    countToday(db, scope),
    measureTimeToFirstUnit(db, scope),
    measureTimeToActive(db, scope),
    getDispatchRevision(db, scope),
  ]);

  const [assignments, crew] = await Promise.all([
    listAssignments(db, incidentRows.map((i) => i.id)),
    listCrew(db, unitRows.map((u) => u.id)),
  ]);

  const assignedByIncident = new Map<string, string[]>();
  for (const a of assignments) {
    const bucket = assignedByIncident.get(a.incidentId);
    if (bucket) bucket.push(a.unitId);
    else assignedByIncident.set(a.incidentId, [a.unitId]);
  }

  const crewByUnit = new Map<string, typeof crew>();
  for (const member of crew) {
    const bucket = crewByUnit.get(member.unitId);
    if (bucket) bucket.push(member);
    else crewByUnit.set(member.unitId, [member]);
  }

  const incidents = incidentRows
    .map((row) => toIncidentSummaryDto(row, assignedByIncident.get(row.id) ?? []))
    .sort(compareIncidentsForDashboard);
  const units = unitRows.map((row) => toUnitDto(row, crewByUnit.get(row.id) ?? []));
  const panics = panicRows.map(toPanicDto);

  const ownPanic = selfRow === null
    ? null
    : panicRows.find((p) => p.memberId === selfRow.memberId)?.id ?? null;

  const base = toSelfDto(selfRow, scope, ownPanic);

  // The call the member's own unit is on, resolved from data already loaded.
  const myUnit = base.unitId === null ? null : units.find((u) => u.id === base.unitId) ?? null;
  const myCall = myUnit?.incident == null
    ? null
    : incidents.find((i) => i.id === myUnit.incident!.id) ?? null;

  const self: DashboardSelf = {
    ...base,
    displayName: selfDetail?.displayName ?? 'Unknown',
    organization: selfDetail === null ? null : {
      id: selfDetail.organizationId,
      key: selfDetail.organizationKey,
      shortName: selfDetail.organizationShortName,
      color: selfDetail.organizationColor,
    },
    rankName: selfDetail?.rankName ?? null,
    memberCallsign: selfDetail?.memberCallsign ?? null,
    employeeNumber: selfDetail?.employeeNumber ?? null,
    assignment: myCall === null ? null : {
      incidentId: myCall.id,
      number: myCall.number,
      title: myCall.title,
      priority: myCall.priority,
      status: myCall.status,
    },
  };

  const statistics: DashboardStatistics = {
    windowStart: today.windowStart.toISOString(),
    windowEnd: today.windowEnd.toISOString(),
    incidentsToday: today.opened,
    incidentsClosedToday: today.closed,
    timeToFirstUnit: durationMetric(firstUnit),
    timeToActive: durationMetric(active),
    /**
     * NOT MEASURED, and said so.
     *
     * True response time is dispatch to arrival on scene. Nothing records an
     * arrival: the incident timeline has an `arrival` entry type, but no code
     * path writes one, and no unit reports reaching a location. Presenting
     * either proxy above under this name would be inventing a number, so the
     * dashboard states the gap instead (engineering rules 34, 35, 45).
     */
    responseTime: unavailable(
      'not-measured', 0,
      'Arrival on scene is not recorded yet — needs the FiveM bridge or an explicit on-scene action.',
    ),
  };

  /**
   * Capped, with the remainder counted.
   *
   * `alertsFrom` already emits them worst-first, so the cap keeps the panics and
   * criticals and summarises the tail. Truncating silently would be the wrong
   * trade — the operator needs to know there are twelve more.
   */
  const allAlerts = alertsFrom(
    panics, incidents, Date.now(), { fivemConnected: deps.fivemConnected },
  );

  return {
    serverTime: new Date().toISOString(),
    revision,
    self,
    counts: countsFrom(incidents, units, personnel),
    statistics,
    alerts: allAlerts.slice(0, MAX_LISTED_ALERTS),
    alertOverflow: Math.max(0, allAlerts.length - MAX_LISTED_ALERTS),
    incidents,
    units,
    panics,
    statuses: statusRows.map(toStatusDto),
    capabilities: toCapabilitiesDto(scope),
  };
}

/**
 * The polled response.
 *
 * Shares the DISPATCH revision, because the two screens change on exactly the
 * same events — a call created, a unit's status changed, a panic raised. One
 * marker means a dashboard open beside a dispatch board cannot lag it.
 */
export async function buildDashboardDelta(
  deps: DashboardDeps,
  scope: DispatchScope,
  knownRevision: string | null,
): Promise<DashboardDelta> {
  const revision = await getDispatchRevision(deps.db, scope);

  if (knownRevision !== null && knownRevision === revision) {
    return { changed: false, revision, serverTime: new Date().toISOString() };
  }

  const snapshot = await buildDashboard(deps, scope);
  return { changed: true, ...snapshot };
}
