-- Trigram indexes for the columns global search reads.
--
-- `ILIKE '%term%'` on an unindexed column is a sequential scan, and global
-- search issues one per category on every keystroke pause. With a GIN trigram
-- index Postgres can serve the leading-wildcard match from the index instead,
-- which is the difference between a search that is usable during an active
-- shift and one that is not (engineering rule 21).
--
-- Migration 0001 already covers person names, aliases, vehicle plates and
-- incident titles. These are the columns the cross-entity search added.

CREATE INDEX IF NOT EXISTS unit_callsign_trgm_idx
  ON "unit" USING gin ((callsign::text) gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS organization_name_trgm_idx
  ON "organization" USING gin (name gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS organization_key_trgm_idx
  ON "organization" USING gin ((key::text) gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS user_account_display_name_trgm_idx
  ON "user_account" USING gin (display_name gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS organization_member_callsign_trgm_idx
  ON "organization_member" USING gin ((callsign::text) gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS incident_number_trgm_idx
  ON "incident" USING gin ((number::text) gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS incident_location_trgm_idx
  ON "incident" USING gin (location_text gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS vehicle_model_trgm_idx
  ON "vehicle" USING gin (model gin_trgm_ops);
