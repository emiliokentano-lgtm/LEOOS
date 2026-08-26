import { eq, sql } from 'drizzle-orm';
import type { OrganizationCategory, PermissionKey } from '@leoos/contracts';
import type { Database } from '../client.js';
import { organization, role, rolePermission } from '../schema/index.js';

/**
 * The six initial organizations, and a default rank structure for each.
 *
 * IMPORTANT: this file is the ONLY place these organizations are named, and it
 * is seed DATA, not application logic. Nothing in the codebase branches on an
 * organization key (engineering rules 5, 8). Adding a seventh organization is
 * another entry in this array — no component, query, or authorization path
 * changes.
 *
 * Hierarchy convention (ADR-0007): 1–100, HIGHER MEANS MORE SENIOR. Levels are
 * seeded with gaps so a rank can be inserted later without renumbering.
 */

interface RoleSeed {
  key: string;
  name: string;
  level: number;
  isDefault?: boolean;
  permissions: PermissionKey[];
}

interface OrganizationSeed {
  key: string;
  name: string;
  shortName: string;
  description: string;
  category: OrganizationCategory;
  color: string;
  roles: RoleSeed[];
}

// ── Permission bundles ─────────────────────────────────────────────────────
// Composed rather than repeated, so a rank structure reads as "everything the
// rank below has, plus these".

const BASE_OPERATIONAL: PermissionKey[] = [
  'map.view', 'map.track_units',
  'dispatch.view', 'dispatch.create', 'dispatch.panic',
  /**
   * Asking for help and saying where you are are seeded to EVERYONE who works
   * a shift, for the same reason panic is: the moment somebody needs to shout
   * for backup is not the moment to discover a permission was never granted.
   * They are self-actions and commit nobody else.
   */
  'dispatch.request_backup', 'dispatch.share_location',
  'persons.view', 'vehicles.view',
  'personnel.view', 'roles.view', 'organization.view',
];

const FIELD_OFFICER: PermissionKey[] = [
  ...BASE_OPERATIONAL,
  'persons.create', 'persons.edit', 'persons.flags.manage', 'persons.criminal.view',
  'vehicles.create', 'vehicles.edit', 'vehicles.flags.manage',
  'dispatch.manage', 'dispatch.assign', 'map.markers.manage',
];

const SUPERVISOR: PermissionKey[] = [
  ...FIELD_OFFICER,
  'dispatch.close', 'dispatch.panic.acknowledge', 'units.manage',
  'personnel.edit', 'personnel.callsign',
  'persons.warrants.manage',
];

const COMMAND: PermissionKey[] = [
  ...SUPERVISOR,
  'organization.announce',
  'personnel.hire', 'personnel.fire', 'personnel.promote', 'personnel.demote',
  'personnel.create',
  'roles.create', 'roles.edit', 'roles.assign', 'roles.permissions',
  'persons.delete', 'persons.restore', 'vehicles.delete', 'vehicles.restore',
  'map.track_all_orgs', 'map.history',
];

const CHIEF: PermissionKey[] = [
  ...COMMAND,
  'roles.delete', 'roles.restore', 'organization.edit',
];

const MEDICAL_BASE: PermissionKey[] = [
  ...BASE_OPERATIONAL,
  'persons.medical.view', 'persons.medical.edit',
];

const MEDICAL_SENIOR: PermissionKey[] = [
  ...MEDICAL_BASE,
  'organization.announce',
  'persons.create', 'persons.edit',
  'dispatch.manage', 'dispatch.assign', 'dispatch.close', 'dispatch.panic.acknowledge',
  'units.manage', 'map.markers.manage',
];

const MECHANIC_BASE: PermissionKey[] = [
  'map.view', 'dispatch.view', 'dispatch.create', 'dispatch.panic',
  'dispatch.request_backup', 'dispatch.share_location',
  'vehicles.view', 'vehicles.create', 'vehicles.edit',
  'personnel.view', 'roles.view', 'organization.view',
];

/**
 * Example rank structures.
 *
 * These are STARTING POINTS. Every organization can create, rename, reorder and
 * delete its own roles through the application; nothing here is privileged.
 */
export const ORGANIZATION_SEEDS: OrganizationSeed[] = [
  {
    key: 'PD',
    name: 'Los Santos Police Department',
    shortName: 'LSPD',
    description: 'Municipal law enforcement — patrol, traffic, investigations.',
    category: 'law_enforcement',
    color: '#3b82d9',
    roles: [
      { key: 'chief', name: 'Chief of Police', level: 100, permissions: CHIEF },
      { key: 'deputy_chief', name: 'Deputy Chief', level: 90, permissions: COMMAND },
      { key: 'commander', name: 'Commander', level: 80, permissions: COMMAND },
      { key: 'lieutenant', name: 'Lieutenant', level: 60, permissions: SUPERVISOR },
      { key: 'sergeant', name: 'Sergeant', level: 50, permissions: SUPERVISOR },
      { key: 'officer', name: 'Officer', level: 30, permissions: FIELD_OFFICER },
      { key: 'cadet', name: 'Cadet', level: 10, isDefault: true, permissions: BASE_OPERATIONAL },
    ],
  },
  {
    key: 'MD',
    name: 'Los Santos Medical Department',
    shortName: 'LSMD',
    description: 'Emergency medical services and hospital operations.',
    category: 'medical',
    color: '#2ea86b',
    roles: [
      { key: 'cmo', name: 'Chief Medical Officer', level: 100, permissions: [...MEDICAL_SENIOR, ...CHIEF] },
      { key: 'deputy_cmo', name: 'Deputy Chief Medical Officer', level: 90, permissions: [...MEDICAL_SENIOR, ...COMMAND] },
      { key: 'doctor', name: 'Doctor', level: 60, permissions: MEDICAL_SENIOR },
      { key: 'paramedic', name: 'Paramedic', level: 40, permissions: MEDICAL_BASE },
      { key: 'emt', name: 'EMT', level: 20, permissions: MEDICAL_BASE },
      { key: 'trainee', name: 'Trainee', level: 10, isDefault: true, permissions: BASE_OPERATIONAL },
    ],
  },
  {
    key: 'FIB',
    name: 'Federal Investigation Bureau',
    shortName: 'FIB',
    description: 'Federal investigations, organised crime, counter-intelligence.',
    category: 'federal',
    color: '#8b5cf6',
    roles: [
      { key: 'director', name: 'Director', level: 100, permissions: CHIEF },
      { key: 'deputy_director', name: 'Deputy Director', level: 90, permissions: COMMAND },
      { key: 'special_agent_in_charge', name: 'Special Agent in Charge', level: 70, permissions: COMMAND },
      { key: 'senior_agent', name: 'Senior Agent', level: 50, permissions: SUPERVISOR },
      { key: 'agent', name: 'Agent', level: 30, permissions: FIELD_OFFICER },
      { key: 'probationary_agent', name: 'Probationary Agent', level: 10, isDefault: true, permissions: BASE_OPERATIONAL },
    ],
  },
  {
    key: 'ARMY',
    name: 'National Guard',
    shortName: 'ARMY',
    description: 'Military support, base security and large-scale incident response.',
    category: 'military',
    color: '#a3a635',
    roles: [
      { key: 'general', name: 'General', level: 100, permissions: CHIEF },
      { key: 'colonel', name: 'Colonel', level: 85, permissions: COMMAND },
      { key: 'major', name: 'Major', level: 70, permissions: COMMAND },
      { key: 'captain', name: 'Captain', level: 55, permissions: SUPERVISOR },
      { key: 'sergeant', name: 'Sergeant', level: 40, permissions: SUPERVISOR },
      { key: 'soldier', name: 'Soldier', level: 20, permissions: FIELD_OFFICER },
      { key: 'recruit', name: 'Recruit', level: 10, isDefault: true, permissions: BASE_OPERATIONAL },
    ],
  },
  {
    key: 'ICE',
    name: 'Immigration and Customs Enforcement',
    shortName: 'ICE',
    description: 'Immigration enforcement, customs and border operations.',
    category: 'federal',
    color: '#14b8a6',
    roles: [
      { key: 'director', name: 'Director', level: 100, permissions: CHIEF },
      { key: 'deputy_director', name: 'Deputy Director', level: 85, permissions: COMMAND },
      { key: 'supervisor', name: 'Supervisory Agent', level: 60, permissions: SUPERVISOR },
      { key: 'agent', name: 'Deportation Officer', level: 30, permissions: FIELD_OFFICER },
      { key: 'trainee', name: 'Trainee', level: 10, isDefault: true, permissions: BASE_OPERATIONAL },
    ],
  },
  {
    key: 'MECHANIC',
    name: 'Los Santos Customs',
    shortName: 'LSC',
    description: 'Vehicle recovery, repair and impound operations.',
    category: 'civil_service',
    color: '#d99a2b',
    roles: [
      { key: 'owner', name: 'Owner', level: 100, permissions: [...MECHANIC_BASE, 'organization.edit', 'organization.announce', 'personnel.hire', 'personnel.fire', 'personnel.promote', 'personnel.demote', 'roles.create', 'roles.edit', 'roles.delete', 'roles.assign', 'roles.permissions', 'personnel.edit', 'personnel.callsign', 'units.manage', 'dispatch.manage', 'dispatch.assign', 'dispatch.close'] },
      { key: 'manager', name: 'Manager', level: 70, permissions: [...MECHANIC_BASE, 'personnel.edit', 'personnel.callsign', 'units.manage', 'dispatch.manage', 'dispatch.assign', 'dispatch.close', 'roles.assign'] },
      { key: 'senior_mechanic', name: 'Senior Mechanic', level: 40, permissions: [...MECHANIC_BASE, 'vehicles.flags.manage', 'dispatch.manage'] },
      { key: 'mechanic', name: 'Mechanic', level: 20, permissions: MECHANIC_BASE },
      { key: 'apprentice', name: 'Apprentice', level: 10, isDefault: true, permissions: ['map.view', 'dispatch.view', 'vehicles.view', 'personnel.view', 'organization.view'] },
    ],
  },
];

export interface OrganizationSeedResult {
  organizations: number;
  roles: number;
  rolePermissions: number;
}

/**
 * Idempotent. Re-running updates organization metadata and role definitions
 * without duplicating rows or disturbing existing memberships.
 */
export async function seedOrganizations(db: Database): Promise<OrganizationSeedResult> {
  const result: OrganizationSeedResult = { organizations: 0, roles: 0, rolePermissions: 0 };

  for (const seed of ORGANIZATION_SEEDS) {
    const [org] = await db
      .insert(organization)
      .values({
        key: seed.key,
        name: seed.name,
        shortName: seed.shortName,
        description: seed.description,
        category: seed.category,
        color: seed.color,
      })
      .onConflictDoUpdate({
        target: organization.key,
        // The unique index is partial (live rows only), so ON CONFLICT must
        // carry the same predicate for Postgres to infer it.
        targetWhere: sql`deleted_at IS NULL`,
        set: {
          name: sql`excluded.name`,
          shortName: sql`excluded.short_name`,
          description: sql`excluded.description`,
          category: sql`excluded.category`,
          color: sql`excluded.color`,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    if (!org) throw new Error(`Failed to seed organization ${seed.key}`);
    result.organizations += 1;

    for (const roleSeed of seed.roles) {
      const [inserted] = await db
        .insert(role)
        .values({
          organizationId: org.id,
          key: roleSeed.key,
          name: roleSeed.name,
          hierarchyLevel: roleSeed.level,
          isDefault: roleSeed.isDefault ?? false,
          /**
           * NOT system roles.
           *
           * `is_system` marks a role whose structure is fixed and which the API
           * refuses to rename, re-level or archive. Marking the seeded rank
           * structures with it made every one of them permanently uneditable —
           * which contradicts the note above ("these are STARTING POINTS…
           * nothing here is privileged") and would leave all six organizations
           * unable to touch a single one of their own ranks. The flag is kept
           * for genuinely fixed roles; an organization's rank list is not one
           * (engineering rules 5, 6, 8).
           */
          isSystem: false,
        })
        .onConflictDoUpdate({
          target: [role.organizationId, role.key],
          targetWhere: sql`deleted_at IS NULL`,
          set: {
            name: sql`excluded.name`,
            hierarchyLevel: sql`excluded.hierarchy_level`,
            isDefault: sql`excluded.is_default`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      if (!inserted) throw new Error(`Failed to seed role ${seed.key}/${roleSeed.key}`);
      result.roles += 1;

      // Replace the permission set so removing a permission from the seed
      // actually removes it, rather than leaving a stale grant behind.
      await db.delete(rolePermission).where(eq(rolePermission.roleId, inserted.id));

      const unique = [...new Set(roleSeed.permissions)];
      if (unique.length > 0) {
        await db
          .insert(rolePermission)
          .values(unique.map((key) => ({ roleId: inserted.id, permissionKey: key })))
          .onConflictDoNothing();
        result.rolePermissions += unique.length;
      }
    }
  }

  return result;
}
