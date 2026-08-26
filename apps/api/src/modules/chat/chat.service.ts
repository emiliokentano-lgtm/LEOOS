import { sql } from 'drizzle-orm';
import {
  CONVERSATION_MAX_PARTICIPANTS, MESSAGE_MAX_LENGTH, MESSAGE_MAX_LINKS,
  type ConversationKind, type MessageLinkEntity,
} from '@leoos/contracts';
import { AUDIT_ACTIONS, type Database } from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from '../dispatch/dispatch.scope.js';
import type { DispatchOutcome } from '../dispatch/dispatch.events.js';

/**
 * Conversations and messages.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO PERMISSION GATES ORDINARY CONVERSATION
 *
 * Talking to a colleague is not a privilege an organization grants, and gating
 * it would produce members who can read a dispatch board and cannot ask a
 * question about it.
 *
 * What IS gated is everything a message can reach. A link resolves per viewer
 * through the same redaction the record read paths apply, so a conversation
 * grants no access its participants did not already have. That is where the
 * authorization lives — see `chat.read.ts` and docs/architecture/16-chat.md §2.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * MEMBERSHIP IS CHECKED ON EVERY READ AND EVERY WRITE, never cached — the same
 * rule the map and dispatch topics follow. Somebody removed from a group stops
 * being able to read it on their next request, with no revocation machinery.
 */

type LockedMembership = {
  id: string;
  organization_id: string;
  status: string;
};

async function lockOwnMembership(
  tx: Database,
  scope: DispatchScope,
): Promise<LockedMembership | null> {
  if (scope.organizationId === null) return null;
  const rows = await tx.execute<LockedMembership>(sql`
    SELECT id, organization_id, status FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
     FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * Is this member currently in this conversation?
 *
 * The one question every read and every write asks first. Returns the
 * conversation's organization too, so a caller never has to make a second trip
 * for the fact that decides scope.
 */
export async function conversationMembership(
  tx: Database,
  conversationId: string,
  memberId: string,
): Promise<{ organizationId: string; kind: ConversationKind } | null> {
  const rows = await tx.execute<{ organization_id: string; kind: ConversationKind }>(sql`
    SELECT c.organization_id, c.kind
      FROM conversation c
      JOIN conversation_member cm
        ON cm.conversation_id = c.id AND cm.member_id = ${memberId} AND cm.left_at IS NULL
     WHERE c.id = ${conversationId}
  `);
  return rows[0]
    ? { organizationId: rows[0].organization_id, kind: rows[0].kind }
    : null;
}

/**
 * Opens the direct thread between the caller and somebody else.
 *
 * IDEMPOTENT BY DATABASE CONSTRAINT, not by a read-then-write. Two people
 * opening a DM at the same moment would otherwise create two threads and each
 * see half the conversation — a race only a unique index can settle. The
 * ordered pair in `direct_conversation_key` is that index.
 */
export async function openDirectConversation(
  db: Database,
  scope: DispatchScope,
  otherMemberId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string; created: boolean }>> {
  return db.transaction(async (tx) => {
    const me = await lockOwnMembership(tx, scope);
    if (me === null) throw new ForbiddenError('You are not a member of this organization.');
    if (me.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot start a conversation.');
    }
    if (otherMemberId === me.id) {
      throw new ConflictError('CANNOT_MESSAGE_SELF', 'You cannot message yourself.');
    }

    /**
     * The other person must be an ACTIVE member of the SAME organization.
     *
     * Read here rather than trusted. A member id from another agency resolves
     * to nothing and answers NOT FOUND — a 403 would confirm they exist
     * somewhere, which is itself information about another organization.
     */
    const other = await tx.execute<{ id: string }>(sql`
      SELECT id FROM organization_member
       WHERE id = ${otherMemberId} AND organization_id = ${me.organization_id}
         AND status = 'active'
    `);
    if (!other[0]) throw new NotFoundError('That person is not in your organization.');

    // Canonical ordering, so A→B and B→A hit the same unique key.
    const [a, b] = me.id < otherMemberId ? [me.id, otherMemberId] : [otherMemberId, me.id];

    const existing = await tx.execute<{ conversation_id: string }>(sql`
      SELECT conversation_id FROM direct_conversation_key
       WHERE member_a = ${a} AND member_b = ${b}
    `);
    if (existing[0]) {
      /**
       * Re-joining a thread they had left.
       *
       * Leaving a direct conversation is soft, so opening it again puts them
       * back rather than creating a second one. The history is intact and they
       * see it — which is right: they were a participant when it was said.
       */
      await tx.execute(sql`
        UPDATE conversation_member SET left_at = NULL
         WHERE conversation_id = ${existing[0].conversation_id} AND member_id = ${me.id}
      `);
      return { result: { id: existing[0].conversation_id, created: false }, events: [] };
    }

    const [conv] = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversation (kind, organization_id, created_by_member_id)
      VALUES ('direct', ${me.organization_id}, ${me.id})
      RETURNING id
    `);
    if (!conv) throw new ConflictError('NOT_CREATED', 'The conversation could not be opened.');

    await tx.execute(sql`
      INSERT INTO direct_conversation_key (conversation_id, member_a, member_b)
      VALUES (${conv.id}, ${a}, ${b})
    `);
    await tx.execute(sql`
      INSERT INTO conversation_member (conversation_id, member_id)
      VALUES (${conv.id}, ${a}), (${conv.id}, ${b})
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.CONVERSATION_CREATED,
      actorUserId: scope.actorUserId,
      organizationId: me.organization_id,
      entityType: 'conversation',
      entityId: conv.id,
      metadata: { kind: 'direct' },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { result: { id: conv.id, created: true }, events: [] };
  });
}

export async function createGroupConversation(
  db: Database,
  scope: DispatchScope,
  input: { title: string; memberIds: string[] },
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string }>> {
  return db.transaction(async (tx) => {
    const me = await lockOwnMembership(tx, scope);
    if (me === null) throw new ForbiddenError('You are not a member of this organization.');
    if (me.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot start a conversation.');
    }

    // The creator is always in it. Deduplicated, so naming yourself is harmless.
    const wanted = [...new Set([me.id, ...input.memberIds])];
    if (wanted.length > CONVERSATION_MAX_PARTICIPANTS) {
      throw new ValidationError([{
        path: 'memberIds',
        message: `A group may have at most ${CONVERSATION_MAX_PARTICIPANTS} participants.`,
      }]);
    }

    /**
     * Every participant is verified against THIS organization.
     *
     * The filter is the authorization: a member id from elsewhere simply does
     * not come back, and the count check below turns that into a refusal rather
     * than a silently smaller group.
     */
    const valid = await tx.execute<{ id: string }>(sql`
      SELECT id FROM organization_member
       WHERE id = ANY(${sql.param(wanted)}::uuid[])
         AND organization_id = ${me.organization_id}
         AND status = 'active'
    `);
    if (valid.length !== wanted.length) {
      throw new NotFoundError('One of those people is not in your organization.');
    }

    const [conv] = await tx.execute<{ id: string }>(sql`
      INSERT INTO conversation (kind, organization_id, title, created_by_member_id)
      VALUES ('group', ${me.organization_id}, ${input.title}, ${me.id})
      RETURNING id
    `);
    if (!conv) throw new ConflictError('NOT_CREATED', 'The conversation could not be created.');

    for (const row of valid) {
      await tx.execute(sql`
        INSERT INTO conversation_member (conversation_id, member_id)
        VALUES (${conv.id}, ${row.id})
      `);
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.CONVERSATION_CREATED,
      actorUserId: scope.actorUserId,
      organizationId: me.organization_id,
      entityType: 'conversation',
      entityId: conv.id,
      metadata: { kind: 'group', participants: valid.length },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { result: { id: conv.id }, events: [] };
  });
}

export interface SendMessageInput {
  body: string;
  links: { entityType: MessageLinkEntity; entityId: string; position: number }[];
}

/**
 * Posting.
 *
 * Returns the recipients so the ROUTE can publish to each participant's own
 * topic. The event carries three ids and no body — see the contract.
 */
export async function sendMessage(
  db: Database,
  scope: DispatchScope,
  conversationId: string,
  input: SendMessageInput,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string; recipientUserIds: string[] }>> {
  if (input.body.trim().length === 0) {
    throw new ValidationError([{ path: 'body', message: 'A message cannot be empty.' }]);
  }
  if (input.body.length > MESSAGE_MAX_LENGTH) {
    throw new ValidationError([{ path: 'body', message: 'That message is too long.' }]);
  }
  if (input.links.length > MESSAGE_MAX_LINKS) {
    throw new ValidationError([{ path: 'links', message: 'Too many links.' }]);
  }

  return db.transaction(async (tx) => {
    const me = await lockOwnMembership(tx, scope);
    if (me === null) throw new ForbiddenError('You are not a member of this organization.');

    const membership = await conversationMembership(tx, conversationId, me.id);
    // Not in it — or it does not exist. The same answer either way: the
    // existence of a conversation is itself information.
    if (membership === null) throw new NotFoundError('That conversation is not available.');

    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO message (conversation_id, author_member_id, body)
      VALUES (${conversationId}, ${me.id}, ${input.body})
      RETURNING id
    `);
    if (!row) throw new ConflictError('NOT_SENT', 'The message could not be sent.');

    /**
     * Links are stored as TYPED IDENTIFIERS with no label.
     *
     * `label_hint` is deliberately left null on the way in: whatever the author
     * saw is their view of the record, and storing it would put a name into a
     * row that a later reader might not be entitled to. The label every reader
     * sees is resolved at READ time, for them.
     */
    for (const link of input.links) {
      await tx.execute(sql`
        INSERT INTO message_link (message_id, entity_type, entity_id, position)
        VALUES (${row.id}, ${link.entityType}::message_link_entity,
                ${link.entityId}, ${link.position})
      `);
    }

    // Denormalised, so the conversation list never touches this table.
    await tx.execute(sql`
      UPDATE conversation SET last_message_at = now() WHERE id = ${conversationId}
    `);

    /**
     * The audience: everybody still in the conversation, except the author.
     *
     * Read here, inside the transaction, so somebody who left a moment ago is
     * already excluded. Not audited — an audit row per message would double the
     * write volume of the busiest table here and bury the administrative events
     * the log exists to surface, to record something the message already is.
     */
    const recipients = await tx.execute<{ user_id: string }>(sql`
      SELECT m.user_id
        FROM conversation_member cm
        JOIN organization_member m ON m.id = cm.member_id AND m.status = 'active'
       WHERE cm.conversation_id = ${conversationId}
         AND cm.left_at IS NULL
         AND cm.member_id <> ${me.id}
    `);

    return {
      result: { id: row.id, recipientUserIds: recipients.map((r) => r.user_id) },
      events: [],
    };
  });
}

/**
 * Deleting your own message.
 *
 * SOFT, and only your own. An operational conversation is a record — "who told
 * me to go there" is asked afterwards — so a hard delete would let one
 * participant remove the answer. The reader sees a tombstone rather than a gap,
 * because a thread whose shape changes depending on who is reading is worse
 * than one with a visible hole.
 */
export async function deleteMessage(
  db: Database,
  scope: DispatchScope,
  messageId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string }>> {
  return db.transaction(async (tx) => {
    const me = await lockOwnMembership(tx, scope);
    if (me === null) throw new ForbiddenError('You are not a member of this organization.');

    const rows = await tx.execute<{
      id: string; conversation_id: string; author_member_id: string | null;
    }>(sql`
      SELECT id, conversation_id, author_member_id FROM message
       WHERE id = ${messageId} AND deleted_at IS NULL
       FOR UPDATE
    `);
    const found = rows[0];
    if (!found) throw new NotFoundError('That message is not available.');

    // In the conversation at all? Asked before anything else is revealed.
    const membership = await conversationMembership(tx, found.conversation_id, me.id);
    if (membership === null) throw new NotFoundError('That message is not available.');

    if (found.author_member_id !== me.id) {
      throw new ForbiddenError('You can only delete your own messages.');
    }

    await tx.execute(sql`UPDATE message SET deleted_at = now() WHERE id = ${messageId}`);

    /**
     * Audited, unlike sending.
     *
     * Deleting is the only thing here that destroys information, which makes it
     * the only thing worth a row of its own.
     */
    await writeAudit(tx, {
      action: AUDIT_ACTIONS.MESSAGE_DELETED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organizationId,
      entityType: 'message',
      entityId: messageId,
      metadata: { conversationId: found.conversation_id },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { result: { id: messageId }, events: [] };
  });
}

/** Marks a conversation read up to now. Idempotent and unaudited. */
export async function markConversationRead(
  db: Database,
  scope: DispatchScope,
  conversationId: string,
): Promise<void> {
  const me = await db.execute<{ id: string }>(sql`
    SELECT id FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
  `);
  const memberId = me[0]?.id;
  if (!memberId) throw new ForbiddenError('You are not a member of this organization.');

  const membership = await conversationMembership(db, conversationId, memberId);
  if (membership === null) throw new NotFoundError('That conversation is not available.');

  await db.execute(sql`
    UPDATE conversation_member SET last_read_at = now()
     WHERE conversation_id = ${conversationId} AND member_id = ${memberId}
  `);
}

/** Adding somebody to a group. Any member may; the organization must match. */
export async function addParticipant(
  db: Database,
  scope: DispatchScope,
  conversationId: string,
  memberId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ added: boolean }>> {
  return db.transaction(async (tx) => {
    const me = await lockOwnMembership(tx, scope);
    if (me === null) throw new ForbiddenError('You are not a member of this organization.');

    const membership = await conversationMembership(tx, conversationId, me.id);
    if (membership === null) throw new NotFoundError('That conversation is not available.');
    if (membership.kind !== 'group') {
      // A direct thread is between exactly two people, by definition. Adding a
      // third would silently turn it into something else.
      throw new ConflictError('NOT_A_GROUP', 'You cannot add people to a direct message.');
    }

    const target = await tx.execute<{ id: string }>(sql`
      SELECT id FROM organization_member
       WHERE id = ${memberId} AND organization_id = ${membership.organizationId}
         AND status = 'active'
    `);
    if (!target[0]) throw new NotFoundError('That person is not in your organization.');

    const count = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM conversation_member
       WHERE conversation_id = ${conversationId} AND left_at IS NULL
    `);
    if ((count[0]?.n ?? 0) >= CONVERSATION_MAX_PARTICIPANTS) {
      throw new ConflictError('GROUP_FULL', 'That group is full.');
    }

    await tx.execute(sql`
      INSERT INTO conversation_member (conversation_id, member_id)
      VALUES (${conversationId}, ${memberId})
      ON CONFLICT (conversation_id, member_id) DO UPDATE SET left_at = NULL
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.CONVERSATION_PARTICIPANT_ADDED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organizationId,
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { memberId },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { result: { added: true }, events: [] };
  });
}

/**
 * Leaving, or removing somebody.
 *
 * Leaving is always allowed. Removing somebody ELSE is the creator's alone —
 * otherwise any participant could clear a group of everybody who disagreed with
 * them, which is the one social failure mode worth designing against.
 */
export async function removeParticipant(
  db: Database,
  scope: DispatchScope,
  conversationId: string,
  memberId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ removed: boolean }>> {
  return db.transaction(async (tx) => {
    const me = await lockOwnMembership(tx, scope);
    if (me === null) throw new ForbiddenError('You are not a member of this organization.');

    const membership = await conversationMembership(tx, conversationId, me.id);
    if (membership === null) throw new NotFoundError('That conversation is not available.');

    if (memberId !== me.id) {
      const owner = await tx.execute<{ created_by_member_id: string | null }>(sql`
        SELECT created_by_member_id FROM conversation WHERE id = ${conversationId}
      `);
      if (owner[0]?.created_by_member_id !== me.id) {
        throw new ForbiddenError('Only the person who created a group can remove others.');
      }
    }

    // Soft: the history should still show they were in it when things were said.
    await tx.execute(sql`
      UPDATE conversation_member SET left_at = now()
       WHERE conversation_id = ${conversationId} AND member_id = ${memberId}
         AND left_at IS NULL
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.CONVERSATION_PARTICIPANT_REMOVED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organizationId,
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { memberId, self: memberId === me.id },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return { result: { removed: true }, events: [] };
  });
}
