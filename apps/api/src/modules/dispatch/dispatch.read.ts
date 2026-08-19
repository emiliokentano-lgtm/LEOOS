import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  incident, incidentAssignment, incidentLog, incidentType, memberStatus, operationalStatus,
  organization, organizationMember, panicEvent, person, unit, unitMember, userAccount, vehicle,
  type Database,
} from '@leoos/db';
import type { DispatchScope } from './dispatch.scope.js';

/**
 * Dispatch reads.
 *
 * Everything takes a `DispatchScope` and expresses its restriction as SQL, so a
 * call or unit the caller may not see is never selected rather than filtered on
 * the way out.
 */

/**
 * Organization restriction for org-owned dispatch rows.
 *
 * `allowNull` covers multi-agency incidents, which have no owning organization
 * and belong to everyone. An empty scope returns `false` rather than an empty
 * `IN ()` — which would be a syntax error at best and a total bypass at worst.
 */
function orgRestriction(
  scope: DispatchScope,
  column: Parameters<typeof inArray>[0],
  allowNull: boolean,
) {
  if (scope.canViewAllOrganizations) return undefined;
  if (scope.organizationIds.length === 0) {
    return allowNull ? isNull(column as never) : sql`false`;
  }
  const owned = inArray(column, scope.organizationIds);
  return allowNull ? or(owned, isNull(column as never)) : owned;
}

// ── Incidents ──────────────────────────────────────────────────────────────

export interface IncidentRow {
  id: string;
  number: string;
  title: string;
  typeKey: string | null;
  typeLabel: string | null;
  priority: number;
  status: string;
  organizationId: string | null;
  organizationKey: string | null;
  organizationShortName: string | null;
  organizationColor: string | null;
  locationText: string | null;
  posX: number | null;
  posY: number | null;
  createdAt: Date;
  closedAt: Date | null;
}

const incidentColumns = {
  id: incident.id,
  number: incident.number,
  title: incident.title,
  typeKey: incident.typeKey,
  typeLabel: incidentType.label,
  priority: incident.priority,
  status: incident.status,
  organizationId: incident.organizationId,
  organizationKey: organization.key,
  organizationShortName: organization.shortName,
  organizationColor: organization.color,
  locationText: incident.locationText,
  posX: incident.posX,
  posY: incident.posY,
  createdAt: incident.createdAt,
  closedAt: incident.closedAt,
};

/**
 * The queue.
 *
 * Open calls by default. Closed calls are available but BOUNDED — a dispatcher
 * reviewing what happened wants the last few, not the year, and an unbounded
 * history query on the busiest table in the system is how a board becomes slow
 * at exactly the wrong moment.
 */
export async function listIncidents(
  db: Database,
  scope: DispatchScope,
  opts: { includeClosed?: boolean; closedLimit?: number } = {},
): Promise<IncidentRow[]> {
  const restriction = orgRestriction(scope, incident.organizationId, true);

  const open = await db
    .select(incidentColumns)
    .from(incident)
    .leftJoin(organization, eq(organization.id, incident.organizationId))
    .leftJoin(incidentType, eq(incidentType.key, incident.typeKey))
    .where(and(
      isNull(incident.deletedAt),
      inArray(incident.status, ['pending', 'dispatched', 'on_scene', 'contained', 'on_hold']),
      restriction,
    ))
    .orderBy(asc(incident.priority), asc(incident.createdAt), asc(incident.id));

  if (opts.includeClosed !== true) return open;

  const closed = await db
    .select(incidentColumns)
    .from(incident)
    .leftJoin(organization, eq(organization.id, incident.organizationId))
    .leftJoin(incidentType, eq(incidentType.key, incident.typeKey))
    .where(and(
      isNull(incident.deletedAt),
      inArray(incident.status, ['closed', 'cancelled']),
      restriction,
    ))
    .orderBy(desc(incident.closedAt), desc(incident.createdAt))
    .limit(opts.closedLimit ?? 50);

  return [...open, ...closed];
}

export interface AssignmentRow {
  incidentId: string;
  unitId: string;
  callsign: string;
  organizationShortName: string;
  organizationColor: string;
  role: string | null;
  assignedAt: Date;
  releasedAt: Date | null;
}

/**
 * Assignments for a set of incidents, in one query.
 *
 * Loaded separately rather than joined onto the queue: a call with four units
 * would otherwise multiply its row four times, and every incident field with it.
 * Takes an explicit id list, so it cannot be called in a way that widens the set
 * the caller was already allowed to see.
 */
export async function listAssignments(
  db: Database,
  incidentIds: string[],
  opts: { includeReleased?: boolean } = {},
): Promise<AssignmentRow[]> {
  if (incidentIds.length === 0) return [];

  return db
    .select({
      incidentId: incidentAssignment.incidentId,
      unitId: incidentAssignment.unitId,
      callsign: unit.callsign,
      organizationShortName: organization.shortName,
      organizationColor: organization.color,
      role: incidentAssignment.role,
      assignedAt: incidentAssignment.assignedAt,
      releasedAt: incidentAssignment.releasedAt,
    })
    .from(incidentAssignment)
    .innerJoin(unit, eq(unit.id, incidentAssignment.unitId))
    .innerJoin(organization, eq(organization.id, unit.organizationId))
    .where(and(
      inArray(incidentAssignment.incidentId, incidentIds),
      opts.includeReleased === true ? undefined : isNull(incidentAssignment.releasedAt),
    ))
    .orderBy(asc(incidentAssignment.assignedAt));
}

export interface IncidentDetailRow extends IncidentRow {
  description: string | null;
  source: string;
  callerPhone: string | null;
  closingNotes: string | null;
  createdByName: string | null;
  closedByName: string | null;
}

export async function getIncidentDetail(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
): Promise<IncidentDetailRow | null> {
  const createdByName = sql<string | null>`(
    SELECT ua.display_name FROM user_account ua
     WHERE ua.id = ${sql.raw('"incident"."created_by"')})`;
  const closedByName = sql<string | null>`(
    SELECT ua.display_name FROM user_account ua
     WHERE ua.id = ${sql.raw('"incident"."closed_by"')})`;

  const [row] = await db
    .select({
      ...incidentColumns,
      description: incident.description,
      source: incident.source,
      callerPhone: incident.callerPhone,
      closingNotes: incident.closingNotes,
      createdByName,
      closedByName,
    })
    .from(incident)
    .leftJoin(organization, eq(organization.id, incident.organizationId))
    .leftJoin(incidentType, eq(incidentType.key, incident.typeKey))
    .where(and(
      eq(incident.id, incidentId),
      isNull(incident.deletedAt),
      orgRestriction(scope, incident.organizationId, true),
    ))
    .limit(1);

  return row ?? null;
}

export interface TimelineRow {
  id: string;
  entryType: string;
  body: string | null;
  actorLabel: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * The timeline — the legal record of the call.
 *
 * Read oldest-first as a narrative, but SELECTed newest-first so the limit keeps
 * the most recent entries: a long-running major incident accumulates hundreds,
 * and truncating the wrong end would hide what just happened.
 */
export async function listTimeline(
  db: Database,
  incidentId: string,
  limit = 200,
): Promise<TimelineRow[]> {
  const rows = await db
    .select({
      id: incidentLog.id,
      entryType: incidentLog.entryType,
      body: incidentLog.body,
      actorLabel: sql<string | null>`coalesce(${incidentLog.actorLabel}, ${userAccount.displayName})`,
      metadata: incidentLog.metadata,
      createdAt: incidentLog.createdAt,
    })
    .from(incidentLog)
    .leftJoin(userAccount, eq(userAccount.id, incidentLog.actorUserId))
    .where(eq(incidentLog.incidentId, incidentId))
    .orderBy(desc(incidentLog.createdAt), desc(incidentLog.id))
    .limit(limit);

  return rows.reverse() as TimelineRow[];
}

// ── Units ──────────────────────────────────────────────────────────────────

export interface UnitRow {
  id: string;
  callsign: string;
  name: string | null;
  unitType: string;
  isCovert: boolean;
  organizationId: string;
  organizationKey: string;
  organizationShortName: string;
  organizationColor: string;
  statusKey: string;
  statusLabel: string;
  statusShortLabel: string;
  statusColorToken: string;
  statusIcon: string;
  statusIsAvailable: boolean;
  statusIsOnDuty: boolean;
  vehicleId: string | null;
  vehiclePlate: string | null;
  vehicleModel: string | null;
  vehicleDisplayName: string | null;
  incidentId: string | null;
  incidentNumber: string | null;
  incidentPriority: number | null;
  posX: number | null;
  posY: number | null;
  heading: number | null;
  positionUpdatedAt: Date | null;
  createdAt: Date;
}

export async function listUnits(db: Database, scope: DispatchScope): Promise<UnitRow[]> {
  return db
    .select({
      id: unit.id,
      callsign: unit.callsign,
      name: unit.name,
      unitType: unit.unitType,
      isCovert: unit.isCovert,
      organizationId: unit.organizationId,
      organizationKey: organization.key,
      organizationShortName: organization.shortName,
      organizationColor: organization.color,
      statusKey: unit.statusKey,
      statusLabel: operationalStatus.label,
      statusShortLabel: operationalStatus.shortLabel,
      statusColorToken: operationalStatus.colorToken,
      statusIcon: operationalStatus.icon,
      statusIsAvailable: operationalStatus.isAvailable,
      statusIsOnDuty: operationalStatus.isOnDuty,
      vehicleId: vehicle.id,
      vehiclePlate: vehicle.plate,
      vehicleModel: vehicle.model,
      vehicleDisplayName: vehicle.displayName,
      incidentId: incident.id,
      incidentNumber: incident.number,
      incidentPriority: incident.priority,
      posX: unit.posX,
      posY: unit.posY,
      heading: unit.heading,
      positionUpdatedAt: unit.positionUpdatedAt,
      createdAt: unit.createdAt,
    })
    .from(unit)
    .innerJoin(organization, eq(organization.id, unit.organizationId))
    .innerJoin(operationalStatus, eq(operationalStatus.key, unit.statusKey))
    .leftJoin(vehicle, eq(vehicle.id, unit.vehicleId))
    .leftJoin(incident, eq(incident.id, unit.currentIncidentId))
    .where(and(
      eq(unit.status, 'active'),
      orgRestriction(scope, unit.organizationId, false),
    ))
    .orderBy(asc(organization.shortName), asc(unit.callsign), asc(unit.id));
}

export interface CrewRow {
  unitId: string;
  memberId: string;
  userId: string;
  name: string;
  callsign: string | null;
  isLeader: boolean;
  statusKey: string;
}

export async function listCrew(db: Database, unitIds: string[]): Promise<CrewRow[]> {
  if (unitIds.length === 0) return [];

  return db
    .select({
      unitId: unitMember.unitId,
      memberId: unitMember.memberId,
      userId: organizationMember.userId,
      name: sql<string>`coalesce(
        ${person.firstName} || ' ' || ${person.lastName},
        ${userAccount.displayName},
        'Unknown'
      )`,
      callsign: organizationMember.callsign,
      isLeader: unitMember.isLeader,
      statusKey: sql<string>`coalesce(${memberStatus.statusKey}, 'off_duty')`,
    })
    .from(unitMember)
    .innerJoin(organizationMember, eq(organizationMember.id, unitMember.memberId))
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(person, eq(person.id, organizationMember.personId))
    .leftJoin(memberStatus, eq(memberStatus.memberId, unitMember.memberId))
    .where(and(inArray(unitMember.unitId, unitIds), isNull(unitMember.leftAt)))
    .orderBy(desc(unitMember.isLeader), asc(unitMember.joinedAt));
}

// ── Panic ──────────────────────────────────────────────────────────────────

export interface PanicRow {
  id: string;
  memberId: string;
  memberName: string;
  callsign: string | null;
  organizationId: string;
  organizationKey: string;
  organizationShortName: string;
  organizationColor: string;
  unitId: string | null;
  unitCallsign: string | null;
  incidentId: string | null;
  posX: number | null;
  posY: number | null;
  source: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
}

/**
 * Live panics.
 *
 * Unresolved only. A panic STAYS in the payload after it is acknowledged — the
 * acknowledgement means somebody has seen it, not that the officer is safe, and
 * clearing it from the board at that point is exactly the wrong behaviour.
 */
export async function listLivePanics(db: Database, scope: DispatchScope): Promise<PanicRow[]> {
  const acknowledgedByName = sql<string | null>`(
    SELECT ua.display_name FROM user_account ua
     WHERE ua.id = ${sql.raw('"panic_event"."acknowledged_by"')})`;

  return db
    .select({
      id: panicEvent.id,
      memberId: panicEvent.memberId,
      memberName: sql<string>`coalesce(
        ${person.firstName} || ' ' || ${person.lastName},
        ${userAccount.displayName},
        'Unknown'
      )`,
      callsign: organizationMember.callsign,
      organizationId: panicEvent.organizationId,
      organizationKey: organization.key,
      organizationShortName: organization.shortName,
      organizationColor: organization.color,
      unitId: panicEvent.unitId,
      unitCallsign: unit.callsign,
      incidentId: panicEvent.incidentId,
      posX: panicEvent.posX,
      posY: panicEvent.posY,
      source: panicEvent.source,
      createdAt: panicEvent.createdAt,
      acknowledgedAt: panicEvent.acknowledgedAt,
      acknowledgedByName,
    })
    .from(panicEvent)
    .innerJoin(organizationMember, eq(organizationMember.id, panicEvent.memberId))
    .innerJoin(organization, eq(organization.id, panicEvent.organizationId))
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(person, eq(person.id, organizationMember.personId))
    .leftJoin(unit, eq(unit.id, panicEvent.unitId))
    .where(and(
      isNull(panicEvent.resolvedAt),
      orgRestriction(scope, panicEvent.organizationId, false),
    ))
    .orderBy(desc(panicEvent.createdAt));
}

// ── Reference data and self ────────────────────────────────────────────────

/**
 * The status catalogue this caller may pick from.
 *
 * Global statuses plus their own organization's additions. `operational_status`
 * is a table precisely so an organization can extend the list without a code
 * change (engineering rules 5-7), and this is the query that makes that real
 * rather than theoretical.
 */
export async function listOperationalStatuses(db: Database, scope: DispatchScope) {
  return db
    .select({
      key: operationalStatus.key,
      label: operationalStatus.label,
      shortLabel: operationalStatus.shortLabel,
      colorToken: operationalStatus.colorToken,
      icon: operationalStatus.icon,
      isAvailable: operationalStatus.isAvailable,
      isOnDuty: operationalStatus.isOnDuty,
      sortOrder: operationalStatus.sortOrder,
      organizationId: operationalStatus.organizationId,
    })
    .from(operationalStatus)
    .where(and(
      eq(operationalStatus.isActive, true),
      scope.organizationId === null
        ? isNull(operationalStatus.organizationId)
        : or(
          isNull(operationalStatus.organizationId),
          eq(operationalStatus.organizationId, scope.organizationId),
        ),
    ))
    .orderBy(asc(operationalStatus.sortOrder), asc(operationalStatus.key));
}

export async function listIncidentTypes(db: Database, scope: DispatchScope) {
  return db
    .select({
      key: incidentType.key,
      label: incidentType.label,
      defaultPriority: incidentType.defaultPriority,
    })
    .from(incidentType)
    .where(and(
      eq(incidentType.isActive, true),
      scope.organizationId === null
        ? isNull(incidentType.organizationId)
        : or(
          isNull(incidentType.organizationId),
          eq(incidentType.organizationId, scope.organizationId),
        ),
    ))
    .orderBy(asc(incidentType.label));
}

export interface SelfRow {
  memberId: string;
  organizationId: string;
  membershipStatus: string;
  statusKey: string | null;
  unitId: string | null;
  unitCallsign: string | null;
  isUnitLeader: boolean;
}

/** The signed-in operator's own dispatch state. */
export async function getSelfState(
  db: Database,
  userId: string,
  organizationId: string | null,
): Promise<SelfRow | null> {
  if (organizationId === null) return null;

  const [row] = await db
    .select({
      memberId: organizationMember.id,
      organizationId: organizationMember.organizationId,
      membershipStatus: organizationMember.status,
      statusKey: memberStatus.statusKey,
      unitId: unitMember.unitId,
      unitCallsign: unit.callsign,
      isUnitLeader: sql<boolean>`coalesce(${unitMember.isLeader}, false)`,
    })
    .from(organizationMember)
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .leftJoin(unitMember, and(
      eq(unitMember.memberId, organizationMember.id),
      isNull(unitMember.leftAt),
    ))
    .leftJoin(unit, eq(unit.id, unitMember.unitId))
    .where(and(
      eq(organizationMember.userId, userId),
      eq(organizationMember.organizationId, organizationId),
    ))
    .limit(1);

  return row ?? null;
}

export async function listDispatchOrganizations(db: Database, scope: DispatchScope) {
  return db
    .select({
      id: organization.id,
      key: organization.key,
      shortName: organization.shortName,
      color: organization.color,
    })
    .from(organization)
    .where(and(
      isNull(organization.deletedAt),
      eq(organization.isActive, true),
      scope.canViewAllOrganizations
        ? undefined
        : scope.organizationIds.length === 0
          ? sql`false`
          : inArray(organization.id, scope.organizationIds),
    ))
    .orderBy(asc(organization.shortName));
}

/**
 * A cheap marker of "has anything changed".
 *
 * The board is expensive to serialise and a quiet shift changes nothing for
 * minutes at a time, so the poll asks this first and skips the render when it
 * matches what the client already holds.
 *
 * It combines the newest mutation timestamp with a row count per table: a
 * timestamp alone misses a DELETE, a count alone misses an edit. Together they
 * move on any change the board can display.
 *
 * BUILT WITH THE QUERY BUILDER, not raw SQL, and deliberately so. The first
 * version was one hand-written statement — it was compact, and it shipped two
 * bugs that typechecking could not see: a column named by its Drizzle property
 * rather than its database name, and an array bound as a scalar. Four small
 * aggregate queries reuse `orgRestriction` (so scoping cannot drift from the
 * reads) and are still a fraction of the cost of building the board.
 *
 * This stands in for the per-topic `seq` the WebSocket protocol specifies
 * (03-realtime.md §4). When the socket lands the server pushes and this goes
 * away.
 */
export async function getDispatchRevision(
  db: Database,
  scope: DispatchScope,
): Promise<string> {
  const [incidents, units, statuses, panics] = await Promise.all([
    db.select({
      at: sql<string | null>`max(extract(epoch from ${incident.updatedAt}))::text`,
      n: sql<number>`count(*) FILTER (WHERE ${incident.deletedAt} IS NULL)::int`,
    }).from(incident).where(orgRestriction(scope, incident.organizationId, true)),

    db.select({
      at: sql<string | null>`max(extract(epoch from ${unit.updatedAt}))::text`,
      n: sql<number>`count(*) FILTER (WHERE ${unit.status} = 'active')::int`,
    }).from(unit).where(orgRestriction(scope, unit.organizationId, false)),

    db.select({
      at: sql<string | null>`max(extract(epoch from ${memberStatus.updatedAt}))::text`,
      n: sql<number>`count(*)::int`,
    })
      .from(memberStatus)
      .innerJoin(organizationMember, eq(organizationMember.id, memberStatus.memberId))
      .where(orgRestriction(scope, organizationMember.organizationId, false)),

    db.select({
      at: sql<string | null>`max(extract(epoch from ${panicEvent.createdAt}))::text`,
      // Unresolved only: acknowledging a panic changes `acknowledged_at`, which
      // the timestamp above does not move, so the live count carries it.
      n: sql<number>`count(*) FILTER (WHERE ${panicEvent.resolvedAt} IS NULL)::int`,
      ack: sql<string | null>`max(extract(epoch from ${panicEvent.acknowledgedAt}))::text`,
    }).from(panicEvent).where(orgRestriction(scope, panicEvent.organizationId, false)),
  ]);

  // Assignments are the one thing that changes an incident without touching its
  // own `updated_at`, so they get their own marker.
  const [assignments] = await db
    .select({
      at: sql<string | null>`max(extract(epoch from ${incidentAssignment.assignedAt}))::text`,
      released: sql<string | null>`max(extract(epoch from ${incidentAssignment.releasedAt}))::text`,
      n: sql<number>`count(*) FILTER (WHERE ${incidentAssignment.releasedAt} IS NULL)::int`,
    })
    .from(incidentAssignment);

  return [
    incidents[0]?.at ?? '0', incidents[0]?.n ?? 0,
    units[0]?.at ?? '0', units[0]?.n ?? 0,
    statuses[0]?.at ?? '0', statuses[0]?.n ?? 0,
    panics[0]?.at ?? '0', panics[0]?.n ?? 0, panics[0]?.ack ?? '0',
    assignments?.at ?? '0', assignments?.released ?? '0', assignments?.n ?? 0,
  ].join(':');
}
