import { relations, sql } from 'drizzle-orm';
import {
  index, jsonb, pgTable, text, timestamp, uuid,
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
