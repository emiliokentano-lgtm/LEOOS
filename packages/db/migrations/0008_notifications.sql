-- ===========================================================================
-- LEOOS — Notification preferences
-- ===========================================================================
--
-- The `notification` table itself has existed since 0000_init; this migration
-- adds the one thing the notification system needs that was missing, and two
-- indexes the read paths turned out to want.

-- ── Preferences ────────────────────────────────────────────────────────────
--
-- One row per user, created on first write. A MISSING ROW IS THE DEFAULT, not an
-- error: the defaults live in `@leoos/contracts`
-- (`DEFAULT_NOTIFICATION_PREFERENCES`) so the browser and the API read the same
-- values, and seeding a row per account would put them in two places and
-- guarantee eventual drift.
--
-- The column defaults below mirror those contract defaults so that a row created
-- by anything other than the API — a support fix, a restore — still comes out
-- with sound OFF. An application that starts making noise on first use is one
-- people mute at the operating-system level, and then the panic tone is muted
-- too.

CREATE TABLE IF NOT EXISTS "notification_preference" (
  -- The user IS the key. Two preference rows for one person is not a state this
  -- table should be able to represent, and it makes a concurrent first write
  -- from two tabs an upsert rather than a duplicate.
  "user_id"             uuid PRIMARY KEY REFERENCES "user_account"("id") ON DELETE CASCADE,

  "sound_enabled"       boolean NOT NULL DEFAULT false,
  "sound_critical_only" boolean NOT NULL DEFAULT true,
  "sound_volume"        integer NOT NULL DEFAULT 60,
  "critical_toasts"     boolean NOT NULL DEFAULT true,

  -- Categories the operator has muted. `panic` is refused by the API on the way
  -- in (UNMUTABLE_CATEGORIES); the CHECK below makes that structural rather than
  -- a rule somebody has to remember, because a preference row is exactly the
  -- kind of thing a support script edits directly.
  "muted_categories"    text[] NOT NULL DEFAULT '{}'::text[],

  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "notification_preference_volume_range"
    CHECK ("sound_volume" >= 0 AND "sound_volume" <= 100),
  CONSTRAINT "notification_preference_panic_unmutable"
    CHECK (NOT ('panic' = ANY ("muted_categories")))
);
--> statement-breakpoint

COMMENT ON TABLE "notification_preference" IS
  'Per-operator notification settings. A missing row means the contract defaults.';
--> statement-breakpoint

COMMENT ON CONSTRAINT "notification_preference_panic_unmutable" ON "notification_preference" IS
  'A panic alert cannot be muted. Enforced here as well as in the API.';
--> statement-breakpoint

-- ── Read paths ─────────────────────────────────────────────────────────────
--
-- The centre pages by (created_at, id) DESC — a keyset, not an offset, because
-- notifications arrive at the head while the list is open and an offset would
-- repeat and skip rows. The existing `notification_user_time_idx` covers
-- `(user_id, created_at)`; adding `id` makes the tiebreak part of the index
-- rather than a sort on top of it.

CREATE INDEX IF NOT EXISTS "notification_user_keyset_idx"
  ON "notification" ("user_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint

-- The category filter expands to a set of type keys (see notification.service),
-- so the filtered page is `user_id = ? AND type IN (…)` ordered by time.
CREATE INDEX IF NOT EXISTS "notification_user_type_idx"
  ON "notification" ("user_id", "type", "created_at" DESC);
--> statement-breakpoint

-- Retention deletes READ notifications past the window. Unread ones are never
-- deleted by age: somebody back from two weeks off still needs to see that they
-- were assigned to something.
CREATE INDEX IF NOT EXISTS "notification_read_at_idx"
  ON "notification" ("read_at")
  WHERE "read_at" IS NOT NULL;
