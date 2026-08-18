import { relations, sql } from 'drizzle-orm';
import {
  boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  citext, createdAt, primaryId, softDelete, timestamps, vehicleInsuranceEnum,
  vehicleRegistrationEnum,
} from './_shared';
import { userAccount } from './identity';
import { organization } from './organization';
import { person } from './person';

export const vehicle = pgTable(
  'vehicle',
  {
    id: primaryId(),
    plate: citext('plate').notNull(),
    /** GTA model name, e.g. `police3`. */
    model: text('model').notNull(),
    displayName: text('display_name'),
    color: text('color'),
    vehicleClass: text('vehicle_class'),

    ownerPersonId: uuid('owner_person_id').references(() => person.id, { onDelete: 'restrict' }),
    ownerOrganizationId: uuid('owner_organization_id').references(() => organization.id, {
      onDelete: 'restrict',
    }),

    registrationStatus: vehicleRegistrationEnum('registration_status')
      .notNull()
      .default('registered'),
    insuranceStatus: vehicleInsuranceEnum('insurance_status').notNull().default('uninsured'),
    isFleet: boolean('is_fleet').notNull().default(false),
    notes: text('notes'),

    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    // Partial: archiving a vehicle must not permanently burn its plate.
    // This is the single most common bug in soft-delete implementations.
    uniqueIndex('vehicle_plate_key').on(t.plate).where(sql`deleted_at IS NULL`),
    index('vehicle_owner_person_idx').on(t.ownerPersonId).where(sql`deleted_at IS NULL`),
    index('vehicle_owner_org_idx').on(t.ownerOrganizationId).where(sql`deleted_at IS NULL`),
    index('vehicle_model_idx').on(t.model),
    check(
      'vehicle_single_owner',
      sql`NOT (${t.ownerPersonId} IS NOT NULL AND ${t.ownerOrganizationId} IS NOT NULL)`,
    ),
    check(
      'vehicle_fleet_has_org',
      sql`NOT ${t.isFleet} OR ${t.ownerOrganizationId} IS NOT NULL`,
    ),
    check(
      'vehicle_soft_delete_complete',
      sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)
          AND (${t.deletedAt} IS NOT NULL OR ${t.deletionReason} IS NULL)`,
    ),
  ],
);

export const vehicleFlag = pgTable(
  'vehicle_flag',
  {
    id: primaryId(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicle.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => userAccount.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('vehicle_flag_active_idx').on(t.vehicleId).where(sql`resolved_at IS NULL`),
  ],
);

export const vehicleRelations = relations(vehicle, ({ one, many }) => ({
  ownerPerson: one(person, { fields: [vehicle.ownerPersonId], references: [person.id] }),
  ownerOrganization: one(organization, {
    fields: [vehicle.ownerOrganizationId],
    references: [organization.id],
  }),
  flags: many(vehicleFlag),
}));

export const vehicleFlagRelations = relations(vehicleFlag, ({ one }) => ({
  vehicle: one(vehicle, { fields: [vehicleFlag.vehicleId], references: [vehicle.id] }),
}));
