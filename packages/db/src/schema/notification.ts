import { relations, sql } from 'drizzle-orm';
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt, notificationChannelEnum, notificationSeverityEnum, primaryId,
} from './_shared';
import { userAccount } from './identity';
import { organization } from './organization';

/**
 * User-facing notifications.
 *
 * Persisted rather than fire-and-forget, because an operator who was off-shift
 * when a warrant was issued still needs to see it. Delivery over WebSocket is a
 * transport on top of this table, not a replacement for it.
 */
export const notification = pgTable(
  'notification',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    /** Scopes the notification to the organization context it belongs to. */
    organizationId: uuid('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    channel: notificationChannelEnum('channel').notNull().default('in_app'),
    severity: notificationSeverityEnum('severity').notNull().default('info'),
    /** Machine key, e.g. `incident.assigned` — drives icon and routing. */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** Deep link into the app, e.g. `/dispatch?incident=…`. */
    href: text('href'),
    /** Subject of the notification, for grouping and dedup. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Set once the notification has actually left for its channel. */
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    // The badge query: unread notifications for one user, newest first.
    index('notification_user_unread_idx')
      .on(t.userId, t.createdAt)
      .where(sql`read_at IS NULL`),
    index('notification_user_time_idx').on(t.userId, t.createdAt),
    index('notification_entity_idx').on(t.entityType, t.entityId),
    index('notification_undispatched_idx')
      .on(t.createdAt)
      .where(sql`dispatched_at IS NULL`),
    // Cascade target on an unbounded table: without this, archiving an
    // organization scans every notification ever created.
    index('notification_org_idx').on(t.organizationId),
  ],
);

export const notificationRelations = relations(notification, ({ one }) => ({
  user: one(userAccount, { fields: [notification.userId], references: [userAccount.id] }),
  organization: one(organization, {
    fields: [notification.organizationId],
    references: [organization.id],
  }),
}));

/**
 * Per-operator notification preferences.
 *
 * ONE ROW PER USER, created on first write. A missing row is not an error — it
 * means "the defaults", which are defined once in
 * `@leoos/contracts` (`DEFAULT_NOTIFICATION_PREFERENCES`) and read by both
 * tiers. Seeding a row per account at registration would put the defaults in two
 * places and guarantee they drift.
 *
 * NOT ORGANIZATION-SCOPED. A person crewing PD in the morning and MD in the
 * evening does not want two sound settings; the preference is about the human at
 * the keyboard, not about their membership.
 *
 * WHAT IS DELIBERATELY ABSENT: any preference that could suppress a panic.
 * `muted_categories` is a text array, and the server refuses `panic` when
 * writing it (`UNMUTABLE_CATEGORIES` in contracts). The column cannot be trusted
 * to hold only what the UI offers — it is checked on the way in.
 */
export const notificationPreference = pgTable('notification_preference', {
  /**
   * The user IS the key.
   *
   * A primary key on `user_id` rather than a surrogate id with a unique index:
   * two preference rows for one person is not a state the table should be able
   * to represent, and a concurrent first-write from two tabs resolves as an
   * upsert instead of two rows.
   */
  userId: uuid('user_id')
    .primaryKey()
    .references(() => userAccount.id, { onDelete: 'cascade' }),

  soundEnabled: boolean('sound_enabled').notNull().default(false),
  soundCriticalOnly: boolean('sound_critical_only').notNull().default(true),
  soundVolume: integer('sound_volume').notNull().default(60),
  criticalToasts: boolean('critical_toasts').notNull().default(true),
  mutedCategories: text('muted_categories').array().notNull().default(sql`'{}'::text[]`),

  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationPreferenceRelations = relations(notificationPreference, ({ one }) => ({
  user: one(userAccount, {
    fields: [notificationPreference.userId],
    references: [userAccount.id],
  }),
}));
