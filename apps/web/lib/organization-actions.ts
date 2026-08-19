'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, CSRF_COOKIE } from './api-client';
import type { ActionState } from './auth-action-types';

/**
 * Organization server actions.
 *
 * The organization id always travels in the PATH. None of these accepts an
 * organization id in a body, so there is no field for a client to rewrite — and
 * even if there were, the API re-derives the actor's authority over the
 * organization named in the path (engineering rule 11).
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

export async function updateOrganizationAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload: Record<string, unknown> = {};
  const name = String(formData.get('name') ?? '').trim();
  const shortName = String(formData.get('shortName') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const color = String(formData.get('color') ?? '').trim();

  if (name) payload.name = name;
  if (shortName) payload.shortName = shortName;
  payload.description = description || null;
  if (/^#[0-9a-fA-F]{6}$/.test(color)) payload.color = color;

  payload.settings = {
    shareOnPublicMap: formData.get('shareOnPublicMap') === 'on',
    allowSelfDispatch: formData.get('allowSelfDispatch') === 'on',
    requireCallsignOnDuty: formData.get('requireCallsignOnDuty') === 'on',
    panicNotifiesAllOrganizations: formData.get('panicNotifiesAllOrganizations') === 'on',
  };

  const res = await apiFetch(`/api/v1/organizations/${organizationId}`, {
    method: 'PATCH', body: payload, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  revalidatePath('/organization');
  return { status: 'success', message: 'Organization updated.' };
}

export async function grantLeadAction(
  organizationId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = String(formData.get('userId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!userId) return { status: 'error', message: 'Choose a member to appoint.' };

  const res = await apiFetch(`/api/v1/organizations/${organizationId}/leads`, {
    method: 'POST',
    body: { userId, ...(reason ? { reason } : {}) },
    headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  revalidatePath('/organization');
  revalidatePath('/admin/organizations');
  return { status: 'success', message: 'Organization Lead granted.' };
}

export async function revokeLeadAction(
  organizationId: string,
  userId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get('reason') ?? '').trim();

  const res = await apiFetch(`/api/v1/organizations/${organizationId}/leads/${userId}`, {
    method: 'DELETE',
    body: reason ? { reason } : {},
    headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  revalidatePath('/organization');
  revalidatePath('/admin/organizations');
  return { status: 'success', message: 'Organization Lead revoked.' };
}

export async function createOrganizationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload = {
    key: String(formData.get('key') ?? '').trim().toUpperCase(),
    name: String(formData.get('name') ?? '').trim(),
    shortName: String(formData.get('shortName') ?? '').trim(),
    description: String(formData.get('description') ?? '').trim() || undefined,
    category: String(formData.get('category') ?? 'other'),
    color: String(formData.get('color') ?? '#6b7686'),
  };

  const res = await apiFetch(`/api/v1/organizations`, {
    method: 'POST', body: payload, headers: await csrfHeader(),
  });

  if (!res.ok) return failure(res.error, res.requestId);
  revalidatePath('/admin/organizations');
  return { status: 'success', message: `${payload.name} created.` };
}

export async function setOrganizationActiveAction(
  organizationId: string,
  isActive: boolean,
): Promise<ActionState> {
  const res = await apiFetch(`/api/v1/organizations/${organizationId}`, {
    method: 'PATCH', body: { isActive }, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  revalidatePath('/admin/organizations');
  return { status: 'success', message: isActive ? 'Organization enabled.' : 'Organization disabled.' };
}
