import { sql } from 'drizzle-orm';
import { customType, pgEnum, timestamp, uuid, text } from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text.
 *
 * Used for every natural key a human types: emails, usernames, plates,
 * callsigns, organization keys. Without it `LSPD0412` and `lspd0412` are two
 * different plates, and the uniqueness guarantee is only as good as whichever
 * code path last remembered to lowercase. The `citext` extension is created in
 * the migration prelude.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/**
 * Shared column builders and enums.
 *
 * Every table in LEOOS uses these rather than declaring its own timestamp or
 * soft-deletion columns, so the lifecycle rules in
 * docs/architecture/01-data-model.md §3a hold uniformly.
 */

// ── Primary keys ───────────────────────────────────────────────────────────
/**
 * UUID v7 primary key — time-sortable, so B-tree inserts stay sequential and
 * range scans by creation order are cheap. Postgres 16 has no built-in v7, so
 * the extension-free `uuidv7()` SQL function is created in the first migration.
 */
export const primaryId = () => uuid('id').primaryKey().default(sql`uuidv7()`);

// ── Timestamps ─────────────────────────────────────────────────────────────
/** `timestamptz` everywhere. A naive timestamp in a dispatch system is a bug. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Soft deletion (ADR-0008) ───────────────────────────────────────────────
/**
 * Applied to every soft-deletable table. `deletedAt IS NULL` means live.
 *
 * A CHECK constraint on each table requires `deletedBy` and `deletionReason`
 * whenever `deletedAt` is set — an archived record must always say who archived
 * it and why, or the audit trail has a hole.
 */
export const softDelete = () => ({
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
  deletionReason: text('deletion_reason'),
});

/** Reusable CHECK body for the soft-deletion invariant (data model §8, #14). */
export const softDeleteCheck = sql`(deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NOT NULL OR deletion_reason IS NULL)`;

// ── Enums ──────────────────────────────────────────────────────────────────

export const accountStatusEnum = pgEnum('account_status', [
  'pending_verification',
  'active',
  'suspended',
  'disabled',
]);

export const globalCapabilityEnum = pgEnum('global_capability', [
  'global_admin',
  'user_admin',
  'org_admin',
  'audit_viewer',
  'support',
]);

export const authTokenPurposeEnum = pgEnum('auth_token_purpose', [
  'email_verification',
  'password_reset',
  'email_change',
]);

export const sessionRevokeReasonEnum = pgEnum('session_revoke_reason', [
  'logout',
  'admin',
  'password_change',
  'privilege_change',
  'expired',
]);

export const gameIdentityProviderEnum = pgEnum('game_identity_provider', [
  'license',
  'license2',
  'steam',
  'discord',
  'fivem',
  'xbl',
  'live',
]);

/**
 * Organization category — exists so cross-organization behaviour is expressed as
 * data ("medical-category organizations may view medical records") rather than
 * as `if (org.key === 'MD')` (engineering rules 5, 8).
 */
export const organizationCategoryEnum = pgEnum('organization_category', [
  'law_enforcement',
  'medical',
  'federal',
  'military',
  'civil_service',
  'other',
]);

export const permissionScopeEnum = pgEnum('permission_scope', ['organization', 'global']);
export const permissionRiskEnum = pgEnum('permission_risk', ['low', 'medium', 'high']);

export const membershipStatusEnum = pgEnum('membership_status', [
  'active',
  'on_leave',
  'suspended',
  'terminated',
]);

export const permissionOverrideEffectEnum = pgEnum('permission_override_effect', [
  'grant',
  'deny',
]);

export const personStatusEnum = pgEnum('person_status', [
  'alive',
  'deceased',
  'missing',
  'incarcerated',
]);

export const flagSeverityEnum = pgEnum('flag_severity', ['info', 'caution', 'critical']);

export const warrantTypeEnum = pgEnum('warrant_type', ['arrest', 'search', 'bench']);
export const warrantStatusEnum = pgEnum('warrant_status', [
  'active',
  'served',
  'expired',
  'revoked',
]);

export const chargeSeverityEnum = pgEnum('charge_severity', [
  'infraction',
  'misdemeanor',
  'felony',
]);
export const chargeStatusEnum = pgEnum('charge_status', ['pending', 'convicted', 'dismissed']);

export const licenseTypeEnum = pgEnum('license_type', [
  'driver',
  'weapon',
  'pilot',
  'boat',
  'medical',
  'business',
  'hunting',
]);
export const licenseStatusEnum = pgEnum('license_status', [
  'valid',
  'suspended',
  'revoked',
  'expired',
]);

export const vehicleRegistrationEnum = pgEnum('vehicle_registration_status', [
  'registered',
  'expired',
  'unregistered',
]);
export const vehicleInsuranceEnum = pgEnum('vehicle_insurance_status', [
  'insured',
  'uninsured',
  'expired',
]);

export const unitStatusEnum = pgEnum('unit_status', ['active', 'disbanded']);

/**
 * Incident lifecycle.
 *
 * Stored keys, not display labels — the UI reads `pending` as "Open" and
 * `on_scene` as "Active" (see INCIDENT_STATUSES in @leoos/contracts). Renaming
 * the stored values to match the labels would be a migration and a data rewrite
 * buying nothing, and it would break every index and CHECK that names them.
 *
 * `contained` was added in migration 0006: the situation is under control but
 * the call is not finished. It is genuinely distinct from `on_hold` (parked,
 * waiting on something) and from `closed` (over).
 */
export const incidentStatusEnum = pgEnum('incident_status', [
  'pending',
  'dispatched',
  'on_scene',
  'contained',
  'on_hold',
  'closed',
  'cancelled',
]);

export const incidentSourceEnum = pgEnum('incident_source', [
  'manual',
  'fivem',
  'panic',
  'automatic',
]);

export const incidentLogEntryEnum = pgEnum('incident_log_entry_type', [
  'note',
  'status_change',
  'assignment',
  'arrival',
  'clear',
  'attachment',
  'system',
]);

export const incidentLinkEntityEnum = pgEnum('incident_link_entity', ['person', 'vehicle']);
export const incidentLinkRelationEnum = pgEnum('incident_link_relation', [
  'suspect',
  'victim',
  'witness',
  'involved',
  'patient',
  'reporting_party',
]);

export const mapMarkerTypeEnum = pgEnum('map_marker_type', [
  'hazard',
  'roadblock',
  'staging',
  'command_post',
  'poi',
  'custom',
]);

export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'game_server', 'job']);
export const auditOutcomeEnum = pgEnum('audit_outcome', ['success', 'denied', 'error']);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'in_app',
  'email',
  'push',
]);
export const notificationSeverityEnum = pgEnum('notification_severity', [
  'info',
  'warning',
  'critical',
]);

/**
 * Field requests: what somebody asked for, and where it ended up.
 *
 * Two kinds and one lifecycle, because backup and location sharing are the same
 * shape — raised in the field, offered to colleagues, taken or dismissed — and
 * differ only in what accepting does. See docs/architecture/09-dispatch.md §6b.
 */
export const fieldRequestKindEnum = pgEnum('field_request_kind', [
  'backup',
  'location_share',
]);

export const fieldRequestStatusEnum = pgEnum('field_request_status', [
  'pending',
  'accepted',
  'declined',
  /** The asker withdrew it. Distinct from `declined`, which somebody else did. */
  'cancelled',
  /** Nobody took it in time. Distinct from `declined`: silence is not refusal. */
  'expired',
]);
