import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { notification, type Database } from '@leoos/db';
import {
  NOTIFICATION_SEVERITIES, notificationTypeMeta,
  type NotificationPayload, type NotificationSeverity, type NotificationType,
  type UnreadSummary,
} from '@leoos/contracts';
import type { Recipient } from './recipients.js';

/**
 * Writing notifications.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ROWS INSIDE THE TRANSACTION; DELIVERY AFTER THE COMMIT
 *
 * The same rule the audit log follows, for the same reason. `createNotifications`
 * takes a TRANSACTION HANDLE and inserts inside it, so a rolled-back assignment
 * leaves no "you were assigned" sitting in somebody's bell. The WebSocket
 * delivery is a separate step performed by the route after the service returns —
 * which it can only do once the transaction has committed.
 *
 * A crash between the two loses a real-time toast, not the notification: the row
 * is committed, the badge is right on the next poll, and the centre shows it.
 * That is the correct direction to fail in.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface NotificationDraft {
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Overrides the type's default. Used where the same type varies in urgency. */
  severity?: NotificationSeverity;
  href?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Which screen the live toast offers to open.
   *
   * A SCREEN NAME, not the `href`: the socket payload does not carry URLs
   * (docs/architecture/03-realtime.md §4), and the stored `href` is what the
   * notification centre uses once the recipient fetches the row.
   */
  target?: 'dispatch' | 'map' | 'dashboard' | null;
}

/**
 * What the route needs in order to deliver.
 *
 * Deliberately NOT the full row: the socket payload carries a title, a body and
 * a tone, and nothing else (docs/architecture/03-realtime.md §4). The recipient
 * fetches the detail through the authorized read like any other screen.
 */
export interface NotificationDelivery {
  userId: string;
  notificationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  target: 'dispatch' | 'map' | 'dashboard' | null;
}

/** The socket payload for one delivery. Tone is derived from severity, once. */
export function deliveryPayload(delivery: NotificationDelivery): NotificationPayload {
  return {
    id: delivery.notificationId,
    type: delivery.type,
    severity: delivery.severity,
    title: delivery.title,
    body: delivery.body,
    tone: NOTIFICATION_SEVERITIES[delivery.severity].tone,
    target: delivery.target,
  };
}

/**
 * Inserts one notification per recipient and returns what to deliver.
 *
 * Deduplicated by user id: a person who is both a dispatcher and on the crew of
 * the assigned unit gets one notification about the call, not two.
 *
 * Bulk-inserted in one statement rather than a loop — an announcement to a
 * hundred-member organization is one round trip, and the whole point of doing
 * this inside the caller's transaction is that it must not be slow enough to
 * make anybody move it outside.
 */
/**
 * The largest number of notification rows one INSERT may carry.
 *
 * Twelve bind parameters per row against Postgres's 65 535 ceiling allows about
 * 5 400; 2 000 leaves room for the columns this table may grow without anybody
 * having to remember this arithmetic again.
 */
const NOTIFICATION_INSERT_CHUNK = 2_000;

async function insertInChunks(
  tx: Database,
  values: (typeof notification.$inferInsert)[],
): Promise<{ id: string; userId: string }[]> {
  const written: { id: string; userId: string }[] = [];
  for (let i = 0; i < values.length; i += NOTIFICATION_INSERT_CHUNK) {
    const rows = await tx
      .insert(notification)
      .values(values.slice(i, i + NOTIFICATION_INSERT_CHUNK))
      .returning({ id: notification.id, userId: notification.userId });
    written.push(...rows);
  }
  return written;
}

export async function createNotifications(
  tx: Database,
  recipients: readonly Recipient[],
  draft: NotificationDraft,
): Promise<NotificationDelivery[]> {
  const unique = [...new Map(recipients.map((r) => [r.userId, r])).values()];
  if (unique.length === 0) return [];

  const severity = draft.severity ?? notificationTypeMeta(draft.type).defaultSeverity;

  /**
   * WRITTEN IN CHUNKS, because one statement has a parameter ceiling.
   *
   * Postgres accepts at most 65 535 bind parameters per statement. This insert
   * binds twelve per row, so a single statement tops out around 5 400
   * recipients — and past that the driver fails the whole statement. The
   * failure mode is what makes this worth guarding: the largest fan-out in the
   * product is a PANIC, so the notification that matters most is the first one
   * to stop working, and it stops by throwing rather than by delivering fewer.
   *
   * Found when a test database accumulated ~7 800 memberships across repeated
   * fixture runs and every panic began returning 500 with a 53 000-placeholder
   * insert. No real organization is that large, which is precisely why nothing
   * would have caught it before somebody's did.
   *
   * The chunks share the caller's transaction, so this is still all-or-nothing:
   * a rolled-back assignment leaves no "you were assigned" in anybody's bell.
   */
  const rows = await insertInChunks(tx, unique.map((recipient) => ({
      userId: recipient.userId,
      organizationId: draft.organizationId ?? null,
      channel: 'in_app' as const,
      severity,
      type: draft.type,
      title: draft.title,
      body: draft.body ?? null,
      href: draft.href ?? null,
      entityType: draft.entityType ?? null,
      entityId: draft.entityId ?? null,
      metadata: draft.metadata ?? {},
      /**
       * Stamped at insert, because in-app delivery IS the write.
       *
       * The column exists for channels that leave the process — email, push —
       * where "created" and "sent" are genuinely different moments. For an
       * in-app notification they are the same moment, and leaving it null would
       * make the undispatched index fill up with rows nothing will ever pick up.
       */
      dispatchedAt: new Date(),
    })));

  return rows.map((row) => ({
    userId: row.userId,
    notificationId: row.id,
    type: draft.type,
    severity,
    title: draft.title,
    body: draft.body ?? null,
    target: draft.target ?? null,
  }));
}

// ── Reading ────────────────────────────────────────────────────────────────

export type NotificationRow = {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date | string;
  readAt: Date | string | null;
  organizationId: string | null;
  organizationKey: string | null;
  organizationName: string | null;
  organizationShortName: string | null;
  organizationCategory: string | null;
  organizationColor: string | null;
};

export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at))) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt: at, id };
  } catch {
    return null;
  }
}

export interface ListOptions {
  unreadOnly?: boolean;
  category?: string;
  severity?: string;
  limit?: number;
  cursor?: string;
}

/**
 * One person's notifications.
 *
 * SCOPED TO THE CALLER IN SQL, always. `user_id = ${userId}` is not a filter the
 * caller can influence — there is no query parameter that reaches it — so there
 * is no request shape that reads somebody else's feed. That matters more here
 * than on most reads: a notification list is a summary of everything its owner
 * has been told, which is a richer disclosure than any single screen.
 *
 * Keyset paging, like the audit log: notifications arrive at the head while the
 * centre is open, and an offset would repeat and skip rows.
 */
export async function listNotifications(
  db: Database,
  userId: string,
  options: ListOptions,
): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const clauses = [sql`n.user_id = ${userId}`];

  if (options.unreadOnly) clauses.push(sql`n.read_at IS NULL`);
  if (options.severity) clauses.push(sql`n.severity = ${options.severity}`);

  /**
   * Category is a property of the TYPE, not a column.
   *
   * Expanded here into the set of type keys it covers, so filtering happens in
   * the database over the whole feed rather than in the browser over whatever
   * page arrived. The catalogue is the single source: a type added there is
   * filterable the day it ships.
   */
  if (options.category) {
    const { NOTIFICATION_TYPES } = await import('@leoos/contracts');
    const keys = Object.values(NOTIFICATION_TYPES)
      .filter((meta) => meta.category === options.category)
      .map((meta) => meta.key);
    if (keys.length === 0) return { rows: [], nextCursor: null };
    clauses.push(sql`n.type IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`);
  }

  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  if (cursor) {
    clauses.push(sql`(n.created_at, n.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
  }

  const rows = await db.execute<NotificationRow>(sql`
    SELECT n.id,
           n.type,
           n.severity::text          AS severity,
           n.title,
           n.body,
           n.href,
           n.entity_type             AS "entityType",
           n.entity_id               AS "entityId",
           n.metadata,
           n.created_at              AS "createdAt",
           n.read_at                 AS "readAt",
           n.organization_id         AS "organizationId",
           o.key                     AS "organizationKey",
           o.name                    AS "organizationName",
           o.short_name              AS "organizationShortName",
           o.category::text          AS "organizationCategory",
           o.color                   AS "organizationColor"
      FROM notification n
      LEFT JOIN organization o ON o.id = n.organization_id
     WHERE ${sql.join(clauses, sql` AND `)}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/**
 * The badge.
 *
 * Critical is counted separately so the bell can say not just "twelve" but
 * "twelve, one of which needs you now" — a count alone cannot distinguish a
 * quiet morning's updates from a panic.
 */
export async function unreadSummary(db: Database, userId: string): Promise<UnreadSummary> {
  const [row] = await db.execute<{ total: number; critical: number }>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE severity = 'critical')::int AS critical
      FROM notification
     WHERE user_id = ${userId} AND read_at IS NULL
  `);
  return { total: row?.total ?? 0, critical: row?.critical ?? 0 };
}

/**
 * Marks notifications read.
 *
 * The `user_id` predicate is what makes this safe: an id belonging to somebody
 * else matches nothing and the call reports zero, rather than silently marking
 * another person's alert as seen. Reading somebody else's notification is a
 * disclosure; MARKING one read is worse — it removes the badge that would have
 * made them look.
 */
export async function markRead(
  db: Database,
  userId: string,
  notificationIds: readonly string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0;

  const rows = await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(
      eq(notification.userId, userId),
      isNull(notification.readAt),
      sql`${notification.id} IN (${sql.join(notificationIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
    ))
    .returning({ id: notification.id });

  return rows.length;
}

export async function markAllRead(db: Database, userId: string): Promise<number> {
  const rows = await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.userId, userId), isNull(notification.readAt)))
    .returning({ id: notification.id });
  return rows.length;
}

/** One notification, scoped to its owner. Used by the detail view. */
export async function findNotification(
  db: Database,
  userId: string,
  notificationId: string,
): Promise<NotificationRow | null> {
  const rows = await db.execute<NotificationRow>(sql`
    SELECT n.id,
           n.type,
           n.severity::text          AS severity,
           n.title,
           n.body,
           n.href,
           n.entity_type             AS "entityType",
           n.entity_id               AS "entityId",
           n.metadata,
           n.created_at              AS "createdAt",
           n.read_at                 AS "readAt",
           n.organization_id         AS "organizationId",
           o.key                     AS "organizationKey",
           o.name                    AS "organizationName",
           o.short_name              AS "organizationShortName",
           o.category::text          AS "organizationCategory",
           o.color                   AS "organizationColor"
      FROM notification n
      LEFT JOIN organization o ON o.id = n.organization_id
     WHERE n.id = ${notificationId} AND n.user_id = ${userId}
     LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * Retention.
 *
 * Notifications are operational ephemera, not a record: the audit log is what
 * survives. Read notifications older than the window are deleted rather than
 * kept forever, because an unbounded per-user table is the one that eventually
 * makes the badge query slow.
 *
 * UNREAD notifications are never deleted by age. Somebody returning from two
 * weeks off should still see that they were assigned to something.
 */
export async function purgeOldNotifications(db: Database, olderThanDays = 30): Promise<number> {
  const rows = await db
    .delete(notification)
    .where(and(
      sql`${notification.readAt} IS NOT NULL`,
      sql`${notification.readAt} < now() - ${`${olderThanDays} days`}::interval`,
    ))
    .returning({ id: notification.id });
  return rows.length;
}

/** Total rows for one user, for the admin/system view. */
export async function countFor(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(notification)
    .where(eq(notification.userId, userId));
  return rows[0]?.value ?? 0;
}
