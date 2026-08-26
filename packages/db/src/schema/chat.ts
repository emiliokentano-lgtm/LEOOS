import { relations, sql } from 'drizzle-orm';
import {
  check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  conversationKindEnum, createdAt, messageLinkEntityEnum, primaryId, timestamps,
} from './_shared';
import { organization, organizationMember } from './organization';

/**
 * Chat.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO DECISIONS THAT SHAPE THIS FILE
 *
 * 1. THE SOCKET CARRIES AN IDENTIFIER, NEVER A BODY. Event payloads in LEOOS
 *    carry no free text, asserted by tests that search the whole serialised
 *    frame. Chat extends that rule rather than being exempted from it — a
 *    `message.created` event is three ids, and the client fetches the message
 *    over REST where per-viewer authorization already lives.
 *
 * 2. A LINK IS A TYPED IDENTIFIER. Two people reading the same message may
 *    correctly see different things, because a link resolves through the same
 *    redaction the person and vehicle read paths apply.
 *
 * Both argued in docs/architecture/16-chat.md.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const conversation = pgTable(
  'conversation',
  {
    id: primaryId(),
    kind: conversationKindEnum('kind').notNull(),

    /** Cross-agency chat is deliberately absent — see the document. */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),

    /** Null for a direct message: naming a two-person thread is furniture. */
    title: text('title'),

    createdByMemberId: uuid('created_by_member_id')
      .references(() => organizationMember.id, { onDelete: 'set null' }),

    /**
     * Denormalised so the conversation LIST never touches the message table.
     * One indexed read per user instead of a join against the largest table
     * in this context.
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    check('conversation_group_shape', sql`kind = 'group' OR title IS NULL`),
    index('conversation_org_idx').on(t.organizationId, t.lastMessageAt),
  ],
);

export const conversationMember = pgTable(
  'conversation_member',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),

    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Leaving is SOFT.
     *
     * The history should still show that they were in the conversation when the
     * things they can see were said — and a hard delete would make "who was in
     * this group" unanswerable after the fact.
     */
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.memberId] }),
    index('conversation_member_active_idx')
      .on(t.memberId)
      .where(sql`left_at IS NULL`),
  ],
);

/**
 * The canonical key for a two-person thread.
 *
 * A functional unique index over the ORDERED pair, so A→B and B→A resolve to
 * the same row. Without it, two people opening a direct message at the same
 * moment create two threads and each sees half the conversation — a race only
 * the database can settle.
 */
export const directConversationKey = pgTable(
  'direct_conversation_key',
  {
    conversationId: uuid('conversation_id')
      .primaryKey()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    memberA: uuid('member_a')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
    memberB: uuid('member_b')
      .notNull()
      .references(() => organizationMember.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('direct_conversation_pair_key').on(t.memberA, t.memberB),
    check('direct_pair_ordered', sql`member_a < member_b`),
  ],
);

export const message = pgTable(
  'message',
  {
    id: primaryId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    authorMemberId: uuid('author_member_id')
      .references(() => organizationMember.id, { onDelete: 'set null' }),

    body: text('body').notNull(),

    /** Soft. The reader sees a tombstone, so the thread's shape is stable. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (t) => [
    /**
     * Keyset paging on `(conversation_id, id DESC)`, not on `created_at`.
     *
     * Ids are uuidv7 so they already sort by creation time, and a keyset on a
     * UNIQUE column cannot repeat or skip a row when two messages share a
     * millisecond. The audit log pages this way for the same reason.
     */
    index('message_conversation_idx').on(t.conversationId, t.id),
    index('message_created_idx').on(t.createdAt),
    check('message_body_not_blank', sql`length(btrim(body)) > 0`),
  ],
);

export const messageLink = pgTable(
  'message_link',
  {
    id: primaryId(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    entityType: messageLinkEntityEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    /**
     * What the AUTHOR saw when they inserted it.
     *
     * Kept only so a message whose target was later deleted still reads
     * sensibly. NEVER shown to a viewer who may not resolve the target — that
     * would be exactly the leak this design exists to prevent.
     */
    labelHint: text('label_hint'),

    /** Character offset, so a chip renders in place rather than appended. */
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('message_link_message_idx').on(t.messageId),
    // Batched preview resolution: one query per entity TYPE per page.
    index('message_link_entity_idx').on(t.entityType, t.entityId),
    check('message_link_position_sane', sql`position >= 0`),
  ],
);

export const conversationRelations = relations(conversation, ({ one, many }) => ({
  organization: one(organization, {
    fields: [conversation.organizationId],
    references: [organization.id],
  }),
  members: many(conversationMember),
  messages: many(message),
}));

export const messageRelations = relations(message, ({ one, many }) => ({
  conversation: one(conversation, {
    fields: [message.conversationId],
    references: [conversation.id],
  }),
  author: one(organizationMember, {
    fields: [message.authorMemberId],
    references: [organizationMember.id],
  }),
  links: many(messageLink),
}));
