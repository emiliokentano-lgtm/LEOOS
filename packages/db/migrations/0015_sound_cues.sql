-- ─────────────────────────────────────────────────────────────────────────────
-- Per-cue sound preferences.
--
-- Sound already existed, driven entirely by notifications. A cue covers the
-- thing that has no notification: the confirmation that YOUR OWN action landed.
-- Setting your status does not notify you — you are not told about what you just
-- did — so there was nothing for a tone to hang on.
--
-- `muted_cues` is separate from `muted_categories` because they do different
-- things. Muting a CATEGORY takes away a notification's banner; silencing a CUE
-- takes away only its sound, and covers cues that are not notifications at all.
--
-- PANIC CANNOT BE SILENCED, and this is the fourth place that says so — after
-- the contracts, and the API stripping it both on the way in and on the way out.
-- A support script editing this row by hand is refused too.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "notification_preference"
  ADD COLUMN "muted_cues" text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_panic_cue_unmutable"
  CHECK (NOT ('panic' = ANY ("muted_cues")));
