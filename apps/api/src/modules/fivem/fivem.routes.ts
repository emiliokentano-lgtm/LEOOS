import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FIVEM_DEFAULT_HEARTBEAT_MS, FIVEM_DEFAULT_TELEMETRY_MS, FIVEM_PROTOCOL_VERSION,
  type FiveMHandshakeResponse, type FiveMIngestResponse,
} from '@leoos/contracts';
import { AUDIT_ACTIONS, gameIdentity, gameServerState, type Database } from '@leoos/db';
import { LIMITS } from '../../lib/rate-limit.js';
import { writeAudit } from '../../lib/audit.js';
import { RateLimitedError, ValidationError } from '../../lib/errors.js';
import { resolveIdentity, toActorContext } from '../auth/context.service.js';
import { resolveDispatchScope } from '../dispatch/dispatch.scope.js';
import { triggerPanic } from '../dispatch/panic.service.js';
import { setOwnStatus } from '../dispatch/unit.service.js';
import { publishDispatchEvents } from '../dispatch/dispatch.events.js';
import {
  commitSequence, describeAuthFailure, verifyFiveMRequest, type FiveMPrincipal,
} from './fivem.auth.js';
import {
  claimSchema, eventsSchema, handshakeSchema, heartbeatSchema, telemetrySchema,
} from './fivem.schema.js';
import { flushPositions, ingestTelemetry } from './fivem.ingest.js';
import { findIdentity, primaryIdentifier } from './fivem.identity.js';

/**
 * The ingest surface.
 *
 * EVERY ROUTE HERE IS MACHINE-TO-MACHINE. There is no session, no cookie and no
 * CSRF token; a request is authenticated entirely by its signature. That is why
 * this module is registered separately from everything else and why nothing in
 * it ever reads `request.auth`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE
 *
 * A verified signature proves the request came from a registered game server. It
 * proves NOTHING about whether the contents are true. Every route below treats
 * the body as untrusted input from a machine that may be buggy, modded or
 * compromised — schema first, sanity filters second, and every organizational
 * fact looked up in the database rather than read from the payload.
 *
 * In particular, an in-game panic and an in-game status change do not bypass
 * authorization: they go through the SAME dispatch services a browser request
 * does, with a scope resolved from the player's real permissions. The game
 * server asking does not make it so.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Bodies are small; a telemetry batch for 500 players is about 100 KB. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Attaches any waiting commands to an ingest response.
 *
 * ONE FUNCTION, used by every ingest route, because the alternative is the bug
 * the resource shipped with: it applied commands only from the telemetry
 * response, so an installation running `leoos_feature_telemetry false` — a
 * supported configuration — received none at all. A channel that works in the
 * default setup and silently does nothing in a valid one is the worst shape a
 * bug can take.
 *
 * Draining here also means the reply is the ONLY place a command leaves the
 * API. There is no push, no socket to a game server and no inbound endpoint on
 * the game host; if this call is not made, nothing reaches a game.
 */
function withCommands<T extends FiveMIngestResponse>(
  app: FastifyInstance,
  gameServerId: string,
  response: T,
): T {
  const { commands, pending } = app.fivemCommands.drain(gameServerId);
  if (commands.length === 0) return response;
  return { ...response, commands, ...(pending ? { commandsPending: true } : {}) };
}

interface AuthedRequest {
  principal: FiveMPrincipal;
  body: unknown;
}

export default async function fivemRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Authenticates, rate-limits and burns the sequence number.
   *
   * Returns null when it has already answered — Fastify handlers that return
   * a reply are done, and threading an early return through each handler keeps
   * the auth path in exactly one place.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    limit: { limit: number; windowSeconds: number },
    surface: string,
  ): Promise<AuthedRequest | null> {
    // The handshake establishes the sequence counter rather than continuing it,
    // which is what lets a restarted game server come back — see check 6 in
    // fivem.auth.ts. Derived from the surface rather than passed separately, so
    // there is no way to ask for the exemption on any other endpoint.
    const isHandshake = surface === 'handshake';

    const rawBody = request.rawBody ?? '';
    if (rawBody.length > MAX_BODY_BYTES) {
      await reply.status(413).send({
        error: { code: 'BODY_TOO_LARGE', message: 'Ingest payload is too large.' },
        requestId: request.requestId,
      });
      return null;
    }

    const result = await verifyFiveMRequest(
      {
        method: request.method,
        // The PATH ONLY. A query string is not signed and must not be, or a
        // proxy appending a tracking parameter would break every request.
        path: request.url.split('?')[0] ?? request.url,
        headers: request.headers as Record<string, string | string[] | undefined>,
        rawBody,
        isHandshake,
      },
      { db: app.db, nonces: app.fivemNonces, secretBox: app.secretBox },
    );

    if (!result.ok) {
      const described = describeAuthFailure(result.reason);
      request.log.warn(
        { reason: result.reason, surface, ip: request.ip },
        'fivem ingest rejected',
      );
      await reply.status(described.status).send({
        error: { code: `FIVEM_${result.reason.toUpperCase().replace(/-/g, '_')}`, message: described.message },
        requestId: request.requestId,
      });
      return null;
    }

    const { principal } = result;

    /**
     * Rate limited PER CREDENTIAL, not per IP.
     *
     * A game server is one machine behind one address, so an IP bucket would be
     * the same bucket — and a shared host would put two servers in it. The
     * credential is the thing whose behaviour we are bounding.
     */
    const rate = app.limiter.consume(
      `fivem:${surface}:${principal.keyId}`, limit.limit, limit.windowSeconds,
    );
    if (!rate.allowed) throw new RateLimitedError(rate.retryAfterSeconds);

    /**
     * The sequence is burned BEFORE the body is processed.
     *
     * A payload that fails validation has still consumed its sequence number, so
     * it cannot be replayed verbatim once its nonce expires. The alternative —
     * only advancing on success — would leave every rejected request replayable
     * for as long as an attacker cared to wait.
     */
    await commitSequence(app.db, principal);

    return { principal, body: request.body };
  }

  // ── Handshake ────────────────────────────────────────────────────────────
  //
  // Called once at resource start. This is where the API tells the resource how
  // to behave — intervals, protocol version — so a configuration change does not
  // need a resource update on someone else's game server.
  app.post('/handshake', async (request, reply) => {
    const authed = await authenticate(request, reply, LIMITS.fivemHandshake, 'handshake');
    if (authed === null) return reply;

    const body = handshakeSchema.parse(authed.body);
    const sessionId = randomUUID();
    const now = new Date();

    await app.db
      .insert(gameServerState)
      .values({
        gameServerId: authed.principal.gameServerId,
        sessionId,
        sessionStartedAt: now,
        resourceVersion: body.resourceVersion,
        lastHeartbeatAt: now,
        lastIngestSeq: authed.principal.seq,
      })
      .onConflictDoUpdate({
        target: gameServerState.gameServerId,
        set: {
          sessionId,
          sessionStartedAt: now,
          resourceVersion: body.resourceVersion,
          lastHeartbeatAt: now,
          /**
           * The baseline is RESET, not advanced.
           *
           * `commitSequence` only ever moves this forward, which is right for
           * ordinary traffic and wrong here: a resource that restarted is
           * counting from near zero again, and leaving the old high-water mark
           * in place would reject every request it goes on to send. The
           * handshake is the one request that gets to say where the sequence
           * starts, and it may only say so about itself.
           */
          lastIngestSeq: authed.principal.seq,
          updatedAt: now,
        },
      });

    await writeAudit(app.db, {
      action: AUDIT_ACTIONS.GAME_SERVER_REGISTERED,
      actorType: 'game_server',
      actorLabel: authed.principal.gameServerName,
      entityType: 'game_server', entityId: authed.principal.gameServerId,
      metadata: {
        event: 'handshake',
        resourceVersion: body.resourceVersion,
        adapter: body.adapter ?? null,
        maxPlayers: body.maxPlayers ?? null,
        protocolVersion: authed.principal.protocolVersion,
      },
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
      requestId: request.requestId,
    });

    const response: FiveMHandshakeResponse = {
      ok: true,
      sessionId,
      serverKey: authed.principal.gameServerKey,
      protocolVersion: FIVEM_PROTOCOL_VERSION,
      telemetryIntervalMs: FIVEM_DEFAULT_TELEMETRY_MS,
      heartbeatIntervalMs: FIVEM_DEFAULT_HEARTBEAT_MS,
      ...(authed.principal.protocolVersion < FIVEM_PROTOCOL_VERSION
        ? {
          upgradeNotice:
              `leoos_bridge is speaking protocol ${authed.principal.protocolVersion}; `
              + `this API speaks ${FIVEM_PROTOCOL_VERSION}. Still supported — please update.`,
        }
        : {}),
    };

    return reply.status(200).send(response);
  });

  // ── Heartbeat ────────────────────────────────────────────────────────────
  //
  // The only thing keeping a server's units on the map. Stop sending these and
  // every unit this server reports goes offline within 30 seconds — see
  // fivem.source.ts.
  app.post('/heartbeat', async (request, reply) => {
    const authed = await authenticate(request, reply, LIMITS.fivemHeartbeat, 'heartbeat');
    if (authed === null) return reply;

    const body = heartbeatSchema.parse(authed.body);
    await requireSession(app.db, authed.principal.gameServerId, body.sessionId);

    const now = new Date();
    await app.db
      .update(gameServerState)
      .set({
        lastHeartbeatAt: now,
        playerCount: body.playerCount,
        resourceVersion: body.resourceVersion,
        updatedAt: now,
      })
      .where(eq(gameServerState.gameServerId, authed.principal.gameServerId));

    const response: FiveMIngestResponse = {
      ok: true,
      nextIntervalMs: FIVEM_DEFAULT_HEARTBEAT_MS,
    };
    return reply.send(withCommands(app, authed.principal.gameServerId, response));
  });

  // ── Telemetry ────────────────────────────────────────────────────────────
  app.post('/telemetry', async (request, reply) => {
    const authed = await authenticate(request, reply, LIMITS.fivemTelemetry, 'telemetry');
    if (authed === null) return reply;

    const body = telemetrySchema.parse(authed.body);
    await requireSession(app.db, authed.principal.gameServerId, body.sessionId);

    const result = await ingestTelemetry(
      body,
      { gameServerId: authed.principal.gameServerId },
      { db: app.db, store: app.mapPositions, liveness: app.fivemLiveness },
    );

    /**
     * The Postgres cache is written at a FRACTION of the tick rate.
     *
     * Every tick goes to the in-memory store, which is the live truth. Writing
     * `unit.pos_*` at 1 Hz across a shift is the ~13M rows/day that engineering
     * rules 21 and 22 exist to prevent, so the two rates are deliberately
     * different numbers.
     */
    if (app.fivemFlush.due()) {
      await flushPositions(
        app.db, app.mapPositions, authed.principal.gameServerId, result.unitIds,
      );
    }

    const response: FiveMIngestResponse = {
      ok: true,
      accepted: result.accepted,
      rejected: result.rejected,
      nextIntervalMs: FIVEM_DEFAULT_TELEMETRY_MS,
    };
    return reply.send(withCommands(app, authed.principal.gameServerId, response));
  });

  // ── Events ───────────────────────────────────────────────────────────────
  //
  // Discrete and rare, so they get their own endpoint and their own retry queue
  // in the resource. A panic must never be lost to telemetry coalescing.
  app.post('/events', async (request, reply) => {
    const authed = await authenticate(request, reply, LIMITS.fivemEvents, 'events');
    if (authed === null) return reply;

    const body = eventsSchema.parse(authed.body);
    await requireSession(app.db, authed.principal.gameServerId, body.sessionId);

    let handled = 0;
    for (const event of body.events) {
      const identifier = primaryIdentifier(event.identifiers);
      if (identifier === null) continue;

      const identity = await findIdentity(app.db, identifier);
      // An unlinked identifier has no LEOOS account, so there is nothing to act
      // on. Not an error — plenty of players on a server are not officers.
      if (identity?.userId == null) continue;

      switch (event.kind) {
        case 'player.panic':
          await handleInGamePanic(app, identity.userId, identifier.full, event, request);
          handled += 1;
          break;

        case 'player.status_requested':
          await handleStatusRequest(app, identity.userId, event, request);
          handled += 1;
          break;

        case 'player.dropped': {
          /**
           * Remove the position now rather than waiting for the TTL.
           *
           * The TTL is the safety net; this is the prompt path. A dispatcher
           * looking at a unit that logged off 40 seconds ago is a dispatcher
           * being misled.
           */
          const unitRows = await app.db.execute<{ unit_id: string }>(sql`
            SELECT um.unit_id
              FROM organization_member om
              JOIN unit_member um ON um.member_id = om.id AND um.left_at IS NULL
             WHERE om.user_id = ${identity.userId} AND om.status = 'active'
          `);
          for (const row of unitRows) app.mapPositions.delete(row.unit_id);
          handled += 1;
          break;
        }

        case 'player.connected':
          // Nothing to do: the next telemetry tick carries their position, and
          // acting on a connect before we have one would put a marker at 0,0.
          handled += 1;
          break;
      }
    }

    const response: FiveMIngestResponse = { ok: true, accepted: handled };
    return reply.send(withCommands(app, authed.principal.gameServerId, response));
  });

  // ── Identity claim ───────────────────────────────────────────────────────
  //
  // Links a FiveM identifier to a LEOOS account, PROVEN FROM BOTH SIDES: the
  // user generates a code while signed in to the web app, then enters it in
  // game. Neither half alone is enough, so a player cannot claim someone else's
  // identifier and an administrator cannot silently attach one to an account.
  app.post('/identity/claim', async (request, reply) => {
    const authed = await authenticate(request, reply, LIMITS.fivemClaim, 'claim');
    if (authed === null) return reply;

    const body = claimSchema.parse(authed.body);
    const identifier = primaryIdentifier(body.identifiers);
    if (identifier === null) {
      return reply.send({
        ok: false,
        message: 'Your FiveM identifiers could not be read. Contact an administrator.',
      });
    }

    /**
     * Expiry is compared against the DATABASE's clock, not the API process's.
     *
     * Also the practical reason: a raw `sql` template binds parameters straight
     * through the driver, which throws on a JS `Date` — only the query builder
     * converts one. `now()` is both correct and the thing that works.
     */
    const codes = await app.db.execute<{ id: string; user_id: string; display_name: string }>(sql`
      SELECT c.id, c.user_id, ua.display_name
        FROM identity_claim_code c
        JOIN user_account ua ON ua.id = c.user_id
       WHERE c.code = ${body.code}
         AND c.consumed_at IS NULL
         AND c.expires_at > now()
       LIMIT 1
    `);
    const claim = codes[0];

    if (!claim) {
      // Deliberately vague, and the only vague message in this module: this is
      // the one place where a guess is worth something to an attacker.
      return reply.send({ ok: false, message: 'That code is not valid or has expired.' });
    }

    const existing = await findIdentity(app.db, identifier);
    if (existing !== null && existing.userId !== null && existing.userId !== claim.user_id) {
      /**
       * Already claimed by someone else. Refused, and AUDITED, because this is
       * either two people sharing a machine or an attempt to steal an identity —
       * and both are things an administrator should be able to see.
       */
      await writeAudit(app.db, {
        action: AUDIT_ACTIONS.GAME_IDENTITY_LINKED,
        actorType: 'game_server',
        actorUserId: claim.user_id,
        actorLabel: authed.principal.gameServerName,
        outcome: 'denied',
        entityType: 'game_identity', entityId: existing.id,
        metadata: { identifier: identifier.full, reason: 'already-linked-elsewhere' },
        ip: request.ip, requestId: request.requestId,
      });
      return reply.send({
        ok: false,
        message: 'That FiveM identity is already linked to another account.',
      });
    }

    await app.db.transaction(async (tx) => {
      // Single use, and consumed inside the same transaction that links the
      // identity — so a crash between the two cannot leave a spent code that
      // linked nothing, or a link with a code still live.
      const consumed = await tx.execute<{ id: string }>(sql`
        UPDATE identity_claim_code
           SET consumed_at = now(), consumed_identity = ${identifier.full}
         WHERE id = ${claim.id} AND consumed_at IS NULL
        RETURNING id
      `);
      if (consumed.length === 0) throw new ValidationError('That code was just used.');

      // The query BUILDER, so a `Date` is converted rather than bound raw.
      const linkedAt = new Date();
      if (existing === null) {
        await tx.insert(gameIdentity).values({
          provider: identifier.provider,
          identifier: identifier.value,
          userId: claim.user_id,
          verifiedAt: linkedAt,
        });
      } else {
        await tx
          .update(gameIdentity)
          .set({ userId: claim.user_id, verifiedAt: linkedAt, lastSeenAt: linkedAt })
          .where(eq(gameIdentity.id, existing.id));
      }

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.GAME_IDENTITY_LINKED,
        actorType: 'game_server',
        actorUserId: claim.user_id,
        actorLabel: authed.principal.gameServerName,
        entityType: 'game_identity',
        metadata: { identifier: identifier.full, gameServer: authed.principal.gameServerKey },
        ip: request.ip, requestId: request.requestId,
      });
    });

    return reply.send({
      ok: true,
      message: `Linked to ${claim.display_name}. You will now appear on the LEOOS map when on duty.`,
      displayName: claim.display_name,
    });
  });
}

/**
 * A session id must match the one issued at handshake.
 *
 * Not security — the signature already did that — but CORRECTNESS. A resource
 * that restarted and did not re-handshake has a sequence counter that reset, and
 * accepting its traffic under the old session would silently defeat the replay
 * protection. Telling it to handshake again is both safe and self-healing.
 */
async function requireSession(
  db: Database,
  gameServerId: string,
  sessionId: string,
): Promise<void> {
  const rows = await db.execute<{ session_id: string | null }>(sql`
    SELECT session_id FROM game_server_state WHERE game_server_id = ${gameServerId}
  `);
  const current = rows[0]?.session_id ?? null;
  if (current !== sessionId) {
    throw new ValidationError('Unknown session. Re-run the handshake.');
  }
}

/**
 * An in-game panic goes through the ORDINARY panic service.
 *
 * The whole point: the game server can tell us a player pressed a button, and
 * that is all it can do. Whether that becomes a panic event is decided by the
 * same code, with the same permission check, the same audit row and the same
 * broadcast as a panic raised from a browser. A compromised game server can
 * raise a panic for a player who is genuinely on duty — which is noisy, bounded
 * and audited — and cannot raise one for anybody else.
 */
async function handleInGamePanic(
  app: FastifyInstance,
  userId: string,
  identifier: string,
  event: { x?: number | null; y?: number | null; down?: boolean | null },
  request: FastifyRequest,
): Promise<void> {
  /**
   * A dead player does not press a panic button.
   *
   * THREE LAYERS, each catching what the one before it cannot:
   *
   *   1. the client refuses locally, so the player gets an instant answer
   *      rather than a silent no-op;
   *   2. the game server re-checks with a server-side native before signing
   *      anything, because a modded client is exactly what layer 1 cannot stop;
   *   3. here — the API refuses when the game server itself said the player was
   *      down, on this event or on its last telemetry.
   *
   * Layer 3 is the weakest and worth being honest about: it catches a bridge
   * whose event path was bypassed while its telemetry stayed truthful. A wholly
   * compromised game server defeats all three, which has always been true of
   * coordinates too.
   *
   * EITHER SOURCE SAYING DOWN REFUSES. The event is fresher, but letting a
   * `down: false` on the event override a recent telemetry report would delete
   * layer 3 entirely — that override is precisely what a bypassed event path
   * would send.
   *
   * FAIL OPEN ON ABSENT INFORMATION, though: `down` missing, or a liveness
   * report older than the position TTL, and the panic proceeds. Refusing on
   * silence would let a telemetry gap suppress somebody's alarm — far worse
   * than a dead player managing to raise one.
   */
  if (event.down === true || app.fivemLiveness.isDown(identifier)) {
    /**
     * Audited, not merely dropped.
     *
     * A stream of these is either a player hammering a key while dead, or a
     * resource whose liveness check has broken. Recorded under the SAME action
     * as a successful panic with `denied` as the outcome, so "show me refused
     * panics" is one filter rather than a new key nobody thinks to look at.
     */
    await writeAudit(app.db, {
      action: AUDIT_ACTIONS.PANIC_TRIGGERED,
      actorType: 'game_server',
      actorUserId: userId,
      outcome: 'denied',
      metadata: {
        reason: 'player-down',
        assertedBy: event.down === true ? 'event' : 'telemetry',
      },
      ip: request.ip,
      userAgent: 'leoos_bridge',
      requestId: request.requestId,
    });
    return;
  }

  const scope = await scopeFor(app.db, userId);
  if (scope === null) return;

  try {
    const outcome = await triggerPanic(
      app.db,
      scope,
      { x: event.x ?? null, y: event.y ?? null, source: 'fivem' },
      { ip: request.ip, userAgent: 'leoos_bridge', requestId: request.requestId },
    );
    publishDispatchEvents(
      app.events,
      { kind: 'game_server', userId, label: null },
      outcome.events,
    );
  } catch (error) {
    // A refusal is a legitimate outcome — an inactive membership, a missing
    // permission — and must not fail the whole event batch. It is already
    // audited by the service.
    request.log.warn({ err: error, userId }, 'in-game panic refused');
  }
}

/** Same reasoning as panic: advisory in, authorized decision out. */
async function handleStatusRequest(
  app: FastifyInstance,
  userId: string,
  event: { statusKey?: string | null },
  request: FastifyRequest,
): Promise<void> {
  if (!event.statusKey) return;
  const scope = await scopeFor(app.db, userId);
  if (scope === null) return;

  try {
    const outcome = await setOwnStatus(
      app.db,
      scope,
      event.statusKey,
      { ip: request.ip, userAgent: 'leoos_bridge', requestId: request.requestId },
    );
    publishDispatchEvents(
      app.events,
      { kind: 'game_server', userId, label: null },
      outcome.events,
    );
  } catch (error) {
    request.log.warn({ err: error, userId }, 'in-game status change refused');
  }
}

/**
 * Builds a dispatch scope for a player, from THEIR permissions.
 *
 * This is the line that makes the trust model real. The scope is resolved from
 * the database exactly as it would be for a web request, so a player's in-game
 * actions are bounded by their actual rank and permissions rather than by what
 * the game server claims about them.
 */
async function scopeFor(db: Database, userId: string) {
  const identity = await resolveIdentity(db, userId);
  if (identity === null) return null;

  const membership = identity.memberships.find((m) => m.status === 'active');
  if (membership === undefined) return null;

  const actor = toActorContext(identity, membership.organizationId);
  return resolveDispatchScope(actor, userId);
}
