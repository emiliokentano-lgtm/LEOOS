import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchPersons } from '@/lib/persons';
import { PersonsView } from './persons-view';

export const metadata: Metadata = { title: 'Persons' };

/**
 * Person register.
 *
 * Search, filtering and paging all happen SERVER-SIDE. The browser is never sent
 * the register and asked to filter it: a hidden row is still a row that left the
 * database, and the register is the largest table in the system
 * (engineering rules 9, 21).
 */
export default async function PersonsPage({
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
    status: one('status'),
    dateOfBirth: one('dob'),
    onlyFlagged: one('flagged'),
    onlyWanted: one('wanted'),
    includeArchived: one('archived'),
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
  };

  const list = await fetchPersons(filters);

  return (
    <PersonsView
      list={list}
      filters={filters}
      page={page}
      pageSize={pageSize}
    />
  );
}
