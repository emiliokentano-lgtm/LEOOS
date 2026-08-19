import 'server-only';
import type { DashboardDelta, DashboardSnapshot } from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Dashboard data access.
 *
 * A pass-through. Every figure on the dashboard is computed server-side over
 * exactly the rows the caller may see (ADR-0001, engineering rule 9) — nothing
 * here aggregates, filters or decides.
 */

export async function fetchDashboard(): Promise<DashboardSnapshot | null> {
  const res = await apiFetch<DashboardSnapshot>('/api/v1/dashboard');
  return res.ok && res.data ? res.data : null;
}

export async function fetchDashboardDelta(
  revision: string | null,
): Promise<DashboardDelta | null> {
  const res = await apiFetch<DashboardDelta>('/api/v1/dashboard/poll', {
    method: 'POST',
    body: { revision },
  });
  return res.ok && res.data ? res.data : null;
}
