-- ===========================================================================
-- LEOOS — FiveM ingest
-- ===========================================================================

-- ── The ingest secret has to be RECOVERABLE, not hashed ────────────────────
--
-- ARCHITECTURAL CONFLICT, resolved here rather than worked around.
--
-- `docs/architecture/04-fivem-integration.md` §3 asks for two things that cannot
-- both be true:
--
--   (a) requests are signed with HMAC-SHA256 over a canonical string;
--   (b) the secret is stored only as an Argon2id hash.
--
-- HMAC is symmetric. To recompute the signature of an incoming request the API
-- must hold the same key the resource used. An Argon2id hash is one-way by
-- design, so (b) makes (a) impossible. Verifying a hash instead would mean the
-- resource sending the secret itself on every request — which loses the body
-- binding that makes tampering with one coordinate a signature failure, and puts
-- a long-lived credential in every proxy log between the game host and the API.
--
-- Resolution: the secret is ENCRYPTED at rest (AES-256-GCM, key from
-- LEOOS_FIVEM_SECRET_KEY, held in the environment and never in the database),
-- following the `*_enc` convention this schema already uses for
-- `user_account.totp_secret_enc`. The secret still leaves the API exactly once,
-- at creation, and is never returned again.
--
-- `secret_hash` is KEPT and still populated. It is no longer the verification
-- path, but it answers "is this the secret you were given?" for a support flow
-- without decrypting anything, and keeping it avoids loosening a NOT NULL
-- constraint on a security column.

ALTER TABLE "game_server_credential"
  ADD COLUMN IF NOT EXISTS "secret_enc" text;
--> statement-breakpoint

COMMENT ON COLUMN "game_server_credential"."secret_enc" IS
  'AES-256-GCM ciphertext of the ingest secret. Required for HMAC verification; '
  'a credential without it cannot be verified and must be reissued.';
--> statement-breakpoint

COMMENT ON COLUMN "game_server_credential"."secret_hash" IS
  'Argon2id hash of the same secret. Not the verification path — see secret_enc.';
--> statement-breakpoint

-- ── Session identity ───────────────────────────────────────────────────────
--
-- Assigned at handshake and echoed on every subsequent request, so a resource
-- restart is visible as a new session rather than as a gap in the numbers. The
-- sequence counter resets with it, which is why the two live together: a
-- restarted resource legitimately starts counting from zero again, and without a
-- session boundary that would be indistinguishable from a replay.

ALTER TABLE "game_server_state"
  ADD COLUMN IF NOT EXISTS "session_id" text;
--> statement-breakpoint

ALTER TABLE "game_server_state"
  ADD COLUMN IF NOT EXISTS "session_started_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "game_server_state"
  ADD COLUMN IF NOT EXISTS "last_anomaly_at" timestamptz;
--> statement-breakpoint

-- ── Which server a unit's position came from ───────────────────────────────
--
-- Needed for offline detection: when a game server stops sending heartbeats,
-- every unit IT was reporting must go offline — and only those. A deployment
-- with two game servers must not have one going quiet blank the other's units.

ALTER TABLE "unit"
  ADD COLUMN IF NOT EXISTS "pos_game_server_id" uuid
  REFERENCES "game_server"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "unit_pos_game_server_idx"
  ON "unit" ("pos_game_server_id")
  WHERE "pos_game_server_id" IS NOT NULL;
