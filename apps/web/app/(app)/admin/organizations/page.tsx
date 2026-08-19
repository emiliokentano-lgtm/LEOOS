import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionOrNull } from '@/lib/session';
import { fetchOrganizations } from '@/lib/organizations';
import { apiFetch } from '@/lib/api-client';
import { AdminOrganizationsView } from './admin-organizations-view';
import type { OrganizationLeadDto } from '@/lib/organizations';

export const metadata: Metadata = { title: 'Organizations' };

/**
 * Global administration of organizations.
 *
 * Reachable only with a global capability. The guard here is convenience — the
 * API refuses every mutation on this page to anyone else, and the list endpoint
 * returns only the caller's own organizations to a non-admin, so a user who
 * reached this URL would see their own memberships and be unable to change
 * anything.
 */
export default async function AdminOrganizationsPage() {
  const session = await getSessionOrNull();
  if (!session) redirect('/login');

  const isGlobal = session.isGlobalAdmin || session.globalCapabilities.includes('org_admin');
  if (!isGlobal) redirect('/dashboard');

  const organizations = await fetchOrganizations(true);

  // Leads across every organization, fetched per organization so each one is
  // scoped by the API rather than by a bulk query that trusts this page.
  const leadLists = await Promise.all(
    organizations.map(async (org) => {
      const res = await apiFetch<{ leads: OrganizationLeadDto[] }>(
        `/api/v1/organizations/${org.id}/leads`,
      );
      return res.ok ? (res.data?.leads ?? []) : [];
    }),
  );

  return (
    <AdminOrganizationsView
      organizations={organizations}
      leadsByOrganization={Object.fromEntries(
        organizations.map((org, i) => [org.id, leadLists[i] ?? []]),
      )}
    />
  );
}
