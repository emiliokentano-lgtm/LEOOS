/**
 * The permission catalogue — single source of truth.
 *
 * This object is the origin of every permission key in the system. The database
 * `permission` table is seeded from it, the API authorizes against it, and the UI
 * filters navigation with it. A CI check (Phase 2) fails the build if the seeded
 * table and this object diverge.
 *
 * Adding a permission is a one-line addition here plus a migration. That is the
 * extensibility mechanism (engineering rules 7, 8).
 */

export type PermissionScope = 'organization' | 'global';
export type PermissionRisk = 'low' | 'medium' | 'high';

export interface PermissionMeta {
  readonly category: string;
  readonly risk: PermissionRisk;
  /** Organization-scoped unless stated. Global permissions can never be attached
   *  to an organization role — that is what stops a chief writing themselves an
   *  admin role. */
  readonly scope?: PermissionScope;
  readonly label: string;
}

export const PERMISSIONS = {
  // ── personnel ────────────────────────────────────────────────────────────
  'personnel.view': { category: 'personnel', risk: 'low', label: 'View personnel' },
  'personnel.create': { category: 'personnel', risk: 'medium', label: 'Create personnel records' },
  'personnel.edit': { category: 'personnel', risk: 'medium', label: 'Edit personnel records' },
  'personnel.hire': { category: 'personnel', risk: 'high', label: 'Hire members' },
  'personnel.fire': { category: 'personnel', risk: 'high', label: 'Terminate members' },
  'personnel.promote': { category: 'personnel', risk: 'high', label: 'Promote members' },
  'personnel.demote': { category: 'personnel', risk: 'high', label: 'Demote members' },
  'personnel.callsign': { category: 'personnel', risk: 'low', label: 'Assign callsigns' },

  // ── roles ────────────────────────────────────────────────────────────────
  'roles.view': { category: 'roles', risk: 'low', label: 'View roles' },
  'roles.create': { category: 'roles', risk: 'high', label: 'Create roles' },
  'roles.edit': { category: 'roles', risk: 'high', label: 'Edit roles' },
  'roles.delete': { category: 'roles', risk: 'high', label: 'Archive roles' },
  'roles.restore': { category: 'roles', risk: 'medium', label: 'Restore archived roles' },
  'roles.assign': { category: 'roles', risk: 'high', label: 'Assign roles' },
  /**
   * Separate from `roles.edit` on purpose. Renaming a role or moving it a level
   * is an administrative change; changing WHAT IT CAN DO rewrites the authority
   * of everyone holding it. Splitting the two lets an organization delegate the
   * first without the second — the usual case for a personnel officer who
   * maintains the rank list but must not be able to widen it.
   */
  'roles.permissions': { category: 'roles', risk: 'high', label: "Edit a role's permissions" },

  // ── persons ──────────────────────────────────────────────────────────────
  'persons.view': { category: 'persons', risk: 'low', label: 'View persons' },
  'persons.create': { category: 'persons', risk: 'low', label: 'Create person records' },
  'persons.edit': { category: 'persons', risk: 'medium', label: 'Edit person records' },
  'persons.delete': { category: 'persons', risk: 'high', label: 'Archive person records' },
  'persons.restore': { category: 'persons', risk: 'medium', label: 'Restore archived persons' },
  'persons.view_deleted': { category: 'persons', risk: 'medium', label: 'View archived persons' },
  'persons.flags.manage': { category: 'persons', risk: 'medium', label: 'Manage person flags' },
  'persons.warrants.manage': { category: 'persons', risk: 'high', label: 'Manage warrants' },
  'persons.criminal.view': { category: 'persons', risk: 'medium', label: 'View criminal history' },
  'persons.medical.view': { category: 'persons', risk: 'high', label: 'View medical records' },
  'persons.medical.edit': { category: 'persons', risk: 'high', label: 'Edit medical records' },

  // ── vehicles ─────────────────────────────────────────────────────────────
  'vehicles.view': { category: 'vehicles', risk: 'low', label: 'View vehicles' },
  'vehicles.create': { category: 'vehicles', risk: 'low', label: 'Register vehicles' },
  'vehicles.edit': { category: 'vehicles', risk: 'medium', label: 'Edit vehicles' },
  'vehicles.delete': { category: 'vehicles', risk: 'high', label: 'Archive vehicles' },
  'vehicles.restore': { category: 'vehicles', risk: 'medium', label: 'Restore archived vehicles' },
  'vehicles.view_deleted': { category: 'vehicles', risk: 'medium', label: 'View archived vehicles' },
  'vehicles.flags.manage': { category: 'vehicles', risk: 'medium', label: 'Manage vehicle flags' },

  // ── dispatch ─────────────────────────────────────────────────────────────
  'dispatch.view': { category: 'dispatch', risk: 'low', label: 'View dispatch' },
  'dispatch.create': { category: 'dispatch', risk: 'low', label: 'Create incidents' },
  'dispatch.manage': { category: 'dispatch', risk: 'medium', label: 'Manage incidents' },
  'dispatch.assign': { category: 'dispatch', risk: 'medium', label: 'Assign units' },
  'dispatch.close': { category: 'dispatch', risk: 'medium', label: 'Close incidents' },
  'dispatch.panic': { category: 'dispatch', risk: 'low', label: 'Trigger panic' },
  'dispatch.panic.acknowledge': { category: 'dispatch', risk: 'medium', label: 'Acknowledge panic' },
  'units.manage': { category: 'dispatch', risk: 'medium', label: 'Manage units' },

  // ── map ──────────────────────────────────────────────────────────────────
  'map.view': { category: 'map', risk: 'low', label: 'View map' },
  'map.track_units': { category: 'map', risk: 'medium', label: 'Track units' },
  'map.track_all_orgs': { category: 'map', risk: 'high', label: 'Track all organizations' },
  'map.markers.manage': { category: 'map', risk: 'low', label: 'Manage map markers' },
  'map.history': { category: 'map', risk: 'high', label: 'Replay position history' },

  // ── organization ─────────────────────────────────────────────────────────
  'organization.view': { category: 'organization', risk: 'low', label: 'View organization' },
  'organization.edit': { category: 'organization', risk: 'high', label: 'Edit organization' },
  /**
   * Sending an announcement writes a row into every member's notification list.
   *
   * `medium` rather than `low`: it is the only way one person can put text on
   * everybody else's screen, and the audience cannot opt out of the
   * organization category the way they can mute incident chatter. It sits below
   * `organization.edit` because it changes nothing about the organization.
   */
  'organization.announce': { category: 'organization', risk: 'medium', label: 'Send announcements' },

  // ── admin (global scope) ─────────────────────────────────────────────────
  'admin.users': { category: 'admin', risk: 'high', scope: 'global', label: 'Manage user accounts' },
  'admin.organizations': { category: 'admin', risk: 'high', scope: 'global', label: 'Manage organizations' },
  'admin.org_leads': { category: 'admin', risk: 'high', scope: 'global', label: 'Grant organization leads' },
  'admin.audit_logs': { category: 'admin', risk: 'high', scope: 'global', label: 'View audit logs' },
  'admin.game_servers': { category: 'admin', risk: 'high', scope: 'global', label: 'Manage game servers' },
  'admin.impersonate': { category: 'admin', risk: 'high', scope: 'global', label: 'Impersonate users' },
  'admin.purge': { category: 'admin', risk: 'high', scope: 'global', label: 'Permanently erase records' },
} as const satisfies Record<string, PermissionMeta>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function permissionMeta(key: PermissionKey): PermissionMeta {
  // Widened to the interface: the `as const satisfies` above narrows each entry
  // to its literal type, which drops the optional `scope` key from the union.
  return PERMISSIONS[key] as PermissionMeta;
}

export function isGlobalPermission(key: PermissionKey): boolean {
  return permissionMeta(key).scope === 'global';
}

/** Permission keys grouped by category, for the role editor UI. */
export function permissionsByCategory(): Record<string, PermissionKey[]> {
  const out: Record<string, PermissionKey[]> = {};
  for (const key of PERMISSION_KEYS) {
    const cat = permissionMeta(key).category;
    (out[cat] ??= []).push(key);
  }
  return out;
}
