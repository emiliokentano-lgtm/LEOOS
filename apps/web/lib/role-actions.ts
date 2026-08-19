'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, CSRF_COOKIE } from './api-client';
import type { ActionState } from './auth-action-types';

/**
 * Role server actions.
 *
 * THE ORGANIZATION ID AND THE ROLE ID TRAVEL IN THE PATH, bound at render time
 * from data the server already fetched. What arrives from the browser is the
 * payload only — a name, a level, a set of permission keys.
 *
 * None of these decides anything. Every one is re-decided server-side inside the
 * transaction that performs the change, against the role row read under lock:
 * the actor's rank versus the role's, and the subset rule over the permissions
 * the change would add (engineering rules 9, 12, 14, 15).
 */

async function csrfHeader(): Promise<Record<string, string>> {
  const jar = await cookies();
  const token = jar.get(CSRF_COOKIE)?.value;
  return token ? { 'x-leoos-csrf': token } : {};
}

function failure(
  error: { message: string; detail?: unknown } | undefined,
  requestId: string | undefined,
): ActionState {
  return { status: 'error', message: error?.message ?? 'Request failed.', requestId };
}

function refresh(): void {
  revalidatePath('/roles');
  revalidatePath('/personnel');
  revalidatePath('/organization');
}

const basePath = (organizationId: string) =>
  `/api/v1/organizations/${organizationId}/roles`;

/** Lowercase, underscore-separated — matched by the API's own schema. */
function toKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export async function createRoleAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const level = Number(formData.get('hierarchyLevel'));
  const permissions = formData.getAll('permissions').map(String);

  if (name.length < 2) return { status: 'error', message: 'Give the role a name.' };
  if (!Number.isInteger(level) || level < 1 || level > 100) {
    return { status: 'error', message: 'The hierarchy level must be a whole number from 1 to 100.' };
  }

  const key = toKey(name);
  if (key.length < 2) {
    return { status: 'error', message: 'That name has too few letters or numbers to form a key.' };
  }

  const res = await apiFetch<{ roleId: string }>(basePath(organizationId), {
    method: 'POST',
    body: {
      key,
      name,
      description: description || null,
      hierarchyLevel: level,
      permissions,
    },
    headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: `${name} created.` };
}

export async function updateRoleAction(
  organizationId: string,
  roleId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload: Record<string, unknown> = {};

  if (formData.has('name')) {
    const name = String(formData.get('name') ?? '').trim();
    if (name.length < 2) return { status: 'error', message: 'Give the role a name.' };
    payload.name = name;
  }
  if (formData.has('description')) {
    payload.description = String(formData.get('description') ?? '').trim() || null;
  }
  if (formData.has('hierarchyLevel')) {
    const level = Number(formData.get('hierarchyLevel'));
    if (!Number.isInteger(level) || level < 1 || level > 100) {
      return { status: 'error', message: 'The hierarchy level must be a whole number from 1 to 100.' };
    }
    payload.hierarchyLevel = level;
  }

  if (Object.keys(payload).length === 0) {
    return { status: 'error', message: 'Nothing to change.' };
  }

  const res = await apiFetch(`${basePath(organizationId)}/${roleId}`, {
    method: 'PATCH', body: payload, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Role updated.' };
}

/**
 * Submits the WHOLE desired permission set.
 *
 * The server diffs it against the stored row under lock and applies the subset
 * rule to the additions IT derives — so the browser cannot mislabel an addition,
 * and two editors saving at once cannot combine into a set neither submitted.
 */
export async function setRolePermissionsAction(
  organizationId: string,
  roleId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const permissions = formData.getAll('permissions').map(String);

  const res = await apiFetch<{ added: string[]; removed: string[] }>(
    `${basePath(organizationId)}/${roleId}/permissions`,
    { method: 'PUT', body: { permissions }, headers: await csrfHeader() },
  );

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();

  const added = res.data?.added.length ?? 0;
  const removed = res.data?.removed.length ?? 0;
  const parts = [
    added > 0 ? `${added} added` : null,
    removed > 0 ? `${removed} removed` : null,
  ].filter(Boolean);

  return {
    status: 'success',
    message: parts.length > 0 ? `Permissions saved — ${parts.join(', ')}.` : 'Permissions saved.',
  };
}

export async function archiveRoleAction(
  organizationId: string,
  roleId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { status: 'error', message: 'A reason is required — it is written to the audit log.' };
  }

  const res = await apiFetch(`${basePath(organizationId)}/${roleId}`, {
    method: 'DELETE', body: { reason }, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Role archived. The record and its history are retained.' };
}

export async function restoreRoleAction(
  organizationId: string,
  roleId: string,
): Promise<ActionState> {
  const res = await apiFetch(`${basePath(organizationId)}/${roleId}/restore`, {
    method: 'POST', headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Role restored.' };
}

export async function setDefaultRoleAction(
  organizationId: string,
  roleId: string,
): Promise<ActionState> {
  const res = await apiFetch(`${basePath(organizationId)}/${roleId}/default`, {
    method: 'POST', headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'New hires will receive this role.' };
}

/**
 * Reassigns levels across several roles at once.
 *
 * All-or-nothing on the server: a partially applied reorder is a hierarchy in a
 * state nobody chose.
 */
export async function reorderRolesAction(
  organizationId: string,
  order: { roleId: string; hierarchyLevel: number }[],
): Promise<ActionState> {
  const res = await apiFetch<{ moved: number }>(`${basePath(organizationId)}/order`, {
    method: 'POST', body: { order }, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: `Hierarchy updated — ${res.data?.moved ?? 0} role(s) moved.` };
}
