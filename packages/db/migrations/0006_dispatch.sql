-- ===========================================================================
-- LEOOS — dispatch subsystem
-- ===========================================================================

-- ── Incident lifecycle: `contained` ────────────────────────────────────────
--
-- The one genuinely missing state. "Contained" means the situation is under
-- control but the call is not finished — distinct from `on_hold` (parked,
-- waiting on something) and from `closed` (over).
--
-- The rest of the requested lifecycle already existed under different names and
-- is presented as such rather than migrated: `pending` reads as "Open",
-- `on_scene` reads as "Active". Renaming stored enum values to match display
-- labels would rewrite data and break the indexes and CHECKs that name them,
-- in exchange for nothing.
--
-- `incident_open_queue_idx` is `status NOT IN ('closed','cancelled')`, so a
-- contained incident is treated as open by the queue with no index change.

ALTER TYPE "incident_status" ADD VALUE IF NOT EXISTS 'contained' AFTER 'on_scene';
--> statement-breakpoint

-- ── Dispatch queue read paths ──────────────────────────────────────────────
--
-- The board asks "every open call for these organizations, worst first". The
-- existing `incident_open_queue_idx` orders by priority but is not scoped by
-- organization, so a multi-organization deployment scans calls it will discard.

CREATE INDEX "incident_org_open_idx" ON "incident" ("organization_id", "priority", "created_at")
  WHERE deleted_at IS NULL AND status NOT IN ('closed','cancelled');
--> statement-breakpoint

-- ── Panic ──────────────────────────────────────────────────────────────────
--
-- Panic is a server-side operational state, so the dispatch board reads live
-- panics on every poll. Indexed for the query it actually runs: unresolved
-- panics, newest first.

CREATE INDEX "panic_event_live_idx" ON "panic_event" ("organization_id", "created_at" DESC)
  WHERE resolved_at IS NULL;
--> statement-breakpoint

-- ── Unit membership lookup ─────────────────────────────────────────────────
--
-- Self-assignment asks "is this member already in a unit" on every join, and the
-- board resolves crew for every unit on screen. The unique index that enforces
-- one-active-unit-per-member serves the first; this serves the second.

CREATE INDEX "unit_member_active_member_idx" ON "unit_member" ("member_id")
  WHERE left_at IS NULL;
