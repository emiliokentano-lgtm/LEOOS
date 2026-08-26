import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CONVERSATION_MAX_PARTICIPANTS, CONVERSATION_TITLE_MAX,
  MESSAGE_MAX_LENGTH, MESSAGE_MAX_LINKS,
} from '@leoos/contracts';
import { NotFoundError } from '../../lib/errors.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { resolveDispatchScope } from '../dispatch/dispatch.scope.js';
import { realtimeActorOf } from '../dispatch/dispatch.events.js';
import { resolveSearchScope } from '../search/search.scope.js';
import {
  addParticipant, conversationMembership, createGroupConversation, deleteMessage,
  markConversationRead, openDirectConversation, removeParticipant, sendMessage,
} from './chat.service.js';
import { listConversations, listMessages, memberIdFor, totalUnread } from './chat.read.js';

/**
 * Chat.
 *
 * Every route here answers the same question first: IS THIS CALLER IN THIS
 * CONVERSATION? Not cached, not passed in — read from the database on every
 * request, so somebody removed from a group stops being able to read it on
 * their next one.
 */

const directSchema = z.object({ memberId: z.uuid() }).strict();

const groupSchema = z.object({
  title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX),
  memberIds: z.array(z.uuid()).max(CONVERSATION_MAX_PARTICIPANTS),
}).strict();

const sendSchema = z.object({
  body: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  links: z.array(z.object({
    entityType: z.enum(['person', 'vehicle', 'incident', 'unit', 'member']),
    entityId: z.uuid(),
    position: z.number().int().min(0).max(MESSAGE_MAX_LENGTH).default(0),
  }).strict()).max(MESSAGE_MAX_LINKS).default([]),
}).strict();

const participantSchema = z.object({ memberId: z.uuid() }).strict();

function meta(request: FastifyRequest): RequestMeta {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.requestId,
  };
}

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  function scopeOf(request: FastifyRequest) {
    return resolveDispatchScope(app.actorContext(request), request.auth!.userId);
  }

  /**
   * The caller's own membership id.
   *
   * Every read needs it, and an account with no active membership has no
   * conversations — reported as an empty list rather than an error, because
   * having no agency is an ordinary state (a global administrator is in it).
   */
  async function requireMemberId(request: FastifyRequest): Promise<string> {
    const scope = scopeOf(request);
    const memberId = await memberIdFor(app.db, scope.actorUserId, scope.organizationId);
    if (memberId === null) throw new NotFoundError('chat');
    return memberId;
  }

  app.get('/conversations', async (request, reply) => {
    const scope = scopeOf(request);
    const memberId = await memberIdFor(app.db, scope.actorUserId, scope.organizationId);
    if (memberId === null) return reply.send({ conversations: [], totalUnread: 0 });
    return reply.send(await listConversations(app.db, memberId));
  });

  app.get('/unread', async (request, reply) => {
    const scope = scopeOf(request);
    const memberId = await memberIdFor(app.db, scope.actorUserId, scope.organizationId);
    if (memberId === null) return reply.send({ total: 0 });
    return reply.send({ total: await totalUnread(app.db, memberId) });
  });

  app.post('/conversations/direct', async (request, reply) => {
    const scope = scopeOf(request);
    const body = directSchema.parse(request.body ?? {});
    const { result } = await openDirectConversation(
      app.db, scope, body.memberId, meta(request),
    );
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.post('/conversations/group', async (request, reply) => {
    const scope = scopeOf(request);
    const body = groupSchema.parse(request.body ?? {});
    const { result } = await createGroupConversation(app.db, scope, body, meta(request));
    return reply.status(201).send(result);
  });

  app.get('/conversations/:conversationId/messages', async (request, reply) => {
    const scope = scopeOf(request);
    const memberId = await requireMemberId(request);
    const { conversationId } = request.params as { conversationId: string };
    const query = request.query as { cursor?: string; limit?: string } | undefined;

    /**
     * The membership check, before anything is read.
     *
     * A conversation the caller is not in answers NOT FOUND — the existence of
     * a conversation is itself information about who is talking to whom.
     */
    const membership = await conversationMembership(app.db, conversationId, memberId);
    if (membership === null) throw new NotFoundError('conversation');

    /**
     * Links resolve against the SEARCH scope, which is already the object that
     * answers "which categories may this caller read, and whose rows". A second
     * set of rules here would be a second set to drift from the first.
     */
    const searchScope = resolveSearchScope(app.actorContext(request), scope.actorUserId);

    return reply.send(await listMessages(app.db, searchScope, conversationId, memberId, {
      cursor: query?.cursor ?? null,
      limit: query?.limit ? Number(query.limit) : undefined,
    }));
  });

  app.post('/conversations/:conversationId/messages', async (request, reply) => {
    const scope = scopeOf(request);
    const { conversationId } = request.params as { conversationId: string };
    const body = sendSchema.parse(request.body ?? {});

    const { result } = await sendMessage(app.db, scope, conversationId, {
      body: body.body,
      links: body.links.map((l) => ({
        entityType: l.entityType,
        entityId: l.entityId,
        position: l.position,
      })),
    }, meta(request));

    /**
     * Published to each participant's OWN topic, with three ids and no body.
     *
     * The recipient list came from inside the transaction, so somebody who left
     * a moment ago is already excluded.
     */
    app.events?.messageCreated(
      { organizationId: scope.organizationId, actor: realtimeActorOf(request) },
      {
        conversationId,
        messageId: result.id,
        authorMemberId: null,
      },
      result.recipientUserIds,
    );

    return reply.status(201).send({ id: result.id });
  });

  app.delete('/messages/:messageId', async (request, reply) => {
    const scope = scopeOf(request);
    const { messageId } = request.params as { messageId: string };
    const { result } = await deleteMessage(app.db, scope, messageId, meta(request));
    return reply.send(result);
  });

  app.post('/conversations/:conversationId/read', async (request, reply) => {
    const scope = scopeOf(request);
    const { conversationId } = request.params as { conversationId: string };
    await markConversationRead(app.db, scope, conversationId);
    return reply.status(204).send();
  });

  app.post('/conversations/:conversationId/participants', async (request, reply) => {
    const scope = scopeOf(request);
    const { conversationId } = request.params as { conversationId: string };
    const body = participantSchema.parse(request.body ?? {});
    const { result } = await addParticipant(
      app.db, scope, conversationId, body.memberId, meta(request),
    );
    return reply.send(result);
  });

  app.delete('/conversations/:conversationId/participants/:memberId', async (request, reply) => {
    const scope = scopeOf(request);
    const { conversationId, memberId } = request.params as {
      conversationId: string; memberId: string;
    };
    const { result } = await removeParticipant(
      app.db, scope, conversationId, memberId, meta(request),
    );
    return reply.send(result);
  });
}
