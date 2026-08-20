import { relations, sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, primaryId, timestamps } from './_shared';
import { userAccount } from './identity';

/**
 * FiveM integration.
 *
 * The game server authenticates as a MACHINE and is trusted to report where
 * players are — never who they are in organizational terms (engineering rules
 * 19, 20).
 */

export const gameServer = pgTable(
  'game_server',
  {
    id: primaryId(),
    key: citext('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('game_server_key_key').on(t.key)],
);

/**
 * Ingest credentials. The secret is shown ONCE at creation and stored only as an
 * Argon2id hash — it never leaves the API again (engineering rule 16).
 *
 * Two live credentials per server are permitted so keys rotate without downtime.
 */
export const gameServerCredential = pgTable(
  'game_server_credential',
  {
    id: primaryId(),
    gameServerId: uuid('game_server_id')
      .notNull()
      .references(() => gameServer.id, { onDelete: 'cascade' }),
    /** Public, sent in a header, identifies which secret to verify against. */
    keyId: citext('key_id').notNull(),
    /**
     * Argon2id hash of the secret.
     *
     * NOT the verification path — see `secretEnc`. HMAC is symmetric, so
     * verifying a signature needs the key itself, and a one-way hash cannot
     * provide it. This is kept because it answers "is this the secret you were
     * given?" for a support flow without decrypting anything.
     */
    secretHash: text('secret_hash').notNull(),
    /**
     * AES-256-GCM ciphertext of the same secret, under a key held in the
     * environment and never in the database.
     *
     * Nullable only for credentials issued before the ingest scheme existed.
     * One of those cannot be verified at all, and the API says so and asks for a
     * reissue rather than failing with an inscrutable signature mismatch.
     * See migration 0007 for why this column has to exist.
     */
    secretEnc: text('secret_enc'),
    scopes: text('scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => userAccount.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('game_server_credential_key_id_key').on(t.keyId),
    index('game_server_credential_live_idx')
      .on(t.gameServerId)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const gameServerState = pgTable(
  'game_server_state',
  {
    gameServerId: uuid('game_server_id')
      .primaryKey()
      .references(() => gameServer.id, { onDelete: 'cascade' }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    playerCount: integer('player_count').notNull().default(0),
    resourceVersion: text('resource_version'),
    /** Monotonic replay protection — survives the nonce cache TTL window. */
    lastIngestSeq: bigint('last_ingest_seq', { mode: 'bigint' }).notNull().default(sql`0`),
    /**
     * Assigned at handshake, echoed on every later request.
     *
     * Lives beside the sequence counter because the two move together: a
     * restarted resource legitimately starts counting from zero, and without a
     * session boundary that is indistinguishable from a replay.
     */
    sessionId: text('session_id'),
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true }),
    anomalyCount: integer('anomaly_count').notNull().default(0),
    lastAnomalyAt: timestamp('last_anomaly_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const gameServerRelations = relations(gameServer, ({ many, one }) => ({
  credentials: many(gameServerCredential),
  state: one(gameServerState, {
    fields: [gameServer.id],
    references: [gameServerState.gameServerId],
  }),
}));
