import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import type { ActorContext } from '@leoos/authz-core';
import type { AppConfig } from '../config.js';
import { resolveIdentity, toActorContext } from '../modules/auth/context.service.js';
import { isSessionLive as sessionIsLive } from '../modules/auth/session.service.js';
import { RealtimeHub } from '../realtime/hub.js';
import { LocationBroadcaster } from '../realtime/location-broadcaster.js';
import { RealtimePublisher } from '../realtime/publisher.js';
import { TicketStore } from '../realtime/tickets.js';
import { visibleUnitIdsFor } from '../modules/map/map.read.js';

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeHub;
    events: RealtimePublisher;
    wsTickets: TicketStore;
    /** The one clock for the position path. See location-broadcaster.ts. */
    locationBroadcaster: LocationBroadcaster;
  }
}

export interface RealtimeOptions {
  config: AppConfig;
}

/**
 * Wires the real-time subsystem.
 *
 * The hub needs two things from the rest of the application, and they are
 * INJECTED rather than imported so the hub itself depends on neither auth nor
 * the map module:
 *
 *   `resolveActor` re-reads a subscriber's live authorization context. It is
 *   called on every delivery — see the note in hub.ts — which is what makes a
 *   permission change take effect without any revocation machinery.
 *
 *   `visibleUnitsFor` answers which units a subscriber may see positions for,
 *   applying the covert and sharing rules from docs/architecture/05-map.md §5.
 */
export default fp<RealtimeOptions>(async (app, opts) => {
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
      // The upgrade carries no credentials — authentication is the first
      // message (ADR-0013) — so there is nothing to verify here beyond size.
    },
  });

  const tickets = new TicketStore();
  tickets.start();
  app.decorate('wsTickets', tickets);

  /**
   * Actor contexts are cached for a very short window.
   *
   * Without it, a burst of events would re-run the identity query once per event
   * per subscriber. One second is short enough that a permission change still
   * takes effect within a tick, and long enough to collapse a burst into one
   * read — the responsiveness the re-authorization buys is measured in seconds,
   * not milliseconds.
   */
  const actorCache = new Map<string, { at: number; actor: ActorContext | null }>();
  const ACTOR_TTL_MS = 1_000;

  const resolveActor = async (
    userId: string,
    organizationId: string | null,
  ): Promise<ActorContext | null> => {
    const key = `${userId}:${organizationId ?? ''}`;
    const cached = actorCache.get(key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < ACTOR_TTL_MS) return cached.actor;

    const identity = await resolveIdentity(app.db, userId);
    const actor = identity === null ? null : toActorContext(identity, organizationId);
    actorCache.set(key, { at: now, actor });
    return actor;
  };

  const visibleUnitsFor = async (
    userId: string,
    organizationId: string | null,
  ): Promise<Set<string>> => {
    const identity = await resolveIdentity(app.db, userId);
    if (identity === null) return new Set();
    const actor = toActorContext(identity, organizationId);
    return visibleUnitIdsFor(app.db, actor, userId);
  };

  /**
   * Session liveness, cached on the same short window as the actor context.
   *
   * One second is short enough that a logout or a revocation reaches an open
   * socket within a tick, and long enough that a burst of events does not run
   * this query once per event per subscriber. It is a SEPARATE cache from the
   * actor's because the two answer different questions and expire for different
   * reasons — an actor context is about permissions, this is about whether the
   * connection should exist at all.
   */
  const sessionCache = new Map<string, { at: number; live: boolean }>();
  const SESSION_TTL_MS = 1_000;

  const isSessionLive = async (sessionId: string): Promise<boolean> => {
    const now = Date.now();
    const cached = sessionCache.get(sessionId);
    if (cached !== undefined && now - cached.at < SESSION_TTL_MS) return cached.live;

    const live = await sessionIsLive(app.db, sessionId);
    // A dead session is never re-checked: nothing brings one back, and keeping
    // the entry would be an unbounded map keyed by every session that ever
    // opened a socket.
    if (live) sessionCache.set(sessionId, { at: now, live });
    else sessionCache.delete(sessionId);
    return live;
  };

  const hub = new RealtimeHub({
    resolveActor,
    isSessionLive,
    visibleUnitsFor,
    log: (message) => app.log.warn(message),
    // Closing over the broadcaster declared below is safe: the callback only
    // ever runs once a connection exists, which is long after this function
    // returns.
    onRemove: (connectionId) => broadcaster.forget(connectionId),
  });

  const broadcaster = new LocationBroadcaster({
    hub,
    store: app.mapPositions,
    visibleUnitsFor,
    log: (message) => app.log.warn(message),
  });

  hub.start();
  /**
   * The broadcast tick is NOT started under NODE_ENV=test, for the same reason
   * the position simulator is not: a timer serialising positions while a test
   * asserts on a socket is a flake generator. Tests drive `flushPositions`
   * explicitly.
   */
  if (opts.config.NODE_ENV !== 'test') broadcaster.start();

  app.decorate('realtime', hub);
  app.decorate('events', new RealtimePublisher(hub));
  app.decorate('locationBroadcaster', broadcaster);

  // The actor cache must not outlive its usefulness on a long-running process.
  const cacheSweeper = setInterval(() => {
    const cutoff = Date.now() - ACTOR_TTL_MS;
    for (const [key, entry] of actorCache) {
      if (entry.at < cutoff) actorCache.delete(key);
    }
  }, 30_000);
  cacheSweeper.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(cacheSweeper);
    broadcaster.stop();
    hub.stop();
    tickets.stop();
  });
});
