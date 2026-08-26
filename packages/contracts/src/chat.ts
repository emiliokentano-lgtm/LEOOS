/**
 * Chat: direct messages and groups, with records linked inline.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTE WHAT IS ABSENT FROM `MessageCreatedPayload`
 *
 * The body. Event payloads in LEOOS carry identifiers and never free text, and
 * chat EXTENDS that rule rather than being exempted from it — the socket says
 * "conversation X has message Y", and the client fetches the message over REST
 * where per-viewer authorization already lives.
 *
 * The full argument, including the two options weighed and why the body could
 * not have been rendered from a broadcast frame anyway, is in
 * docs/architecture/16-chat.md §1.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type ConversationKind = 'direct' | 'group';

export type MessageLinkEntity = 'person' | 'vehicle' | 'incident' | 'unit' | 'member';

export interface MessageLinkMeta {
  key: MessageLinkEntity;
  label: string;
  icon: string;
  /** Where a resolvable link navigates to, with `:id` substituted. */
  hrefTemplate: string | null;
}

/**
 * The catalogue, as data.
 *
 * Adding a linkable type is an entry here plus a resolver, not a branch in the
 * composer, the renderer and the search box.
 */
export const MESSAGE_LINK_ENTITIES: Record<MessageLinkEntity, MessageLinkMeta> = {
  person: { key: 'person', label: 'Person', icon: 'User', hrefTemplate: '/persons?id=:id' },
  vehicle: { key: 'vehicle', label: 'Vehicle', icon: 'Car', hrefTemplate: '/vehicles?id=:id' },
  incident: { key: 'incident', label: 'Call', icon: 'Siren', hrefTemplate: '/dispatch?id=:id' },
  unit: { key: 'unit', label: 'Unit', icon: 'Radio', hrefTemplate: '/dispatch' },
  member: { key: 'member', label: 'Member', icon: 'IdCard', hrefTemplate: '/personnel?id=:id' },
};

export function messageLinkMeta(kind: string): MessageLinkMeta {
  return MESSAGE_LINK_ENTITIES[kind as MessageLinkEntity] ?? {
    key: kind as MessageLinkEntity,
    label: kind,
    icon: 'CircleHelp',
    hrefTemplate: null,
  };
}

/**
 * A link, AS THIS VIEWER MAY SEE IT.
 *
 * `resolved: false` is not an error and not a missing record — it is "there is
 * something here you are not entitled to see". The chip still renders, because
 * removing it would change the shape of the conversation depending on who is
 * reading, and a sentence with a hole in it is more confusing than a sentence
 * with a redacted chip in it.
 *
 * An unresolved link carries NO usable identifier. A label and a type, and
 * clicking it does nothing.
 */
export type MessageLinkDto =
  | {
    id: string;
    entityType: MessageLinkEntity;
    position: number;
    resolved: true;
    entityId: string;
    label: string;
    href: string | null;
  }
  | {
    id: string;
    entityType: MessageLinkEntity;
    position: number;
    resolved: false;
    /** Why, in words the reader can act on. */
    reason: 'not-permitted' | 'not-found';
  };

export interface MessageAuthor {
  memberId: string;
  displayName: string;
  callsign: string | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  /** Null when the author's membership row is gone. */
  author: MessageAuthor | null;
  /**
   * The tombstone replaces this when a message is deleted — the reader sees
   * "message deleted", not a gap. Soft deletion keeps the thread's shape stable.
   */
  body: string | null;
  deleted: boolean;
  links: MessageLinkDto[];
  createdAt: string;
  /** True when the caller wrote it — the only person who may delete it. */
  viewerIsAuthor: boolean;
}

export interface ConversationParticipant {
  memberId: string;
  displayName: string;
  callsign: string | null;
  /** Left the conversation but was in it when things were said. */
  active: boolean;
}

export interface ConversationDto {
  id: string;
  kind: ConversationKind;
  /** Null for a direct thread; the other participant names it on screen. */
  title: string | null;
  participants: ConversationParticipant[];
  lastMessageAt: string | null;
  /** A preview, resolved for THIS viewer like everything else. */
  lastMessagePreview: string | null;
  unreadCount: number;
  /** True when the caller created it — the only person who may remove others. */
  viewerCreated: boolean;
}

export interface ConversationListDto {
  conversations: ConversationDto[];
  /** Across every conversation. Feeds the nav badge. */
  totalUnread: number;
}

export interface MessagePageDto {
  messages: MessageDto[];
  /**
   * Keyset cursor. A conversation grows at the head while somebody reads it,
   * and an offset silently repeats and skips rows.
   */
  nextCursor: string | null;
}

/** What a client may send. Everything else is derived. */
export interface SendMessageInput {
  body: string;
  links?: { entityType: MessageLinkEntity; entityId: string; position?: number }[];
}

/** How long a message is kept before the retention sweep purges it. */
export const MESSAGE_RETENTION_DAYS = 180;

/** Bounds. An unbounded string from a client is an allocation they choose. */
export const MESSAGE_MAX_LENGTH = 4000;
export const MESSAGE_MAX_LINKS = 20;
export const CONVERSATION_TITLE_MAX = 80;
export const CONVERSATION_MAX_PARTICIPANTS = 50;
