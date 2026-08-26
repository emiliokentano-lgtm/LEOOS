import { relations, sql } from 'drizzle-orm';
import {
  boolean, check, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text,
  timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  citext, createdAt, fieldRequestKindEnum, fieldRequestStatusEnum, incidentLinkEntityEnum,
  incidentLinkRelationEnum, incidentLogEntryEnum, incidentSourceEnum, incidentStatusEnum,
  mapMarkerTypeEnum, mapShapeKindEnum, primaryId, softDelete, softDeleteCheck, timestamps,
  unitStatusEnum,
} from './_shared';
import { userAccount } from './identity';
import { organization, organizationMember } from './organization';
import { person } from './person';
import { vehicle } from './vehicle';

/**
 * Dispatch operations: operational status, units (patrols) and incidents.
 */

// ── operational status ─────────────────────────────────────────────────────

/**
 * The OPERATIONAL STATUS catalogue.
 *
 * A table, not an enum, so an organization can extend the list without a code
 * change or migration (engineering rules 5-7). The default set is seeded from
 * `@leoos/contracts`; `organization_id` scopes an organization-specific status.
 *
 * Every status carries an icon and colour so the UI can render it without
 * colour being the only signal.
 */
export const operationalStatus = pgTable(
  'operational_status',
  {
    key: text('key').primaryKey(),
    label: text('label').notNull(),
    /** Radio abbreviation, e.g. `AVL`. */
    shortLabel: text('short_label').notNull(),
    colorToken: text('color_token').notNull(),
    icon: text('icon').notNull(),
    /** Counts toward "units available" figures. */
    isAvailable: boolean('is_available').notNull().default(false),
    /** Member appears on the map and counts as active. */
    isOnDuty: boolean('is_on_duty').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(100),
    /** Null = available to every organization. */
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('operational_status_org_idx').on(t.organizationId)],
);

// ── unit (dispatch unit / patrol) ──────────────────────────────────────────

export const unit = pgTable(
  'unit',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    callsign: citext('callsign').notNull(),
    name: text('name'),
    status: unitStatusEnum('status').notNull().default('active'),
    /** Seeded catalogue value (`patrol`, `k9`, `air`…). */
    unitType: text('unit_type').notNull().default('patrol'),
    statusKey: text('status_key')
      .notNull()
      .default('available')
      .references(() => operationalStatus.key, { onDelete: 'restrict' }),

    vehicleId: uuid('vehicle_id').references(() => vehicle.id, { onDelete: 'set null' }),

    /**
     * Last known position. This is a CACHE of the live Redis state, refreshed at
     * a low rate — high-frequency telemetry is never written here
     * (engineering rules 21, 22). Authoritative live position lives in Redis.
     */
    posX: doublePrecision('pos_x'),
    posY: doublePrecision('pos_y'),
    posZ: doublePrecision('pos_z'),
    heading: doublePrecision('heading'),
    /** Metres per second at the last sample. Drives map interpolation confidence. */
    speed: doublePrecision('speed'),
    positionUpdatedAt: timestamp('position_updated_at', { withTimezone: true }),
    /**
     * Which game server reported that position.
     *
     * Needed for offline detection: when a game server stops sending
     * heartbeats, every unit IT was reporting goes offline — and only those. A
     * deployment with two game servers must not have one going quiet blank the
     * other's units.
     */
    posGameServerId: uuid('pos_game_server_id'),

    /**
     * Covert unit — excluded from every map payload except its own
     * organization's and holders of `map.track_all_orgs`.
     *
     * This lives on the UNIT rather than on the organization because covertness
     * is operational, not structural: FIB runs marked and unmarked units at the
     * same time, and an undercover car must not appear on a PD dispatcher's map
     * merely because FIB shares its fleet on the public map. Enforcement is in
     * the query (docs/architecture/05-map.md §5), never in the client.
     */
    isCovert: boolean('is_covert').notNull().default(false),

    /** Denormalised for the unit board; the authority is `incident_assignment`. */
    currentIncidentId: uuid('current_incident_id'),

    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    disbandedAt: timestamp('disbanded_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // Callsign unique among ACTIVE units only, so a disbanded callsign is reusable.
    uniqueIndex('unit_active_callsign_key')
      .on(t.organizationId, t.callsign)
      .where(sql`status = 'active'`),
    index('unit_org_status_idx').on(t.organizationId, t.status),
    // The map's own query: every active unit that has ever reported a position.
    // Partial, because a unit with no position is never drawn and the index has
    // no reason to carry it.
    index('unit_map_position_idx')
      .on(t.organizationId, t.positionUpdatedAt)
      .where(sql`status = 'active' AND pos_x IS NOT NULL`),
    index('unit_status_key_idx').on(t.statusKey).where(sql`status = 'active'`),
    index('unit_incident_idx').on(t.currentIncidentId),
    check(
      'unit_disband_complete',
      sql`${t.status} <> 'disbanded' OR ${t.disbandedAt} IS NOT NULL`,
    ),
  ],
);

export const unitMember = pgTable(
  'unit_member',
  {
    id: primaryId(),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'restrict' }),
    isLeader: boolean('is_leader').notNull().default(false),
    joinedAt: createdAt(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * A member can be in AT MOST ONE active unit — enforced by the database
     * rather than by application logic, because every code path that adds a
     * member to a patrol must respect it.
     */
    uniqueIndex('unit_member_one_active_per_member')
      .on(t.memberId)
      .where(sql`left_at IS NULL`),
    index('unit_member_unit_idx').on(t.unitId).where(sql`left_at IS NULL`),
    // At most one leader per active unit.
    uniqueIndex('unit_member_one_leader')
      .on(t.unitId)
      .where(sql`is_leader AND left_at IS NULL`),
  ],
);

// ── member operational status ──────────────────────────────────────────────

/** Current duty status of a member. One row per member, updated in place. */
export const memberStatus = pgTable(
  'member_status',
  {
    memberId: uuid('member_id')
      .primaryKey()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
    statusKey: text('status_key')
      .notNull()
      .references(() => operationalStatus.key, { onDelete: 'restrict' }),
    unitId: uuid('unit_id').references(() => unit.id, { onDelete: 'set null' }),
    since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('member_status_key_idx').on(t.statusKey),
    index('member_status_unit_idx').on(t.unitId),
  ],
);

/**
 * Append-only history of status transitions — shift reconstruction.
 *
 * RESTRICT, not CASCADE: this is a history table, and a cascade would let a
 * membership deletion silently erase the record of who was on duty when.
 * Memberships are never hard-deleted anyway (terminated members are retained,
 * engineering rule 24), so this makes the intent explicit rather than relying on
 * that policy holding forever.
 */
export const memberStatusHistory = pgTable(
  'member_status_history',
  {
    id: primaryId(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'restrict' }),
    fromStatusKey: text('from_status_key'),
    toStatusKey: text('to_status_key').notNull(),
    unitId: uuid('unit_id'),
    changedBy: uuid('changed_by').references(() => userAccount.id, { onDelete: 'set null' }),
    changedAt: createdAt(),
  },
  (t) => [
    index('member_status_history_member_time_idx').on(t.memberId, t.changedAt),
    index('member_status_history_time_idx').on(t.changedAt),
    // Set-null target on an unbounded history table.
    index('member_status_history_unit_idx').on(t.unitId),
  ],
);

// ── incidents ──────────────────────────────────────────────────────────────

export const incidentType = pgTable(
  'incident_type',
  {
    key: text('key').primaryKey(),
    label: text('label').notNull(),
    category: text('category'),
    defaultPriority: integer('default_priority').notNull().default(3),
    color: text('color'),
    icon: text('icon'),
    /** Null = available to every organization. */
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index('incident_type_org_idx').on(t.organizationId),
    check('incident_type_priority_range', sql`${t.defaultPriority} BETWEEN 1 AND 5`),
  ],
);

export const incident = pgTable(
  'incident',
  {
    id: primaryId(),
    /**
     * Human-callable, e.g. `2026-08-000431` — read aloud over radio.
     *
     * Sequence-backed rather than `count(*) + 1`, which races under concurrent
     * call creation. The function is defined in the migration prelude.
     */
    number: citext('number').notNull().default(sql`next_incident_number()`),
    /** Null for genuinely multi-agency calls. */
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'restrict',
    }),
    typeKey: text('type_key').references(() => incidentType.key, { onDelete: 'restrict' }),
    /** 1 = highest. Numeric so it is orderable and reads the way operators speak. */
    priority: integer('priority').notNull().default(3),
    status: incidentStatusEnum('status').notNull().default('pending'),
    title: text('title').notNull(),
    description: text('description'),

    locationText: text('location_text'),
    posX: doublePrecision('pos_x'),
    posY: doublePrecision('pos_y'),
    posZ: doublePrecision('pos_z'),

    callerPersonId: uuid('caller_person_id').references(() => person.id, {
      onDelete: 'set null',
    }),
    callerPhone: text('caller_phone'),
    source: incidentSourceEnum('source').notNull().default('manual'),

    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    closedBy: uuid('closed_by').references(() => userAccount.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closingNotes: text('closing_notes'),

    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('incident_number_key').on(t.number),
    // The dispatch queue's primary query: open calls, worst first, oldest first.
    index('incident_open_queue_idx')
      .on(t.priority, t.createdAt)
      .where(sql`status NOT IN ('closed', 'cancelled') AND deleted_at IS NULL`),
    index('incident_org_status_idx').on(t.organizationId, t.status),
    index('incident_status_idx').on(t.status),
    index('incident_created_at_idx').on(t.createdAt),
    index('incident_type_idx').on(t.typeKey),
    check('incident_priority_range', sql`${t.priority} BETWEEN 1 AND 5`),
    /**
     * A closed incident must record WHEN it was closed.
     *
     * `closed_by` is deliberately NOT required: the schema supports
     * `source = 'automatic'`, and a retention job or the FiveM bridge can close a
     * call with no human actor. Requiring a user here would make that legitimate
     * flow impossible. Who closed it — user, system or job — is answered by the
     * audit log, which records an actor_type for exactly this reason.
     */
    check(
      'incident_closure_complete',
      sql`${t.status} <> 'closed' OR ${t.closedAt} IS NOT NULL`,
    ),
    check(
      'incident_soft_delete_complete',
      sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)
          AND (${t.deletedAt} IS NOT NULL OR ${t.deletionReason} IS NULL)`,
    ),
  ],
);

export const incidentAssignment = pgTable(
  'incident_assignment',
  {
    id: primaryId(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incident.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'restrict' }),
    role: text('role'),
    assignedBy: uuid('assigned_by').references(() => userAccount.id, { onDelete: 'set null' }),
    assignedAt: createdAt(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    // A unit cannot be assigned to the same incident twice concurrently.
    uniqueIndex('incident_assignment_active_key')
      .on(t.incidentId, t.unitId)
      .where(sql`released_at IS NULL`),
    index('incident_assignment_unit_active_idx')
      .on(t.unitId)
      .where(sql`released_at IS NULL`),
    index('incident_assignment_incident_idx').on(t.incidentId),
  ],
);

/**
 * The incident timeline — APPEND ONLY. This is the legal record of the call.
 *
 * No update or delete path exists in the API, and the application database role
 * is granted INSERT and SELECT only on this table.
 */
export const incidentLog = pgTable(
  'incident_log',
  {
    id: primaryId(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incident.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').references(() => userAccount.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label'),
    entryType: incidentLogEntryEnum('entry_type').notNull().default('note'),
    body: text('body'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('incident_log_incident_time_idx').on(t.incidentId, t.createdAt)],
);

/** Attaches persons and vehicles to a call. */
export const incidentLink = pgTable(
  'incident_link',
  {
    id: primaryId(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incident.id, { onDelete: 'cascade' }),
    entityType: incidentLinkEntityEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    relation: incidentLinkRelationEnum('relation').notNull().default('involved'),
    note: text('note'),
    addedBy: uuid('added_by').references(() => userAccount.id, { onDelete: 'set null' }),
    addedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('incident_link_key').on(t.incidentId, t.entityType, t.entityId, t.relation),
    index('incident_link_entity_idx').on(t.entityType, t.entityId),
  ],
);

export const panicEvent = pgTable(
  'panic_event',
  {
    id: primaryId(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id').references(() => unit.id, { onDelete: 'set null' }),
    incidentId: uuid('incident_id').references(() => incident.id, { onDelete: 'set null' }),
    posX: doublePrecision('pos_x'),
    posY: doublePrecision('pos_y'),
    posZ: doublePrecision('pos_z'),
    source: text('source').notNull().default('web'),
    createdAt: createdAt(),
    acknowledgedBy: uuid('acknowledged_by').references(() => userAccount.id, {
      onDelete: 'set null',
    }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('panic_event_unresolved_idx')
      .on(t.organizationId)
      .where(sql`resolved_at IS NULL`),
    index('panic_event_created_idx').on(t.createdAt),
  ],
);

export const mapMarker = pgTable(
  'map_marker',
  {
    id: primaryId(),
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    type: mapMarkerTypeEnum('type').notNull().default('poi'),
    label: text('label').notNull(),
    description: text('description'),
    posX: doublePrecision('pos_x').notNull(),
    posY: doublePrecision('pos_y').notNull(),
    posZ: doublePrecision('pos_z'),
    color: text('color'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...softDelete(),
  },
  (t) => [
    index('map_marker_org_idx').on(t.organizationId).where(sql`deleted_at IS NULL`),
    index('map_marker_expiry_idx').on(t.expiresAt).where(sql`expires_at IS NOT NULL`),
  ],
);

/**
 * Areas and routes drawn on the map.
 *
 * A SEPARATE TABLE FROM `mapMarker`, and that is not a parallel model. A marker
 * is a point; a shape is a sequence of them. One table would mean every marker
 * row carrying a nullable geometry column and every query filtering on kind.
 * They share what should be shared — the `map.markers.manage` permission, the
 * organization visibility rule, expiry-on-read, soft deletion — and differ only
 * in the geometry.
 *
 * GEOMETRY IS TWO PARALLEL ARRAYS, not PostGIS and not jsonb. PostGIS answers
 * spatial QUERIES ("which shapes contain this point") and this product asks
 * none: shapes are drawn, listed and rendered, never intersected. Arrays let the
 * database enforce the point count, which an opaque blob cannot — see the CHECK
 * constraints in migration 0014.
 */
export const mapShape = pgTable(
  'map_shape',
  {
    id: primaryId(),
    kind: mapShapeKindEnum('kind').notNull(),
    /** Null means visible to every organization, exactly as it does for a marker. */
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    label: text('label').notNull(),
    description: text('description'),
    color: text('color'),
    pointsX: doublePrecision('points_x').array().notNull(),
    pointsY: doublePrecision('points_y').array().notNull(),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    ...timestamps(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...softDelete(),
  },
  (t) => [
    index('map_shape_live_idx').on(t.organizationId).where(sql`deleted_at IS NULL`),
    check('map_shape_points_paired', sql`array_length(points_x, 1) = array_length(points_y, 1)`),
    check(
      'map_shape_min_points',
      sql`array_length(points_x, 1) >= CASE WHEN kind = 'area' THEN 3 ELSE 2 END`,
    ),
    check('map_shape_max_points', sql`array_length(points_x, 1) <= 500`),
    check('map_shape_label_not_blank', sql`length(btrim(label)) > 0`),
    check('map_shape_soft_delete', softDeleteCheck),
  ],
);

/**
 * Downsampled position history — 1 sample per 10 s, NOT per tick.
 *
 * Exists only to support incident playback. Live positions are in Redis; writing
 * every telemetry sample here would be ~13M rows/day of data that is stale within
 * seconds (engineering rule 22). Partitioned monthly with a retention job.
 */
export const positionHistory = pgTable(
  'position_history',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    unitId: uuid('unit_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    posX: doublePrecision('pos_x').notNull(),
    posY: doublePrecision('pos_y').notNull(),
    posZ: doublePrecision('pos_z'),
    heading: doublePrecision('heading'),
    speed: doublePrecision('speed'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('position_history_unit_time_idx').on(t.unitId, t.recordedAt),
    // Cascade target on the highest-volume table in the system. Composite with
    // time so it also serves "every position for this organization in a window",
    // which is what incident playback asks for.
    index('position_history_org_time_idx').on(t.organizationId, t.recordedAt),
  ],
);

// ── relations ──────────────────────────────────────────────────────────────

export const unitRelations = relations(unit, ({ one, many }) => ({
  organization: one(organization, {
    fields: [unit.organizationId],
    references: [organization.id],
  }),
  vehicle: one(vehicle, { fields: [unit.vehicleId], references: [vehicle.id] }),
  members: many(unitMember),
  assignments: many(incidentAssignment),
}));

export const unitMemberRelations = relations(unitMember, ({ one }) => ({
  unit: one(unit, { fields: [unitMember.unitId], references: [unit.id] }),
  member: one(organizationMember, {
    fields: [unitMember.memberId],
    references: [organizationMember.id],
  }),
}));

export const incidentRelations = relations(incident, ({ one, many }) => ({
  organization: one(organization, {
    fields: [incident.organizationId],
    references: [organization.id],
  }),
  type: one(incidentType, { fields: [incident.typeKey], references: [incidentType.key] }),
  assignments: many(incidentAssignment),
  logs: many(incidentLog),
  links: many(incidentLink),
}));

export const incidentAssignmentRelations = relations(incidentAssignment, ({ one }) => ({
  incident: one(incident, {
    fields: [incidentAssignment.incidentId],
    references: [incident.id],
  }),
  unit: one(unit, { fields: [incidentAssignment.unitId], references: [unit.id] }),
}));

export const memberStatusRelations = relations(memberStatus, ({ one }) => ({
  member: one(organizationMember, {
    fields: [memberStatus.memberId],
    references: [organizationMember.id],
  }),
  status: one(operationalStatus, {
    fields: [memberStatus.statusKey],
    references: [operationalStatus.key],
  }),
  unit: one(unit, { fields: [memberStatus.unitId], references: [unit.id] }),
}));

/**
 * A request raised from the field.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOT AN INCIDENT, AND THE DISTINCTION IS LOAD-BEARING
 *
 * An incident is a call: a number, a type, a timeline, and an expectation that
 * somebody closes it. Most backup requests are answered or overtaken by events
 * within a minute. Modelling each as an incident would fill the call queue with
 * entries nobody closes and corrupt every dashboard count, because the dashboard
 * is composed from the same reads.
 *
 * Nor is it merely an attachment to an incident, because the asker frequently
 * has none — a traffic stop that turns bad is a unit, a position and no call.
 *
 * So it is its own row, and a first-class record: "who asked for help, when, and
 * did anybody come" is a question asked afterwards, and the answer must not
 * depend on whether a dispatcher happened to open a call.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const fieldRequest = pgTable(
  'field_request',
  {
    id: primaryId(),
    kind: fieldRequestKindEnum('kind').notNull(),

    /** Keyed on the MEMBERSHIP: a person in two organizations asks as one of them. */
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),

    unitId: uuid('unit_id').references(() => unit.id, { onDelete: 'set null' }),

    /**
     * The call they were on WHEN THEY ASKED.
     *
     * Captured rather than read live from the unit at accept time: a unit that
     * has since moved to another call must not silently redirect the people who
     * accepted this request to somewhere they never agreed to go.
     */
    incidentId: uuid('incident_id').references(() => incident.id, { onDelete: 'set null' }),

    /** A snapshot, never a track. A share that followed you would be surveillance. */
    posX: doublePrecision('pos_x'),
    posY: doublePrecision('pos_y'),

    note: text('note'),
    source: text('source').notNull().default('web'),

    status: fieldRequestStatusEnum('status').notNull().default('pending'),

    /**
     * Expiry is a COLUMN, evaluated on read.
     *
     * No job rewrites these rows. Nothing runs when nobody is looking, and a
     * request cannot be accepted past its deadline even if a client is holding
     * a prompt that went stale in a pocket.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    resolvedBy: uuid('resolved_by').references(() => organizationMember.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    /**
     * One live request per member per kind, enforced by the DATABASE.
     *
     * A held key, or a flaky network retrying, must not put four identical
     * prompts on everybody's screen. Only the database can decide this under
     * concurrency; the service reads the conflict as "you already have one
     * live" rather than as an error.
     */
    uniqueIndex('field_request_one_live_per_member')
      .on(t.memberId, t.kind)
      .where(sql`status = 'pending'`),
    index('field_request_live_idx')
      .on(t.organizationId, t.createdAt)
      .where(sql`status = 'pending'`),
    index('field_request_member_idx').on(t.memberId, t.createdAt),
    index('field_request_incident_idx')
      .on(t.incidentId)
      .where(sql`incident_id IS NOT NULL`),
    check(
      'field_request_resolution_consistent',
      sql`(status = 'pending' AND resolved_at IS NULL)
          OR (status <> 'pending' AND resolved_at IS NOT NULL)`,
    ),
    check('field_request_position_paired', sql`(pos_x IS NULL) = (pos_y IS NULL)`),
    check(
      'field_request_accepted_has_resolver',
      sql`status <> 'accepted' OR resolved_by IS NOT NULL`,
    ),
  ],
);

/**
 * Who was offered a request, and what they did about it.
 *
 * A DECLINE IS A FACT WORTH KEEPING. "Eight people dismissed this" is a
 * different thing from "nobody saw it", and it is the first question asked when
 * somebody reviews why help did not arrive. Without this table the two are
 * indistinguishable.
 */
export const fieldRequestResponse = pgTable(
  'field_request_response',
  {
    fieldRequestId: uuid('field_request_id')
      .notNull()
      .references(() => fieldRequest.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
    response: text('response').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fieldRequestId, t.memberId] }),
    index('field_request_response_member_idx').on(t.memberId, t.createdAt),
    check('field_request_response_kind', sql`response IN ('accepted', 'declined')`),
  ],
);

export const fieldRequestRelations = relations(fieldRequest, ({ one, many }) => ({
  member: one(organizationMember, {
    fields: [fieldRequest.memberId],
    references: [organizationMember.id],
  }),
  organization: one(organization, {
    fields: [fieldRequest.organizationId],
    references: [organization.id],
  }),
  unit: one(unit, { fields: [fieldRequest.unitId], references: [unit.id] }),
  incident: one(incident, { fields: [fieldRequest.incidentId], references: [incident.id] }),
  responses: many(fieldRequestResponse),
}));

export const fieldRequestResponseRelations = relations(fieldRequestResponse, ({ one }) => ({
  request: one(fieldRequest, {
    fields: [fieldRequestResponse.fieldRequestId],
    references: [fieldRequest.id],
  }),
  member: one(organizationMember, {
    fields: [fieldRequestResponse.memberId],
    references: [organizationMember.id],
  }),
}));
