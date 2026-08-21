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

/**
 * The first snapshot, or the reason there isn't one.
 *
 * A THREE-WAY answer, because two of the three are not errors:
 *
 *   · `ok`            — the dashboard, as the caller may see it;
 *   · `not-permitted` — the caller may not see dispatch. The API says 404 for
 *     this, as it does everywhere: a caller who may not use dispatch learns
 *     nothing about what is on it. It is a stable fact about the account, not a
 *     transient failure, so the screen must say so and STOP ASKING;
 *   · `unavailable`   — the API is genuinely unreachable. Transient, worth
 *     retrying, worth reporting as an outage.
 *
 * Collapsing the middle case into the last one is what produced a dashboard
 * that polled forever and told an operator it had "lost contact with the
 * server" — which was untrue, and sends somebody looking for an outage that
 * is not there.
 */
export type DashboardAccess =
  | { kind: 'ok'; snapshot: DashboardSnapshot }
  | { kind: 'not-permitted' }
  | { kind: 'unavailable' };

export async function fetchDashboard(): Promise<DashboardAccess> {
  const res = await apiFetch<DashboardSnapshot>('/api/v1/dashboard');
  if (res.ok && res.data) return { kind: 'ok', snapshot: res.data };
  if (res.status === 404 || res.status === 403) return { kind: 'not-permitted' };
  return { kind: 'unavailable' };
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
