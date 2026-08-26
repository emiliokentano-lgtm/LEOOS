import type {
  DispatchCapabilities, DispatchCounts, DispatchCrewMember, DispatchIncidentDetail,
  DispatchIncidentSummary, DispatchSelfState, DispatchUnit, IncidentPriority,
  IncidentStatusKey, IncidentTimelineEntry, IncidentTimelineKind, MapOrganizationRef,
  OperationalStatusMeta, PanicAlert,
} from '@leoos/contracts';
import type { DispatchScope } from './dispatch.scope.js';
import type {
  AssignmentRow, CrewRow, IncidentDetailRow, IncidentRow, PanicRow, SelfRow, TimelineRow, UnitRow,
} from './dispatch.read.js';

/**
 * Dispatch serialisation boundary.
 *
 * Every response is assembled from a contract type rather than by handing back a
 * row (engineering rule 16). It matters specifically here because the unit row
 * carries `is_covert` and the member rows carry identifiers that have no place
 * on a dispatch board — and because a payload built by spreading a row ships
 * whatever column is added to these tables next.
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
 * The column has a CHECK constraint, so this can only differ if that were
 * dropped — but the DTO promises 1–5 and the renderer should not be the thing
 * that discovers otherwise.
 */
function priorityOf(value: number | null): IncidentPriority {
  return Math.min(5, Math.max(1, Math.round(value ?? 3))) as IncidentPriority;
}

export function toIncidentSummaryDto(
  row: IncidentRow,
  assignedUnitIds: string[],
): DispatchIncidentSummary {
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
    position: row.posX === null || row.posY === null ? null : { x: row.posX, y: row.posY },
    assignedUnitIds,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  };
}

export function toTimelineDto(row: TimelineRow): IncidentTimelineEntry {
  return {
    id: row.id,
    kind: row.entryType as IncidentTimelineKind,
    body: row.body,
    actorLabel: row.actorLabel,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

export function toIncidentDetailDto(input: {
  core: IncidentDetailRow;
  assignments: AssignmentRow[];
  timeline: TimelineRow[];
}): DispatchIncidentDetail {
  const active = input.assignments.filter((a) => a.releasedAt === null);

  return {
    ...toIncidentSummaryDto(input.core, active.map((a) => a.unitId)),
    description: input.core.description,
    source: input.core.source,
    callerPhone: input.core.callerPhone,
    closingNotes: input.core.closingNotes,
    createdByName: input.core.createdByName,
    closedByName: input.core.closedByName,
    // Released assignments are included here, unlike in the queue summary: the
    // detail view is the record of who attended, and a unit that came and went
    // is part of that record.
    assignments: input.assignments.map((a) => ({
      unitId: a.unitId,
      callsign: a.callsign,
      organizationShortName: a.organizationShortName,
      organizationColor: a.organizationColor,
      role: a.role,
      assignedAt: a.assignedAt.toISOString(),
      releasedAt: a.releasedAt === null ? null : a.releasedAt.toISOString(),
    })),
    timeline: input.timeline.map(toTimelineDto),
  };
}

export function toCrewDto(row: CrewRow): DispatchCrewMember {
  return {
    memberId: row.memberId,
    userId: row.userId,
    name: row.name,
    callsign: row.callsign,
    isLeader: row.isLeader,
    statusKey: row.statusKey,
  };
}

export function toUnitDto(row: UnitRow, crew: CrewRow[]): DispatchUnit {
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
      isPanic: row.statusKey === 'panic',
      sortOrder: 0,
    },
    crew: crew.map(toCrewDto),
    vehicle: row.vehicleId === null || row.vehiclePlate === null || row.vehicleModel === null
      ? null
      : {
        id: row.vehicleId,
        plate: row.vehiclePlate,
        model: row.vehicleModel,
        displayName: row.vehicleDisplayName,
      },
    incident: row.incidentId === null || row.incidentNumber === null
      ? null
      : {
        id: row.incidentId,
        number: row.incidentNumber,
        priority: priorityOf(row.incidentPriority),
      },
    position: row.posX === null || row.posY === null || row.positionUpdatedAt === null
      ? null
      : {
        x: row.posX,
        y: row.posY,
        heading: row.heading,
        updatedAt: row.positionUpdatedAt.toISOString(),
      },
    isCovert: row.isCovert,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPanicDto(row: PanicRow): PanicAlert {
  return {
    id: row.id,
    memberId: row.memberId,
    memberName: row.memberName,
    callsign: row.callsign,
    organization: organizationRef(
      row.organizationId, row.organizationKey, row.organizationShortName, row.organizationColor,
    ),
    unitId: row.unitId,
    unitCallsign: row.unitCallsign,
    incidentId: row.incidentId,
    position: row.posX === null || row.posY === null ? null : { x: row.posX, y: row.posY },
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt === null ? null : row.acknowledgedAt.toISOString(),
    acknowledgedByName: row.acknowledgedByName,
  };
}

export function toStatusDto(row: {
  key: string; label: string; shortLabel: string; colorToken: string; icon: string;
  isAvailable: boolean; isOnDuty: boolean; sortOrder: number;
}): OperationalStatusMeta {
  return {
    key: row.key,
    label: row.label,
    shortLabel: row.shortLabel,
    colorToken: row.colorToken,
    icon: row.icon,
    isAvailable: row.isAvailable,
    isOnDuty: row.isOnDuty,
    /**
     * Panic is marked here rather than compared as a string in components.
     * The catalogue is extensible, so an organization could add its own
     * emergency status later; the flag is the seam for that.
     */
    isPanic: row.key === 'panic',
    sortOrder: row.sortOrder,
  };
}

export function toSelfDto(
  row: SelfRow | null,
  scope: DispatchScope,
  ownPanicId: string | null = null,
): DispatchSelfState {
  if (row === null) {
    return {
      memberId: null,
      organizationId: scope.organizationId,
      statusKey: null,
      unitId: null,
      unitCallsign: null,
      isUnitLeader: false,
      canOperate: false,
      ownPanicId: null,
    };
  }
  return {
    memberId: row.memberId,
    organizationId: row.organizationId,
    statusKey: row.statusKey,
    unitId: row.unitId,
    unitCallsign: row.unitCallsign,
    isUnitLeader: row.isUnitLeader,
    canOperate: row.membershipStatus === 'active',
    ownPanicId,
  };
}

export function toCapabilitiesDto(scope: DispatchScope): DispatchCapabilities {
  return {
    canView: scope.canView,
    canCreateIncident: scope.canCreateIncident,
    canManageIncident: scope.canManageIncident,
    canAssignUnits: scope.canAssignUnits,
    canCloseIncident: scope.canCloseIncident,
    canManageUnits: scope.canManageUnits,
    canTriggerPanic: scope.canTriggerPanic,
    canAcknowledgePanic: scope.canAcknowledgePanic,
    canRequestBackup: scope.canRequestBackup,
    canShareLocation: scope.canShareLocation,
  };
}

/**
 * Board counts.
 *
 * Computed over exactly the rows this caller received, not by a separate query.
 * A count derived independently is a count that can disagree with the list next
 * to it — and on this screen the two are read together.
 */
export function toCountsDto(
  incidents: DispatchIncidentSummary[],
  units: DispatchUnit[],
  panics: PanicAlert[],
): DispatchCounts {
  const open = incidents.filter((i) => i.closedAt === null
    && i.status !== 'closed' && i.status !== 'cancelled');

  return {
    openIncidents: open.length,
    unassignedIncidents: open.filter((i) => i.assignedUnitIds.length === 0).length,
    criticalIncidents: open.filter((i) => i.priority === 1).length,
    unitsAvailable: units.filter((u) => u.status.isAvailable && u.status.key !== 'at_hq').length,
    unitsBusy: units.filter((u) => u.status.key === 'busy').length,
    unitsInOperation: units.filter((u) => u.status.key === 'in_operation').length,
    unitsAtHq: units.filter((u) => u.status.key === 'at_hq').length,
    unitsOffDuty: units.filter((u) => !u.status.isOnDuty).length,
    unitsPanic: units.filter((u) => u.status.isPanic).length,
    livePanics: panics.length,
  };
}
