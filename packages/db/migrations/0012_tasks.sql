-- ═══════════════════════════════════════════════════════════════════════════
-- Tasks: work somebody asked somebody else to do, with a deadline and a tick.
--
-- Assignee is a MEMBERSHIP, not a user. A person in two organizations does
-- their PD work as their PD self, and a task follows them out of an agency no
-- more than a callsign does.
--
-- See docs/architecture/10-dashboard.md §4b for why this is gated on a
-- permission rather than on rank.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Priority is a table, like every other catalogue here ───────────────────
--
-- Adding "urgent" is a row, not a branch in five components. `sort_order`
-- rather than the numeric key drives display, so a later insertion between two
-- existing levels does not require renumbering anything.
CREATE TABLE "task_priority" (
  "key"         text PRIMARY KEY,
  "label"       text NOT NULL,
  "short_label" text NOT NULL,
  "color_token" text NOT NULL,
  "sort_order"  integer NOT NULL DEFAULT 100,
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE "task" (
  "id"              uuid PRIMARY KEY DEFAULT uuidv7(),

  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,

  -- WHO IT IS FOR. Cascade: a membership row is never deleted in practice
  -- (terminations are soft), so this fires only if one genuinely goes.
  "assignee_member_id" uuid NOT NULL
    REFERENCES "organization_member"("id") ON DELETE CASCADE,

  -- WHO ASKED. Kept when they leave: who wanted this is part of the record.
  "created_by_member_id" uuid
    REFERENCES "organization_member"("id") ON DELETE SET NULL,

  "title"       text NOT NULL,
  "detail"      text,
  "priority_key" text NOT NULL REFERENCES "task_priority"("key") ON DELETE RESTRICT,

  -- Nullable: plenty of work has no deadline, and inventing one would make
  -- every such task either permanently overdue or permanently ignorable.
  "due_at"      timestamptz,

  "completed_at"        timestamptz,
  "completed_by_member_id" uuid
    REFERENCES "organization_member"("id") ON DELETE SET NULL,

  -- Soft deletion, per ADR-0008. A cancelled task is a fact about what was
  -- asked for and then was not needed.
  "cancelled_at"     timestamptz,
  "cancelled_reason" text,

  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),

  -- A completed task names who completed it and when, or neither.
  CONSTRAINT "task_completion_consistent" CHECK (
    ("completed_at" IS NULL) = ("completed_by_member_id" IS NULL)
  ),

  -- Completed and cancelled are different endings; a row cannot be both.
  CONSTRAINT "task_one_ending" CHECK (
    "completed_at" IS NULL OR "cancelled_at" IS NULL
  ),

  CONSTRAINT "task_title_not_blank" CHECK (length(btrim("title")) > 0)
);
--> statement-breakpoint

-- ── The dashboard query ────────────────────────────────────────────────────
--
-- "My open tasks, most urgent first" runs on every dashboard load. Partial on
-- open-ness, so the index stays proportional to outstanding work rather than to
-- everything ever asked for — a shift that closes its tasks keeps this small
-- forever.
CREATE INDEX "task_assignee_open_idx"
  ON "task" ("assignee_member_id", "due_at" NULLS LAST)
  WHERE "completed_at" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint

-- Supervisors reviewing what their organization is carrying.
CREATE INDEX "task_org_open_idx"
  ON "task" ("organization_id", "created_at" DESC)
  WHERE "completed_at" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint

-- "What did I ask for", including finished work.
CREATE INDEX "task_creator_idx" ON "task" ("created_by_member_id", "created_at" DESC);
--> statement-breakpoint

CREATE TRIGGER "task_set_updated_at"
  BEFORE UPDATE ON "task"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ── The catalogue ──────────────────────────────────────────────────────────
--
-- Seeded in the migration rather than in the seed script because the `task`
-- table has a foreign key to it: a database that has been migrated but not
-- seeded must still be able to accept a task.
INSERT INTO "task_priority" ("key", "label", "short_label", "color_token", "sort_order")
VALUES
  ('critical', 'Critical', 'CRIT', '--color-priority-1', 10),
  ('high',     'High',     'HIGH', '--color-priority-2', 20),
  ('normal',   'Normal',   'NORM', '--color-priority-3', 30),
  ('low',      'Low',      'LOW',  '--color-priority-4', 40)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

COMMENT ON TABLE "task" IS
  'Work assigned between members of one organization. Permission-gated, not rank-gated: see docs/architecture/10-dashboard.md 4b.';
--> statement-breakpoint

COMMENT ON COLUMN "task"."due_at" IS
  'Nullable. Inventing a deadline for work that has none would make every such task permanently overdue or permanently ignorable.';
