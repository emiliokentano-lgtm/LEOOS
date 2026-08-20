import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  FIVEM_SERVER_OFFLINE_AFTER_MS,
  type GameServerCredentialIssued, type GameServerDto,
} from '@leoos/contracts';
import { AUDIT_ACTIONS, gameServer, gameServerCredential } from '@leoos/db';
import { can } from '@leoos/authz-core';
import { writeAudit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/password.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { SecretBoxUnavailable } from '../../lib/secret-box.js';
import { issueCredentialSchema, registerServerSchema } from './fivem.schema.js';

/**
 * Registering game servers and issuing their credentials.
 *
 * SEPARATE FROM THE INGEST SURFACE, deliberately. Everything in `fivem.routes.ts`
 * is authenticated by signature and has no session; everything here is an
 * ordinary authenticated admin action gated on `admin.game_servers`. Mixing them
 * would put a session-authenticated route one typo away from the machine path.
 *
 * WHY THIS EXISTS AT ALL: without it the integration is undeployable. An HMAC
 * scheme needs a secret to exist on both sides, and there is no way to create
 * one that does not involve a person deciding to. The one that matters:
 *
 *   THE SECRET IS RETURNED EXACTLY ONCE, at creation. There is no endpoint that
 *   can return it again, and no admin screen that could — not because it would
 *   be hard to add, but because being unable to is the property (engineering
 *   rule 16). An operator who loses it issues a new one, which takes seconds and
 *   leaves an audit trail.
 */

const serverIdParam = z.object({ gameServerId: z.uuid() });
const credentialParams = z.object({ gameServerId: z.uuid(), credentialId: z.uuid() });

export default async function gameServerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.requireSession);

  /**
   * `admin.game_servers` is a GLOBAL capability, not an organization permission.
   *
   * A game server is not owned by an agency — it is the world every agency plays
   * in — so scoping this to an organization would be meaningless. 404 rather
   * than 403, as everywhere: a caller who may not administer game servers learns
   * nothing about whether any exist.
   */
  function requireAdmin(request: FastifyRequest): string {
    const actor = app.actorContext(request);
    if (!can(actor, 'admin.game_servers')) throw new NotFoundError('game servers');
    return request.auth!.userId;
  }

  function requireSecretBox(): NonNullable<typeof app.secretBox> {
    if (app.secretBox === null) throw new SecretBoxUnavailable();
    return app.secretBox;
  }

  // ── List ─────────────────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    requireAdmin(request);

    const rows = await app.db.execute<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      is_active: boolean;
      /**
       * EPOCH SECONDS, not a timestamp.
       *
       * A raw `sql` projection returns a timestamp as a STRING, and calling a
       * `Date` method on it fails at runtime rather than at compile time — the
       * type annotation here is a claim TypeScript cannot check against the
       * driver. Selecting a number removes the ambiguity entirely.
       */
      created_epoch: number;
      last_heartbeat_epoch: number | null;
      player_count: number | null;
      resource_version: string | null;
      anomaly_count: number | null;
      has_state: boolean;
    }>(sql`
      SELECT
        gs.id, gs.key, gs.name, gs.description, gs.is_active,
        EXTRACT(EPOCH FROM gs.created_at)::double precision AS created_epoch,
        EXTRACT(EPOCH FROM st.last_heartbeat_at)::double precision AS last_heartbeat_epoch,
        st.player_count, st.resource_version, st.anomaly_count,
        (st.game_server_id IS NOT NULL) AS has_state
      FROM game_server gs
      LEFT JOIN game_server_state st ON st.game_server_id = gs.id
      ORDER BY gs.name
    `);

    const credentials = await app.db
      .select({
        id: gameServerCredential.id,
        gameServerId: gameServerCredential.gameServerId,
        keyId: gameServerCredential.keyId,
        createdAt: gameServerCredential.createdAt,
        lastUsedAt: gameServerCredential.lastUsedAt,
        expiresAt: gameServerCredential.expiresAt,
        revokedAt: gameServerCredential.revokedAt,
      })
      .from(gameServerCredential);

    const now = Date.now();
    const servers: GameServerDto[] = rows.map((row) => {
      const lastHeartbeatAt = row.last_heartbeat_epoch === null
        ? null
        : new Date(Math.round(row.last_heartbeat_epoch * 1000));

      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        isActive: row.is_active,
        createdAt: new Date(Math.round(row.created_epoch * 1000)).toISOString(),
        state: row.has_state
          ? {
            lastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null,
            playerCount: row.player_count ?? 0,
            resourceVersion: row.resource_version,
            anomalyCount: row.anomaly_count ?? 0,
            /**
             * DERIVED, never stored. A boolean column would be wrong the moment
             * the process that maintained it stopped — which is exactly the
             * situation it would be reporting on.
             */
            online: lastHeartbeatAt !== null
              && now - lastHeartbeatAt.getTime() <= FIVEM_SERVER_OFFLINE_AFTER_MS,
          }
          : null,
        // Assembled from a typed DTO, never a raw row. `secret_hash` and
        // `secret_enc` are not selected above and cannot leak here.
        credentials: credentials
          .filter((c) => c.gameServerId === row.id)
          .map((c) => ({
            id: c.id,
            keyId: c.keyId,
            createdAt: c.createdAt.toISOString(),
            lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
            expiresAt: c.expiresAt?.toISOString() ?? null,
            revokedAt: c.revokedAt?.toISOString() ?? null,
          })),
      };
    });

    reply.header('cache-control', 'no-store');
    return reply.send({ servers });
  });

  // ── Register ─────────────────────────────────────────────────────────────
  app.post('/', async (request, reply) => {
    const actorUserId = requireAdmin(request);
    const body = registerServerSchema.parse(request.body);

    const clash = await app.db
      .select({ id: gameServer.id })
      .from(gameServer)
      .where(eq(gameServer.key, body.key))
      .limit(1);
    if (clash.length > 0) {
      throw new ConflictError('SERVER_KEY_TAKEN', `A game server with key "${body.key}" exists.`);
    }

    const created = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(gameServer)
        .values({
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          isActive: true,
        })
        .returning({ id: gameServer.id });

      if (!row) throw new ConflictError('SERVER_NOT_CREATED', 'The game server could not be created.');

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.GAME_SERVER_REGISTERED,
        actorUserId,
        entityType: 'game_server', entityId: row.id,
        after: { key: body.key, name: body.name },
        ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
        requestId: request.requestId,
      });

      return row;
    });

    return reply.status(201).send({ id: created.id, key: body.key });
  });

  // ── Activate / deactivate ────────────────────────────────────────────────
  //
  // Distinct from revoking a credential. Deactivating turns a server off and
  // keeps its keys; revoking deals with a compromise. Conflating them would mean
  // taking a server down for maintenance forced a credential rotation.
  app.post('/:gameServerId/active', async (request, reply) => {
    const actorUserId = requireAdmin(request);
    const { gameServerId } = serverIdParam.parse(request.params);
    const { isActive } = z.object({ isActive: z.boolean() }).strict().parse(request.body);

    const updated = await app.db
      .update(gameServer)
      .set({ isActive })
      .where(eq(gameServer.id, gameServerId))
      .returning({ id: gameServer.id, key: gameServer.key });

    if (updated.length === 0) throw new NotFoundError('game server');

    await writeAudit(app.db, {
      action: AUDIT_ACTIONS.GAME_SERVER_REGISTERED,
      actorUserId,
      entityType: 'game_server', entityId: gameServerId,
      after: { isActive },
      metadata: { event: isActive ? 'activated' : 'deactivated' },
      ip: request.ip, requestId: request.requestId,
    });

    return reply.send({ updated: true, isActive });
  });

  // ── Issue a credential ───────────────────────────────────────────────────
  app.post('/:gameServerId/credentials', async (request, reply) => {
    const actorUserId = requireAdmin(request);
    const { gameServerId } = serverIdParam.parse(request.params);
    const body = issueCredentialSchema.parse(request.body ?? {});
    const box = requireSecretBox();

    const target = await app.db
      .select({ id: gameServer.id, key: gameServer.key, name: gameServer.name })
      .from(gameServer)
      .where(eq(gameServer.id, gameServerId))
      .limit(1);
    const server = target[0];
    if (!server) throw new NotFoundError('game server');

    /**
     * TWO LIVE CREDENTIALS MAXIMUM, so keys rotate without downtime.
     *
     * The operator adds the new key, updates the resource config, confirms
     * traffic on the new `key_id`, then revokes the old one. A third would mean
     * an abandoned key sitting live indefinitely because nobody could remember
     * which of them was in use.
     */
    const live = await app.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM game_server_credential
       WHERE game_server_id = ${gameServerId} AND revoked_at IS NULL
    `);
    if ((live[0]?.n ?? 0) >= 2) {
      throw new ConflictError(
        'TOO_MANY_CREDENTIALS',
        'This server already has two live credentials. Revoke one before issuing another.',
      );
    }

    /**
     * 32 bytes of randomness, base64url.
     *
     * The key id is public and identifies WHICH secret to verify against; it is
     * deliberately guessable-looking and carries no authority. The secret is the
     * whole of the credential.
     */
    const keyId = `srv_${randomBytes(8).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');

    const expiresAt = body.expiresInDays == null
      ? null
      : new Date(Date.now() + body.expiresInDays * 86_400_000);

    await app.db.transaction(async (tx) => {
      await tx.insert(gameServerCredential).values({
        gameServerId,
        keyId,
        // Both are written. The hash is not the verification path — see
        // migration 0007 — but it answers "is this the secret you were given?"
        // for a support flow without decrypting anything.
        secretHash: await hashPassword(secret, app.config),
        secretEnc: box.seal(secret),
        createdBy: actorUserId,
        expiresAt,
      });

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.GAME_SERVER_CREDENTIAL_ISSUED,
        actorUserId,
        entityType: 'game_server', entityId: gameServerId,
        // The key id is safe to audit; the secret is not, and `redact()` would
        // catch it anyway if anyone ever tried.
        metadata: { keyId, serverKey: server.key, expiresAt: expiresAt?.toISOString() ?? null },
        ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
        requestId: request.requestId,
      });
    });

    const issued: GameServerCredentialIssued = {
      keyId,
      secret,
      expiresAt: expiresAt?.toISOString() ?? null,
    };

    // `no-store`, without exception. A credential in a shared cache is a
    // credential belonging to whoever reads that cache next.
    reply.header('cache-control', 'no-store');
    return reply.status(201).send(issued);
  });

  // ── Revoke ───────────────────────────────────────────────────────────────
  app.delete('/:gameServerId/credentials/:credentialId', async (request, reply) => {
    const actorUserId = requireAdmin(request);
    const { gameServerId, credentialId } = credentialParams.parse(request.params);

    const revoked = await app.db
      .update(gameServerCredential)
      .set({ revokedAt: new Date(), revokedBy: actorUserId })
      .where(eq(gameServerCredential.id, credentialId))
      .returning({ id: gameServerCredential.id, keyId: gameServerCredential.keyId });

    const row = revoked[0];
    if (!row) throw new NotFoundError('credential');

    await writeAudit(app.db, {
      action: AUDIT_ACTIONS.GAME_SERVER_CREDENTIAL_REVOKED,
      actorUserId,
      entityType: 'game_server', entityId: gameServerId,
      metadata: { keyId: row.keyId },
      ip: request.ip, requestId: request.requestId,
    });

    return reply.send({ revoked: true });
  });
}
