import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NOTIFICATION_CATEGORIES, type NotificationPage, type NotificationSeverity,
  type RealtimeActor, type UnreadSummary,
} from '@leoos/contracts';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  findNotification, listNotifications, markAllRead, markRead, unreadSummary,
} from './notification.service.js';
import { toNotificationDto } from './notification.dto.js';
import { readPreferences, writePreferences } from './preference.service.js';
import { sendAnnouncement } from './announcement.service.js';
import { publishDispatchEvents, notificationEmissions } from '../dispatch/dispatch.events.js';

/**
 * The notification surface.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERY ROUTE HERE IS SCOPED TO THE CALLER, IN SQL, WITH NO PARAMETER
 *
 * There is no `userId` anywhere in this file except `request.auth!.userId`. Not
 * in a path, not in a query, not in a body — so there is no request shape that
 * reads or modifies somebody else's feed, and no permission that grants it
 * either. A notification list is a summary of everything its owner has been
 * told, which is a richer disclosure than any single screen; a global
 * administrator has no operational reason to read one, and the capability would
 * be pure surveillance. The socket takes the same position: `user:<id>` is
 * refused to everybody but its owner (`realtime/topics.ts`).
 *
 * The ONE route that is not self-scoped is the announcement, which writes to
 * other people. It is gated on `organization.announce` in the caller's own
 * organization and audited — see `announcement.service.ts`.
 * ────────────────────────────────────────────────────────────────────────────
 */

const categoryKeys = NOTIFICATION_CATEGORIES.map((c) => c.key) as [string, ...string[]];

const listQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  category: z.enum(categoryKeys).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Opaque to the client and validated by decoding, not by shape: a cursor that
  // will not decode is treated as no cursor, which returns the head of the list
  // rather than an error nobody can act on.
  cursor: z.string().max(200).optional(),
}).strict();

const notificationIdParam = z.object({ notificationId: z.uuid() });

const markReadSchema = z.object({
  // Bounded: "mark these read" is a page's worth of ids, and an unbounded array
  // is an unbounded IN list.
  notificationIds: z.array(z.uuid()).min(1).max(200),
}).strict();

const preferencesSchema = z.object({
  soundEnabled: z.boolean().optional(),
  soundCriticalOnly: z.boolean().optional(),
  soundVolume: z.number().int().min(0).max(100).optional(),
  /**
   * Cues to silence. Bounded and validated as strings rather than an enum, so a
   * client that knows a cue this build does not is answered with the stored
   * state rather than a 400 — the service drops what it does not recognise.
   */
  mutedCues: z.array(z.string().max(40)).max(20).optional(),
  criticalToasts: z.boolean().optional(),
  /**
   * `panic` is accepted by the SCHEMA and refused by the SERVICE.
   *
   * Deliberate: rejecting it here would turn a request into a 400 the client has
   * to special-case, when the correct behaviour is to store what can be stored
   * and answer with the state that actually resulted. The client renders the
   * response, so an operator who tried to mute panic sees the switch snap back.
   */
  mutedCategories: z.array(z.enum(categoryKeys)).max(categoryKeys.length).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'No changes supplied.' });

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(2000),
  /**
   * `critical` is absent from the enum ON PURPOSE.
   *
   * Critical is the level a panic uses to earn a sticky toast and, if the
   * operator asked for it, a sound. An announcement that can dress itself as one
   * is how people learn to dismiss the level that matters. The service caps it
   * too — this is the polite refusal, that one is the enforcement.
   */
  severity: z.enum(['info', 'warning']).default('info'),
}).strict();

const organizationIdParam = z.object({ organizationId: z.uuid() });

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

function realtimeActor(request: FastifyRequest): RealtimeActor {
  return {
    kind: 'user',
    userId: request.auth?.userId ?? null,
    label: request.auth?.identity.account.displayName ?? null,
  };
}

export default async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  // ── The centre ───────────────────────────────────────────────────────────

  /**
   * One page, plus the unread total.
   *
   * The count is for EVERYTHING, not for this page, because it drives the badge.
   * Returning it with the page rather than from a second endpoint means the list
   * and the badge cannot disagree — they came out of the same request.
   */
  app.get('/', async (request, reply) => {
    const userId = request.auth!.userId;
    const query = listQuerySchema.parse(request.query ?? {});

    const [{ rows, nextCursor }, unread] = await Promise.all([
      listNotifications(app.db, userId, {
        unreadOnly: query.unreadOnly,
        category: query.category,
        severity: query.severity,
        limit: query.limit,
        cursor: query.cursor,
      }),
      unreadSummary(app.db, userId),
    ]);

    reply.header('cache-control', 'no-store');
    const page: NotificationPage = {
      notifications: rows.map(toNotificationDto),
      unreadCount: unread.total,
      nextCursor,
    };
    return reply.send(page);
  });

  /**
   * The badge on its own.
   *
   * The shell polls this on every screen as the backstop behind the socket, so
   * it is deliberately the cheapest query in the module: one partial-index scan,
   * no join, no page.
   */
  app.get('/unread', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const summary: UnreadSummary = await unreadSummary(app.db, request.auth!.userId);
    return reply.send(summary);
  });

  /**
   * One notification.
   *
   * 404 for a notification belonging to somebody else — the same answer as for
   * one that does not exist, so an id cannot be probed for existence.
   */
  app.get('/:notificationId', async (request, reply) => {
    const { notificationId } = notificationIdParam.parse(request.params);
    const row = await findNotification(app.db, request.auth!.userId, notificationId);
    if (!row) throw new NotFoundError('notification');
    reply.header('cache-control', 'no-store');
    return reply.send(toNotificationDto(row));
  });

  // ── Read state ───────────────────────────────────────────────────────────

  /**
   * Marks a set read, and answers with the new badge.
   *
   * Ids belonging to somebody else match nothing and are silently counted as
   * zero rather than refused: the `user_id` predicate is the security, and a 403
   * would confirm that an id exists. Marking another person's alert read is
   * worse than reading it — it removes the badge that would have made them look.
   */
  app.post('/read', async (request, reply) => {
    const userId = request.auth!.userId;
    const body = markReadSchema.parse(request.body);
    const updated = await markRead(app.db, userId, body.notificationIds);
    reply.header('cache-control', 'no-store');
    return reply.send({ updated, unread: await unreadSummary(app.db, userId) });
  });

  app.post('/read-all', async (request, reply) => {
    const userId = request.auth!.userId;
    const updated = await markAllRead(app.db, userId);
    reply.header('cache-control', 'no-store');
    return reply.send({ updated, unread: await unreadSummary(app.db, userId) });
  });

  // ── Preferences ──────────────────────────────────────────────────────────

  app.get('/preferences', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.send(await readPreferences(app.db, request.auth!.userId));
  });

  /**
   * Answers with the STORED state, not the requested one.
   *
   * An operator who asked to mute `panic` gets a response in which it is not
   * muted, and the switch snaps back. Echoing the request would produce a client
   * that believes it silenced something the server will keep sending.
   */
  app.put('/preferences', async (request, reply) => {
    const body = preferencesSchema.parse(request.body);
    reply.header('cache-control', 'no-store');
    return reply.send(await writePreferences(app.db, request.auth!.userId, {
      soundEnabled: body.soundEnabled,
      soundCriticalOnly: body.soundCriticalOnly,
      soundVolume: body.soundVolume,
      mutedCues: body.mutedCues,
      criticalToasts: body.criticalToasts,
      mutedCategories: body.mutedCategories as never,
    }));
  });

  // ── Announcements ────────────────────────────────────────────────────────

  /**
   * The one route that writes to other people.
   *
   * The organization comes from the PATH and must match the caller's active
   * organization; the audience is derived from it inside the transaction. There
   * is no recipient parameter, here or in the service, so there is no version of
   * this request that reaches somebody outside the organization named.
   */
  app.post('/announcements/:organizationId', async (request, reply) => {
    const { organizationId } = organizationIdParam.parse(request.params);
    const body = announcementSchema.parse(request.body);
    const actor = app.actorContext(request);

    const { result, deliveries } = await sendAnnouncement(
      app.db, actor, organizationId,
      { title: body.title, body: body.body, severity: body.severity as NotificationSeverity },
      meta(request),
    );

    // Published after the transaction committed, like every other emission in
    // the system — see dispatch.events.ts for why that is a shape rather than a
    // convention.
    publishDispatchEvents(app.events, realtimeActor(request), notificationEmissions(deliveries));

    return reply.status(201).send(result);
  });
}
