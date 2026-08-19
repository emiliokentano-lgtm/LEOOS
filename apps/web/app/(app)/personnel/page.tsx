import type { Metadata } from 'next';
import { requireActiveOrganization } from '@/lib/session';
import { fetchAssignableRoles, fetchHireCandidates, fetchPersonnel } from '@/lib/personnel';
import { PersonnelView } from './personnel-view';

export const metadata: Metadata = { title: 'Personnel' };

/**
 * Personnel roster.
 *
 * The organization comes from the SESSION, not from a query parameter — and the
 * API scopes every response to the caller's own membership regardless, so a
 * hand-edited URL cannot widen it (engineering rule 11).
 *
 * Search and filtering happen server-side so the browser is never sent rows it
 * is not entitled to and then asked to hide them.
 */
export default async function PersonnelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organization } = await requireActiveOrganization();
  const params = await searchParams;

  const one = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' && value ? value : undefined;
  };

  // The page window is a URL parameter so a roster position survives a reload
  // and can be linked to. It is bounded again by the API.
  const page = Math.max(1, Number(one('page') ?? '1') || 1);
  const pageSize = 50;

  const filters = {
    search: one('search'),
    status: one('status'),
    roleId: one('roleId'),
    dutyStatus: one('dutyStatus'),
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
  };

  const [roster, roles] = await Promise.all([
    fetchPersonnel(organization.id, filters),
    fetchAssignableRoles(organization.id),
  ]);

  // Candidate enumeration reads across accounts, so the API reserves it to
  // whoever may hire. An empty list here means "not offered", and the hire
  // dialog says so rather than showing an empty picker.
  const candidates = roster?.capabilities.canHire
    ? await fetchHireCandidates(organization.id)
    : [];

  return (
    <PersonnelView
      organizationId={organization.id}
      organizationName={organization.name}
      roster={roster}
      roles={roles}
      candidates={candidates}
      filters={filters}
      page={page}
      pageSize={pageSize}
    />
  );
}
