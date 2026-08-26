-- ─────────────────────────────────────────────────────────────────────────────
-- Map shapes: areas and routes drawn by operators.
--
-- A SEPARATE TABLE FROM map_marker, and that is not a parallel model. A marker
-- is a point; a shape is a sequence of them. Folding both into one table would
-- mean every marker row carrying a nullable geometry and every query filtering
-- on kind. What SHOULD be shared is shared and is not duplicated here: the
-- map.markers.manage permission, the organization visibility rule, expiry on
-- read, soft deletion, and the audit keys.
--
-- GEOMETRY IS TWO PARALLEL double precision[] COLUMNS, not PostGIS and not
-- jsonb. PostGIS answers spatial QUERIES — "which shapes contain this point",
-- "which routes cross this area" — and this product asks none of them: shapes
-- are drawn, listed and rendered, never intersected. Adding the extension to
-- store a coordinate list would be a dependency with no second use
-- (engineering rule 29). Arrays over jsonb because the DATABASE can then
-- enforce the point count, which an opaque blob cannot — see the CHECKs below.
--
-- ROUTE IS NOT NAVIGATION. This repository has no road graph. A "route" here is
-- a polyline a human drew, and nothing in the schema, the API or the UI calls
-- it a path, a directions or a navigation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "map_shape_kind" AS ENUM ('area', 'route');

CREATE TABLE "map_shape" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "kind" "map_shape_kind" NOT NULL,
  -- NULL means every organization sees it, exactly as for a marker.
  "organization_id" uuid REFERENCES "organization"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "description" text,
  "color" text,
  "points_x" double precision[] NOT NULL,
  "points_y" double precision[] NOT NULL,
  "created_by" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "deleted_at" timestamptz,
  "deleted_by" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,

  -- The two arrays are one geometry. A pair that disagrees in length would
  -- produce a point with an undefined coordinate somewhere downstream.
  CONSTRAINT "map_shape_points_paired" CHECK (
    array_length("points_x", 1) = array_length("points_y", 1)),

  -- An area needs three points to enclose anything; a route needs two to be a
  -- line. Enforced here as well as in the service, because a shape that cannot
  -- be drawn is a rendering bug on somebody's screen at the worst moment.
  CONSTRAINT "map_shape_min_points" CHECK (
    array_length("points_x", 1) >= CASE WHEN "kind" = 'area' THEN 3 ELSE 2 END),

  -- The ceiling exists in three places that cannot disagree: here, in
  -- MAP_SHAPE_MAX_POINTS, and in the request schema. An unbounded array is an
  -- allocation whose size the sender chooses.
  CONSTRAINT "map_shape_max_points" CHECK (array_length("points_x", 1) <= 500),

  CONSTRAINT "map_shape_label_not_blank" CHECK (length(btrim("label")) > 0)
);

-- The live set is what every snapshot reads; the deleted ones are read only by
-- the audit trail, so the index covers exactly the live ones.
CREATE INDEX "map_shape_live_idx" ON "map_shape" ("organization_id")
  WHERE "deleted_at" IS NULL;

CREATE TRIGGER "map_shape_set_updated_at" BEFORE UPDATE ON "map_shape"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
