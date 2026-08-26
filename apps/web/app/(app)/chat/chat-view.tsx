'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Ban, Send, Trash2, Users } from 'lucide-react';
import {
  messageLinkMeta,
  type ConversationDto, type ConversationListDto,
  type MessageDto, type MessageLinkDto, type MessagePageDto,
} from '@leoos/contracts';
import {
  Alert, Badge, Button, EmptyState, Input, Panel, PanelHeader, SkeletonRows, useToast,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { Icon } from '@/components/icon';
import { cn, formatRelative } from '@/lib/utils';
import { deleteMessage, markConversationRead, sendMessage } from '@/lib/chat-actions';
import { useRealtimeRefresh } from '@/lib/realtime/realtime-context';
import { useAuth } from '@/components/shell/auth-context';
import { userTopics } from '@/lib/realtime/topics';

/**
 * Chat.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SOCKET SAYS SOMETHING ARRIVED; THE FETCH SAYS WHAT
 *
 * A `message.created` event carries three ids and no text. That is not a
 * limitation to work around — a message can link a record that resolves
 * differently for different readers, so a ready-to-render frame would have to
 * be built per recipient, and the round trip it was meant to save would be
 * spent on the server instead.
 *
 * So an event refetches the open thread. On a slow link that second step can
 * fail; the 30-second poll behind it picks the message up regardless, and
 * nothing is silently dropped. See docs/architecture/16-chat.md §1.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function ChatView() {
  const auth = useAuth();
  const toast = useToast();

  const [list, setList] = React.useState<ConversationListDto | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [page, setPage] = React.useState<MessagePageDto | null>(null);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);

  const loadList = React.useCallback(() => {
    void fetch('/api/chat/conversations')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then((data: ConversationListDto) => { setList(data); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);

  const loadThread = React.useCallback((conversationId: string) => {
    void fetch(`/api/chat/conversations/${conversationId}/messages`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then((data: MessagePageDto) => setPage(data))
      .catch(() => setPage(null));
  }, []);

  React.useEffect(() => {
    loadList();
    // Thirty seconds: the backstop behind the socket, not the mechanism.
    const id = setInterval(loadList, 30_000);
    return () => clearInterval(id);
  }, [loadList]);

  React.useEffect(() => {
    if (activeId === null) return;
    loadThread(activeId);
    void markConversationRead(activeId).then(loadList);
  }, [activeId, loadThread, loadList]);

  /**
   * The caller's OWN topic, which is the only one chat travels on.
   *
   * `user:<id>` is refused to everybody but its owner — no capability grants
   * access to another person's stream, including a global administrator's.
   */
  const topics = React.useMemo(() => userTopics(auth.userId), [auth.userId]);
  useRealtimeRefresh(topics, () => {
    loadList();
    if (activeId !== null) loadThread(activeId);
  }, { interestingTypes: ['message.created'] });

  const active = list?.conversations.find((c) => c.id === activeId) ?? null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (activeId === null || draft.trim().length === 0) return;

    setSending(true);
    try {
      const result = await sendMessage(activeId, draft.trim());
      if (!result.ok) {
        toast.push({ title: result.error ?? 'That could not be sent.', tone: 'danger' });
        return;
      }
      setDraft('');
      loadThread(activeId);
      loadList();
    } finally {
      setSending(false);
    }
  }

  if (failed) {
    return (
      <PageContainer>
        <Alert tone="danger" title="Chat is unavailable" className="max-w-xl">
          Your conversations could not be loaded. They are not necessarily empty.
        </Alert>
      </PageContainer>
    );
  }

  if (list === null) {
    return <PageContainer><SkeletonRows rows={6} /></PageContainer>;
  }

  return (
    <PageContainer padded={false} className="overflow-hidden">
      <div className="grid h-full min-h-0 grid-cols-[minmax(240px,320px)_minmax(0,1fr)] gap-3 p-3">
        {/* ── Conversations ─────────────────────────────────────────────── */}
        <Panel flush className="min-h-0">
          <PanelHeader
            title="Conversations"
            actions={list.totalUnread > 0
              ? <Badge variant="accent" mono>{list.totalUnread}</Badge>
              : null}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {list.conversations.length === 0 ? (
              <EmptyState
                title="No conversations"
                description="Open one from a colleague's profile on the personnel screen."
              />
            ) : (
              <ul>
                {list.conversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    selected={conversation.id === activeId}
                    onSelect={() => setActiveId(conversation.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </Panel>

        {/* ── The thread ────────────────────────────────────────────────── */}
        <Panel flush className="min-h-0">
          {active === null ? (
            <EmptyState
              title="Nothing selected"
              description="Choose a conversation to read it."
            />
          ) : (
            <>
              <PanelHeader
                title={active.title ?? otherParticipants(active).join(', ') ?? 'Conversation'}
                actions={
                  <span className="flex items-center gap-1 text-2xs text-text-tertiary">
                    <Users className="size-3" aria-hidden />
                    {active.participants.filter((p) => p.active).length}
                  </span>
                }
              />

              {/*
                Newest at the BOTTOM, which means reversing the page.
                The API returns newest-first because that is what a keyset page
                has to be; a reader expects the opposite.
              */}
              <div className="flex min-h-0 flex-1 flex-col-reverse overflow-auto p-2">
                {page === null ? (
                  <div className="p-3">
                    <Alert tone="warning" title="Messages unavailable">
                      This conversation could not be loaded.
                    </Alert>
                  </div>
                ) : page.messages.length === 0 ? (
                  <EmptyState title="No messages yet" description="Say something." />
                ) : (
                  page.messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      onDeleted={() => { loadThread(active.id); loadList(); }}
                    />
                  ))
                )}
              </div>

              <form
                onSubmit={(event) => void submit(event)}
                className="flex items-center gap-2 border-t border-border-subtle p-2"
              >
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Message…"
                  aria-label="Message"
                  maxLength={4000}
                  className="flex-1"
                />
                <Button type="submit" size="sm" disabled={sending || draft.trim().length === 0}>
                  <Send aria-hidden /> Send
                </Button>
              </form>
            </>
          )}
        </Panel>
      </div>
    </PageContainer>
  );
}

function otherParticipants(conversation: ConversationDto): string[] {
  return conversation.participants
    .filter((p) => p.active)
    .map((p) => (p.callsign ? `${p.callsign} · ${p.displayName}` : p.displayName));
}

function ConversationRow({
  conversation, selected, onSelect,
}: {
  conversation: ConversationDto;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = conversation.title ?? otherParticipants(conversation).join(', ');

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-3 py-2',
          'text-left transition-colors duration-(--duration-fast) hover:bg-hover',
          selected && 'border-l-2 border-l-accent bg-active pl-[10px]',
        )}
      >
        <span className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{label}</span>
          {conversation.unreadCount > 0 ? (
            <Badge variant="accent" size="sm" mono>{conversation.unreadCount}</Badge>
          ) : null}
        </span>
        <span className="flex w-full items-center gap-2 text-2xs text-text-tertiary">
          <span className="min-w-0 flex-1 truncate">
            {conversation.lastMessagePreview ?? 'No messages yet'}
          </span>
          {conversation.lastMessageAt ? (
            <span>{formatRelative(conversation.lastMessageAt)}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function MessageRow({
  message, onDeleted,
}: {
  message: MessageDto;
  onDeleted: () => void;
}) {
  const [pending, setPending] = React.useState(false);

  async function remove() {
    setPending(true);
    try {
      await deleteMessage(message.id);
      onDeleted();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="group flex items-start gap-2 px-1 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-2xs text-text-tertiary">
          <span className="font-medium text-text-secondary">
            {message.author
              ? (message.author.callsign
                ? `${message.author.callsign} · ${message.author.displayName}`
                : message.author.displayName)
              : 'Unknown'}
          </span>
          <span>{formatRelative(message.createdAt)}</span>
        </p>

        {message.deleted ? (
          /* A TOMBSTONE, not a gap. A thread whose shape changes depending on
             who is reading is worse than one with a visible hole. */
          <p className="flex items-center gap-1.5 text-xs italic text-text-tertiary">
            <Ban className="size-3" aria-hidden />
            Message deleted
          </p>
        ) : (
          <>
            <p className="text-xs text-text-primary">{message.body}</p>
            {message.links.length > 0 ? (
              <p className="mt-1 flex flex-wrap gap-1">
                {message.links.map((link) => <LinkChip key={link.id} link={link} />)}
              </p>
            ) : null}
          </>
        )}
      </div>

      {message.viewerIsAuthor && !message.deleted ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => void remove()}
          aria-label="Delete this message"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A linked record, as this viewer may see it.
 *
 * An unresolved link still renders — removing it would change the shape of the
 * conversation depending on who is reading, and a sentence with a hole in it is
 * more confusing than a sentence with a redacted chip in it. The chip carries
 * no identifier and goes nowhere.
 *
 * The two unresolved reasons are shown differently on purpose: "you cannot see
 * this" and "this is gone" are different facts, and collapsing them would tell a
 * reader that a record they may not see does not exist.
 */
function LinkChip({ link }: { link: MessageLinkDto }) {
  const meta = messageLinkMeta(link.entityType);

  if (!link.resolved) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-[2px] border border-border-subtle
          bg-raised px-1 text-2xs text-text-tertiary"
        title={link.reason === 'not-permitted'
          ? 'You do not have permission to see this record.'
          : 'This record no longer exists.'}
      >
        <Icon name={meta.icon} className="size-3" aria-hidden />
        {meta.label}
        {' · '}
        {link.reason === 'not-permitted' ? 'not available to you' : 'no longer exists'}
      </span>
    );
  }

  const chip = (
    <span className="inline-flex items-center gap-1 rounded-[2px] border border-accent/40
      bg-accent/10 px-1 text-2xs text-accent"
    >
      <Icon name={meta.icon} className="size-3" aria-hidden />
      {link.label}
    </span>
  );

  return link.href === null
    ? chip
    : <Link href={link.href as Route} className="hover:underline">{chip}</Link>;
}
