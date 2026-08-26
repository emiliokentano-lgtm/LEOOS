import { sql } from 'drizzle-orm';
import type {
  ConversationDto, ConversationListDto, ConversationKind, MessageDto, MessagePageDto,
} from '@leoos/contracts';
import type { Database } from '@leoos/db';
import type { SearchScope } from '../search/search.scope.js';
import { resolveLinks, type RawLink } from './link-resolver.js';

/**
 * Reading conversations and messages.
 *
 * MEMBERSHIP IS THE FILTER, applied in SQL rather than after. A conversation
 * the caller is not in does not come back, so there is no code path where a
 * later `if` is the only thing standing between them and it.
 */

/** The caller's membership id in the organization they are acting in. */
export async function memberIdFor(
  db: Database,
  userId: string,
  organizationId: string | null,
): Promise<string | null> {
  if (organizationId === null) return null;
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM organization_member
     WHERE user_id = ${userId} AND organization_id = ${organizationId} AND status = 'active'
  `);
  return rows[0]?.id ?? null;
}

type ConversationRow = {
  id: string;
  kind: ConversationKind;
  title: string | null;
  last_message_at: string | null;
  created_by_member_id: string | null;
  unread: number;
  last_preview: string | null;
};

export async function listConversations(
  db: Database,
  memberId: string,
): Promise<ConversationListDto> {
  /**
   * Unread is counted against `last_read_at`, NOT stored.
   *
   * A stored counter has to be incremented on every send for every
   * participant, and drifts permanently the first time one of those writes is
   * lost. Counting is a subquery against an index; drift is a support ticket
   * nobody can reproduce.
   */
  const rows = await db.execute<ConversationRow>(sql`
    SELECT
      c.id, c.kind, c.title, c.last_message_at, c.created_by_member_id,
      (SELECT count(*)::int FROM message m
        WHERE m.conversation_id = c.id
          AND m.deleted_at IS NULL
          AND m.author_member_id <> ${memberId}
          AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)) AS unread,
      (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE left(m.body, 120) END
         FROM message m
        WHERE m.conversation_id = c.id
        ORDER BY m.id DESC LIMIT 1) AS last_preview
    FROM conversation c
    JOIN conversation_member cm
      ON cm.conversation_id = c.id AND cm.member_id = ${memberId} AND cm.left_at IS NULL
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT 100
  `);

  if (rows.length === 0) return { conversations: [], totalUnread: 0 };

  const ids = rows.map((r) => r.id);
  const participants = await db.execute<{
    conversation_id: string; member_id: string;
    display_name: string; callsign: string | null; active: boolean;
  }>(sql`
    SELECT cm.conversation_id, cm.member_id, u.display_name, m.callsign,
           (cm.left_at IS NULL) AS active
      FROM conversation_member cm
      JOIN organization_member m ON m.id = cm.member_id
      JOIN user_account u ON u.id = m.user_id
     WHERE cm.conversation_id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY cm.joined_at
  `);

  const byConversation = new Map<string, ConversationDto['participants']>();
  for (const p of participants) {
    const list = byConversation.get(p.conversation_id) ?? [];
    list.push({
      memberId: p.member_id,
      displayName: p.display_name,
      callsign: p.callsign,
      active: p.active,
    });
    byConversation.set(p.conversation_id, list);
  }

  const conversations = rows.map<ConversationDto>((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    participants: byConversation.get(row.id) ?? [],
    lastMessageAt: row.last_message_at === null
      ? null
      : new Date(row.last_message_at).toISOString(),
    lastMessagePreview: row.last_preview,
    unreadCount: Number(row.unread ?? 0),
    viewerCreated: row.created_by_member_id === memberId,
  }));

  return {
    conversations,
    totalUnread: conversations.reduce((sum, c) => sum + c.unreadCount, 0),
  };
}

type MessageRow = {
  id: string;
  conversation_id: string;
  author_member_id: string | null;
  author_name: string | null;
  author_callsign: string | null;
  body: string;
  deleted_at: string | null;
  created_at: string;
};

/**
 * One page of a thread, newest first.
 *
 * KEYSET, not offset. A conversation grows at the head while somebody reads it,
 * and an offset silently repeats and skips rows — the same reason the audit log
 * pages this way. Ids are uuidv7, so ordering by id is ordering by time, and a
 * keyset on a unique column cannot tie.
 */
export async function listMessages(
  db: Database,
  scope: SearchScope,
  conversationId: string,
  memberId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<MessagePageDto> {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const cursorFilter = options.cursor
    ? sql`AND m.id < ${options.cursor}`
    : sql``;

  const rows = await db.execute<MessageRow>(sql`
    SELECT m.id, m.conversation_id, m.author_member_id,
           u.display_name AS author_name, om.callsign AS author_callsign,
           m.body, m.deleted_at, m.created_at
      FROM message m
      LEFT JOIN organization_member om ON om.id = m.author_member_id
      LEFT JOIN user_account u ON u.id = om.user_id
     WHERE m.conversation_id = ${conversationId}
       ${cursorFilter}
     ORDER BY m.id DESC
     LIMIT ${limit + 1}
  `);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  /**
   * Links for the WHOLE PAGE in one go, then resolved per type.
   *
   * One query for the link rows and at most five to resolve them, regardless of
   * how many messages carry how many links.
   */
  const messageIds = page.map((m) => m.id);
  const linkRows = messageIds.length === 0 ? [] : await db.execute<{
    id: string; message_id: string; entity_type: RawLink['entityType'];
    entity_id: string; position: number;
  }>(sql`
    SELECT id, message_id, entity_type, entity_id, position
      FROM message_link
     WHERE message_id = ANY(${sql.param(messageIds)}::uuid[])
  `);

  const linksByMessage = await resolveLinks(
    db,
    scope,
    linkRows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      position: Number(r.position),
    })),
  );

  const messages = page.map<MessageDto>((row) => {
    const deleted = row.deleted_at !== null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      author: row.author_member_id === null ? null : {
        memberId: row.author_member_id,
        displayName: row.author_name ?? 'Unknown',
        callsign: row.author_callsign,
      },
      /**
       * A TOMBSTONE, not a gap.
       *
       * The body is withheld and the row still renders, so the thread's shape
       * does not silently change — a conversation that looks different
       * depending on who is reading is worse than one with a visible hole.
       */
      body: deleted ? null : row.body,
      deleted,
      // A deleted message's links go with it: they were context for text that
      // is no longer there.
      links: deleted ? [] : (linksByMessage.get(row.id) ?? []),
      createdAt: new Date(row.created_at).toISOString(),
      viewerIsAuthor: row.author_member_id === memberId,
    };
  });

  return { messages, nextCursor };
}

/** Unread across every conversation. One partial-index scan, for the nav badge. */
export async function totalUnread(db: Database, memberId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM message m
      JOIN conversation_member cm
        ON cm.conversation_id = m.conversation_id
       AND cm.member_id = ${memberId} AND cm.left_at IS NULL
     WHERE m.deleted_at IS NULL
       AND m.author_member_id <> ${memberId}
       AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
  `);
  return row?.n ?? 0;
}
