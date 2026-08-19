import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchOrganizationOptions, fetchVehicles } from '@/lib/vehicles';
import { VehiclesView } from './vehicles-view';

export const metadata: Metadata = { title: 'Vehicles' };

/**
 * Vehicle register.
 *
 * Search, filtering and paging are server-side, as for persons — a plate lookup
 * must not require shipping the register to the browser first.
 */
export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const params = await searchParams;

  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value ? value : undefined;
  };

  const page = Math.max(1, Number(one('page') ?? '1') || 1);
  const pageSize = 25;

  const filters = {
    search: one('search'),
    registrationStatus: one('registration'),
    insuranceStatus: one('insurance'),
    onlyFleet: one('fleet'),
    onlyFlagged: one('flagged'),
    includeArchived: one('archived'),
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
  };

  const [list, organizations] = await Promise.all([
    fetchVehicles(filters),
    fetchOrganizationOptions(),
  ]);

  return (
    <VehiclesView
      list={list}
      organizations={organizations}
      filters={filters}
      page={page}
      pageSize={pageSize}
    />
  );
}
