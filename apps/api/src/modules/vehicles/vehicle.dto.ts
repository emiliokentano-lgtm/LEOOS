import { can, type ActorContext } from '@leoos/authz-core';
import type {
  VehicleCore, VehicleFlagRow, VehicleHistoryRow, VehicleListItem,
} from './vehicle.read.js';
import { canWriteVehicle } from './vehicle.service.js';

/**
 * Vehicle DTOs — the serialization boundary (engineering rule 16).
 *
 * Every field is named. The per-record capability flags are COSMETIC: they
 * decide what the screen renders, and every one is decided again server-side
 * inside the transaction that performs the change.
 */

export interface VehicleListItemDto extends VehicleListItem {
  /** False for another organization's fleet, whatever permissions the caller holds. */
  manageable: boolean;
  lockedReason: string | null;
}

export function toVehicleListItemDto(
  row: VehicleListItem,
  actor: ActorContext,
): VehicleListItemDto {
  const manageable = canWriteVehicle(actor, row, 'vehicles.edit');
  return {
    id: row.id,
    plate: row.plate,
    model: row.model,
    displayName: row.displayName,
    color: row.color,
    vehicleClass: row.vehicleClass,
    registrationStatus: row.registrationStatus,
    insuranceStatus: row.insuranceStatus,
    isFleet: row.isFleet,
    ownerPersonId: row.ownerPersonId,
    ownerName: row.ownerName,
    ownerOrganizationId: row.ownerOrganizationId,
    ownerOrganizationKey: row.ownerOrganizationKey,
    ownerOrganizationColor: row.ownerOrganizationColor,
    flagCount: row.flagCount,
    ownerHasWarrant: row.ownerHasWarrant,
    isArchived: row.isArchived,
    createdAt: row.createdAt,
    manageable,
    lockedReason: manageable
      ? null
      : row.ownerOrganizationId !== null && !can(actor, 'vehicles.edit')
        ? 'Editing vehicles requires the “Edit vehicles” permission'
        : row.ownerOrganizationId !== null
          ? `Fleet vehicle of ${row.ownerOrganizationKey ?? 'another organization'}`
          : 'Editing vehicles requires the “Edit vehicles” permission',
  };
}

export interface VehicleScreenCapabilitiesDto {
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canManageFlags: boolean;
  canViewArchived: boolean;
  /** The organization a new fleet vehicle would be assigned to. */
  actorOrganizationId: string | null;
}

export function toVehicleScreenCapabilitiesDto(
  actor: ActorContext,
): VehicleScreenCapabilitiesDto {
  return {
    canCreate: can(actor, 'vehicles.create'),
    canEdit: can(actor, 'vehicles.edit'),
    canArchive: can(actor, 'vehicles.delete'),
    canRestore: can(actor, 'vehicles.restore'),
    canManageFlags: can(actor, 'vehicles.flags.manage'),
    canViewArchived: can(actor, 'vehicles.view_deleted'),
    actorOrganizationId: actor.organizationId,
  };
}

export interface VehicleProfileDto {
  vehicle: VehicleListItemDto & {
    notes: string | null;
    archivedReason: string | null;
    updatedAt: string;
    createdByName: string | null;
    ownerStatus: string | null;
    ownerPhone: string | null;
    ownerOrganizationName: string | null;
  };
  flags: VehicleFlagRow[];
  history: VehicleHistoryRow[];
  capabilities: {
    canEdit: boolean;
    canArchive: boolean;
    canRestore: boolean;
    canManageFlags: boolean;
  };
}

export function toVehicleProfileDto(input: {
  core: VehicleCore;
  flags: VehicleFlagRow[];
  history: VehicleHistoryRow[];
  actor: ActorContext;
}): VehicleProfileDto {
  const base = toVehicleListItemDto(input.core, input.actor);

  return {
    vehicle: {
      ...base,
      notes: input.core.notes,
      archivedReason: input.core.archivedReason,
      updatedAt: input.core.updatedAt,
      createdByName: input.core.createdByName,
      ownerStatus: input.core.ownerStatus,
      ownerPhone: input.core.ownerPhone,
      ownerOrganizationName: input.core.ownerOrganizationName,
    },
    flags: input.flags,
    history: input.history,
    capabilities: {
      canEdit: canWriteVehicle(input.actor, input.core, 'vehicles.edit'),
      canArchive: canWriteVehicle(input.actor, input.core, 'vehicles.delete'),
      canRestore: canWriteVehicle(input.actor, input.core, 'vehicles.restore'),
      // Flagging is deliberately NOT fleet-scoped — see the service.
      canManageFlags: can(input.actor, 'vehicles.flags.manage'),
    },
  };
}
