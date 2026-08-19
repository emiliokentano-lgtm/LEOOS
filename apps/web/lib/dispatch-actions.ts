'use server';

import { revalidatePath } from 'next/cache';
import type { IncidentPriority, IncidentStatusKey } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Dispatch actions.
 *
 * Every one is re-authorized by the API inside the mutating transaction
 * (engineering rules 9, 10). The screen hides controls it knows will be
 * refused; that is UX, and it decides nothing.
 *
 * All of them return a plain result rather than throwing: on this screen a
 * refusal has to render as a message beside the control the operator just used,
 * not as an error boundary that clears the board mid-incident.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Machine-readable, so the caller can react to a specific refusal. */
  code?: string;
}

async function call(
  path: string,
  init: { method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<ActionResult> {
  const res = await apiFetch<unknown>(path, {
    method: init.method ?? 'POST',
    ...(init.body === undefined ? {} : { body: init.body }),
  });

  if (!res.ok) {
    return {
      ok: false,
      error: res.error?.message ?? 'That action could not be completed.',
      code: res.error?.code,
    };
  }
  revalidatePath('/dispatch');
  return { ok: true };
}

// ── Self ───────────────────────────────────────────────────────────────────

export async function setOwnStatus(statusKey: string): Promise<ActionResult> {
  return call('/api/v1/dispatch/self/status', { body: { statusKey } });
}

export async function joinUnit(unitId: string): Promise<ActionResult> {
  return call(`/api/v1/dispatch/self/unit/${unitId}`);
}

export async function leaveUnit(): Promise<ActionResult> {
  return call('/api/v1/dispatch/self/unit', { method: 'DELETE' });
}

export async function triggerPanic(): Promise<ActionResult> {
  // No position is sent from the browser: it has no idea where the character
  // is. The server falls back to the unit's last known position, which is the
  // best available answer (see panic.service.ts).
  return call('/api/v1/dispatch/self/panic', { body: {} });
}

// ── Panic handling ─────────────────────────────────────────────────────────

export async function acknowledgePanic(panicId: string): Promise<ActionResult> {
  return call(`/api/v1/dispatch/panics/${panicId}/acknowledge`, { body: {} });
}

export async function resolvePanic(panicId: string): Promise<ActionResult> {
  return call(`/api/v1/dispatch/panics/${panicId}/resolve`, { body: {} });
}

// ── Incidents ──────────────────────────────────────────────────────────────

export interface CreateIncidentInput {
  title: string;
  description?: string | null;
  typeKey?: string | null;
  priority: IncidentPriority;
  locationText?: string | null;
  x?: number | null;
  y?: number | null;
  callerPhone?: string | null;
}

export async function createIncident(input: CreateIncidentInput): Promise<ActionResult> {
  return call('/api/v1/dispatch/incidents', {
    body: {
      title: input.title,
      description: input.description ?? null,
      typeKey: input.typeKey ?? null,
      priority: input.priority,
      locationText: input.locationText ?? null,
      // A coordinate is a pair; the API rejects half of one.
      ...(input.x != null && input.y != null ? { x: input.x, y: input.y } : {}),
      callerPhone: input.callerPhone ?? null,
    },
  });
}

export async function setIncidentStatus(
  incidentId: string,
  status: Exclude<IncidentStatusKey, 'closed' | 'cancelled'>,
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/status`, { body: { status } });
}

export async function setIncidentPriority(
  incidentId: string,
  priority: IncidentPriority,
  reason?: string | null,
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/priority`, {
    body: { priority, reason: reason ?? null },
  });
}

export async function closeIncident(
  incidentId: string,
  opts: { cancelled?: boolean; notes?: string | null } = {},
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/close`, {
    body: { cancelled: opts.cancelled ?? false, notes: opts.notes ?? null },
  });
}

export async function reopenIncident(
  incidentId: string,
  reason: string,
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/reopen`, { body: { reason } });
}

export async function addIncidentNote(
  incidentId: string,
  body: string,
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/notes`, { body: { body } });
}

// ── Assignment ─────────────────────────────────────────────────────────────

export async function assignUnit(
  incidentId: string,
  unitId: string,
  role?: string | null,
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/units`, {
    body: { unitId, role: role ?? null },
  });
}

export async function releaseUnit(
  incidentId: string,
  unitId: string,
): Promise<ActionResult> {
  return call(`/api/v1/dispatch/incidents/${incidentId}/units/${unitId}`, { method: 'DELETE' });
}

// ── Units ──────────────────────────────────────────────────────────────────

export async function createUnit(input: {
  callsign: string;
  name?: string | null;
  unitType?: string;
  joinSelf?: boolean;
}): Promise<ActionResult> {
  return call('/api/v1/dispatch/units', {
    body: {
      callsign: input.callsign,
      name: input.name ?? null,
      unitType: input.unitType ?? 'patrol',
      joinSelf: input.joinSelf ?? true,
    },
  });
}

export async function disbandUnit(unitId: string): Promise<ActionResult> {
  return call(`/api/v1/dispatch/units/${unitId}`, { method: 'DELETE' });
}
