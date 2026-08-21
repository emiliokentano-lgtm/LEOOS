import 'server-only';
import type {
  AdminCapabilities, AdminLeadOverview, AdminUserDetail, AdminUserList, AdminUserQuery,
  AuditPage, AuditQuery, GlobalCapabilityMeta, AccountStatusMeta,
  OrganizationSummary, PermissionOverview, SystemStatus,
} from '@leoos/contracts';
import { apiFetch } from './api-client';

/**
 * Administration data access for the web tier.
 *
 * A thin pass-through, like every other `lib/*.ts` here. Nothing in this file
 * decides who may see what: each endpoint re-derives that from the caller's
 * global capabilities, and a page that rendered without asking would simply get
 * a 403 with an empty result (engineering rule 9).
 *
 * `null` on failure rather than a throw, so a page can render its own error
 * state instead of a Next.js error boundary — the difference between "the
 * register is unavailable" and a blank screen.
 */

export async function fetchAdminCapabilities(): Promise<AdminCapabilities | null> {
  const res = await apiFetch<{ capabilities: AdminCapabilities }>('/api/v1/admin/capabilities');
  return res.ok && res.data ? res.data.capabilities : null;
}

/**
 * Serialises a typed query object into a query string.
 *
 * Takes the query types rather than a bare record so a typo in a field name is
 * a compile error here instead of a silently ignored filter at the API.
 */
function query(params: AdminUserQuery | AuditQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function fetchAdminUsers(q: AdminUserQuery): Promise<AdminUserList | null> {
  const res = await apiFetch<AdminUserList>(`/api/v1/admin/users${query(q)}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchAdminUser(userId: string): Promise<AdminUserDetail | null> {
  const res = await apiFetch<{ user: AdminUserDetail }>(`/api/v1/admin/users/${userId}`);
  return res.ok && res.data ? res.data.user : null;
}

export async function fetchAccountStatuses(): Promise<AccountStatusMeta[]> {
  const res = await apiFetch<{ statuses: AccountStatusMeta[] }>('/api/v1/admin/account-statuses');
  return res.ok && res.data ? res.data.statuses : [];
}

export async function fetchCapabilityCatalogue(): Promise<GlobalCapabilityMeta[]> {
  const res = await apiFetch<{ capabilities: GlobalCapabilityMeta[] }>(
    '/api/v1/admin/capability-catalogue',
  );
  return res.ok && res.data ? res.data.capabilities : [];
}

export async function fetchLeadOverview(): Promise<AdminLeadOverview | null> {
  const res = await apiFetch<AdminLeadOverview>('/api/v1/admin/leads');
  return res.ok && res.data ? res.data : null;
}

export async function fetchPermissionOverview(): Promise<PermissionOverview | null> {
  const res = await apiFetch<PermissionOverview>('/api/v1/admin/permissions');
  return res.ok && res.data ? res.data : null;
}

export async function fetchAuditPage(q: AuditQuery): Promise<AuditPage | null> {
  const res = await apiFetch<AuditPage>(`/api/v1/admin/audit${query(q)}`);
  return res.ok && res.data ? res.data : null;
}

export async function fetchAuditVocabulary(): Promise<{
  actions: string[];
  organizations: OrganizationSummary[];
}> {
  const res = await apiFetch<{ actions: string[]; organizations: OrganizationSummary[] }>(
    '/api/v1/admin/audit/actions',
  );
  return res.ok && res.data ? res.data : { actions: [], organizations: [] };
}

export async function fetchSystemStatus(): Promise<SystemStatus | null> {
  const res = await apiFetch<SystemStatus>('/api/v1/admin/system');
  return res.ok && res.data ? res.data : null;
}
