-- ═══════════════════════════════════════════════════════════════════════════
-- Chat: direct messages and groups, with records linked inline.
--
-- Two decisions are load-bearing and argued in docs/architecture/16-chat.md:
--
--   1. The socket carries an IDENTIFIER, never a message body. Chat does not
--      become an exception to the payload rule the rest of the system holds.
--   2. A link is a TYPED IDENTIFIER, resolved per viewer at read time. It is
--      never pasted text, and it never carries a name into a row that somebody
--      unentitled might read.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "conversation_kind" AS ENUM ('direct', 'group');
--> statement-breakpoint

CREATE TYPE "message_link_entity" AS ENUM (
  'person', 'vehicle', 'incident', 'unit', 'member'
);
--> statement-breakpoint

CREATE TABLE "conversation" (
  "id"              uuid PRIMARY KEY DEFAULT uuidv7(),
  "kind"            "conversation_kind" NOT NULL,

  -- A conversation BELONGS to an organization. Cross-agency chat would need a
  -- home for authorization, an audience rule spanning two permission sets, and
  -- a retention policy two agencies must agree on. Absent on purpose.
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,

  -- Null for a direct message: naming a two-person thread is furniture.
  "title"           text,

  "created_by_member_id" uuid REFERENCES "organization_member"("id") ON DELETE SET NULL,

  -- Denormalised so the conversation LIST does not have to touch messages.
  -- One indexed read per user instead of a join against the largest table here.
  "last_message_at" timestamptz,

  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "conversation_group_shape" CHECK (
    "kind" = 'group' OR "title" IS NULL
  )
);
--> statement-breakpoint

CREATE TABLE "conversation_member" (
  "conversation_id" uuid NOT NULL REFERENCES "conversation"("id") ON DELETE CASCADE,
  "member_id"       uuid NOT NULL REFERENCES "organization_member"("id") ON DELETE CASCADE,

  -- Where they have read up to. Null means they have read nothing.
  "last_read_at"    timestamptz,

  "joined_at"       timestamptz NOT NULL DEFAULT now(),

  -- Leaving is soft: the conversation's history should still show that they
  -- were in it when the things they can see were said.
  "left_at"         timestamptz,

  PRIMARY KEY ("conversation_id", "member_id")
);
--> statement-breakpoint

-- "My conversations, most recent first" — the list query, partial on still
-- being in them.
CREATE INDEX "conversation_member_active_idx"
  ON "conversation_member" ("member_id")
  WHERE "left_at" IS NULL;
--> statement-breakpoint

-- ── The one direct conversation between two people ─────────────────────────
--
-- Enforced by a functional unique index over the ORDERED pair, so A→B and B→A
-- resolve to the same row. Without it, two people opening a DM simultaneously
-- create two threads and each sees half the conversation — a race only the
-- database can settle.
CREATE TABLE "direct_conversation_key" (
  "conversation_id" uuid PRIMARY KEY REFERENCES "conversation"("id") ON DELETE CASCADE,
  "member_a"        uuid NOT NULL REFERENCES "organization_member"("id") ON DELETE CASCADE,
  "member_b"        uuid NOT NULL REFERENCES "organization_member"("id") ON DELETE CASCADE,

  -- Ordered on the way in, so the pair is canonical.
  CONSTRAINT "direct_pair_ordered" CHECK ("member_a" < "member_b")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "direct_conversation_pair_key"
  ON "direct_conversation_key" ("member_a", "member_b");
--> statement-breakpoint

CREATE TABLE "message" (
  "id"              uuid PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" uuid NOT NULL REFERENCES "conversation"("id") ON DELETE CASCADE,
  "author_member_id" uuid REFERENCES "organization_member"("id") ON DELETE SET NULL,

  "body"            text NOT NULL,

  -- Soft deletion. An operational conversation is a record: "who told me to go
  -- there" is asked afterwards, and a hard delete lets one participant remove
  -- the answer. The reader sees a tombstone, so the thread's shape does not
  -- silently change.
  "deleted_at"      timestamptz,

  "created_at"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "message_body_not_blank" CHECK (length(btrim("body")) > 0)
);
--> statement-breakpoint

-- ── Keyset paging ──────────────────────────────────────────────────────────
--
-- `(conversation_id, id DESC)` and NOT `(conversation_id, created_at DESC)`:
-- ids are uuidv7, so they sort by creation time already, and a keyset on a
-- unique column cannot repeat or skip a row when two messages share a
-- millisecond. The audit log pages this way for the same reason.
CREATE INDEX "message_conversation_idx" ON "message" ("conversation_id", "id" DESC);
--> statement-breakpoint

-- Retention sweeps delete by age; without this that is a full scan.
CREATE INDEX "message_created_idx" ON "message" ("created_at");
--> statement-breakpoint

-- ── Links ──────────────────────────────────────────────────────────────────
--
-- A TYPED IDENTIFIER, never pasted text. The label a viewer sees is resolved at
-- read time through the same redaction the person and vehicle read paths use,
-- so a link grants no access its reader did not already have.
--
-- `label_hint` is what the AUTHOR saw when they inserted it, kept only so a
-- message whose target was later deleted still reads sensibly. It is never
-- shown to a viewer who may not resolve the target — that would be the leak
-- this whole design exists to prevent.
CREATE TABLE "message_link" (
  "id"          uuid PRIMARY KEY DEFAULT uuidv7(),
  "message_id"  uuid NOT NULL REFERENCES "message"("id") ON DELETE CASCADE,
  "entity_type" "message_link_entity" NOT NULL,
  "entity_id"   uuid NOT NULL,
  "label_hint"  text,
  -- Character offset in the body, so the client can render the chip in place
  -- rather than appending links at the end.
  "position"    integer NOT NULL DEFAULT 0,

  CONSTRAINT "message_link_position_sane" CHECK ("position" >= 0)
);
--> statement-breakpoint

CREATE INDEX "message_link_message_idx" ON "message_link" ("message_id");
--> statement-breakpoint

-- Batched preview resolution: one query per entity TYPE per page, not one per
-- link. A page of twenty messages with six links each costs five queries.
CREATE INDEX "message_link_entity_idx" ON "message_link" ("entity_type", "entity_id");
--> statement-breakpoint

CREATE TRIGGER "conversation_set_updated_at"
  BEFORE UPDATE ON "conversation"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

COMMENT ON TABLE "message" IS
  'Chat messages. The socket carries only an id: see docs/architecture/16-chat.md 1.';
--> statement-breakpoint

COMMENT ON COLUMN "message_link"."label_hint" IS
  'What the AUTHOR saw. Never shown to a viewer who cannot resolve the target — that would be the leak this design prevents.';
