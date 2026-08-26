'use server';

import { revalidatePath } from 'next/cache';
import type { MessageLinkEntity } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Chat actions.
 *
 * A pass-through, like every other action file. Who may read, post or delete is
 * decided entirely by the API against the caller's membership of the
 * conversation, read fresh on every request.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

async function call(
  path: string,
  body: unknown,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<ActionResult> {
  const res = await apiFetch<{ id?: string; error?: { message?: string } }>(path, {
    method,
    ...(body === undefined ? {} : { body }),
  });
  if (!res.ok) {
    return { ok: false, error: res.data?.error?.message ?? 'That could not be sent.' };
  }
  revalidatePath('/chat');
  return { ok: true, id: res.data?.id };
}

export async function openDirectConversation(memberId: string): Promise<ActionResult> {
  return call('/api/v1/chat/conversations/direct', { memberId });
}

export async function createGroupConversation(
  title: string, memberIds: string[],
): Promise<ActionResult> {
  return call('/api/v1/chat/conversations/group', { title, memberIds });
}

export async function sendMessage(
  conversationId: string,
  body: string,
  links: { entityType: MessageLinkEntity; entityId: string; position: number }[] = [],
): Promise<ActionResult> {
  return call(`/api/v1/chat/conversations/${conversationId}/messages`, { body, links });
}

export async function deleteMessage(messageId: string): Promise<ActionResult> {
  return call(`/api/v1/chat/messages/${messageId}`, undefined, 'DELETE');
}

export async function markConversationRead(conversationId: string): Promise<ActionResult> {
  return call(`/api/v1/chat/conversations/${conversationId}/read`, {});
}
