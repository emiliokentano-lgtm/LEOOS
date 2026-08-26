import type {
  IncidentPriority, IncidentStatusKey, MapCapabilities, MapIncidentMarker, MapMarker,
  MapMarkerType, MapOrganizationRef, MapShape, MapShapeKind, MapShapePoint, MapUnit,
  UnitLocation, UnitPositionDelta,
} from '@leoos/contracts';
import type { MapScope } from './map.scope.js';
import type {
  MapCrewRow, MapIncidentRow, MapMarkerRow, MapShapeRow, MapUnitRow,
} from './map.read.js';

/**
 * Map serialisation boundary.
 *
 * Every response is assembled here from an explicit DTO type in
 * `@leoos/contracts` rather than by handing back a row (engineering rule 16).
 * On this screen that matters for a specific reason beyond the general one: the
 * unit row carries `is_covert`, and a payload built by spreading the row would
 * ship that flag — and, worse, would ship whatever column someone adds to `unit`
 * next — to every browser on the map.
 */

function organizationRef(
  id: string, key: string, shortName: string, color: string,
): MapOrganizationRef {
  return { id, key, shortName, color };
}

function optionalOrganizationRef(
  id: string | null, key: string | null, shortName: string | null, color: string | null,
): MapOrganizationRef | null {
  return id === null || key === null || shortName === null
    ? null
    : organizationRef(id, key, shortName, color ?? '#6b7686');
}

/**
 * Clamps a stored priority into the contract's range.
 *
 * The column is a plain integer with a CHECK constraint, so this can only differ
 * if the constraint were ever dropped — but the DTO type promises 1–5 and it
 * should not be the renderer that discovers otherwise.
 */
function priorityOf(value: number): IncidentPriority {
  const clamped = Math.min(5, Math.max(1, Math.round(value)));
  return clamped as IncidentPriority;
}

function locationOf(row: MapUnitRow): UnitLocation | null {
  if (row.posX === null || row.posY === null || row.positionUpdatedAt === null) return null;
  return {
    unitId: row.id,
    organizationId: row.organizationId,
    x: row.posX,
    y: row.posY,
    z: row.posZ,
    heading: row.heading,
    speed: row.speed,
    updatedAt: row.positionUpdatedAt.toISOString(),
  };
}

export function toMapUnitDto(row: MapUnitRow, crew: MapCrewRow[]): MapUnit {
  return {
    id: row.id,
    callsign: row.callsign,
    name: row.name,
    unitType: row.unitType,
    organization: organizationRef(
      row.organizationId, row.organizationKey, row.organizationShortName, row.organizationColor,
    ),
    status: {
      key: row.statusKey,
      label: row.statusLabel,
      shortLabel: row.statusShortLabel,
      colorToken: row.statusColorToken,
      icon: row.statusIcon,
      isAvailable: row.statusIsAvailable,
      isOnDuty: row.statusIsOnDuty,
    },
    crew: crew.map((c) => ({
      memberId: c.memberId,
      name: c.name,
      callsign: c.callsign,
      isLeader: c.isLeader,
    })),
    vehicle: row.vehicleId === null || row.vehiclePlate === null || row.vehicleModel === null
      ? null
      : {
        id: row.vehicleId,
        plate: row.vehiclePlate,
        model: row.vehicleModel,
        displayName: row.vehicleDisplayName,
        vehicleClass: row.vehicleClass,
      },
    incident: row.incidentId === null || row.incidentNumber === null
      ? null
      : {
        id: row.incidentId,
        number: row.incidentNumber,
        title: row.incidentTitle ?? '',
        priority: priorityOf(row.incidentPriority ?? 3),
        status: (row.incidentStatus ?? 'pending') as IncidentStatusKey,
      },
    location: locationOf(row),
    isCovert: row.isCovert,
  };
}

export function toMapIncidentDto(row: MapIncidentRow): MapIncidentMarker | null {
  // The query already excludes positionless incidents; this keeps the DTO honest
  // rather than asserting a non-null the type system cannot see.
  if (row.posX === null || row.posY === null) return null;

  return {
    id: row.id,
    number: row.number,
    title: row.title,
    typeKey: row.typeKey,
    typeLabel: row.typeLabel,
    priority: priorityOf(row.priority),
    status: row.status as IncidentStatusKey,
    organization: optionalOrganizationRef(
      row.organizationId, row.organizationKey, row.organizationShortName, row.organizationColor,
    ),
    locationText: row.locationText,
    x: row.posX,
    y: row.posY,
    assignedUnitCount: row.assignedUnitCount,
    openedAt: row.openedAt.toISOString(),
  };
}

export function toMapMarkerDto(row: MapMarkerRow): MapMarker {
  return {
    id: row.id,
    type: row.type as MapMarkerType,
    label: row.label,
    description: row.description,
    x: row.posX,
    y: row.posY,
    z: row.posZ,
    color: row.color,
    organization: optionalOrganizationRef(
      row.organizationId, row.organizationKey, row.organizationShortName, row.organizationColor,
    ),
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
  };
}

/**
 * Re-pairs the two stored coordinate arrays into points.
 *
 * The DATABASE stores them apart so it can constrain the point count; the WIRE
 * carries them together so a renderer cannot pair them up wrongly. If the two
 * ever disagree in length — which a CHECK constraint forbids — the shorter wins
 * rather than producing a point with an undefined coordinate.
 */
function pointsOf(xs: readonly number[], ys: readonly number[]): MapShapePoint[] {
  const length = Math.min(xs.length, ys.length);
  const points: MapShapePoint[] = [];
  for (let i = 0; i < length; i += 1) points.push({ x: xs[i]!, y: ys[i]! });
  return points;
}

export function toMapShapeDto(row: MapShapeRow): MapShape {
  return {
    id: row.id,
    kind: row.kind as MapShapeKind,
    label: row.label,
    description: row.description,
    color: row.color,
    points: pointsOf(row.pointsX, row.pointsY),
    organization: optionalOrganizationRef(
      row.organizationId, row.organizationKey, row.organizationShortName, row.organizationColor,
    ),
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
  };
}

/**
 * The position delta sent on every tick.
 *
 * Kept to the fields that actually change second to second. Everything stable —
 * crew, vehicle, callsign, organization — is in the snapshot, which is what
 * holds a 300-unit tick under the 5 KB budget.
 */
export function toPositionDeltaDto(row: MapUnitRow): UnitPositionDelta | null {
  if (row.posX === null || row.posY === null || row.positionUpdatedAt === null) return null;
  return {
    unitId: row.id,
    x: row.posX,
    y: row.posY,
    heading: row.heading,
    speed: row.speed,
    statusKey: row.statusKey,
    incidentId: row.incidentId,
    updatedAt: row.positionUpdatedAt.toISOString(),
  };
}

export function toMapCapabilitiesDto(scope: MapScope): MapCapabilities {
  return {
    canViewMap: scope.canViewMap,
    canTrackUnits: scope.canTrackUnits,
    canTrackAllOrganizations: scope.canTrackAllOrganizations,
    canViewMarkers: scope.canViewMarkers,
    canManageMarkers: scope.canManageMarkers,
    canViewHistory: scope.canViewHistory,
    canViewIncidents: scope.canViewIncidents,
    canCreateIncident: scope.canCreateIncident,
    canAssignUnits: scope.canAssignUnits,
  };
}
