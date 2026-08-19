import { sql } from 'drizzle-orm';
import {
  index, inet, jsonb, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';
import { actorTypeEnum, auditOutcomeEnum } from './_shared';

/**
 * Audit log — APPEND ONLY.
 *
 * Written in the SAME TRANSACTION as the change it records, through a single
 * helper, so a rolled-back change leaves no audit row and a committed change
 * always leaves one (engineering rule 23).
 *
 * The application's database role is granted INSERT and SELECT only — no UPDATE,
 * no DELETE (see migration). Tampering therefore requires database superuser
 * access rather than an application bug.
 *
 * Every row answers four questions:
 *   WHO      actor_type + actor_user_id + actor_label (denormalised, survives
 *            account deletion) + ip + user_agent
 *   WHAT     action + entity_type + entity_id + before/after JSONB diff
 *   WHEN     occurred_at
 *   CONTEXT  organization_id + metadata + request_id (correlates with logs)
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    // WHO
    actorType: actorTypeEnum('actor_type').notNull().default('user'),
    actorUserId: uuid('actor_user_id'),
    /** Denormalised so the trail stays readable after an account is removed. */
    actorLabel: text('actor_label'),

    // WHAT
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    outcome: auditOutcomeEnum('outcome').notNull().default('success'),
    before: jsonb('before'),
    after: jsonb('after'),

    // CONTEXT
    organizationId: uuid('organization_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_log_occurred_idx').on(t.occurredAt),
    index('audit_log_actor_idx').on(t.actorUserId, t.occurredAt),
    index('audit_log_action_idx').on(t.action, t.occurredAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_org_idx').on(t.organizationId, t.occurredAt),
    // "Show me every refused privilege escalation" — the signal an operations
    // lead actually needs.
    index('audit_log_denied_idx')
      .on(t.occurredAt)
      .where(sql`outcome = 'denied'`),
  ],
);

/**
 * Canonical audit action keys.
 *
 * Free-text actions drift; this list keeps the log queryable. Not a database
 * enum deliberately — adding an action must not require a migration — but the
 * audit helper accepts only these values, so the type is the enforcement point.
 */
export const AUDIT_ACTIONS = {
  // authentication
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password_changed',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
  EMAIL_VERIFIED: 'auth.email_verified',
  SESSION_REVOKED: 'auth.session_revoked',
  TOTP_ENABLED: 'auth.totp_enabled',
  TOTP_DISABLED: 'auth.totp_disabled',

  // accounts
  USER_CREATED: 'user.created',
  USER_SUSPENDED: 'user.suspended',
  USER_REINSTATED: 'user.reinstated',
  USER_DISABLED: 'user.disabled',
  GLOBAL_CAPABILITY_GRANTED: 'user.global_capability_granted',
  GLOBAL_CAPABILITY_REVOKED: 'user.global_capability_revoked',

  // organizations
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  ORGANIZATION_ARCHIVED: 'organization.archived',
  ORGANIZATION_RESTORED: 'organization.restored',
  ORG_LEAD_GRANTED: 'organization.lead_granted',
  ORG_LEAD_REVOKED: 'organization.lead_revoked',

  // roles & permissions
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_ARCHIVED: 'role.archived',
  ROLE_RESTORED: 'role.restored',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions_changed',
  /**
   * A hierarchy move, separate from a plain update: it changes the rank of
   * everyone holding the role and who may manage them, which is a different
   * question from a rename and deserves to be filterable on its own.
   */
  ROLE_LEVEL_CHANGED: 'role.level_changed',
  ROLE_ASSIGNED: 'role.assigned',
  ROLE_UNASSIGNED: 'role.unassigned',
  PERMISSION_OVERRIDE_SET: 'permission.override_set',
  PERMISSION_OVERRIDE_CLEARED: 'permission.override_cleared',

  // personnel
  MEMBER_HIRED: 'personnel.hired',
  MEMBER_TERMINATED: 'personnel.terminated',
  MEMBER_PROMOTED: 'personnel.promoted',
  MEMBER_DEMOTED: 'personnel.demoted',
  MEMBER_UPDATED: 'personnel.updated',
  MEMBER_CALLSIGN_CHANGED: 'personnel.callsign_changed',

  // records
  PERSON_CREATED: 'person.created',
  PERSON_VIEWED: 'person.viewed',
  PERSON_UPDATED: 'person.updated',
  PERSON_ARCHIVED: 'person.archived',
  PERSON_MEDICAL_VIEWED: 'person.medical_viewed',
  WARRANT_ISSUED: 'warrant.issued',
  WARRANT_SERVED: 'warrant.served',
  WARRANT_REVOKED: 'warrant.revoked',
  VEHICLE_CREATED: 'vehicle.created',
  VEHICLE_VIEWED: 'vehicle.viewed',
  VEHICLE_UPDATED: 'vehicle.updated',
  VEHICLE_ARCHIVED: 'vehicle.archived',
  SEARCH_PERFORMED: 'search.performed',

  // dispatch
  INCIDENT_CREATED: 'incident.created',
  INCIDENT_UPDATED: 'incident.updated',
  INCIDENT_CLOSED: 'incident.closed',
  INCIDENT_REOPENED: 'incident.reopened',
  UNIT_CREATED: 'unit.created',
  UNIT_DISBANDED: 'unit.disbanded',
  UNIT_ASSIGNED: 'unit.assigned',
  UNIT_RELEASED: 'unit.released',
  UNIT_JOINED: 'unit.joined',
  UNIT_LEFT: 'unit.left',
  STATUS_CHANGED: 'status.changed',
  PANIC_TRIGGERED: 'panic.triggered',
  PANIC_ACKNOWLEDGED: 'panic.acknowledged',

  // map
  /**
   * Marker lifecycle. Separate keys rather than one `map.marker_changed`,
   * because "who removed the roadblock, and when" is a question asked after an
   * incident and it should be filterable without reading metadata.
   */
  MAP_MARKER_PLACED: 'map.marker_placed',
  MAP_MARKER_UPDATED: 'map.marker_updated',
  MAP_MARKER_REMOVED: 'map.marker_removed',
  /**
   * Position playback. Reviewing where a unit was over past hours is a
   * surveillance capability, so every query is recorded — see
   * docs/architecture/05-map.md §5.
   */
  MAP_HISTORY_VIEWED: 'map.history_viewed',

  // integration & administration
  GAME_SERVER_REGISTERED: 'game_server.registered',
  GAME_SERVER_CREDENTIAL_ISSUED: 'game_server.credential_issued',
  GAME_SERVER_CREDENTIAL_REVOKED: 'game_server.credential_revoked',
  GAME_IDENTITY_LINKED: 'game_identity.linked',
  RECORD_PURGED: 'admin.record_purged',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
