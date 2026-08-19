import { can, type ActorContext } from '@leoos/authz-core';
import type {
  AffiliationRow, ChargeRow, LicenseRow, MedicalRow, OwnedVehicleRow, PersonAliasRow,
  PersonCore, PersonFlagRow, PersonListItem, WarrantRow,
} from './person.read.js';

/**
 * Person DTOs — the serialization boundary (engineering rule 16).
 *
 * Every field is named; nothing spreads a row. The sensitive sections are
 * OPTIONAL on the profile rather than nulled out: a caller without
 * `persons.criminal.view` gets a response with no `criminal` key at all, and the
 * data was never loaded in the first place (see person.read.ts).
 */

/**
 * Re-exported rather than reimplemented.
 *
 * The kernel's `can()` already resolves global admin, explicit grants and the
 * organization-lead capability — including the rule that a lead never holds a
 * GLOBAL-scope permission. Writing that logic a second time here is how the two
 * drift apart, and the copy is always the one that forgets the exclusion
 * (engineering rules 3, 4).
 */
export const holds = can;

export interface PersonListItemDto {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  address: string | null;
  status: string;
  isDeceased: boolean;
  aliases: string[];
  flagCount: number;
  highestFlagSeverity: string | null;
  activeWarrants: number;
  vehicleCount: number;
  isArchived: boolean;
  createdAt: string;
}

export function toPersonListItemDto(row: PersonListItem): PersonListItemDto {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: row.dateOfBirth,
    phoneNumber: row.phoneNumber,
    address: row.address,
    status: row.status,
    isDeceased: row.isDeceased,
    aliases: row.aliases,
    flagCount: row.flagCount,
    highestFlagSeverity: row.highestFlagSeverity,
    activeWarrants: row.activeWarrants,
    vehicleCount: row.vehicleCount,
    isArchived: row.isArchived,
    createdAt: row.createdAt,
  };
}

export interface PersonCapabilitiesDto {
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canManageFlags: boolean;
  canManageWarrants: boolean;
  canViewCriminal: boolean;
  canViewMedical: boolean;
  canEditMedical: boolean;
  canViewArchived: boolean;
}

export function toPersonCapabilitiesDto(actor: ActorContext): PersonCapabilitiesDto {
  return {
    canCreate: holds(actor, 'persons.create'),
    canEdit: holds(actor, 'persons.edit'),
    canArchive: holds(actor, 'persons.delete'),
    canRestore: holds(actor, 'persons.restore'),
    canManageFlags: holds(actor, 'persons.flags.manage'),
    canManageWarrants: holds(actor, 'persons.warrants.manage'),
    canViewCriminal: holds(actor, 'persons.criminal.view'),
    canViewMedical: holds(actor, 'persons.medical.view'),
    canEditMedical: holds(actor, 'persons.medical.edit'),
    canViewArchived: holds(actor, 'persons.view_deleted'),
  };
}

export interface PersonProfileDto {
  person: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string | null;
    gender: string | null;
    phoneNumber: string | null;
    address: string | null;
    heightCm: number | null;
    weightKg: number | null;
    eyeColor: string | null;
    hairColor: string | null;
    notes: string | null;
    status: string;
    isDeceased: boolean;
    isArchived: boolean;
    archivedReason: string | null;
    createdAt: string;
    updatedAt: string;
    createdByName: string | null;
    updatedByName: string | null;
  };
  aliases: PersonAliasRow[];
  flags: PersonFlagRow[];
  warrants: WarrantRow[];
  licenses: LicenseRow[];
  vehicles: OwnedVehicleRow[];
  affiliations: AffiliationRow[];
  /** Absent entirely without `persons.criminal.view`. */
  criminal?: ChargeRow[];
  /** Absent entirely without `persons.medical.view`. */
  medical?: MedicalRow | null;
  capabilities: PersonCapabilitiesDto;
  /**
   * Which gated sections were withheld, so the UI can say "you do not have
   * access to this" instead of silently showing a record that looks complete.
   * Naming a section the caller cannot open is not a leak — the permission
   * catalogue is public, and a blank space invites the operator to assume there
   * is nothing there.
   */
  withheld: string[];
}

export function toPersonProfileDto(input: {
  core: PersonCore;
  aliases: PersonAliasRow[];
  flags: PersonFlagRow[];
  warrants: WarrantRow[];
  licenses: LicenseRow[];
  vehicles: OwnedVehicleRow[];
  affiliations: AffiliationRow[];
  criminal: ChargeRow[] | null;
  medical: MedicalRow | null | undefined;
  actor: ActorContext;
}): PersonProfileDto {
  const capabilities = toPersonCapabilitiesDto(input.actor);
  const withheld: string[] = [];
  if (!capabilities.canViewCriminal) withheld.push('criminal');
  if (!capabilities.canViewMedical) withheld.push('medical');

  return {
    person: {
      id: input.core.id,
      firstName: input.core.firstName,
      lastName: input.core.lastName,
      dateOfBirth: input.core.dateOfBirth,
      gender: input.core.gender,
      phoneNumber: input.core.phoneNumber,
      address: input.core.address,
      heightCm: input.core.heightCm,
      weightKg: input.core.weightKg,
      eyeColor: input.core.eyeColor,
      hairColor: input.core.hairColor,
      notes: input.core.notes,
      status: input.core.status,
      isDeceased: input.core.isDeceased,
      isArchived: input.core.isArchived,
      archivedReason: input.core.archivedReason,
      createdAt: input.core.createdAt,
      updatedAt: input.core.updatedAt,
      createdByName: input.core.createdByName,
      updatedByName: input.core.updatedByName,
    },
    aliases: input.aliases,
    flags: input.flags,
    warrants: input.warrants,
    licenses: input.licenses,
    vehicles: input.vehicles,
    affiliations: input.affiliations,
    ...(input.criminal !== null ? { criminal: input.criminal } : {}),
    ...(input.medical !== undefined ? { medical: input.medical } : {}),
    capabilities,
    withheld,
  };
}
