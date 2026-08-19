-- Adds `roles.permissions`: the right to change WHAT A ROLE CAN DO, split out
-- from `roles.edit`, which now covers only a role's name, description and level.
--
-- BACKWARDS COMPATIBILITY (engineering rule 48). Before this migration, editing
-- a role's permission set was gated by `roles.edit`. Introducing a new key
-- without back-filling it would silently strip that ability from every role that
-- already had it — a working deployment would come back from a deploy with its
-- command staff unable to do something they did yesterday. The second statement
-- grants the new key to exactly the roles that already held `roles.edit`, so
-- effective authority is unchanged at the moment of migration and the split only
-- affects grants made from here on.

INSERT INTO "permission" ("key", "category", "label", "scope", "risk")
VALUES ('roles.permissions', 'roles', 'Edit a role''s permissions', 'organization', 'high')
ON CONFLICT ("key") DO UPDATE
SET "category" = excluded."category",
    "label"    = excluded."label",
    "scope"    = excluded."scope",
    "risk"     = excluded."risk";
--> statement-breakpoint

INSERT INTO "role_permission" ("role_id", "permission_key")
SELECT rp."role_id", 'roles.permissions'
FROM "role_permission" rp
WHERE rp."permission_key" = 'roles.edit'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
