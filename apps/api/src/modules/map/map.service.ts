import { and, eq, isNull } from 'drizzle-orm';
import {
  isWithinWorldBounds, validateShapeGeometry,
  type MapShapeKind, type MapShapePoint, type MapSnapshot, type MapSourceStatus, type MapTick,
  type MapUnit, type UnitPositionDelta,
} from '@leoos/contracts';
import { AUDIT_ACTIONS, mapMarker, mapShape, type Database } from '@leoos/db';
import type { ActorContext } from '@leoos/authz-core';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  getMarkerCore, getShapeCore, listMapCrew, listMapIncidents, listMapMarkers,
  listMapOrganizations, listMapShapes, listMapUnits, type MapUnitRow,
} from './map.read.js';
import {
  toMapCapabilitiesDto, toMapIncidentDto, toMapMarkerDto, toMapShapeDto, toMapUnitDto,
  toPositionDeltaDto,
} from './map.dto.js';
import type { MapScope } from './map.scope.js';
import type { LivePositionStore } from './sources/live-positions.js';

/**
 * Map assembly and marker mutations.
 *
 * The read side is a composition rather than one query: unit METADATA comes from
 * Postgres, unit POSITION comes from the live store. That split is the whole
 * point of the design — metadata changes when someone joins a patrol, position
 * changes every second, and putting both in the same table at the same rate is
 * what engineering rules 21 and 22 forbid.
 */

/**
 * Overlays live positions onto database rows.
 *
 * The stored `pos_*` columns are a cache flushed at a low rate, so they lag by
 * up to a flush interval. Where the live store has something newer it wins;
 * where it does not — a unit that has not reported since the process started —
 * the cached value is used and its real age is reported, so the client can mark
 * it stale rather than draw a confident marker on a half-hour-old position.
 */
function overlayLivePositions(rows: MapUnitRow[], store: LivePositionStore): MapUnitRow[] {
  return rows.map((row) => {
    const live = store.get(row.id);
    if (live === undefined) return row;
    if (row.positionUpdatedAt !== null && row.positionUpdatedAt > live.sampledAt) return row;
    return {
      ...row,
      posX: live.x,
      posY: live.y,
      posZ: live.z,
      heading: live.heading,
      speed: live.speed,
      positionUpdatedAt: live.sampledAt,
    };
  });
}

export interface SnapshotDeps {
  db: Database;
  store: LivePositionStore;
  source: MapSourceStatus;
}

export async function buildMapSnapshot(
  deps: SnapshotDeps,
  scope: MapScope,
): Promise<MapSnapshot> {
  const [unitRows, incidentRows, markerRows, shapeRows, organizations] = await Promise.all([
    listMapUnits(deps.db, scope),
    listMapIncidents(deps.db, scope),
    listMapMarkers(deps.db, scope),
    listMapShapes(deps.db, scope),
    listMapOrganizations(deps.db, scope),
  ]);

  const overlaid = overlayLivePositions(unitRows, deps.store);
  const crew = await listMapCrew(deps.db, overlaid.map((r) => r.id));

  const crewByUnit = new Map<string, typeof crew>();
  for (const member of crew) {
    const bucket = crewByUnit.get(member.unitId);
    if (bucket) bucket.push(member);
    else crewByUnit.set(member.unitId, [member]);
  }

  const units: MapUnit[] = overlaid.map((row) => toMapUnitDto(row, crewByUnit.get(row.id) ?? []));

  return {
    serverTime: new Date().toISOString(),
    units,
    incidents: incidentRows
      .map(toMapIncidentDto)
      .filter((i): i is NonNullable<typeof i> => i !== null),
    markers: markerRows.map(toMapMarkerDto),
    shapes: shapeRows.map(toMapShapeDto),
    organizations,
    capabilities: toMapCapabilitiesDto(scope),
    source: deps.source,
  };
}

/**
 * The position-only tick.
 *
 * Runs the SAME visibility predicate as the snapshot rather than trusting the
 * set of unit ids the client already knows about. A client that has been open
 * across a permission change, or across a unit being flagged covert, must stop
 * receiving that unit immediately — re-deriving visibility every tick is what
 * makes that true without any revocation machinery.
 *
 * `knownUnitIds` therefore only decides what is reported as REMOVED and whether
 * a resync is needed; it never widens what is returned.
 */
export async function buildMapTick(
  deps: SnapshotDeps,
  scope: MapScope,
  knownUnitIds: readonly string[],
): Promise<MapTick> {
  const rows = overlayLivePositions(await listMapUnits(deps.db, scope), deps.store);

  const positions: UnitPositionDelta[] = rows
    .map(toPositionDeltaDto)
    .filter((d): d is UnitPositionDelta => d !== null);

  const visible = new Set(rows.map((r) => r.id));
  const removed = knownUnitIds.filter((id) => !visible.has(id));

  // A unit the client has never seen carries metadata the tick does not include,
  // so it asks for a snapshot rather than rendering a nameless marker.
  const known = new Set(knownUnitIds);
  const resyncRequired = knownUnitIds.length > 0 && positions.some((p) => !known.has(p.unitId));

  return {
    serverTime: new Date().toISOString(),
    positions,
    removed,
    resyncRequired,
  };
}

// ── Marker mutations ───────────────────────────────────────────────────────

export interface MarkerInput {
  type: 'hazard' | 'roadblock' | 'staging' | 'command_post' | 'poi' | 'custom';
  label: string;
  description: string | null;
  x: number;
  y: number;
  z: number | null;
  color: string | null;
  /** Null pins the marker for every organization. */
  organizationId: string | null;
  expiresAt: Date | null;
}

/**
 * Rejects a coordinate outside the playable world.
 *
 * A marker at (1e9, 1e9) is not a rendering nuisance — it destroys the auto-fit
 * for every other operator on the map, because fitting to the marker set then
 * zooms out to include a point nobody can see.
 */
function assertPlaceable(x: number, y: number): void {
  if (!isWithinWorldBounds({ x, y })) {
    throw new ValidationError('That position is outside the map.');
  }
}

/**
 * Decides which organization a marker or a shape belongs to.
 *
 * NOT read from the request body as given: a caller may only pin an overlay to
 * an organization they are acting in. Allowing an arbitrary id would let anyone
 * place a "roadblock" on another agency's map — cosmetic in isolation, but the
 * same shape of bug as every cross-organization write this system defends
 * against, so it is refused the same way (engineering rule 11).
 *
 * A GLOBAL overlay (`null`) requires `map.track_all_orgs`, the same clearance
 * that lets someone see every organization in the first place. A caller without
 * it is scoped DOWN to their own organization rather than refused: `null` is
 * indistinguishable from an omitted field, and placing something without naming
 * an organization is the ordinary case, not an attempt at anything.
 *
 * ONE function for both, because it is one rule. A second copy for shapes would
 * be a second copy to drift from this one, and drift here is a cross-agency
 * write.
 */
function resolveOverlayOrganization(
  scope: MapScope, requested: string | null, noun: string,
): string | null {
  if (requested === null) {
    if (!scope.canTrackAllOrganizations) {
      if (scope.actorOrganizationId === null) {
        throw new ForbiddenError(`Select an organization before placing a ${noun}.`);
      }
      return scope.actorOrganizationId;
    }
    return null;
  }

  if (scope.canTrackAllOrganizations) return requested;
  if (requested !== scope.actorOrganizationId) {
    throw new ForbiddenError(
      `A ${noun} can only be placed for the organization you are acting in.`,
    );
  }
  return requested;
}

export async function createMapMarker(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  scope: MapScope,
  input: MarkerInput,
  meta: RequestMeta,
): Promise<{ id: string }> {
  if (!scope.canManageMarkers) throw new ForbiddenError('You cannot place map markers.');
  assertPlaceable(input.x, input.y);

  const organizationId = resolveOverlayOrganization(scope, input.organizationId, 'marker');

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(mapMarker)
      .values({
        organizationId,
        type: input.type,
        label: input.label,
        description: input.description,
        posX: input.x,
        posY: input.y,
        posZ: input.z,
        color: input.color,
        createdBy: actorUserId,
        expiresAt: input.expiresAt,
      })
      .returning({ id: mapMarker.id });

    if (!created) throw new ValidationError('The marker could not be created.');

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MAP_MARKER_PLACED,
      actorUserId, organizationId,
      entityType: 'map_marker', entityId: created.id,
      after: { type: input.type, label: input.label },
      metadata: {
        // World coordinates, so the entry still means something after the tile
        // set is re-calibrated. A map-space value would not.
        position: { x: input.x, y: input.y },
        global: organizationId === null,
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { id: created.id };
  });
}

export async function updateMapMarker(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  scope: MapScope,
  markerId: string,
  changes: Partial<Pick<MarkerInput, 'label' | 'description' | 'x' | 'y' | 'color' | 'expiresAt'>>,
  meta: RequestMeta,
): Promise<void> {
  if (!scope.canManageMarkers) throw new ForbiddenError('You cannot change map markers.');

  if (changes.x !== undefined && changes.y !== undefined) assertPlaceable(changes.x, changes.y);

  const existing = await getMarkerCore(db, markerId);
  if (!existing || existing.deletedAt !== null) throw new NotFoundError('marker');

  // Scope before anything else, so a cross-organization attempt is refused as
  // exactly that rather than as a missing permission (the ordering every other
  // mutation in this codebase uses).
  assertOverlayScope(scope, existing.organizationId, 'marker');

  await db.transaction(async (tx) => {
    await tx
      .update(mapMarker)
      .set({
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.x === undefined ? {} : { posX: changes.x }),
        ...(changes.y === undefined ? {} : { posY: changes.y }),
        ...(changes.color === undefined ? {} : { color: changes.color }),
        ...(changes.expiresAt === undefined ? {} : { expiresAt: changes.expiresAt }),
      })
      .where(and(eq(mapMarker.id, markerId), isNull(mapMarker.deletedAt)));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MAP_MARKER_UPDATED,
      actorUserId, organizationId: existing.organizationId,
      entityType: 'map_marker', entityId: markerId,
      metadata: { changed: Object.keys(changes) },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

export async function removeMapMarker(
  db: Database,
  actor: ActorContext,
  actorUserId: string,
  scope: MapScope,
  markerId: string,
  meta: RequestMeta,
): Promise<void> {
  if (!scope.canManageMarkers) throw new ForbiddenError('You cannot remove map markers.');

  const existing = await getMarkerCore(db, markerId);
  if (!existing || existing.deletedAt !== null) throw new NotFoundError('marker');
  assertOverlayScope(scope, existing.organizationId, 'marker');

  await db.transaction(async (tx) => {
    // Soft deletion (ADR-0008): a marker is part of the record of how a scene was
    // managed, and "who removed the roadblock, and when" is a question that gets
    // asked after the fact.
    await tx
      .update(mapMarker)
      .set({ deletedAt: new Date(), deletedBy: actorUserId })
      .where(and(eq(mapMarker.id, markerId), isNull(mapMarker.deletedAt)));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MAP_MARKER_REMOVED,
      actorUserId, organizationId: existing.organizationId,
      entityType: 'map_marker', entityId: markerId,
      before: { label: existing.label },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

/**
 * Refuses a change to somebody else's overlay.
 *
 * Another organization's is NOT FOUND rather than forbidden — the same answer
 * the rest of the product gives about rows belonging to another agency, so a
 * caller cannot enumerate what exists elsewhere by reading status codes. A
 * SHARED overlay is forbidden rather than hidden: the caller can see it, so
 * pretending it does not exist would be a lie they can disprove by looking.
 */
function assertOverlayScope(
  scope: MapScope, organizationId: string | null, noun: string,
): void {
  if (scope.canTrackAllOrganizations) return;
  if (organizationId === null) {
    throw new ForbiddenError(`Only a global map administrator can change a shared ${noun}.`);
  }
  if (!scope.organizationIds.includes(organizationId)) {
    throw new NotFoundError(noun);
  }
}

// ── Shape mutations ────────────────────────────────────────────────────────

/**
 * Areas and routes.
 *
 * SHARE what should be shared with markers and differ only where they genuinely
 * differ. The permission is the same `map.markers.manage`; the organization rule
 * is the same function; the scope check is the same function; expiry and soft
 * deletion behave identically. What is new is the GEOMETRY, and that is the only
 * thing validated differently.
 *
 * A separate `map.shapes.manage` permission was considered and rejected: it
 * would give every installation a second switch to forget to set, guarding a
 * capability nobody has ever wanted to grant separately. Drawing a cordon and
 * dropping a roadblock pin are the same job.
 */

export interface ShapeInput {
  kind: MapShapeKind;
  label: string;
  description: string | null;
  color: string | null;
  points: MapShapePoint[];
  /** Requested; validated against the caller's own scope, never trusted. */
  organizationId: string | null;
  expiresAt: Date | null;
}

/**
 * Geometry validation, server-side, before anything is written.
 *
 * The rule lives in `@leoos/contracts` so the drawing tool can refuse a bad
 * shape before the round trip, and is enforced HERE because the drawing tool is
 * a convenience and this is the boundary. The point cap in particular is not a
 * tidiness rule: an unbounded array is an allocation whose size the sender
 * chooses, which is a payload attack with a friendly name.
 */
function assertDrawable(kind: MapShapeKind, points: MapShapePoint[]): void {
  const problem = validateShapeGeometry(kind, points);
  if (problem !== null) throw new ValidationError(problem);
}

export async function createMapShape(
  db: Database,
  actorUserId: string,
  scope: MapScope,
  input: ShapeInput,
  meta: RequestMeta,
): Promise<{ id: string }> {
  if (!scope.canManageMarkers) throw new ForbiddenError('You cannot draw on the map.');
  assertDrawable(input.kind, input.points);

  const organizationId = resolveOverlayOrganization(scope, input.organizationId, 'shape');

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(mapShape)
      .values({
        kind: input.kind,
        organizationId,
        label: input.label,
        description: input.description,
        color: input.color,
        pointsX: input.points.map((p) => p.x),
        pointsY: input.points.map((p) => p.y),
        createdBy: actorUserId,
        expiresAt: input.expiresAt,
      })
      .returning({ id: mapShape.id });

    if (!created) throw new ValidationError('The shape could not be created.');

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MAP_SHAPE_DRAWN,
      actorUserId, organizationId,
      entityType: 'map_shape', entityId: created.id,
      after: { kind: input.kind, label: input.label },
      metadata: {
        // The point COUNT, not the geometry: an audit row records what happened,
        // it is not a second copy of the shape.
        pointCount: input.points.length,
        global: organizationId === null,
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { id: created.id };
  });
}

export interface ShapeChanges {
  label?: string;
  description?: string | null;
  color?: string | null;
  points?: MapShapePoint[];
  expiresAt?: Date | null;
}

export async function updateMapShape(
  db: Database,
  actorUserId: string,
  scope: MapScope,
  shapeId: string,
  changes: ShapeChanges,
  meta: RequestMeta,
): Promise<void> {
  if (!scope.canManageMarkers) throw new ForbiddenError('You cannot change map shapes.');

  const existing = await getShapeCore(db, shapeId);
  if (!existing || existing.deletedAt !== null) throw new NotFoundError('shape');

  // Scope BEFORE geometry, so a cross-organization attempt is refused as exactly
  // that rather than being told its polygon is malformed.
  assertOverlayScope(scope, existing.organizationId, 'shape');

  /**
   * The KIND cannot change, and re-validating against the STORED one is why.
   *
   * Turning a two-point route into an "area" would produce a polygon enclosing
   * nothing, and the honest fix is to draw the area — so a change of kind is not
   * offered rather than being silently coerced.
   */
  if (changes.points !== undefined) {
    assertDrawable(existing.kind as MapShapeKind, changes.points);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(mapShape)
      .set({
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.color === undefined ? {} : { color: changes.color }),
        ...(changes.points === undefined ? {} : {
          pointsX: changes.points.map((p) => p.x),
          pointsY: changes.points.map((p) => p.y),
        }),
        ...(changes.expiresAt === undefined ? {} : { expiresAt: changes.expiresAt }),
      })
      .where(and(eq(mapShape.id, shapeId), isNull(mapShape.deletedAt)));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MAP_SHAPE_UPDATED,
      actorUserId, organizationId: existing.organizationId,
      entityType: 'map_shape', entityId: shapeId,
      metadata: { changed: Object.keys(changes) },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}

export async function removeMapShape(
  db: Database,
  actorUserId: string,
  scope: MapScope,
  shapeId: string,
  meta: RequestMeta,
): Promise<void> {
  if (!scope.canManageMarkers) throw new ForbiddenError('You cannot remove map shapes.');

  const existing = await getShapeCore(db, shapeId);
  if (!existing || existing.deletedAt !== null) throw new NotFoundError('shape');
  assertOverlayScope(scope, existing.organizationId, 'shape');

  await db.transaction(async (tx) => {
    // Soft (ADR-0008): "when was the cordon lifted, and by whom" is a question
    // asked after the fact, and a hard delete answers it with nothing.
    await tx
      .update(mapShape)
      .set({ deletedAt: new Date(), deletedBy: actorUserId })
      .where(and(eq(mapShape.id, shapeId), isNull(mapShape.deletedAt)));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MAP_SHAPE_REMOVED,
      actorUserId, organizationId: existing.organizationId,
      entityType: 'map_shape', entityId: shapeId,
      before: { kind: existing.kind, label: existing.label },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });
  });
}
