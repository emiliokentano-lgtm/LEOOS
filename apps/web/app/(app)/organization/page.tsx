import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireActiveOrganization } from '@/lib/session';
import {
  fetchLeadCandidates, fetchOrgMembers, fetchOrgRoles, fetchOrgUnits,
  fetchOrgVehicles, fetchOrganizationDetail,
} from '@/lib/organizations';
import { OrganizationView } from './organization-view';

export const metadata: Metadata = { title: 'Organization' };

/**
 * The organization admin screen.
 *
 * Every panel is fetched independently and each is authorized separately by the
 * API, so a member with partial permissions gets a partial page rather than a
 * blanket refusal. A section the caller may not see comes back null and renders
 * as unavailable — it is never silently blank.
 */
export default async function OrganizationPage() {
  const { organization } = await requireActiveOrganization();

  const detail = await fetchOrganizationDetail(organization.id);
  // The API returns NOT FOUND rather than FORBIDDEN when out of scope, so this
  // covers both "gone" and "not yours".
  if (!detail) redirect('/dashboard');

  const [members, roles, units, vehicles, candidates] = await Promise.all([
    detail.capabilities.canViewPersonnel ? fetchOrgMembers(organization.id) : Promise.resolve(null),
    detail.capabilities.canViewRoles ? fetchOrgRoles(organization.id) : Promise.resolve(null),
    fetchOrgUnits(organization.id),
    detail.capabilities.canViewVehicles ? fetchOrgVehicles(organization.id) : Promise.resolve(null),
    detail.capabilities.canManageLeads
      ? fetchLeadCandidates(organization.id)
      : Promise.resolve([]),
  ]);

  return (
    <OrganizationView
      detail={detail}
      members={members}
      roles={roles}
      units={units}
      vehicles={vehicles}
      candidates={candidates}
    />
  );
}
