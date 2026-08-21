'use client';

import * as React from 'react';
import { BellOff, CheckCheck, Loader2, Volume2 } from 'lucide-react';
import {
  NOTIFICATION_CATEGORIES, canMuteCategory,
  type NotificationCategory, type NotificationDto, type NotificationSeverity,
} from '@leoos/contracts';
import {
  Alert, Button, Checkbox, EmptyState, ErrorState, FilterChip, Panel, PanelBody, PanelHeader,
  SkeletonRows, Toggle, useToast,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { useNotifications } from '@/components/shell/notification-context';
import { NotificationItem } from '@/components/domain/notification-item';
import { useNow } from '@/lib/map/use-now';
import { cn } from '@/lib/utils';

/**
 * The notification centre.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HEAD OF THE LIST COMES FROM THE SHELL; THE REST IS PAGED HERE
 *
 * The bell already holds the newest page for every screen, so the centre reads
 * it from the same context rather than fetching its own copy — two lists of the
 * same thing is how the badge stops matching the list under it. Paging beyond
 * that head is this screen's own concern, and it uses the API's keyset cursor:
 * notifications arrive AT THE HEAD while the screen is open, and an offset would
 * repeat and skip rows as they do.
 *
 * FILTERING HAPPENS AT THE API, over the whole feed. Filtering the page that
 * happened to be loaded would make "show me every panic" mean "show me the
 * panics among the last twenty rows", which reads as a quiet shift rather than
 * as a filter that did not do what it said.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface Filters {
  category: NotificationCategory | '';
  severity: NotificationSeverity | '';
  unreadOnly: boolean;
}

const EMPTY_FILTERS: Filters = { category: '', severity: '', unreadOnly: false };

const SEVERITIES: { key: NotificationSeverity; label: string }[] = [
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'info', label: 'Info' },
];

export function NotificationCentre() {
  const centre = useNotifications();
  const now = new Date(useNow());

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [filtered, setFiltered] = React.useState<NotificationDto[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [extra, setExtra] = React.useState<NotificationDto[]>([]);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [pageError, setPageError] = React.useState<string | null>(null);

  const active = filters.category !== '' || filters.severity !== '' || filters.unreadOnly;

  const queryFor = React.useCallback((next: string | null): string => {
    const params = new URLSearchParams({ limit: '30' });
    if (filters.category) params.set('category', filters.category);
    if (filters.severity) params.set('severity', filters.severity);
    if (filters.unreadOnly) params.set('unreadOnly', 'true');
    if (next) params.set('cursor', next);
    return `/api/notifications?${params.toString()}`;
  }, [filters]);

  /**
   * A filtered view is a SEPARATE fetch, not a client-side narrowing.
   *
   * When no filter is set the shell's head page is shown directly, so opening
   * the centre costs nothing. The moment a filter is applied the API answers
   * over the whole feed.
   *
   * The effect only ever FETCHES. Clearing the paged state belongs to the act of
   * changing a filter — `applyFilters` below — because that is when it becomes
   * stale; doing it here would mean setting state synchronously in an effect
   * body, which is a cascading render for something the event handler already
   * knows.
   */
  React.useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch(queryFor(null), {
          signal: controller.signal, cache: 'no-store',
        });
        if (cancelled) return;
        if (!res.ok) { setPageError('That view could not be loaded.'); return; }
        const page = await res.json() as {
          notifications: NotificationDto[]; nextCursor: string | null;
        };
        if (cancelled) return;
        setFiltered(page.notifications);
        setExtra([]);
        setCursor(page.nextCursor);
        setPageError(null);
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setPageError('That view could not be loaded.');
        }
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [active, queryFor]);

  /**
   * Changing a filter discards the page that was on screen.
   *
   * The rows below it belong to the previous query, and the cursor points into
   * it — keeping either would splice two different result sets together.
   */
  const applyFilters = React.useCallback((next: (previous: Filters) => Filters) => {
    setFilters(next);
    setFiltered(null);
    setExtra([]);
    setCursor(null);
    setPageError(null);
  }, []);

  const rows = React.useMemo(
    () => [...(filtered ?? centre.notifications), ...extra],
    [filtered, centre.notifications, extra],
  );

  async function loadMore() {
    setLoadingMore(true);
    try {
      const from = cursor ?? cursorFrom(rows);
      const res = await fetch(queryFor(from), { cache: 'no-store' });
      if (!res.ok) { setPageError('The next page could not be loaded.'); return; }
      const page = await res.json() as {
        notifications: NotificationDto[]; nextCursor: string | null;
      };
      setExtra((prev) => [...prev, ...page.notifications]);
      setCursor(page.nextCursor);
      setPageError(null);
    } catch {
      setPageError('The next page could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * The unfiltered head page has no cursor of its own.
   *
   * The shell fetches it without one, so "load more" from that state derives the
   * cursor from the oldest row on screen — the same base64 `(created_at, id)`
   * pair the API would have returned. Encoded here rather than guessed: the
   * format is one place, and this reproduces it exactly.
   */
  function cursorFrom(list: NotificationDto[]): string | null {
    const last = list[list.length - 1];
    if (!last) return null;
    return btoa(`${last.createdAt}|${last.id}`)
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const canLoadMore = cursor !== null || (!active && rows.length >= 20);

  return (
    <PageContainer>
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
        <SoundSettings />

        <Panel>
          <PanelHeader
            title="Notifications"
            description={
              centre.unread.total === 0
                ? 'Everything here has been read.'
                : `${centre.unread.total} unread${
                  centre.unread.critical > 0
                    ? `, ${centre.unread.critical} needing attention now`
                    : ''
                }.`
            }
            actions={
              <Button
                size="sm"
                variant="secondary"
                disabled={centre.unread.total === 0}
                onClick={() => { void centre.markAllRead(); }}
              >
                <CheckCheck aria-hidden />
                Mark all read
              </Button>
            }
          />

          <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-3 py-2">
            <FilterChip
              label="Unread only"
              active={filters.unreadOnly}
              onToggle={() => applyFilters((f) => ({ ...f, unreadOnly: !f.unreadOnly }))}
            />
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {NOTIFICATION_CATEGORIES.map((category) => (
              <FilterChip
                key={category.key}
                label={category.label}
                active={filters.category === category.key}
                onToggle={() => applyFilters((f) => ({
                  ...f, category: f.category === category.key ? '' : category.key,
                }))}
              />
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {SEVERITIES.map((severity) => (
              <FilterChip
                key={severity.key}
                label={severity.label}
                active={filters.severity === severity.key}
                onToggle={() => applyFilters((f) => ({
                  ...f, severity: f.severity === severity.key ? '' : severity.key,
                }))}
              />
            ))}
            {active ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => applyFilters(() => EMPTY_FILTERS)}
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          <PanelBody className="p-1">
            {centre.loading && rows.length === 0 ? (
              <SkeletonRows rows={6} />
            ) : centre.error !== null ? (
              <ErrorState
                title="Notifications are unavailable"
                message={centre.error}
                onRetry={centre.refresh}
              />
            ) : rows.length === 0 ? (
              <EmptyState
                icon="Bell"
                title={active ? 'Nothing matches those filters' : 'No notifications'}
                description={
                  active
                    ? 'The filters are applied over your whole feed, not just this page.'
                    : 'Panic alerts, critical calls and assignments will appear here.'
                }
              />
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle">
                {rows.map((notification) => (
                  <li key={notification.id}>
                    <NotificationItem
                      notification={notification}
                      now={now}
                      onOpen={(n) => {
                        if (n.readAt === null) void centre.markRead([n.id]);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}

            {pageError !== null ? (
              <Alert tone="warning" title="Could not load more" className="m-2">
                {pageError}
              </Alert>
            ) : null}

            {rows.length > 0 && canLoadMore ? (
              <div className="flex justify-center p-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loadingMore}
                  onClick={() => { void loadMore(); }}
                >
                  {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Load older
                </Button>
              </div>
            ) : null}
          </PanelBody>
        </Panel>
      </div>
    </PageContainer>
  );
}

/**
 * Alert and sound settings.
 *
 * A sibling of the list rather than a component nested inside it: declared
 * inside the render, React would treat it as a new component type on every
 * keystroke and remount it, which would drop `saving` mid-request and make the
 * toggles flicker.
 */
function SoundSettings() {
  const centre = useNotifications();
  const toast = useToast();
  const { preferences, savePreferences } = centre;
  const [saving, setSaving] = React.useState(false);

  async function update(patch: Parameters<typeof savePreferences>[0]) {
    setSaving(true);
    const result = await savePreferences(patch);
    setSaving(false);
    if (!result.ok) {
      toast.push({
        tone: 'danger',
        title: 'Your settings were not saved',
        description: result.error,
      });
    }
  }

  return (
    <Panel>
      <PanelHeader
        title="Alerts and sound"
        description="How this console tells you something happened."
      />
      <PanelBody className="flex flex-col gap-3">
        {/*
          * Said in words, on the screen, because it is the property the whole
          * design rests on. An operator who believes sound is the alarm will
          * work with the tab muted and miss a panic.
          */}
        <Alert tone="info" title="Sound is never the alarm">
          Every alert below is shown visually whether or not sound is on: a
          banner, a badge on the bell, and an entry in this list. A panic also
          appears on the map and the dashboard, where it cannot be filtered
          away. Sound is an addition, never the alarm.
        </Alert>

        <div className="flex flex-col gap-2">
          <Toggle
            checked={preferences.soundEnabled}
            disabled={saving}
            onCheckedChange={(soundEnabled) => { void update({ soundEnabled }); }}
            label="Play a sound for alerts"
            description="Off by default. Your browser may also need a click on this page before it will play anything."
          />
          <Toggle
            checked={preferences.soundCriticalOnly}
            disabled={saving || !preferences.soundEnabled}
            onCheckedChange={(soundCriticalOnly) => { void update({ soundCriticalOnly }); }}
            label="Only for critical alerts"
            description="Panic alerts and assignments to a P1 call. Recommended — thirty routine tones an hour is how people end up turning sound off entirely."
          />

          <label className="flex items-center gap-3 py-1">
            <span className="w-32 shrink-0 text-xs text-text-secondary">Volume</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={preferences.soundVolume}
              disabled={saving || !preferences.soundEnabled}
              onChange={(e) => { void update({ soundVolume: Number(e.target.value) }); }}
              className="h-1 flex-1 accent-accent disabled:opacity-40"
            />
            <span className="w-10 shrink-0 text-right font-mono text-2xs text-text-tertiary">
              {preferences.soundVolume}
            </span>
            <Volume2
              className={cn(
                'size-3.5',
                preferences.soundEnabled ? 'text-text-tertiary' : 'text-text-disabled',
              )}
              aria-hidden
            />
          </label>

          <Toggle
            checked={preferences.criticalToasts}
            disabled={saving}
            onCheckedChange={(criticalToasts) => { void update({ criticalToasts }); }}
            label="Show a banner for critical alerts"
            description="Stays on screen until dismissed. The entry appears in this list either way."
          />
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <BellOff className="size-3.5" aria-hidden />
            Stop interrupting me about
          </span>
          <p className="text-2xs text-text-tertiary">
            A muted category still appears in this list and still counts towards
            the badge — muting stops the banner and the sound, it does not hide
            anything from you.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            {NOTIFICATION_CATEGORIES.map((category) => {
              const mutable = canMuteCategory(category.key);
              const muted = preferences.mutedCategories.includes(category.key);
              return (
                <Checkbox
                  key={category.key}
                  checked={muted}
                  disabled={saving || !mutable}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...preferences.mutedCategories, category.key]
                      : preferences.mutedCategories.filter((c) => c !== category.key);
                    void update({ mutedCategories: next });
                  }}
                  label={
                    mutable
                      ? category.label
                      // Not a disabled control with no explanation: the operator
                      // is told WHY, because "why can't I turn this off" is the
                      // question, and the answer is a policy, not a bug.
                      : `${category.label} — always shown`
                  }
                />
              );
            })}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}
