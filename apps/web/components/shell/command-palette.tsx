'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Clock, CornerDownLeft, Loader2, Search, X } from 'lucide-react';
import type { NavSection } from '@/lib/navigation';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { Badge, Modal } from '@/components/ui';
import type { SearchCategory, SearchResponse } from '@/lib/search';

/**
 * Ctrl+K palette — navigation AND global record search.
 *
 * ONE OVERLAY, NOT TWO. The palette already owned the shortcut, the modal and
 * the keyboard model; adding a second global-search overlay beside it would give
 * dispatchers two boxes that look identical and behave differently
 * (engineering rules 3, 4).
 *
 * Below the minimum search length it lists screens, as it always did. At or
 * above it, it also searches the registers — grouped by category, with the true
 * total per group, so "5 of 61" is legible rather than a truncated list
 * pretending to be complete.
 *
 * EVERYTHING SHOWN COMES FROM THE SERVER. Which categories appear, which records
 * are in them and what the counts say are all decided by the API against the
 * caller's permissions — this component cannot widen any of it, and does not try.
 */

interface CommandPaletteContextValue {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const CommandPaletteContext = React.createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  return ctx;
}

interface Command {
  id: string;
  label: string;
  icon: string;
  href: string;
  group: string;
}

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
const RECENT_LIMIT = 6;

/**
 * Recent searches live in THIS BROWSER only.
 *
 * They are the operator's own trail, not an operational record — keeping a
 * server-side history of what every user typed would create a second, softer
 * copy of who looked up whom, and one with no permission model of its own. The
 * audit log already answers that question, under the rules that belong to it.
 */
function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(terms: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(terms.slice(0, RECENT_LIMIT)));
  } catch {
    // A browser with storage disabled simply gets no history.
  }
}

export function CommandPaletteProvider({
  sections, children,
}: {
  sections: NavSection[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [rawActiveIndex, setActiveIndex] = React.useState(0);
  const [categoryFilter, setCategoryFilter] = React.useState<'all' | SearchCategory>('all');
  /**
   * ONE state slot, tagged with the request it answers.
   *
   * Clearing `search`/`searching`/`failed` in the effect body when the term goes
   * back below the minimum is a synchronous setState inside an effect — a
   * cascading render, and a lint error. Tagging the result with the query and
   * category it was fetched for makes "is this stale" derivable instead, so the
   * only setState left is the one in the fetch callback.
   */
  const [fetched, setFetched] = React.useState<
    { key: string; body: SearchResponse | null } | null
  >(null);
  const [recent, setRecent] = React.useState<string[]>([]);

  const commands = React.useMemo<Command[]>(
    () =>
      sections.flatMap((section) =>
        section.items.map((item) => ({
          id: item.href,
          label: item.label,
          icon: item.icon,
          href: item.href,
          group: section.label ?? 'Operations',
        })),
      ),
    [sections],
  );

  const trimmed = query.trim();
  /**
   * Mirrors the server's `MIN_SEARCH_LENGTH`. The server enforces it regardless
   * — this only decides when to bother asking.
   */
  const MIN_LENGTH = 2;
  const isSearching = trimmed.length >= MIN_LENGTH;

  const screenMatches = React.useMemo(() => {
    if (!trimmed) return commands;
    const q = trimmed.toLowerCase();
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  }, [commands, trimmed]);

  /**
   * Debounced.
   *
   * A request per keystroke would put six trigram queries per character on the
   * database while an operator is typing a plate. 250 ms is short enough to feel
   * instant and long enough that a typed word is one request, not eight.
   */
  const requestKey = `${categoryFilter}:${trimmed}`;

  React.useEffect(() => {
    if (!isOpen) return;
    if (trimmed.length < 2) return;

    const controller = new AbortController();
    const key = requestKey;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      if (categoryFilter !== 'all') params.set('category', categoryFilter);

      fetch(`/api/search?${params.toString()}`, {
        cache: 'no-store', signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((body: SearchResponse) => setFetched({ key, body }))
        .catch((error: unknown) => {
          if ((error as { name?: string })?.name === 'AbortError') return;
          setFetched({ key, body: null });
        });
    }, 250);

    return () => { controller.abort(); clearTimeout(timer); };
  }, [isOpen, trimmed, categoryFilter, requestKey]);

  // Derived, not stored: a result for a different term is simply not this one's.
  const current = fetched?.key === requestKey ? fetched : null;
  const search = trimmed.length >= 2 ? (current?.body ?? null) : null;
  const searching = trimmed.length >= 2 && current === null;
  const failed = current !== null && current.body === null;

  const open = React.useCallback(() => {
    setQuery('');
    setActiveIndex(0);
    setCategoryFilter('all');
    setFetched(null);
    setRecent(readRecent());
    setIsOpen(true);
  }, []);

  const close = React.useCallback(() => setIsOpen(false), []);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((prev) => {
          if (!prev) {
            setQuery('');
            setActiveIndex(0);
            setCategoryFilter('all');
            setFetched(null);
            setRecent(readRecent());
          }
          return !prev;
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * One flat list of everything selectable, so the arrow keys work across
   * groups without the caller having to know which group they are in.
   */
  interface Row {
    key: string;
    kind: 'screen' | 'hit';
    href: string;
    command?: Command;
    hit?: SearchResponse['results'][number]['hits'][number];
  }

  const rows = React.useMemo<Row[]>(() => {
    if (!isSearching) {
      return screenMatches.map((c) => ({
        key: `screen:${c.id}`, kind: 'screen' as const, href: c.href, command: c,
      }));
    }

    const hitRows: Row[] = (search?.results ?? []).flatMap((group) =>
      group.hits.map((hit) => ({
        key: `${group.category}:${hit.id}`, kind: 'hit' as const, href: hit.href, hit,
      })),
    );

    // Screens stay reachable while searching — "dispatch" should still jump to
    // the dispatch board, not only find incidents mentioning it.
    return [
      ...hitRows,
      ...screenMatches.slice(0, 3).map((c) => ({
        key: `screen:${c.id}`, kind: 'screen' as const, href: c.href, command: c,
      })),
    ];
  }, [isSearching, screenMatches, search]);

  /**
   * CLAMPED, not reset from an effect.
   *
   * When the result set shrinks the stored index can point past the end; taking
   * the minimum at render keeps the highlight valid without a cascading render,
   * and the handlers that change the query reset it to 0 explicitly.
   */
  const activeIndex = Math.min(rawActiveIndex, Math.max(0, rows.length - 1));

  const go = React.useCallback((href: string, term?: string) => {
    if (term && term.length >= 2) {
      const next = [term, ...readRecent().filter((t) => t !== term)];
      writeRecent(next);
    }
    setIsOpen(false);
    router.push(href as never);
  }, [router]);

  const value = React.useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  const available = search?.available ?? [];
  const grouped = search?.results ?? [];

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <Modal
        open={isOpen}
        onOpenChange={setIsOpen}
        title="Search"
        description="Find a person, vehicle, unit, incident or screen."
        size="lg"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-xs border border-border bg-raised px-2.5">
            {searching
              ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
              : <Search className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />}
            <input
              autoFocus
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const row = rows[activeIndex];
                  if (row) go(row.href, isSearching ? trimmed : undefined);
                  else if (isSearching) go(`/search?q=${encodeURIComponent(trimmed)}`, trimmed);
                }
              }}
              placeholder="Name, plate, callsign, incident number, or a screen…"
              aria-label="Global search"
              className="h-9 w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="text-text-tertiary hover:text-text-primary"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>

          {/* Category filters. Only the categories this caller may search. */}
          {available.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1">
              <FilterPill
                label="All"
                count={search?.total}
                active={categoryFilter === 'all'}
                onClick={() => setCategoryFilter('all')}
              />
              {available.map((c) => (
                <FilterPill
                  key={c}
                  label={CATEGORY_LABEL[c]}
                  count={grouped.find((g) => g.category === c)?.total}
                  active={categoryFilter === c}
                  onClick={() => setCategoryFilter(c)}
                />
              ))}
            </div>
          ) : null}

          <ul className="max-h-[420px] overflow-auto" role="listbox" aria-label="Search results">
            {/* Recent searches, before anything is typed. */}
            {!trimmed && recent.length > 0 ? (
              <li>
                <GroupHeader label="Recent searches" />
                <ul>
                  {recent.map((term) => (
                    <li key={term}>
                      <button
                        type="button"
                        onClick={() => setQuery(term)}
                        className="flex w-full items-center gap-2.5 rounded-xs px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-hover"
                      >
                        <Clock className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                        <span className="truncate">{term}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}

            {failed ? (
              <li className="px-2 py-6 text-center text-xs text-danger">
                Search is unavailable. Check your connection and try again.
              </li>
            ) : null}

            {isSearching && searching && rows.length === 0 ? (
              <li className="flex items-center justify-center gap-2 px-2 py-6 text-xs text-text-tertiary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Searching…
              </li>
            ) : null}

            {isSearching && !searching && !failed && rows.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-text-tertiary">
                Nothing matches “{trimmed}”.
                <span className="mt-1 block text-2xs">
                  Try a partial name, a plate fragment, or an incident number.
                </span>
              </li>
            ) : null}

            {!isSearching && trimmed && screenMatches.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-text-tertiary">
                Keep typing — record search starts at {MIN_LENGTH} characters.
              </li>
            ) : null}

            {/* Grouped record results. */}
            {isSearching
              ? grouped.map((group) => (
                <li key={group.category}>
                  <GroupHeader
                    label={CATEGORY_LABEL[group.category]}
                    count={group.total}
                    shown={group.hits.length}
                  />
                  <ul>
                    {group.hits.map((hit) => {
                      const index = rows.findIndex(
                        (r) => r.key === `${group.category}:${hit.id}`,
                      );
                      return (
                        <li key={hit.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === activeIndex}
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => go(hit.href, trimmed)}
                            className={cn(
                              'flex w-full items-start gap-2.5 rounded-xs px-2 py-2 text-left',
                              index === activeIndex ? 'bg-hover' : '',
                            )}
                          >
                            <Icon
                              name={CATEGORY_ICON[group.category]}
                              className="mt-0.5 size-4 shrink-0 text-text-tertiary"
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-sm text-text-primary">
                                  {hit.title}
                                </span>
                                {hit.organizationKey ? (
                                  <span
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: hit.organizationColor ?? undefined }}
                                    aria-hidden
                                  />
                                ) : null}
                                {hit.badge ? (
                                  <Badge size="sm" variant={toneVariant(hit.badge.tone)}>
                                    {hit.badge.label}
                                  </Badge>
                                ) : null}
                              </span>
                              {hit.subtitle ? (
                                <span className="truncate text-2xs text-text-secondary">
                                  {hit.subtitle}
                                </span>
                              ) : null}
                              {hit.facts.length > 0 ? (
                                <span className="truncate font-mono text-2xs text-text-tertiary">
                                  {hit.facts.join(' · ')}
                                </span>
                              ) : null}
                            </span>
                            {index === activeIndex ? (
                              <CornerDownLeft
                                className="mt-1 size-3 shrink-0 text-text-tertiary"
                                aria-hidden
                              />
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
              : null}

            {/* Screens. */}
            {(!isSearching ? screenMatches : screenMatches.slice(0, 3)).length > 0 ? (
              <li>
                {isSearching ? <GroupHeader label="Screens" /> : null}
                <ul>
                  {(!isSearching ? screenMatches : screenMatches.slice(0, 3)).map((cmd) => {
                    const index = rows.findIndex((r) => r.key === `screen:${cmd.id}`);
                    return (
                      <li key={cmd.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === activeIndex}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => go(cmd.href)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-xs px-2 py-2 text-left text-sm',
                            index === activeIndex
                              ? 'bg-hover text-text-primary'
                              : 'text-text-secondary',
                          )}
                        >
                          <Icon name={cmd.icon} className="size-4 shrink-0 text-text-tertiary" />
                          <span>{cmd.label}</span>
                          <span className="ml-auto text-2xs text-text-tertiary">{cmd.group}</span>
                          {index === activeIndex ? (
                            <CornerDownLeft
                              className="size-3 shrink-0 text-text-tertiary"
                              aria-hidden
                            />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ) : null}
          </ul>

          {isSearching && search && search.total > 0 ? (
            <button
              type="button"
              onClick={() => go(`/search?q=${encodeURIComponent(trimmed)}`, trimmed)}
              className="flex items-center justify-center gap-1.5 border-t border-border-subtle pt-2 text-2xs text-text-tertiary hover:text-text-primary"
            >
              See all {search.total} result{search.total === 1 ? '' : 's'} on the search page
              <CornerDownLeft className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
      </Modal>
    </CommandPaletteContext.Provider>
  );
}

function toneVariant(tone: 'danger' | 'warning' | 'success' | 'neutral') {
  return tone === 'danger' ? 'danger'
    : tone === 'warning' ? 'warning'
      : tone === 'success' ? 'success' : 'neutral';
}

function GroupHeader({
  label, count, shown,
}: {
  label: string; count?: number; shown?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-2">
      <span className="text-2xs font-semibold uppercase tracking-wide text-text-tertiary">
        {label}
      </span>
      {typeof count === 'number' ? (
        <span className="font-mono text-2xs text-text-tertiary">
          {/* "5 of 61" — a truncated list that says "5" pretends to be complete. */}
          {typeof shown === 'number' && shown < count ? `${shown} of ${count}` : count}
        </span>
      ) : null}
    </div>
  );
}

function FilterPill({
  label, count, active, onClick,
}: {
  label: string; count?: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors',
        active
          ? 'border-accent bg-accent/10 text-text-primary'
          : 'border-border-subtle text-text-tertiary hover:border-border hover:text-text-secondary',
      )}
    >
      {label}
      {typeof count === 'number' ? (
        <span className="font-mono text-text-tertiary">{count}</span>
      ) : null}
    </button>
  );
}
