import { and, eq, isNull } from 'drizzle-orm';
import {
  isWithinWorldBounds,
  type MapSnapshot, type MapSourceStatus, type MapTick, type MapUnit,
  type UnitPositionDelta,
} from '@leoos/contracts';
import { AUDIT_ACTIONS, mapMarker, type Database } from '@leoos/db';
import type { ActorContext } from '@leoos/authz-core';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  getMarkerCore, listMapCrew, listMapIncidents, listMapMarkers, listMapOrganizations,
  listMapUnits, type MapUnitRow,
} from './map.read.js';
import {
  toMapCapabilitiesDto, toMapIncidentDto, toMapMarkerDto, toMapUnitDto, toPositionDeltaDto,
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
  const [unitRows, incidentRows, markerRows, organizations] = await Promise.all([
    listMapUnits(deps.db, scope),
    listMapIncidents(deps.db, scope),
    listMapMarkers(deps.db, scope),
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
 * Decides which organization a marker belongs to.
 *
 * NOT read from the request body as given: a caller may only pin a marker to an
 * organization they are acting in. Allowing an arbitrary id would let anyone
 * place a "roadblock" on another agency's map — cosmetic in isolation, but the
 * same shape of bug as every cross-organization write this system defends
 * against, so it is refused the same way (engineering rule 11).
 *
 * A GLOBAL marker (`null`) requires `map.track_all_orgs`, the same clearance
 * that lets someone see every organization in the first place. A caller without
 * it is scoped DOWN to their own organization rather than refused: `null` is
 * indistinguishable from an omitted field, and placing a marker without naming
 * an organization is the ordinary case, not an attempt at anything.
 */
function resolveMarkerOrganization(scope: MapScope, requested: string | null): string | null {
  if (requested === null) {
    if (!scope.canTrackAllOrganizations) {
      if (scope.actorOrganizationId === null) {
        throw new ForbiddenError('Select an organization before placing a marker.');
      }
      return scope.actorOrganizationId;
    }
    return null;
  }

  if (scope.canTrackAllOrganizations) return requested;
  if (requested !== scope.actorOrganizationId) {
    throw new ForbiddenError('A marker can only be placed for the organization you are acting in.');
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

  const organizationId = resolveMarkerOrganization(scope, input.organizationId);

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
  assertMarkerScope(scope, existing.organizationId);

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
  assertMarkerScope(scope, existing.organizationId);

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

function assertMarkerScope(scope: MapScope, markerOrganizationId: string | null): void {
  if (scope.canTrackAllOrganizations) return;
  if (markerOrganizationId === null) {
    throw new ForbiddenError('Only a global map administrator can change a shared marker.');
  }
  if (!scope.organizationIds.includes(markerOrganizationId)) {
    throw new NotFoundError('marker');
  }
}
