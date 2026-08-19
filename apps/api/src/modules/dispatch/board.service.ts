import type { DispatchBoard, DispatchDelta } from '@leoos/contracts';
import type { Database } from '@leoos/db';
import {
  getDispatchRevision, getSelfState, listAssignments, listCrew, listDispatchOrganizations,
  listIncidentTypes, listIncidents, listLivePanics, listOperationalStatuses, listUnits,
} from './dispatch.read.js';
import {
  toCapabilitiesDto, toCountsDto, toIncidentSummaryDto, toPanicDto, toSelfDto, toStatusDto,
  toUnitDto,
} from './dispatch.dto.js';
import type { DispatchScope } from './dispatch.scope.js';

/**
 * Board assembly.
 *
 * Kept separate from the routes because it is composed from six queries and the
 * composition is the interesting part — in particular that the counts are
 * derived from the DTOs that were actually built, so the header can never
 * disagree with the lists under it.
 */

export async function buildDispatchBoard(
  db: Database,
  scope: DispatchScope,
  opts: { includeClosed?: boolean } = {},
): Promise<DispatchBoard> {
  const [
    incidentRows, unitRows, panicRows, statusRows, organizations, incidentTypes, selfRow, revision,
  ] = await Promise.all([
    listIncidents(db, scope, { includeClosed: opts.includeClosed ?? false }),
    listUnits(db, scope),
    listLivePanics(db, scope),
    listOperationalStatuses(db, scope),
    listDispatchOrganizations(db, scope),
    listIncidentTypes(db, scope),
    getSelfState(db, scope.actorUserId, scope.organizationId),
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

  const incidents = incidentRows.map((row) =>
    toIncidentSummaryDto(row, assignedByIncident.get(row.id) ?? []));
  const units = unitRows.map((row) => toUnitDto(row, crewByUnit.get(row.id) ?? []));
  const panics = panicRows.map(toPanicDto);

  // Reused from the panics already loaded rather than queried again — the
  // caller's own alert is by definition in the set they can see.
  const ownPanic = selfRow === null
    ? null
    : panicRows.find((p) => p.memberId === selfRow.memberId)?.id ?? null;

  return {
    serverTime: new Date().toISOString(),
    revision,
    self: toSelfDto(selfRow, scope, ownPanic),
    counts: toCountsDto(incidents, units, panics),
    incidents,
    units,
    panics,
    statuses: statusRows.map(toStatusDto),
    organizations,
    incidentTypes: incidentTypes.map((t) => ({
      key: t.key,
      label: t.label,
      defaultPriority: Math.min(5, Math.max(1, t.defaultPriority)) as 1 | 2 | 3 | 4 | 5,
    })),
    capabilities: toCapabilitiesDto(scope),
  };
}

/**
 * The polled response.
 *
 * Asks the cheap revision marker first and skips the whole board when nothing
 * has moved — which is the common case on a quiet shift, and the difference
 * between a 4-second poll costing nothing and costing six queries per operator.
 *
 * When the WebSocket lands this becomes a push and the revision becomes the
 * per-topic `seq` the protocol already specifies (03-realtime.md §4). The
 * client-side merge does not change.
 */
export async function buildDispatchDelta(
  db: Database,
  scope: DispatchScope,
  knownRevision: string | null,
  opts: { includeClosed?: boolean } = {},
): Promise<DispatchDelta> {
  const revision = await getDispatchRevision(db, scope);

  if (knownRevision !== null && knownRevision === revision) {
    return { changed: false, revision, serverTime: new Date().toISOString() };
  }

  const board = await buildDispatchBoard(db, scope, opts);
  return { changed: true, ...board };
}

/**
 * Just the caller's own state.
 *
 * The shell's status control is on every screen and needs this without paying
 * for a whole board. Four small reads instead of eight, and no crew or timeline
 * assembly.
 */
export async function buildSelfState(
  db: Database,
  scope: DispatchScope,
): Promise<{ self: DispatchBoard['self']; statuses: DispatchBoard['statuses'] }> {
  const [selfRow, statusRows, panicRows] = await Promise.all([
    getSelfState(db, scope.actorUserId, scope.organizationId),
    listOperationalStatuses(db, scope),
    listLivePanics(db, scope),
  ]);

  const ownPanic = selfRow === null
    ? null
    : panicRows.find((p) => p.memberId === selfRow.memberId)?.id ?? null;

  return {
    self: toSelfDto(selfRow, scope, ownPanic),
    statuses: statusRows.map(toStatusDto),
  };
}
