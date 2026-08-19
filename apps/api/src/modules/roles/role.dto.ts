import { PERMISSION_KEYS, permissionMeta, type PermissionKey } from '@leoos/contracts';
import { UNBOUNDED_LEVEL, type ActorContext } from '@leoos/authz-core';
import type { RoleRow } from './role.read.js';

/**
 * Role DTOs — the serialization boundary (engineering rule 16).
 *
 * Every field is named; nothing spreads a row. The per-role capability flags
 * below are COSMETIC — they decide what the editor renders, and each one is
 * decided again server-side inside the transaction that performs the change.
 */

export interface RoleCapabilitiesDto {
  canEdit: boolean;
  canEditPermissions: boolean;
  canDelete: boolean;
  canAssign: boolean;
  /** Why the role is locked, when it is — shown in the UI's tooltip. */
  lockedReason: string | null;
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  hierarchyLevel: number;
  isDefault: boolean;
  isSystem: boolean;
  color: string | null;
  memberCount: number;
  permissionCount: number;
  permissions: PermissionKey[];
  isArchived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  capabilities: RoleCapabilitiesDto;
}

function outranksRole(actor: ActorContext, level: number): boolean {
  if (actor.isGlobalAdmin || actor.isOrgLead) return true;
  return actor.level > level;
}

export function toRoleDto(row: RoleRow, actor: ActorContext): RoleDto {
  const reachable = outranksRole(actor, row.hierarchyLevel);
  const privileged = actor.isGlobalAdmin || actor.isOrgLead;

  const lockedReason = !reachable
    ? `Requires a rank above L${row.hierarchyLevel}`
    : row.isSystem
      ? 'System role — its structure is fixed'
      : null;

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    hierarchyLevel: row.hierarchyLevel,
    isDefault: row.isDefault,
    isSystem: row.isSystem,
    color: row.color,
    memberCount: row.memberCount,
    permissionCount: row.permissionCount,
    permissions: row.permissions,
    isArchived: row.isArchived,
    archivedAt: row.archivedAt,
    archivedReason: row.archivedReason,
    capabilities: {
      canEdit: reachable && !row.isSystem
        && (privileged || actor.permissions.has('roles.edit')),
      canEditPermissions: reachable
        && (privileged || actor.permissions.has('roles.permissions')),
      canDelete: reachable && !row.isSystem && !row.isDefault && row.memberCount === 0
        && (privileged || actor.permissions.has('roles.delete')),
      canAssign: reachable && !row.isArchived
        && (privileged || actor.permissions.has('roles.assign')),
      lockedReason,
    },
  };
}

/**
 * The permission catalogue, grouped for the editor.
 *
 * Served from the API rather than imported into the browser bundle so a client
 * cannot render a permission the server would not accept — the two can never
 * drift apart within a deployment.
 *
 * `grantable` marks the keys THIS actor may hand out (H4). Ungrantable keys are
 * still returned, so the editor can show a role's existing permissions honestly
 * rather than appearing to have fewer than it does; they render disabled.
 */
export interface PermissionOptionDto {
  key: PermissionKey;
  label: string;
  category: string;
  risk: string;
  scope: string;
  /** Global-scope keys can never sit on an organization role. */
  organizationScoped: boolean;
  grantable: boolean;
}

export interface PermissionCatalogueDto {
  categories: { category: string; permissions: PermissionOptionDto[] }[];
}

const CATEGORY_ORDER = [
  'personnel', 'roles', 'persons', 'vehicles', 'dispatch', 'map', 'organization', 'admin',
];

export function toPermissionCatalogueDto(actor: ActorContext): PermissionCatalogueDto {
  const privileged = actor.isGlobalAdmin || actor.isOrgLead;
  const byCategory = new Map<string, PermissionOptionDto[]>();

  for (const key of PERMISSION_KEYS) {
    const meta = permissionMeta(key);
    const scope = meta.scope ?? 'organization';
    const organizationScoped = scope === 'organization';

    const option: PermissionOptionDto = {
      key,
      label: meta.label,
      category: meta.category,
      risk: meta.risk,
      scope,
      organizationScoped,
      // A global-scope key is never grantable onto an organization role, not
      // even by a global administrator — the database trigger refuses it too.
      grantable: organizationScoped && (privileged || actor.permissions.has(key)),
    };

    const bucket = byCategory.get(meta.category);
    if (bucket) bucket.push(option);
    else byCategory.set(meta.category, [option]);
  }

  const ordered = [...byCategory.entries()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a[0]);
    const bi = CATEGORY_ORDER.indexOf(b[0]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return {
    categories: ordered.map(([category, permissions]) => ({ category, permissions })),
  };
}

/** What the caller may do in this organization's role screen at all. */
export interface RoleScreenCapabilitiesDto {
  canCreate: boolean;
  canEdit: boolean;
  canEditPermissions: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canAssign: boolean;
  canReorder: boolean;
  /** The actor's ceiling: no role may be created or moved to this level or above. */
  actorLevel: number | 'unbounded';
}

export function toRoleScreenCapabilitiesDto(actor: ActorContext): RoleScreenCapabilitiesDto {
  const privileged = actor.isGlobalAdmin || actor.isOrgLead;
  const has = (key: PermissionKey) => privileged || actor.permissions.has(key);

  return {
    canCreate: has('roles.create'),
    canEdit: has('roles.edit'),
    canEditPermissions: has('roles.permissions'),
    canDelete: has('roles.delete'),
    canRestore: has('roles.restore'),
    canAssign: has('roles.assign'),
    // Reordering is a level change, so it rides on `roles.edit`.
    canReorder: has('roles.edit'),
    actorLevel: actor.level === UNBOUNDED_LEVEL ? 'unbounded' : actor.level,
  };
}
