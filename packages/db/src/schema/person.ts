import { relations, sql } from 'drizzle-orm';
import {
  boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  chargeSeverityEnum, chargeStatusEnum, createdAt, flagSeverityEnum, licenseStatusEnum,
  licenseTypeEnum, personStatusEnum, primaryId, softDelete, timestamps, warrantStatusEnum,
  warrantTypeEnum,
} from './_shared';
import { userAccount } from './identity';
import { organization } from './organization';

/**
 * Person records — the in-game citizen, deliberately separate from `user_account`.
 *
 * A person may exist with no account (a suspect), and an account may exist with
 * no person (a dispatcher). The link, where it exists, is explicit.
 */

export const person = pgTable(
  'person',
  {
    id: primaryId(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dateOfBirth: date('date_of_birth'),
    /** Free text: RP servers use values no fixed enum would cover well. */
    gender: text('gender'),
    phoneNumber: text('phone_number'),
    address: text('address'),
    imageUrl: text('image_url'),
    heightCm: integer('height_cm'),
    weightKg: integer('weight_kg'),
    eyeColor: text('eye_color'),
    hairColor: text('hair_color'),
    notes: text('notes'),
    status: personStatusEnum('status').notNull().default('alive'),
    isDeceased: boolean('is_deceased').notNull().default(false),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => userAccount.id, { onDelete: 'set null' }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    // Trigram indexes for name search are added in the migration (pg_trgm).
    index('person_last_first_idx').on(t.lastName, t.firstName).where(sql`deleted_at IS NULL`),
    index('person_phone_idx').on(t.phoneNumber).where(sql`deleted_at IS NULL`),
    index('person_dob_idx').on(t.dateOfBirth),
    index('person_status_idx').on(t.status).where(sql`deleted_at IS NULL`),
    check(
      'person_soft_delete_complete',
      sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)
          AND (${t.deletedAt} IS NOT NULL OR ${t.deletionReason} IS NULL)`,
    ),
    check(
      'person_deceased_consistent',
      sql`${t.isDeceased} = (${t.status} = 'deceased')`,
    ),
  ],
);

/** Known aliases / street names. Searched alongside the legal name. */
export const personAlias = pgTable(
  'person_alias',
  {
    id: primaryId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('person_alias_key').on(t.personId, t.alias),
    index('person_alias_search_idx').on(t.alias),
  ],
);

/** Operational flags — these drive the red banners on a person record. */
export const personFlag = pgTable(
  'person_flag',
  {
    id: primaryId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    severity: flagSeverityEnum('severity').notNull().default('info'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => userAccount.id, { onDelete: 'set null' }),
  },
  (t) => [
    // Hot path: "does this person have live flags", hit on every lookup.
    index('person_flag_active_idx')
      .on(t.personId)
      .where(sql`resolved_at IS NULL`),
    index('person_flag_severity_idx').on(t.severity).where(sql`resolved_at IS NULL`),
  ],
);

export const warrant = pgTable(
  'warrant',
  {
    id: primaryId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    type: warrantTypeEnum('type').notNull(),
    status: warrantStatusEnum('status').notNull().default('active'),
    reason: text('reason').notNull(),
    issuedBy: uuid('issued_by').references(() => userAccount.id, { onDelete: 'set null' }),
    issuedAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    servedBy: uuid('served_by').references(() => userAccount.id, { onDelete: 'set null' }),
    servedAt: timestamp('served_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('warrant_person_active_idx').on(t.personId).where(sql`status = 'active'`),
    index('warrant_org_status_idx').on(t.organizationId, t.status),
    index('warrant_issued_at_idx').on(t.issuedAt),
  ],
);

/** Seeded penal code, so charges reference an editable catalogue not free text. */
export const statute = pgTable(
  'statute',
  {
    code: text('code').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    severity: chargeSeverityEnum('severity').notNull(),
    defaultFine: integer('default_fine'),
    defaultJailMinutes: integer('default_jail_minutes'),
    category: text('category'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('statute_category_idx').on(t.category)],
);

export const criminalCharge = pgTable(
  'criminal_charge',
  {
    id: primaryId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'restrict' }),
    /** FK added in the migration to avoid a circular import with dispatch.ts. */
    incidentId: uuid('incident_id'),
    statuteCode: text('statute_code').references(() => statute.code, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    severity: chargeSeverityEnum('severity').notNull(),
    status: chargeStatusEnum('status').notNull().default('pending'),
    fineAmount: integer('fine_amount'),
    jailTimeMinutes: integer('jail_time_minutes'),
    points: integer('points'),
    notes: text('notes'),
    filedBy: uuid('filed_by').references(() => userAccount.id, { onDelete: 'set null' }),
    filedAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('criminal_charge_person_idx').on(t.personId),
    index('criminal_charge_incident_idx').on(t.incidentId),
    index('criminal_charge_status_idx').on(t.status),
  ],
);

export const license = pgTable(
  'license',
  {
    id: primaryId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    type: licenseTypeEnum('type').notNull(),
    status: licenseStatusEnum('status').notNull().default('valid'),
    issuedAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    issuedBy: uuid('issued_by').references(() => userAccount.id, { onDelete: 'set null' }),
    suspendedReason: text('suspended_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('license_person_type_key').on(t.personId, t.type),
    index('license_status_idx').on(t.status),
  ],
);

/**
 * Medical records — MD-scoped.
 *
 * Field-level visibility is enforced in the API: reading this table requires
 * `persons.medical.view`, held by medical-category roles. Every read is audited.
 */
export const medicalRecord = pgTable(
  'medical_record',
  {
    personId: uuid('person_id')
      .primaryKey()
      .references(() => person.id, { onDelete: 'cascade' }),
    bloodType: text('blood_type'),
    allergies: text('allergies').array(),
    conditions: text('conditions').array(),
    medications: text('medications').array(),
    emergencyContact: text('emergency_contact'),
    notes: text('notes'),
    updatedBy: uuid('updated_by').references(() => userAccount.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
);

// ── relations ──────────────────────────────────────────────────────────────

export const personRelations = relations(person, ({ many, one }) => ({
  aliases: many(personAlias),
  flags: many(personFlag),
  warrants: many(warrant),
  charges: many(criminalCharge),
  licenses: many(license),
  medical: one(medicalRecord, {
    fields: [person.id],
    references: [medicalRecord.personId],
  }),
}));

export const personFlagRelations = relations(personFlag, ({ one }) => ({
  person: one(person, { fields: [personFlag.personId], references: [person.id] }),
}));

export const warrantRelations = relations(warrant, ({ one }) => ({
  person: one(person, { fields: [warrant.personId], references: [person.id] }),
  organization: one(organization, {
    fields: [warrant.organizationId],
    references: [organization.id],
  }),
}));
