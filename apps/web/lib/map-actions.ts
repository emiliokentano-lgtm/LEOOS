'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from './api-client';

/**
 * Map marker actions.
 *
 * Every one of these is re-authorized by the API: whether the caller may place
 * a marker at all, and which organization it may be pinned to, are decided
 * server-side inside the mutating transaction (engineering rules 9, 11). The
 * map screen hides the controls it knows will be refused, but that is UX and
 * nothing more.
 */

export interface MarkerActionResult {
  ok: boolean;
  error?: string;
}

export interface PlaceMarkerInput {
  type: 'hazard' | 'roadblock' | 'staging' | 'command_post' | 'poi' | 'custom';
  label: string;
  description?: string | null;
  x: number;
  y: number;
  organizationId?: string | null;
  expiresAt?: string | null;
}

export async function placeMapMarker(input: PlaceMarkerInput): Promise<MarkerActionResult> {
  const res = await apiFetch<{ id: string }>('/api/v1/map/markers', {
    method: 'POST',
    body: {
      type: input.type,
      label: input.label,
      description: input.description ?? null,
      x: input.x,
      y: input.y,
      ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  });

  if (!res.ok) return { ok: false, error: res.error?.message ?? 'The marker could not be placed.' };
  revalidatePath('/map');
  return { ok: true };
}

export async function removeMapMarker(markerId: string): Promise<MarkerActionResult> {
  const res = await apiFetch<{ removed: boolean }>(`/api/v1/map/markers/${markerId}`, {
    method: 'DELETE',
  });

  if (!res.ok) return { ok: false, error: res.error?.message ?? 'The marker could not be removed.' };
  revalidatePath('/map');
  return { ok: true };
}

// ── Shapes ─────────────────────────────────────────────────────────────────

/**
 * Areas and routes.
 *
 * Same story as markers: the API decides. Geometry is validated there too — the
 * drawing tool refuses an impossible shape before the round trip because that is
 * a better experience, not because it is the check that matters.
 */
export interface DrawShapeInput {
  kind: 'area' | 'route';
  label: string;
  description?: string | null;
  color?: string | null;
  points: Array<{ x: number; y: number }>;
  organizationId?: string | null;
  expiresAt?: string | null;
}

export async function drawMapShape(input: DrawShapeInput): Promise<MarkerActionResult> {
  const res = await apiFetch<{ id: string }>('/api/v1/map/shapes', {
    method: 'POST',
    body: {
      kind: input.kind,
      label: input.label,
      description: input.description ?? null,
      color: input.color ?? null,
      points: input.points,
      ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  });

  if (!res.ok) return { ok: false, error: res.error?.message ?? 'The shape could not be saved.' };
  revalidatePath('/map');
  return { ok: true };
}

export async function removeMapShape(shapeId: string): Promise<MarkerActionResult> {
  const res = await apiFetch<{ removed: boolean }>(`/api/v1/map/shapes/${shapeId}`, {
    method: 'DELETE',
  });

  if (!res.ok) return { ok: false, error: res.error?.message ?? 'The shape could not be removed.' };
  revalidatePath('/map');
  return { ok: true };
}
