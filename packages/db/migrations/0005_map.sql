-- ===========================================================================
-- LEOOS — map subsystem
--
-- Two additions the map needs from the unit table, plus the index its snapshot
-- query runs on.
-- ===========================================================================

-- ── Covert units ───────────────────────────────────────────────────────────
--
-- Required by the visibility rule in docs/architecture/05-map.md §5. Covertness
-- is a property of the UNIT, not of the organization: an agency runs marked and
-- unmarked units simultaneously, and an undercover car must not surface on a
-- neighbouring dispatcher's map merely because its organization shares its fleet
-- on the public map.
--
-- Defaults to false so existing units keep exactly the visibility they had.

ALTER TABLE "unit" ADD COLUMN "is_covert" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── Reported speed ─────────────────────────────────────────────────────────
--
-- Sampled alongside position. The map uses it to decide how much to trust an
-- interpolated position between ticks: a stationary unit needs none, a unit at
-- 30 m/s covers 30 metres between samples.

ALTER TABLE "unit" ADD COLUMN "speed" double precision;
--> statement-breakpoint

-- ── Map snapshot index ─────────────────────────────────────────────────────
--
-- The snapshot asks for "every active unit in these organizations that has a
-- position, most recently updated first". Partial on `pos_x IS NOT NULL`
-- because a unit that has never reported one is never drawn and has no business
-- occupying index space.

CREATE INDEX "unit_map_position_idx" ON "unit" ("organization_id", "position_updated_at")
  WHERE status = 'active' AND pos_x IS NOT NULL;
--> statement-breakpoint

-- ── Marker lookup by position ──────────────────────────────────────────────
--
-- Markers are few, but they are read on every snapshot and expired ones must not
-- be returned. Indexing the live set keeps that a scan of what is actually live.

CREATE INDEX "map_marker_live_idx" ON "map_marker" ("organization_id", "created_at")
  WHERE deleted_at IS NULL;
