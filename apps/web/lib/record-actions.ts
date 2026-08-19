'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { apiFetch, CSRF_COOKIE } from './api-client';
import type { ActionState } from './auth-action-types';

/**
 * Person and vehicle server actions.
 *
 * The record id travels in the PATH, bound at render time from data the server
 * already fetched. What arrives from the browser is the payload only.
 *
 * None of these decides anything: the API re-checks the permission on every
 * call, and the two organization-scoped rules — a warrant belongs to the
 * organization that issued it, a fleet vehicle to the organization that operates
 * it — are enforced there against the stored row (engineering rules 9, 11, 12).
 */

async function csrfHeader(): Promise<Record<string, string>> {
  const jar = await cookies();
  const token = jar.get(CSRF_COOKIE)?.value;
  return token ? { 'x-leoos-csrf': token } : {};
}

function failure(
  error: { message: string } | undefined,
  requestId: string | undefined,
): ActionState {
  return { status: 'error', message: error?.message ?? 'Request failed.', requestId };
}

function refreshPersons(): void {
  revalidatePath('/persons');
  revalidatePath('/vehicles');
}

function refreshVehicles(): void {
  revalidatePath('/vehicles');
  revalidatePath('/persons');
}

/** Empty string means "clear it"; an absent field means "leave it alone". */
function optional(formData: FormData, key: string): string | null | undefined {
  if (!formData.has(key)) return undefined;
  const value = String(formData.get(key) ?? '').trim();
  return value === '' ? null : value;
}

function optionalNumber(formData: FormData, key: string): number | null | undefined {
  const raw = optional(formData, key);
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

// ── Persons ────────────────────────────────────────────────────────────────

function personPayload(formData: FormData): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of ['firstName', 'lastName', 'dateOfBirth', 'gender', 'phoneNumber',
    'address', 'eyeColor', 'hairColor', 'notes'] as const) {
    const value = optional(formData, key);
    if (value !== undefined) payload[key] = value;
  }
  for (const key of ['heightCm', 'weightKg'] as const) {
    const value = optionalNumber(formData, key);
    if (value !== undefined) payload[key] = value;
  }
  if (formData.has('status')) payload.status = String(formData.get('status'));
  return payload;
}

export async function createPersonAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload = personPayload(formData);
  if (!payload.firstName || !payload.lastName) {
    return { status: 'error', message: 'A first and last name are required.' };
  }

  const res = await apiFetch<{ personId: string }>('/api/v1/persons', {
    method: 'POST', body: payload, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Person record created.' };
}

export async function updatePersonAction(
  personId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload = personPayload(formData);
  if (Object.keys(payload).length === 0) {
    return { status: 'error', message: 'Nothing to change.' };
  }

  const res = await apiFetch(`/api/v1/persons/${personId}`, {
    method: 'PATCH', body: payload, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Record updated.' };
}

export async function archivePersonAction(
  personId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { status: 'error', message: 'A reason is required — it is written to the audit log.' };
  }

  const res = await apiFetch(`/api/v1/persons/${personId}`, {
    method: 'DELETE', body: { reason }, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Record archived and retained.' };
}

export async function addAliasAction(
  personId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const alias = String(formData.get('alias') ?? '').trim();
  if (alias.length === 0) return { status: 'error', message: 'Enter an alias.' };

  const res = await apiFetch(`/api/v1/persons/${personId}/aliases`, {
    method: 'POST',
    body: { alias, note: String(formData.get('note') ?? '').trim() || null },
    headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: `Alias “${alias}” recorded.` };
}

export async function removeAliasAction(
  personId: string,
  aliasId: string,
): Promise<ActionState> {
  const res = await apiFetch(`/api/v1/persons/${personId}/aliases/${aliasId}`, {
    method: 'DELETE', headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Alias removed.' };
}

export async function addFlagAction(
  personId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const type = String(formData.get('type') ?? '').trim();
  const severity = String(formData.get('severity') ?? 'caution');
  if (type.length < 2) return { status: 'error', message: 'Describe the flag.' };

  const res = await apiFetch(`/api/v1/persons/${personId}/flags`, {
    method: 'POST',
    body: { type, severity, note: String(formData.get('note') ?? '').trim() || null },
    headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Flag added.' };
}

export async function resolveFlagAction(
  personId: string,
  flagId: string,
): Promise<ActionState> {
  const res = await apiFetch(`/api/v1/persons/${personId}/flags/${flagId}/resolve`, {
    method: 'POST', headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Flag cleared.' };
}

export async function issueWarrantAction(
  personId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const type = String(formData.get('type') ?? 'arrest');
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) return { status: 'error', message: 'State the grounds.' };

  // No organization field: the API files it under the actor's own organization.
  const res = await apiFetch(`/api/v1/persons/${personId}/warrants`, {
    method: 'POST', body: { type, reason }, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Warrant issued.' };
}

export async function resolveWarrantAction(
  personId: string,
  warrantId: string,
  outcome: 'served' | 'revoked',
): Promise<ActionState> {
  const res = await apiFetch(`/api/v1/persons/${personId}/warrants/${warrantId}/resolve`, {
    method: 'POST', body: { outcome }, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: `Warrant ${outcome}.` };
}

export async function updateMedicalAction(
  personId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const list = (key: string): string[] =>
    String(formData.get(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

  const res = await apiFetch(`/api/v1/persons/${personId}/medical`, {
    method: 'PUT',
    body: {
      bloodType: String(formData.get('bloodType') ?? '').trim() || null,
      allergies: list('allergies'),
      conditions: list('conditions'),
      medications: list('medications'),
      emergencyContact: String(formData.get('emergencyContact') ?? '').trim() || null,
      notes: String(formData.get('notes') ?? '').trim() || null,
    },
    headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshPersons();
  return { status: 'success', message: 'Medical record updated.' };
}

// ── Vehicles ───────────────────────────────────────────────────────────────

function vehiclePayload(formData: FormData): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of ['plate', 'model', 'displayName', 'color', 'vehicleClass',
    'notes'] as const) {
    const value = optional(formData, key);
    if (value !== undefined) payload[key] = value;
  }
  for (const key of ['registrationStatus', 'insuranceStatus'] as const) {
    if (formData.has(key)) payload[key] = String(formData.get(key));
  }

  // Ownership is one of three shapes, and the form submits which one it means.
  const ownerKind = String(formData.get('ownerKind') ?? '');
  if (ownerKind === 'person') {
    payload.ownerPersonId = String(formData.get('ownerPersonId') ?? '') || null;
    payload.ownerOrganizationId = null;
    payload.isFleet = false;
  } else if (ownerKind === 'organization') {
    payload.ownerPersonId = null;
    payload.ownerOrganizationId = String(formData.get('ownerOrganizationId') ?? '') || null;
    payload.isFleet = formData.get('isFleet') === 'on';
  } else if (ownerKind === 'none') {
    payload.ownerPersonId = null;
    payload.ownerOrganizationId = null;
    payload.isFleet = false;
  }
  return payload;
}

export async function createVehicleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload = vehiclePayload(formData);
  if (!payload.plate) return { status: 'error', message: 'A plate is required.' };
  if (!payload.model) return { status: 'error', message: 'A model is required.' };

  const res = await apiFetch<{ vehicleId: string }>('/api/v1/vehicles', {
    method: 'POST', body: payload, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshVehicles();
  return { status: 'success', message: 'Vehicle registered.' };
}

export async function updateVehicleAction(
  vehicleId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const payload = vehiclePayload(formData);
  if (Object.keys(payload).length === 0) {
    return { status: 'error', message: 'Nothing to change.' };
  }

  const res = await apiFetch(`/api/v1/vehicles/${vehicleId}`, {
    method: 'PATCH', body: payload, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshVehicles();
  return { status: 'success', message: 'Vehicle updated.' };
}

export async function archiveVehicleAction(
  vehicleId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { status: 'error', message: 'A reason is required — it is written to the audit log.' };
  }

  const res = await apiFetch(`/api/v1/vehicles/${vehicleId}`, {
    method: 'DELETE', body: { reason }, headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshVehicles();
  return { status: 'success', message: 'Vehicle archived. The plate is free to reissue.' };
}

export async function addVehicleFlagAction(
  vehicleId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const type = String(formData.get('type') ?? '').trim();
  if (type.length < 2) return { status: 'error', message: 'Describe the flag.' };

  const res = await apiFetch(`/api/v1/vehicles/${vehicleId}/flags`, {
    method: 'POST',
    body: { type, note: String(formData.get('note') ?? '').trim() || null },
    headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshVehicles();
  return { status: 'success', message: 'Flag added.' };
}

export async function resolveVehicleFlagAction(
  vehicleId: string,
  flagId: string,
): Promise<ActionState> {
  const res = await apiFetch(`/api/v1/vehicles/${vehicleId}/flags/${flagId}/resolve`, {
    method: 'POST', headers: await csrfHeader(),
  });
  if (!res.ok) return failure(res.error, res.requestId);
  refreshVehicles();
  return { status: 'success', message: 'Flag cleared.' };
}

/** Owner search for the vehicle editor, called from the client as you type. */
export async function searchOwnersAction(
  term: string,
): Promise<{ id: string; name: string; dateOfBirth: string | null }[]> {
  if (term.trim().length === 0) return [];
  const res = await apiFetch<{ candidates: { id: string; name: string; dateOfBirth: string | null }[] }>(
    `/api/v1/vehicles/owner-candidates?search=${encodeURIComponent(term)}`,
  );
  return res.ok ? (res.data?.candidates ?? []) : [];
}
