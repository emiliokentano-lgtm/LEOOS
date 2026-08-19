'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Clock, Loader2, Search as SearchIcon, X } from 'lucide-react';
import {
  Alert, Badge, Button, EmptyState, Pagination, Panel, PanelHeader, SearchInput,
} from '@/components/ui';
import { Icon } from '@/components/icon';
import { PageContainer } from '@/components/shell/page-container';
import type { SearchCategory, SearchResponse } from '@/lib/search';

/**
 * Cross-entity search.
 *
 * One field, results grouped by entity. Every result set is filtered by the
 * viewer's permissions SERVER-SIDE, and every search that returns something is
 * written to the audit log — "who looked up whom" is a question this system must
 * be able to answer.
 *
 * A category the viewer cannot search does not appear as a locked filter: it is
 * simply not offered, because the list of filters would otherwise itself
 * describe what exists.
 */

const CATEGORY_LABEL: Record<SearchCategory, string> = {
  persons: 'Persons',
  vehicles: 'Vehicles',
  personnel: 'Personnel',
  organizations: 'Organizations',
  units: 'Units',
  incidents: 'Incidents',
};

const CATEGORY_ICON: Record<SearchCategory, string> = {
  persons: 'Users',
  vehicles: 'Car',
  personnel: 'IdCard',
  organizations: 'Building2',
  units: 'Radio',
  incidents: 'Siren',
};

const RECENT_KEY = 'leoos.recent-searches';


/**
 * Recent searches, read as an EXTERNAL STORE.
 *
 * `localStorage` is not React state, and copying it into state from an effect is
 * both a cascading render and a second copy that can go stale. Subscribing to it
 * keeps one source of truth, and the server snapshot is empty because the server
 * has no browser storage — which is also the correct first paint.
 */
const EMPTY_RECENT: string[] = [];
let recentCache: { raw: string | null; parsed: string[] } = { raw: null, parsed: EMPTY_RECENT };

function subscribeRecent(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener('leoos:recent-searches', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener('leoos:recent-searches', onChange);
  };
}

function recentSnapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(RECENT_KEY);
  } catch {
    return EMPTY_RECENT;
  }
  // Cached by raw string so the snapshot is referentially stable between reads,
  // which `useSyncExternalStore` requires.
  if (raw === recentCache.raw) return recentCache.parsed;

  let parsed: string[] = EMPTY_RECENT;
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    parsed = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : EMPTY_RECENT;
  } catch {
    parsed = EMPTY_RECENT;
  }
  recentCache = { raw, parsed };
  return parsed;
}

function useRecentSearches(): string[] {
  return React.useSyncExternalStore(subscribeRecent, recentSnapshot, () => EMPTY_RECENT);
}

export function SearchView({
  query, category, response, page, pageSize,
}: {
  query: string;
  category: string;
  response: SearchResponse | null;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [term, setTerm] = React.useState(query);
  /**
   * `useTransition` rather than a pending flag reset from an effect.
   *
   * The navigation IS the async work, so React already knows when it is in
   * flight; mirroring that into state and clearing it when new props arrive is a
   * second source of truth that can only drift.
   */
  const [pending, startTransition] = React.useTransition();
  const recent = useRecentSearches();

  const push = React.useCallback((next: URLSearchParams) => {
    startTransition(() => {
      router.replace(next.size > 0 ? `/search?${next.toString()}` : '/search');
    });
  }, [router]);

  const setParam = React.useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value); else next.delete(key);
    // Changing the term or the category invalidates the page number.
    if (key !== 'page') next.delete('page');
    push(next);
  }, [searchParams, push]);

  /**
   * Debounced.
   *
   * A request per keystroke would put six trigram queries per character on the
   * database while an operator types a plate.
   */
  React.useEffect(() => {
    const current = searchParams.get('q') ?? '';
    if (term === current) return;
    const timer = setTimeout(() => setParam('q', term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term, searchParams, setParam]);

  const available = response?.available ?? [];
  const grouped = response?.grouped !== false;
  const results = response?.results ?? [];
  const activeCategory = category === 'all' ? null : (category as SearchCategory);
  const activeResult = activeCategory
    ? results.find((r) => r.category === activeCategory)
    : null;

  return (
    <PageContainer>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        <Panel>
          <div className="flex items-center gap-2">
            {pending
              ? <Loader2 className="size-4 shrink-0 animate-spin text-accent" aria-hidden />
              : <SearchIcon className="size-4 shrink-0 text-text-tertiary" aria-hidden />}
            <SearchInput
              value={term}
              onValueChange={setTerm}
              placeholder="Name, alias, plate, callsign, incident number…"
              className="flex-1"
              aria-label="Search everything"
            />
            {term ? (
              <Button variant="ghost" size="sm" onClick={() => { setTerm(''); router.replace('/search'); }}>
                <X aria-hidden /> Clear
              </Button>
            ) : null}
          </div>

          {available.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <CategoryPill
                label="All"
                count={response?.total}
                active={category === 'all'}
                onClick={() => setParam('category', '')}
              />
              {available.map((c) => (
                <CategoryPill
                  key={c}
                  label={CATEGORY_LABEL[c]}
                  count={results.find((r) => r.category === c)?.total}
                  active={category === c}
                  onClick={() => setParam('category', c)}
                />
              ))}
            </div>
          ) : null}
        </Panel>

        {/* Nothing typed yet. */}
        {!query ? (
          <>
            {recent.length > 0 ? (
              <Panel flush>
                <PanelHeader title="Recent searches" icon={<Clock />}
                  description="Kept in this browser only" />
                <ul className="p-2">
                  {recent.map((t) => (
                    <li key={t}>
                      <button
                        type="button"
                        onClick={() => { setTerm(t); setParam('q', t); }}
                        className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-hover"
                      >
                        <Clock className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : (
              <Panel>
                <EmptyState
                  icon={<SearchIcon />}
                  title="Search everything you have access to"
                  description="Persons, vehicles, personnel, organizations, units and incidents — one field."
                />
              </Panel>
            )}
          </>
        ) : null}

        {/* Typed, but too short. */}
        {query && response?.tooShort ? (
          <Alert tone="info" title="Keep typing">
            Record search starts at {response.minLength} characters. A shorter term would match
            most of the database, which is slower and less useful than no result at all.
          </Alert>
        ) : null}

        {/* The API refused or was unreachable. */}
        {query && !response ? (
          <Alert tone="danger" title="Search is unavailable">
            The service could not be reached. Check your connection and try again.
          </Alert>
        ) : null}

        {/* Results. */}
        {query && response && !response.tooShort ? (
          response.total === 0 ? (
            <Panel>
              <EmptyState
                icon={<SearchIcon />}
                variant="filtered"
                title={`Nothing matches “${query}”`}
                description={activeCategory
                  ? `No ${CATEGORY_LABEL[activeCategory].toLowerCase()} matched. Try another category, or a shorter term.`
                  : 'Try a partial name, a plate fragment, or an incident number.'}
                action={activeCategory
                  ? <Button size="sm" variant="ghost" onClick={() => setParam('category', '')}>
                      Search every category
                    </Button>
                  : undefined}
              />
            </Panel>
          ) : (
            <>
              <p className="text-2xs text-text-tertiary">
                <span className="text-text-secondary">{response.total}</span>
                {response.total === 1 ? ' result' : ' results'}
                {activeCategory ? ` in ${CATEGORY_LABEL[activeCategory].toLowerCase()}` : ''}
                {' · '}filtered by your permissions
              </p>

              {results.map((group) => (
                <Panel key={group.category} flush>
                  <PanelHeader
                    title={CATEGORY_LABEL[group.category]}
                    icon={<Icon name={CATEGORY_ICON[group.category]} />}
                    description={
                      grouped && group.hits.length < group.total
                        ? `${group.hits.length} of ${group.total}`
                        : `${group.total} result${group.total === 1 ? '' : 's'}`
                    }
                    actions={
                      grouped && group.hits.length < group.total ? (
                        <Button
                          size="xs" variant="ghost"
                          onClick={() => setParam('category', group.category)}
                        >
                          See all {group.total}
                        </Button>
                      ) : null
                    }
                  />
                  {group.hits.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-text-tertiary">
                      No {CATEGORY_LABEL[group.category].toLowerCase()} matched.
                    </p>
                  ) : (
                    <ul>
                      {group.hits.map((hit) => (
                        <li key={hit.id}>
                          <Link
                            href={hit.href as never}
                            /**
                             * NOT prefetched.
                             *
                             * Next would otherwise fetch the destination for
                             * every visible result — running real register
                             * queries for records the operator has only seen
                             * the title of. A search that returns twenty rows
                             * would quietly issue twenty lookups nobody asked
                             * for (engineering rule 21).
                             */
                            prefetch={false}
                            className="flex items-start gap-2.5 border-b border-border-subtle px-3 py-2.5 last:border-b-0 hover:bg-hover"
                          >
                            <Icon
                              name={CATEGORY_ICON[group.category]}
                              className="mt-0.5 size-4 shrink-0 text-text-tertiary"
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-sm font-medium text-text-primary">
                                  {hit.title}
                                </span>
                                {hit.organizationKey ? (
                                  <span className="flex items-center gap-1">
                                    <span
                                      className="size-2 shrink-0 rounded-full"
                                      style={{ backgroundColor: hit.organizationColor ?? undefined }}
                                      aria-hidden
                                    />
                                    <span className="font-mono text-2xs text-text-tertiary">
                                      {hit.organizationKey}
                                    </span>
                                  </span>
                                ) : null}
                                {hit.badge ? (
                                  <Badge size="sm" variant={toneVariant(hit.badge.tone)}>
                                    {hit.badge.label}
                                  </Badge>
                                ) : null}
                              </span>
                              {hit.subtitle ? (
                                <span className="truncate text-xs text-text-secondary">
                                  {hit.subtitle}
                                </span>
                              ) : null}
                              {hit.facts.length > 0 ? (
                                <span className="truncate font-mono text-2xs text-text-tertiary">
                                  {hit.facts.join(' · ')}
                                </span>
                              ) : null}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              ))}

              {activeResult && activeResult.total > pageSize ? (
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  totalItems={activeResult.total}
                  onPageChange={(next) => setParam('page', next === 1 ? '' : String(next))}
                />
              ) : null}
            </>
          )
        ) : null}
      </div>
    </PageContainer>
  );
}

function toneVariant(tone: 'danger' | 'warning' | 'success' | 'neutral') {
  return tone === 'danger' ? 'danger'
    : tone === 'warning' ? 'warning'
      : tone === 'success' ? 'success' : 'neutral';
}

function CategoryPill({
  label, count, active, onClick,
}: {
  label: string; count?: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-text-primary'
          : 'border-border-subtle text-text-tertiary hover:border-border hover:text-text-secondary'
      }`}
    >
      {label}
      {typeof count === 'number' ? (
        <span className="font-mono text-2xs text-text-tertiary">{count}</span>
      ) : null}
    </button>
  );
}
