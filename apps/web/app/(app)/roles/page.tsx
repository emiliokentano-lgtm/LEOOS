import type { Metadata } from 'next';
import { requireActiveOrganization } from '@/lib/session';
import { fetchPermissionCatalogue, fetchRoles } from '@/lib/roles';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Roles' };

/**
 * Role and permission management.
 *
 * The organization comes from the SESSION, and the API scopes every response to
 * the caller's own membership regardless, so a hand-edited URL cannot widen it.
 *
 * The permission catalogue is fetched from the API rather than imported from
 * `@leoos/contracts` here: the server marks which keys THIS caller may grant,
 * and a bundled copy could drift from the deployed server's idea of what exists.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organization } = await requireActiveOrganization();
  const params = await searchParams;
  const showArchived = params.archived === 'true';

  const [list, catalogue] = await Promise.all([
    fetchRoles(organization.id, showArchived),
    fetchPermissionCatalogue(organization.id),
  ]);

  return (
    <RolesView
      organizationId={organization.id}
      organizationName={organization.name}
      list={list}
      catalogue={catalogue}
      showArchived={showArchived}
    />
  );
}
