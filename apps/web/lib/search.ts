import 'server-only';
import { apiFetch } from './api-client';

/**
 * Global search data access.
 *
 * A thin pass-through. Which categories the caller may search, and what is in
 * them, is decided entirely by the API — nothing here filters or hides
 * (ADR-0001, engineering rule 9).
 */

export type SearchCategory =
  | 'persons' | 'vehicles' | 'personnel' | 'organizations' | 'units' | 'incidents';

export interface SearchHit {
  category: SearchCategory;
  id: string;
  title: string;
  subtitle: string | null;
  facts: string[];
  href: string;
  organizationKey: string | null;
  organizationColor: string | null;
  badge: { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' } | null;
}

export interface SearchCategoryResult {
  category: SearchCategory;
  total: number;
  hits: SearchHit[];
}

export interface SearchResponse {
  query: string;
  tooShort: boolean;
  minLength: number;
  /** Categories this caller may search at all — used to render the filters. */
  available: SearchCategory[];
  grouped?: boolean;
  limit?: number;
  offset?: number;
  total: number;
  results: SearchCategoryResult[];
}

export interface SearchParams {
  q: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export async function fetchSearch(params: SearchParams): Promise<SearchResponse | null> {
  const query = new URLSearchParams({ q: params.q });
  if (params.category && params.category !== 'all') query.set('category', params.category);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));

  const res = await apiFetch<SearchResponse>(`/api/v1/search?${query.toString()}`);
  return res.ok && res.data ? res.data : null;
}
