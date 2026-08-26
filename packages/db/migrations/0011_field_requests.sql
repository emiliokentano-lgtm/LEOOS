-- ═══════════════════════════════════════════════════════════════════════════
-- Field requests: asking for backup, and telling people where you are.
--
-- ONE TABLE FOR TWO FEATURES, because they are the same shape: somebody in the
-- field raises something, their colleagues are offered it, and each of them
-- either takes it or dismisses it. What differs is only what ACCEPTING does —
-- backup attaches you to a call, a location share places a marker — and that
-- is a branch in one service, not a second table.
--
-- Why not an incident: an incident is a call, with a number, a type and an
-- expectation that somebody closes it. Most backup requests are answered or
-- irrelevant within a minute, and turning each into a numbered call would fill
-- the queue with entries nobody closes and corrupt every dashboard count.
-- See docs/architecture/09-dispatch.md §6b.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "field_request_kind" AS ENUM ('backup', 'location_share');
--> statement-breakpoint

CREATE TYPE "field_request_status" AS ENUM (
  'pending', 'accepted', 'declined', 'cancelled', 'expired'
);
--> statement-breakpoint

CREATE TABLE "field_request" (
  "id"               uuid PRIMARY KEY DEFAULT uuidv7(),
  "kind"             "field_request_kind" NOT NULL,

  -- WHO ASKED, as a membership rather than a user. A person can belong to two
  -- organizations; the request belongs to the one they were acting in.
  "member_id"        uuid NOT NULL REFERENCES "organization_member"("id") ON DELETE CASCADE,
  "organization_id"  uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,

  -- The unit they were crewing, if any. Nullable because an officer can ask for
  -- help without being in a unit, and refusing that would make the feature
  -- unavailable in the situation it exists for.
  "unit_id"          uuid REFERENCES "unit"("id") ON DELETE SET NULL,

  -- The call they were on when they asked, captured AT RAISE TIME. Not read
  -- live from the unit later: a unit that has since moved to another call must
  -- not silently redirect people who accepted this request.
  "incident_id"      uuid REFERENCES "incident"("id") ON DELETE SET NULL,

  -- WHERE. A snapshot, never a track — see the doc. Nullable because a browser
  -- request from a desk has no meaningful position.
  "pos_x"            double precision,
  "pos_y"            double precision,

  "note"             text,
  "source"           text NOT NULL DEFAULT 'web',

  "status"           "field_request_status" NOT NULL DEFAULT 'pending',

  -- EXPIRY IS A COLUMN, NOT A JOB. Evaluated on read, so nothing runs when
  -- nobody is looking, and a request cannot be accepted past its deadline even
  -- if a client is holding a stale prompt.
  "expires_at"       timestamptz NOT NULL,

  "resolved_by"      uuid REFERENCES "organization_member"("id") ON DELETE SET NULL,
  "resolved_at"      timestamptz,

  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),

  -- A resolved request names who resolved it and when; a pending one names
  -- neither. Enforced here so a hand-edited row cannot claim an acceptance
  -- nobody made.
  CONSTRAINT "field_request_resolution_consistent" CHECK (
    ("status" = 'pending' AND "resolved_at" IS NULL)
    OR ("status" <> 'pending' AND "resolved_at" IS NOT NULL)
  ),

  -- A coordinate is a pair. Half of one puts a marker in the sea.
  CONSTRAINT "field_request_position_paired" CHECK (
    ("pos_x" IS NULL) = ("pos_y" IS NULL)
  ),

  -- Accepting is the only outcome that names a member other than the asker.
  CONSTRAINT "field_request_accepted_has_resolver" CHECK (
    "status" <> 'accepted' OR "resolved_by" IS NOT NULL
  )
);
--> statement-breakpoint

-- ── One live request per member per kind ───────────────────────────────────
--
-- A partial UNIQUE rather than a check in the service: holding a key down, or a
-- flaky network retrying, must not put four identical prompts on everybody's
-- screen. The database is the only place that can decide this under
-- concurrency, and the service reads the conflict as "you already have one
-- live" rather than as an error.
CREATE UNIQUE INDEX "field_request_one_live_per_member"
  ON "field_request" ("member_id", "kind")
  WHERE "status" = 'pending';
--> statement-breakpoint

-- The board query: everything live for an organization, newest first.
-- Partial, because a resolved request is history and the board never asks for
-- it — this index stays small no matter how many requests have been raised.
CREATE INDEX "field_request_live_idx"
  ON "field_request" ("organization_id", "created_at" DESC)
  WHERE "status" = 'pending';
--> statement-breakpoint

-- History for one member, for the profile drawer and for review.
CREATE INDEX "field_request_member_idx" ON "field_request" ("member_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX "field_request_incident_idx" ON "field_request" ("incident_id")
  WHERE "incident_id" IS NOT NULL;
--> statement-breakpoint

-- ── Who was offered it, and what they did ──────────────────────────────────
--
-- A DECLINE IS A FACT WORTH KEEPING. A backup request that eight people
-- dismissed is a different thing from one nobody saw, and it is the first
-- question a supervisor asks afterwards. Without this table a decline would be
-- indistinguishable from silence.
CREATE TABLE "field_request_response" (
  "field_request_id" uuid NOT NULL REFERENCES "field_request"("id") ON DELETE CASCADE,
  "member_id"        uuid NOT NULL REFERENCES "organization_member"("id") ON DELETE CASCADE,
  "response"         text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY ("field_request_id", "member_id"),

  CONSTRAINT "field_request_response_kind" CHECK ("response" IN ('accepted', 'declined'))
);
--> statement-breakpoint

CREATE INDEX "field_request_response_member_idx"
  ON "field_request_response" ("member_id", "created_at" DESC);
--> statement-breakpoint

CREATE TRIGGER "field_request_set_updated_at"
  BEFORE UPDATE ON "field_request"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

COMMENT ON TABLE "field_request" IS
  'Backup requests and location shares. One row, two outcomes on accept. Not an incident: see docs/architecture/09-dispatch.md 6b.';
--> statement-breakpoint

COMMENT ON COLUMN "field_request"."incident_id" IS
  'Captured at raise time, not read live from the unit — a unit that has since moved to another call must not redirect people who accepted this request.';
--> statement-breakpoint

COMMENT ON TABLE "field_request_response" IS
  'Who was offered a request and what they did. A decline is recorded because "eight people dismissed it" differs from "nobody saw it".';
