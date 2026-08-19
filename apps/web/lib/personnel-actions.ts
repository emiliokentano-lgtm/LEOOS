'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, CSRF_COOKIE } from './api-client';
import type { ActionState } from './auth-action-types';

/**
 * Personnel server actions.
 *
 * THE ORGANIZATION ID AND THE MEMBER ID TRAVEL IN THE PATH. No action here
 * accepts either from a form field, so there is no hidden input for a browser to
 * rewrite — and even if there were, the API re-derives the actor's authority
 * over the organization named in the path and re-decides the hierarchy rules
 * inside the transaction that performs the change (engineering rules 9, 11, 12).
 *
 * These actions bind their ids at render time from data the server already
 * fetched. What arrives from the browser is only the payload: a role choice, a
 * callsign, a reason.
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
  revalidatePath('/personnel');
  revalidatePath('/organization');
}

const basePath = (organizationId: string) =>
  `/api/v1/organizations/${organizationId}/personnel`;

// ── Hire ───────────────────────────────────────────────────────────────────

export async function hireMemberAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = String(formData.get('userId') ?? '');
  const roleId = String(formData.get('roleId') ?? '');
  const callsign = String(formData.get('callsign') ?? '').trim();
  const employeeNumber = String(formData.get('employeeNumber') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();

  if (!userId) return { status: 'error', message: 'Choose someone to hire.' };
  if (!roleId) return { status: 'error', message: 'Choose a starting rank.' };

  const res = await apiFetch(basePath(organizationId), {
    method: 'POST',
    body: {
      userId,
      roleId,
      callsign: callsign || null,
      employeeNumber: employeeNumber || null,
      notes: notes || null,
    },
    headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Member hired.' };
}

// ── Terminate ──────────────────────────────────────────────────────────────

export async function terminateMemberAction(
  organizationId: string,
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { status: 'error', message: 'A reason is required — it is written to the audit log.' };
  }

  const res = await apiFetch(`${basePath(organizationId)}/${memberId}/termination`, {
    method: 'POST', body: { reason }, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return {
    status: 'success',
    message: 'Membership terminated. The record and its history are retained.',
  };
}

// ── Promote / demote ───────────────────────────────────────────────────────

/**
 * One action for both directions.
 *
 * The API derives promotion from demotion by comparing hierarchy levels, so
 * there is no direction flag here for a client to disagree with — the audit
 * entry describes what happened, not what was asked for.
 */
export async function changeRankAction(
  organizationId: string,
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const roleId = String(formData.get('roleId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!roleId) return { status: 'error', message: 'Choose the new rank.' };

  const res = await apiFetch<{ kind: string; fromLevel: number; toLevel: number }>(
    `${basePath(organizationId)}/${memberId}/rank`,
    { method: 'POST', body: { roleId, ...(reason ? { reason } : {}) }, headers: await csrfHeader() },
  );

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  const kind = res.data?.kind === 'demote' ? 'demoted' : 'promoted';
  return { status: 'success', message: `Member ${kind}.` };
}

// ── Individual role grants ─────────────────────────────────────────────────

export async function assignRoleAction(
  organizationId: string,
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const roleId = String(formData.get('roleId') ?? '');
  if (!roleId) return { status: 'error', message: 'Choose a role to assign.' };

  const res = await apiFetch(`${basePath(organizationId)}/${memberId}/roles`, {
    method: 'POST', body: { roleId }, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Role assigned.' };
}

export async function removeRoleAction(
  organizationId: string,
  memberId: string,
  roleId: string,
): Promise<ActionState> {
  const res = await apiFetch(`${basePath(organizationId)}/${memberId}/roles/${roleId}`, {
    method: 'DELETE', headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Role removed.' };
}

// ── Edit details / callsign ────────────────────────────────────────────────

export async function editMemberAction(
  organizationId: string,
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload: Record<string, unknown> = {};

  // Only fields the form actually submitted are sent. An absent key means "leave
  // it alone"; an empty string means "clear it".
  for (const key of ['callsign', 'employeeNumber', 'notes'] as const) {
    if (formData.has(key)) {
      const value = String(formData.get(key) ?? '').trim();
      payload[key] = value || null;
    }
  }
  if (formData.has('status')) {
    payload.status = String(formData.get('status'));
  }

  if (Object.keys(payload).length === 0) {
    return { status: 'error', message: 'Nothing to change.' };
  }

  const res = await apiFetch(`${basePath(organizationId)}/${memberId}`, {
    method: 'PATCH', body: payload, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: 'Personnel record updated.' };
}

/** Callsign on its own — needs only `personnel.callsign`, not `personnel.edit`. */
export async function setCallsignAction(
  organizationId: string,
  memberId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const callsign = String(formData.get('callsign') ?? '').trim();

  const res = await apiFetch(`${basePath(organizationId)}/${memberId}`, {
    method: 'PATCH', body: { callsign: callsign || null }, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  refresh();
  return { status: 'success', message: callsign ? `Callsign set to ${callsign}.` : 'Callsign cleared.' };
}
