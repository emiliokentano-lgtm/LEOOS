-- ===========================================================================
-- LEOOS — Performance
-- ===========================================================================
--
-- Every index here was added because a MEASUREMENT demanded it, against a
-- database loaded to realistic roleplay scale (50 000 persons, 120 000
-- vehicles, 400 000 audit rows, 1 000 000 position samples — see
-- `scripts/load-fixture.mjs`). The before/after numbers are recorded beside each
-- one, and `scripts/bench-queries.mjs` reproduces them.
--
-- Nothing here changes behaviour. An index is the one optimisation that cannot
-- alter a result.

-- ── Global search was a sequential scan ────────────────────────────────────
--
-- An OR degrades to a sequential scan if ANY of its branches is unindexed: the
-- planner cannot build a bitmap it is missing a piece of. Both search paths OR
-- across several columns, and in each case one column had no trigram index — so
-- the indexes on the OTHER columns bought nothing at all, which is the trap.
--
-- Measured with `scripts/bench-queries.mjs` against the fixture, before and
-- after, with nothing else changed:
--
--   vehicle global search   135.3 ms →  1.6 ms   (display_name was the missing branch)
--   person register search   66.9 ms → 13.9 ms   (phone_number and address were
--                                                  missing; see person.read.ts
--                                                  for the second half of this)
--
-- `pg_trgm` handles a leading wildcard, which a btree cannot, and every one of
-- these predicates is `ILIKE '%term%'` — an operator typing a fragment of a name
-- or a plate read over the radio.

CREATE INDEX IF NOT EXISTS person_phone_trgm_idx
  ON "person" USING gin ("phone_number" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS person_address_trgm_idx
  ON "person" USING gin ("address" gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS vehicle_display_name_trgm_idx
  ON "vehicle" USING gin ("display_name" gin_trgm_ops);
--> statement-breakpoint

-- ── The audit log is filtered and sorted together ──────────────────────────
--
-- The admin screen filters by organization, action, actor and date, and ALWAYS
-- sorts by `(occurred_at DESC, id DESC)` because it pages by keyset. Separate
-- single-column indexes could satisfy the filter or the sort but never both:
-- the planner picked one, then discarded 50 000 rows walking it.
--
--   organization + action   1.26 ms → 0.60 ms on the fixture
--
-- The absolute figures there are small because the fixture's actions are spread
-- evenly over six organizations, which makes `(organization, action)` unusually
-- selective. The plan is the point: the composite turns a filter-then-sort into
-- a range scan that stops after 50 rows, and the gap grows with the share of the
-- log a single action accounts for — which in a real installation is dominated
-- by `person.viewed` and `auth.login`.
--
-- The sort direction is part of the index. `occurred_at DESC, id DESC` matches
-- the keyset exactly, so the page is a range scan that stops after 50 rows
-- instead of a sort over everything that matched.

CREATE INDEX IF NOT EXISTS audit_log_org_action_time_idx
  ON "audit_log" ("organization_id", "action", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS audit_log_action_time_idx
  ON "audit_log" ("action", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS audit_log_actor_time_idx
  ON "audit_log" ("actor_user_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint

-- ── …and the single-column ones they replace are dropped ───────────────────
--
-- Each is a strict PREFIX of a composite above, so it can answer nothing the
-- composite cannot. Keeping it would cost a write on every audited action —
-- and `audit_log` takes a row for every person lookup, which is the highest
-- insert rate in the system. Three fewer index writes per row is the point of
-- dropping them, not the disk.

DROP INDEX IF EXISTS "audit_log_org_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_action_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "audit_log_actor_idx";
--> statement-breakpoint

-- ── Position history retention ─────────────────────────────────────────────
--
-- The downsample is already 1/30th of the tick rate, but it is unbounded: one
-- row per unit per 30 s is ~1.4 M rows a month for 500 units, forever. This
-- index is what makes a retention sweep cheap enough to run — deleting by age
-- without it is a sequential scan of the whole table.

CREATE INDEX IF NOT EXISTS position_history_recorded_at_idx
  ON "position_history" ("recorded_at");
--> statement-breakpoint

COMMENT ON INDEX "position_history_recorded_at_idx" IS
  'Retention sweeps delete by age. Without this, pruning scans the whole table.';
