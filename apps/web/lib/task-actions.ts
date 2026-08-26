'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from './api-client';

/**
 * Task actions.
 *
 * A pass-through, like every other action file here. Who may assign, complete
 * or cancel is decided entirely by the API inside the transaction that performs
 * the change; nothing in this file checks anything.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

async function call(path: string, body: unknown): Promise<ActionResult> {
  const res = await apiFetch<{ error?: { message?: string } }>(path, {
    method: 'POST',
    body,
  });
  if (!res.ok) {
    return { ok: false, error: res.data?.error?.message ?? 'That could not be saved.' };
  }
  revalidatePath('/dashboard');
  return { ok: true };
}

export async function createTask(input: {
  assigneeMemberId: string;
  title: string;
  detail?: string | null;
  priorityKey: string;
  dueAt?: string | null;
}): Promise<ActionResult> {
  return call('/api/v1/tasks', {
    assigneeMemberId: input.assigneeMemberId,
    title: input.title,
    detail: input.detail ?? null,
    priorityKey: input.priorityKey,
    dueAt: input.dueAt ?? null,
  });
}

/**
 * Ticking a task off, or putting it back.
 *
 * Takes a boolean rather than being one-way: people tick the wrong row, and the
 * only alternative fix would be a new task, which loses the deadline and the
 * history.
 */
export async function completeTask(taskId: string, completed: boolean): Promise<ActionResult> {
  return call(`/api/v1/tasks/${taskId}/complete`, { completed });
}

export async function cancelTask(taskId: string, reason?: string | null): Promise<ActionResult> {
  return call(`/api/v1/tasks/${taskId}/cancel`, { reason: reason ?? null });
}
