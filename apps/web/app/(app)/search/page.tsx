import type { Metadata } from 'next';
import { requireSession } from '@/lib/session';
import { fetchSearch } from '@/lib/search';
import { SearchView } from './search-view';

export const metadata: Metadata = { title: 'Search' };

/**
 * Cross-entity search.
 *
 * Server-rendered from the URL, so a search can be linked to, reloaded and
 * shared — and so the first paint already has results rather than a spinner that
 * turns into them.
 *
 * Every result set and every count is filtered by the API against the caller's
 * permissions. This page decides nothing.
 */
export default async function SearchPage({
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

  const query = one('q') ?? '';
  const category = one('category') ?? 'all';
  const page = Math.max(1, Number(one('page') ?? '1') || 1);
  const pageSize = 25;

  const response = query
    ? await fetchSearch({
      q: query,
      category,
      ...(category !== 'all' ? { limit: pageSize, offset: (page - 1) * pageSize } : {}),
    })
    : null;

  return (
    <SearchView
      query={query}
      category={category}
      response={response}
      page={page}
      pageSize={pageSize}
    />
  );
}
