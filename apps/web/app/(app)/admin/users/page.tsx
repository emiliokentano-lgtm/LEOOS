import type { Metadata } from 'next';
import { requireAdminCapabilities } from '../guard';
import { fetchAdminUsers, fetchAccountStatuses } from '@/lib/admin';
import { fetchOrganizations } from '@/lib/organizations';
import { AdminUsersView } from './admin-users-view';
import type { AccountStatus, GlobalCapabilityKey } from '@leoos/contracts';

export const metadata: Metadata = { title: 'User accounts' };

/**
 * The account register.
 *
 * Search, filtering and paging all happen SERVER-SIDE, for the same reason the
 * person register does it: the browser is never handed the whole account list
 * and asked to filter it. A hidden row is still a row that left the database,
 * and this is the most sensitive table in the system.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCapabilities('canAdministerUsers');
  const params = await searchParams;

  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value ? value : undefined;
  };

  const page = Math.max(1, Number(one('page') ?? '1') || 1);
  const pageSize = 25;

  const query = {
    search: one('search'),
    status: one('status') as AccountStatus | undefined,
    capability: one('capability') as GlobalCapabilityKey | undefined,
    organizationId: one('org'),
    unaffiliated: one('unaffiliated') === '1' ? true : undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };

  const [list, statuses, organizations] = await Promise.all([
    fetchAdminUsers(query),
    fetchAccountStatuses(),
    fetchOrganizations(false),
  ]);

  return (
    <AdminUsersView
      list={list}
      statuses={statuses}
      organizations={organizations}
      filters={{
        search: query.search ?? '',
        status: query.status ?? '',
        capability: query.capability ?? '',
        org: query.organizationId ?? '',
        unaffiliated: query.unaffiliated === true,
      }}
      page={page}
      pageSize={pageSize}
    />
  );
}
