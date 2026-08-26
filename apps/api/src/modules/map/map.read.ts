import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  incident, incidentType, mapMarker, mapShape, operationalStatus, organization,
  organizationMember, person, unit, unitMember, userAccount, vehicle, type Database,
} from '@leoos/db';
import type { ActorContext } from '@leoos/authz-core';
import { resolveMapScope, type MapScope } from './map.scope.js';

/**
 * Map reads.
 *
 * Everything here takes a `MapScope` and expresses its restriction as SQL. The
 * point is that a unit the caller may not see is never SELECTed, so it cannot
 * leak through a forgotten DTO field, a debug log, or a future endpoint that
 * reuses one of these functions carelessly.
 */

/**
 * Outer columns, EXPLICITLY QUALIFIED for use inside correlated subqueries.
 *
 * Drizzle renders a column unqualified in a SELECT projection when the query has
 * no joins, and a bare name inside a correlated subquery then binds to the
 * SUBQUERY's table if that table happens to have a column of the same name. That
 * silently produced always-false comparisons in the person and vehicle registers
 * (flag counts stuck at zero, no error). These constants make the binding
 * explicit rather than relying on the absence of a name collision.
 */
const INCIDENT_ID = sql.raw('"incident"."id"');

export interface MapUnitRow {
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
  posX: number | null;
  posY: number | null;
  posZ: number | null;
  heading: number | null;
  speed: number | null;
  positionUpdatedAt: Date | null;
  vehicleId: string | null;
  vehiclePlate: string | null;
  vehicleModel: string | null;
  vehicleDisplayName: string | null;
  vehicleClass: string | null;
  incidentId: string | null;
  incidentNumber: string | null;
  incidentTitle: string | null;
  incidentPriority: number | null;
  incidentStatus: string | null;
}

/**
 * THE VISIBILITY PREDICATE, as SQL.
 *
 * Transcribed from docs/architecture/05-map.md §5 and deliberately written as
 * one expression so it reads the way the rule does. It is applied in the WHERE
 * clause of every unit query in this module; there is no code path that reads
 * units without it.
 *
 * The third clause is the interesting one. `settings->>'shareOnPublicMap'` is
 * compared to the string `'true'` rather than cast to boolean, because a JSONB
 * key that is absent, null, or a non-boolean must read as "not shared". A cast
 * would raise on a malformed value and take the whole map down; this treats
 * anything that is not literally true as false, which is the safe direction.
 */
function visibilityPredicate(scope: MapScope) {
  if (scope.canTrackAllOrganizations) return sql`true`;

  const clauses = [];

  // 1. Own organization — unconditional, covert included. A dispatcher who
  //    cannot see their own covert units cannot dispatch them.
  if (scope.organizationIds.length > 0) {
    clauses.push(inArray(unit.organizationId, scope.organizationIds));
  }

  // 2. Shared, non-covert units, for a caller cleared to track units at all.
  if (scope.canTrackUnits) {
    clauses.push(sql`(
      ${organization.settings}->>'shareOnPublicMap' = 'true'
      AND ${unit.isCovert} = false
    )`);
  }

  // Nothing qualifies: return no rows rather than every row. An empty
  // disjunction that collapsed to TRUE would be a total visibility bypass, so
  // this is stated explicitly instead of being left to `and(...[])`.
  if (clauses.length === 0) return sql`false`;

  return or(...clauses)!;
}

export async function listMapUnits(db: Database, scope: MapScope): Promise<MapUnitRow[]> {
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
      posX: unit.posX,
      posY: unit.posY,
      posZ: unit.posZ,
      heading: unit.heading,
      speed: unit.speed,
      positionUpdatedAt: unit.positionUpdatedAt,
      vehicleId: vehicle.id,
      vehiclePlate: vehicle.plate,
      vehicleModel: vehicle.model,
      vehicleDisplayName: vehicle.displayName,
      vehicleClass: vehicle.vehicleClass,
      incidentId: incident.id,
      incidentNumber: incident.number,
      incidentTitle: incident.title,
      incidentPriority: incident.priority,
      incidentStatus: incident.status,
    })
    .from(unit)
    .innerJoin(organization, eq(organization.id, unit.organizationId))
    .innerJoin(operationalStatus, eq(operationalStatus.key, unit.statusKey))
    .leftJoin(vehicle, eq(vehicle.id, unit.vehicleId))
    .leftJoin(incident, eq(incident.id, unit.currentIncidentId))
    .where(and(eq(unit.status, 'active'), visibilityPredicate(scope)))
    .orderBy(asc(organization.shortName), asc(unit.callsign), asc(unit.id));
}

export interface MapCrewRow {
  unitId: string;
  memberId: string;
  name: string;
  callsign: string | null;
  isLeader: boolean;
}

/**
 * Crew for a set of units, in one query.
 *
 * Loaded separately rather than as a join on the unit query, because a unit with
 * four crew would otherwise multiply its row four times and every position field
 * with it. Callers pass the unit ids they already decided are visible, so this
 * needs no visibility predicate of its own — but it takes an explicit id list
 * rather than re-deriving one, so it cannot be called in a way that widens the
 * set.
 */
export async function listMapCrew(db: Database, unitIds: string[]): Promise<MapCrewRow[]> {
  if (unitIds.length === 0) return [];

  return db
    .select({
      unitId: unitMember.unitId,
      memberId: unitMember.memberId,
      // Falls back to the account's display name when the membership has no
      // in-game character attached: an unnamed crew slot is worse than either.
      name: sql<string>`coalesce(
        ${person.firstName} || ' ' || ${person.lastName},
        ${userAccount.displayName},
        'Unknown'
      )`,
      callsign: organizationMember.callsign,
      isLeader: unitMember.isLeader,
    })
    .from(unitMember)
    .innerJoin(organizationMember, eq(organizationMember.id, unitMember.memberId))
    .innerJoin(userAccount, eq(userAccount.id, organizationMember.userId))
    .leftJoin(person, eq(person.id, organizationMember.personId))
    .where(and(inArray(unitMember.unitId, unitIds), isNull(unitMember.leftAt)))
    .orderBy(desc(unitMember.isLeader), asc(unitMember.joinedAt));
}

export interface MapIncidentRow {
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
  assignedUnitCount: number;
  openedAt: Date;
}

/**
 * Open incidents that have a position.
 *
 * Scoped like the dispatch queue: own organization, plus multi-agency calls
 * (`organization_id IS NULL`), which belong to everyone by definition. An
 * incident without coordinates is excluded here rather than returned and
 * skipped by the renderer — it has no place on a map, and shipping it would
 * mean every consumer has to remember to null-check.
 */
export async function listMapIncidents(db: Database, scope: MapScope): Promise<MapIncidentRow[]> {
  if (!scope.canViewIncidents) return [];

  const orgClause = scope.canTrackAllOrganizations
    ? undefined
    : scope.organizationIds.length > 0
      ? or(inArray(incident.organizationId, scope.organizationIds), isNull(incident.organizationId))
      : isNull(incident.organizationId);

  return db
    .select({
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
      assignedUnitCount: sql<number>`(
        SELECT count(*)::int FROM incident_assignment ia
        WHERE ia.incident_id = ${INCIDENT_ID} AND ia.released_at IS NULL)`,
      openedAt: incident.createdAt,
    })
    .from(incident)
    .leftJoin(organization, eq(organization.id, incident.organizationId))
    .leftJoin(incidentType, eq(incidentType.key, incident.typeKey))
    .where(and(
      isNull(incident.deletedAt),
      inArray(incident.status, ['pending', 'dispatched', 'on_scene', 'on_hold']),
      sql`${incident.posX} IS NOT NULL AND ${incident.posY} IS NOT NULL`,
      orgClause,
    ))
    .orderBy(asc(incident.priority), asc(incident.createdAt), asc(incident.id));
}

export interface MapMarkerRow {
  id: string;
  type: string;
  label: string;
  description: string | null;
  posX: number;
  posY: number;
  posZ: number | null;
  color: string | null;
  organizationId: string | null;
  organizationKey: string | null;
  organizationShortName: string | null;
  organizationColor: string | null;
  createdByName: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * Operator-placed markers.
 *
 * Expired markers are filtered in SQL rather than swept by a job: a roadblock
 * whose expiry has passed must stop being drawn the moment it lapses, and a
 * cleanup job running every few minutes would leave it on the map in between.
 * The rows are tidied separately; correctness does not depend on that.
 */
export async function listMapMarkers(db: Database, scope: MapScope): Promise<MapMarkerRow[]> {
  if (!scope.canViewMarkers) return [];

  const orgClause = scope.canTrackAllOrganizations
    ? undefined
    : scope.organizationIds.length > 0
      ? or(inArray(mapMarker.organizationId, scope.organizationIds), isNull(mapMarker.organizationId))
      : isNull(mapMarker.organizationId);

  return db
    .select({
      id: mapMarker.id,
      type: mapMarker.type,
      label: mapMarker.label,
      description: mapMarker.description,
      posX: mapMarker.posX,
      posY: mapMarker.posY,
      posZ: mapMarker.posZ,
      color: mapMarker.color,
      organizationId: mapMarker.organizationId,
      organizationKey: organization.key,
      organizationShortName: organization.shortName,
      organizationColor: organization.color,
      createdByName: userAccount.displayName,
      createdAt: mapMarker.createdAt,
      expiresAt: mapMarker.expiresAt,
    })
    .from(mapMarker)
    .leftJoin(organization, eq(organization.id, mapMarker.organizationId))
    .leftJoin(userAccount, eq(userAccount.id, mapMarker.createdBy))
    .where(and(
      isNull(mapMarker.deletedAt),
      or(isNull(mapMarker.expiresAt), gt(mapMarker.expiresAt, sql`now()`)),
      orgClause,
    ))
    .orderBy(desc(mapMarker.createdAt), asc(mapMarker.id));
}

export interface MapShapeRow {
  id: string;
  kind: string;
  label: string;
  description: string | null;
  color: string | null;
  pointsX: number[];
  pointsY: number[];
  organizationId: string | null;
  organizationKey: string | null;
  organizationShortName: string | null;
  organizationColor: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

/**
 * Operator-drawn areas and routes.
 *
 * THE SAME visibility clause as markers, and gated on the same `canViewMarkers`.
 * A shape the caller may not see is never SELECTed — it is not in the payload
 * the browser filters, which is the whole reason the client-side filter is
 * allowed to be a view filter (docs/architecture/05-map.md §5).
 *
 * Lapsed shapes are excluded in SQL, like lapsed markers, so a cordon stops
 * being drawn the moment it lapses rather than when a sweep happens to run.
 */
export async function listMapShapes(db: Database, scope: MapScope): Promise<MapShapeRow[]> {
  if (!scope.canViewMarkers) return [];

  const orgClause = scope.canTrackAllOrganizations
    ? undefined
    : scope.organizationIds.length > 0
      ? or(inArray(mapShape.organizationId, scope.organizationIds), isNull(mapShape.organizationId))
      : isNull(mapShape.organizationId);

  return db
    .select({
      id: mapShape.id,
      kind: mapShape.kind,
      label: mapShape.label,
      description: mapShape.description,
      color: mapShape.color,
      pointsX: mapShape.pointsX,
      pointsY: mapShape.pointsY,
      organizationId: mapShape.organizationId,
      organizationKey: organization.key,
      organizationShortName: organization.shortName,
      organizationColor: organization.color,
      createdByName: userAccount.displayName,
      createdAt: mapShape.createdAt,
      updatedAt: mapShape.updatedAt,
      expiresAt: mapShape.expiresAt,
    })
    .from(mapShape)
    .leftJoin(organization, eq(organization.id, mapShape.organizationId))
    .leftJoin(userAccount, eq(userAccount.id, mapShape.createdBy))
    .where(and(
      isNull(mapShape.deletedAt),
      or(isNull(mapShape.expiresAt), gt(mapShape.expiresAt, sql`now()`)),
      orgClause,
    ))
    .orderBy(desc(mapShape.createdAt), asc(mapShape.id));
}

/**
 * One shape, WITHOUT the visibility clause.
 *
 * The caller applies its own — `assertOverlayScope` — because a mutation must
 * distinguish "another organization's" from "does not exist", and a query that
 * had already filtered one out could not tell them apart.
 */
export async function getShapeCore(db: Database, shapeId: string) {
  const [row] = await db
    .select({
      id: mapShape.id,
      kind: mapShape.kind,
      label: mapShape.label,
      organizationId: mapShape.organizationId,
      deletedAt: mapShape.deletedAt,
    })
    .from(mapShape)
    .where(eq(mapShape.id, shapeId))
    .limit(1);
  return row ?? null;
}

/** Organizations that can appear on this caller's map — the filter chip list. */
export async function listMapOrganizations(db: Database, scope: MapScope) {
  const where = scope.canTrackAllOrganizations
    ? and(isNull(organization.deletedAt), eq(organization.isActive, true))
    : and(
      isNull(organization.deletedAt),
      eq(organization.isActive, true),
      scope.organizationIds.length > 0
        ? or(
          inArray(organization.id, scope.organizationIds),
          scope.canTrackUnits ? sql`${organization.settings}->>'shareOnPublicMap' = 'true'` : undefined,
        )
        : scope.canTrackUnits
          ? sql`${organization.settings}->>'shareOnPublicMap' = 'true'`
          : sql`false`,
    );

  return db
    .select({
      id: organization.id,
      key: organization.key,
      shortName: organization.shortName,
      color: organization.color,
    })
    .from(organization)
    .where(where)
    .orderBy(asc(organization.shortName));
}

/** A single marker, for authorizing a mutation against its real organization. */
export async function getMarkerCore(db: Database, markerId: string) {
  const [row] = await db
    .select({
      id: mapMarker.id,
      organizationId: mapMarker.organizationId,
      label: mapMarker.label,
      createdBy: mapMarker.createdBy,
      deletedAt: mapMarker.deletedAt,
    })
    .from(mapMarker)
    .where(eq(mapMarker.id, markerId))
    .limit(1);
  return row ?? null;
}

/**
 * The unit ids one subscriber may see positions for.
 *
 * Used by the real-time hub to filter the position feed per subscriber. It runs
 * the SAME `visibilityPredicate` as every other query in this module, so the
 * live feed cannot become a second, weaker door onto covert units than the
 * snapshot is — which is exactly the failure mode the map's visibility rules
 * exist to prevent.
 *
 * Ids only. The hub does not need unit detail and should not be handed it.
 */
export async function visibleUnitIdsFor(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
): Promise<Set<string>> {
  const scope = resolveMapScope(actor, actorUserId);
  if (!scope.canViewMap) return new Set();

  const rows = await db
    .select({ id: unit.id })
    .from(unit)
    .innerJoin(organization, eq(organization.id, unit.organizationId))
    .where(and(eq(unit.status, 'active'), visibilityPredicate(scope)));

  return new Set(rows.map((r) => r.id));
}
