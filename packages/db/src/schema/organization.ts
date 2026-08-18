import { relations, sql } from 'drizzle-orm';
import {
  boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp,
  uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  citext, createdAt, membershipStatusEnum, organizationCategoryEnum, permissionOverrideEffectEnum,
  permissionRiskEnum, permissionScopeEnum, primaryId, softDelete, timestamps,
} from './_shared';
import { userAccount } from './identity';
import { person } from './person';

/**
 * Organizations, roles, permissions and memberships.
 *
 * This module carries the system's authorization data model. Two properties are
 * load-bearing and must survive every future change:
 *
 *   1. Organizations, roles and permissions are ROWS, never code. Adding a
 *      seventh organization is an insert plus a role seed (engineering rules
 *      5-8). Nothing in the application branches on an organization key.
 *
 *   2. `role.hierarchy_level` is an integer where HIGHER MEANS MORE SENIOR
 *      (ADR-0007). A member's effective level is the MAXIMUM across their roles
 *      — never the sum, which would let two junior roles manufacture senior
 *      authority. Comparison is STRICTLY greater-than, so equal ranks are
 *      mutually immune: two lieutenants cannot manage each other.
 */

// ── organization ───────────────────────────────────────────────────────────

export const organization = pgTable(
  'organization',
  {
    id: primaryId(),
    /** Machine key: `PD`, `MD`, `FIB`… Stable, referenced by seeds, never branched on. */
    key: citext('key').notNull(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull(),
    description: text('description'),
    category: organizationCategoryEnum('category').notNull().default('other'),
    /** Hex identity colour. Read from the row so adding an org needs no CSS edit. */
    color: text('color').notNull().default('#6b7686'),
    logoUrl: text('logo_url'),
    /** Per-organization toggles, e.g. `{"shareOnPublicMap": true}`. */
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    // Partial: an archived organization must not permanently consume its key.
    uniqueIndex('organization_key_key').on(t.key).where(sql`deleted_at IS NULL`),
    index('organization_active_idx').on(t.isActive).where(sql`deleted_at IS NULL`),
    index('organization_category_idx').on(t.category),
    check(
      'organization_soft_delete_complete',
      sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)
          AND (${t.deletedAt} IS NOT NULL OR ${t.deletionReason} IS NULL)`,
    ),
  ],
);

// ── permission ─────────────────────────────────────────────────────────────

/**
 * The permission catalogue, seeded from `@leoos/contracts`.
 *
 * A table rather than a bare string column so `role_permission` carries a real
 * foreign key — a typo becomes a constraint violation instead of a silently
 * ineffective grant. A CI check (Phase 2) fails the build if this table and the
 * contracts object diverge.
 */
export const permission = pgTable(
  'permission',
  {
    key: text('key').primaryKey(),
    category: text('category').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    scope: permissionScopeEnum('scope').notNull().default('organization'),
    risk: permissionRiskEnum('risk').notNull().default('low'),
    createdAt: createdAt(),
  },
  (t) => [
    index('permission_category_idx').on(t.category),
    index('permission_scope_idx').on(t.scope),
  ],
);

// ── role ───────────────────────────────────────────────────────────────────

export const role = pgTable(
  'role',
  {
    id: primaryId(),
    /** Null = a global role, not owned by any organization. */
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'restrict',
    }),
    key: citext('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * 1–100, HIGHER = MORE SENIOR. Seeded structures leave gaps (10, 20, 30…)
     * so ranks can be inserted later without renumbering.
     */
    hierarchyLevel: integer('hierarchy_level').notNull(),
    /** Auto-assigned on hire. At most one per organization (partial unique). */
    isDefault: boolean('is_default').notNull().default(false),
    /** System roles cannot be renamed or archived through the API. */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    color: text('color'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('role_org_key_key')
      .on(t.organizationId, t.key)
      .where(sql`deleted_at IS NULL`),
    index('role_org_level_idx').on(t.organizationId, t.hierarchyLevel),
    // Exactly one default role per organization.
    uniqueIndex('role_one_default_per_org')
      .on(t.organizationId)
      .where(sql`is_default AND deleted_at IS NULL`),
    check('role_hierarchy_range', sql`${t.hierarchyLevel} BETWEEN 1 AND 100`),
    check(
      'role_soft_delete_complete',
      sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)
          AND (${t.deletedAt} IS NOT NULL OR ${t.deletionReason} IS NULL)`,
    ),
  ],
);

// ── role_permission ────────────────────────────────────────────────────────

export const rolePermission = pgTable(
  'role_permission',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permission.key, { onDelete: 'restrict' }),
    grantedBy: uuid('granted_by').references(() => userAccount.id, { onDelete: 'set null' }),
    grantedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionKey] }),
    index('role_permission_permission_idx').on(t.permissionKey),
  ],
);

// ── organization_member ────────────────────────────────────────────────────

/**
 * The employment relationship: user × organization.
 *
 * A user may belong to several organizations; each membership carries
 * independent roles, permissions and callsign. Terminated members are RETAINED
 * (engineering rule 24) — status moves to `terminated`, the row stays forever.
 */
export const organizationMember = pgTable(
  'organization_member',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    /** The in-game character this membership operates as. Optional. */
    personId: uuid('person_id').references(() => person.id, { onDelete: 'set null' }),

    status: membershipStatusEnum('status').notNull().default('active'),
    callsign: citext('callsign'),
    employeeNumber: citext('employee_number'),
    notes: text('notes'),

    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    hiredBy: uuid('hired_by').references(() => userAccount.id, { onDelete: 'set null' }),
    leftAt: timestamp('left_at', { withTimezone: true }),
    terminatedBy: uuid('terminated_by').references(() => userAccount.id, { onDelete: 'set null' }),
    terminationReason: text('termination_reason'),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('organization_member_user_org_key').on(t.userId, t.organizationId),
    // Callsigns and employee numbers are unique among ACTIVE members only, so a
    // retired callsign is reusable.
    uniqueIndex('organization_member_active_callsign_key')
      .on(t.organizationId, t.callsign)
      .where(sql`status = 'active' AND callsign IS NOT NULL`),
    uniqueIndex('organization_member_active_employee_no_key')
      .on(t.organizationId, t.employeeNumber)
      .where(sql`status = 'active' AND employee_number IS NOT NULL`),
    index('organization_member_org_status_idx').on(t.organizationId, t.status),
    index('organization_member_user_idx').on(t.userId),
    index('organization_member_person_idx').on(t.personId),
    // Hot path: "who is active in this organization".
    index('organization_member_active_idx')
      .on(t.organizationId)
      .where(sql`status = 'active'`),
    check(
      'organization_member_termination_complete',
      sql`${t.status} <> 'terminated' OR ${t.leftAt} IS NOT NULL`,
    ),
  ],
);

// ── member_role ────────────────────────────────────────────────────────────

/**
 * Role assignment. A member may hold several roles; effective hierarchy level is
 * the MAXIMUM across them (ADR-0007).
 *
 * A trigger (see migration) enforces that the role belongs to the member's own
 * organization, or is global. Without it, a crafted request that slipped past
 * validation could attach a PD Chief role to an ICE membership — producing a
 * rank the authorization kernel would then honour.
 */
export const memberRole = pgTable(
  'member_role',
  {
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'restrict' }),
    assignedBy: uuid('assigned_by').references(() => userAccount.id, { onDelete: 'set null' }),
    assignedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.roleId] }),
    index('member_role_role_idx').on(t.roleId),
  ],
);

// ── member_permission_override ─────────────────────────────────────────────

/** Targeted exceptions without inventing a one-off role. DENY always wins. */
export const memberPermissionOverride = pgTable(
  'member_permission_override',
  {
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permission.key, { onDelete: 'restrict' }),
    effect: permissionOverrideEffectEnum('effect').notNull(),
    /** Required — an unexplained override is an audit hole. */
    reason: text('reason').notNull(),
    grantedBy: uuid('granted_by').references(() => userAccount.id, { onDelete: 'set null' }),
    grantedAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.permissionKey] }),
    index('member_permission_override_expiry_idx')
      .on(t.expiresAt)
      .where(sql`expires_at IS NOT NULL`),
  ],
);

// ── organization_lead ──────────────────────────────────────────────────────

/**
 * The Organization Lead capability.
 *
 * Its own table, grantable only by a global administrator, so it is structurally
 * impossible to obtain by editing organization roles. A lead is treated as level
 * ∞ WITHIN THEIR ORGANIZATION ONLY and receives no global capability whatsoever.
 */
export const organizationLead = pgTable(
  'organization_lead',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'restrict' }),
    grantedAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => userAccount.id, { onDelete: 'set null' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.organizationId] }),
    index('organization_lead_org_idx')
      .on(t.organizationId)
      .where(sql`revoked_at IS NULL`),
  ],
);

// ── relations ──────────────────────────────────────────────────────────────

export const organizationRelations = relations(organization, ({ many }) => ({
  roles: many(role),
  members: many(organizationMember),
  leads: many(organizationLead),
}));

export const roleRelations = relations(role, ({ one, many }) => ({
  organization: one(organization, {
    fields: [role.organizationId],
    references: [organization.id],
  }),
  permissions: many(rolePermission),
  assignments: many(memberRole),
}));

export const rolePermissionRelations = relations(rolePermission, ({ one }) => ({
  role: one(role, { fields: [rolePermission.roleId], references: [role.id] }),
  permission: one(permission, {
    fields: [rolePermission.permissionKey],
    references: [permission.key],
  }),
}));

export const organizationMemberRelations = relations(organizationMember, ({ one, many }) => ({
  user: one(userAccount, {
    fields: [organizationMember.userId],
    references: [userAccount.id],
  }),
  organization: one(organization, {
    fields: [organizationMember.organizationId],
    references: [organization.id],
  }),
  person: one(person, { fields: [organizationMember.personId], references: [person.id] }),
  roles: many(memberRole),
  overrides: many(memberPermissionOverride),
}));

export const memberRoleRelations = relations(memberRole, ({ one }) => ({
  member: one(organizationMember, {
    fields: [memberRole.memberId],
    references: [organizationMember.id],
  }),
  role: one(role, { fields: [memberRole.roleId], references: [role.id] }),
}));
