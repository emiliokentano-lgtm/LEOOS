-- Clears `is_system` from organization-scoped roles.
--
-- The organization seed marked every rank it created as a system role. A system
-- role is one the API refuses to rename, re-level, reorder or archive, so this
-- left all six seeded organizations unable to edit any of their own ranks — the
-- exact opposite of what the seed documents ("these are STARTING POINTS … every
-- organization can create, rename, reorder and delete its own roles").
--
-- The flag itself is kept and still enforced; it is simply not what an
-- organization's own rank list is. Global roles (organization_id IS NULL) are
-- left untouched: those genuinely are structural.

UPDATE "role"
SET "is_system" = false
WHERE "organization_id" IS NOT NULL
  AND "is_system" = true;
