'use client';

import * as React from 'react';
import { Plus, Radio, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  BACKSTOP_POLL_MS, DISPATCH_POLL_MS, EMPTY_DISPATCH_FILTER, INCIDENT_STATUSES, PRIORITY_LIST,
  compareIncidentsForQueue, countActiveDispatchFilters, matchesDispatchIncident,
  type DispatchBoard, type DispatchFilterState, type DispatchIncidentSummary,
} from '@leoos/contracts';
import {
  Alert, Badge, Button, EmptyState, FilterBar, FilterChip, Panel, PanelHeader,
  SearchInput, Tabs, TabsList, TabsTrigger, useToast,
} from '@/components/ui';
import { HttpDispatchSource, type DispatchConnectionState } from '@/lib/dispatch/dispatch-source';
import { useRealtimeRefresh, useRealtimeStatus } from '@/lib/realtime/realtime-context';
import { BOARD_EVENTS, dispatchTopics } from '@/lib/realtime/topics';
import { useAuth } from '@/components/shell/auth-context';
import { useNow } from '@/lib/map/use-now';
import { cn, formatElapsed } from '@/lib/utils';
import { StatusControl } from './status-control';
import { PanicBanner } from './panic-banner';
import { IncidentDetailPanel } from './incident-detail';
import { UnitBoard } from './unit-board';
import { NewIncidentDialog } from './new-incident-dialog';

/**
 * The Leitstelle — the densest screen in the product.
 *
 * Three columns on one 1920×1080 display without scrolling the page:
 *   queue (left) · selected incident and its timeline (centre) · units (right)
 *
 * Each column scrolls independently. Everything on it is server state arriving
 * through `DispatchDataSource`; nothing here is a local toggle that another
 * operator cannot see.
 */
export function DispatchView({
  initialBoard, focusUnitId = null,
}: {
  initialBoard: DispatchBoard | null;
  /** A unit to scroll to and mark on the board — see the page's `?unit=`. */
  focusUnitId?: string | null;
}) {
  const [board, setBoard] = React.useState<DispatchBoard | null>(initialBoard);
  const [connection, setConnection] = React.useState<DispatchConnectionState>('connecting');
  const [connectionDetail, setConnectionDetail] = React.useState<string | null>(null);

  const [filter, setFilter] = React.useState<DispatchFilterState>(EMPTY_DISPATCH_FILTER);
  const [tab, setTab] = React.useState('open');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const sourceRef = React.useRef<HttpDispatchSource | null>(null);
  const now = useNow();
  const toast = useToast();
  const auth = useAuth();
  const realtime = useRealtimeStatus();

  // ── Feed ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    const feed = new HttpDispatchSource();
    sourceRef.current = feed;
    feed.start({
      onBoard: setBoard,
      onStateChange(state, detail) {
        setConnection(state);
        setConnectionDetail(detail);
      },
    });
    return () => feed.stop();
  }, []);

  React.useEffect(() => {
    sourceRef.current?.setIncludeClosed(tab === 'closed');
  }, [tab]);

  const refresh = React.useCallback(() => sourceRef.current?.refresh(), []);

  // ── Live updates ────────────────────────────────────────────────────────
  //
  // An event says the board moved; the authorized read says what it moved to.
  // The board is NOT patched from event payloads — a payload rich enough to
  // patch it would have to carry a caller's phone number and an incident
  // description to every console subscribed to the topic.
  const topics = React.useMemo(
    () => dispatchTopics({ userId: auth.userId, organizationId: auth.activeOrganizationId }),
    [auth.userId, auth.activeOrganizationId],
  );
  useRealtimeRefresh(topics, refresh, { interestingTypes: BOARD_EVENTS });

  // While the socket carries the board, the poll becomes a slow backstop rather
  // than the mechanism — see dispatch-source.ts for why it is not switched off.
  React.useEffect(() => {
    sourceRef.current?.setPollMs(
      realtime.state === 'live' ? BACKSTOP_POLL_MS : DISPATCH_POLL_MS,
    );
  }, [realtime.state]);

  // ── Derived ─────────────────────────────────────────────────────────────
  // Memoised: a fresh array identity every render would re-run the queue memo
  // and re-bind effects on every poll, which is every four seconds.
  const incidents = React.useMemo(() => board?.incidents ?? [], [board]);
  const units = React.useMemo(() => board?.units ?? [], [board]);
  const panics = React.useMemo(() => board?.panics ?? [], [board]);
  const capabilities = board?.capabilities ?? null;
  const self = board?.self ?? null;

  const queue = React.useMemo(() => {
    return incidents
      .filter((i) => {
        const open = INCIDENT_STATUSES[i.status].isOpen;
        if (tab === 'open' && !open) return false;
        if (tab === 'unassigned' && (!open || i.assignedUnitIds.length > 0)) return false;
        if (tab === 'closed' && open) return false;
        return matchesDispatchIncident(i, filter, self?.unitId ?? null);
      })
      .sort(compareIncidentsForQueue);
  }, [incidents, tab, filter, self?.unitId]);

  /**
   * The selection is DERIVED, not synchronised.
   *
   * A call that leaves the board — closed while the queue shows only open ones —
   * simply resolves to null and the panel returns to its empty state. An effect
   * clearing `selectedId` would do the same thing a render later, and would
   * fight the operator if they switch to the Closed tab to keep reading it.
   */
  const selected = incidents.find((i) => i.id === selectedId) ?? null;

  /**
   * KEYBOARD NAVIGATION OF THE QUEUE.
   *
   * ────────────────────────────────────────────────────────────────────────
   * A dispatcher works this board with one hand on a radio. Every call had to
   * be reached by pointing at it, which is the wrong instrument for the busiest
   * list in the product — and the reason a control room uses a keyboard at all.
   *
   *   ↑ / ↓   move through the queue, in the order it is already sorted:
   *           worst priority first, unassigned ahead of assigned, oldest first
   *           within a tie. So "down" always means "next most important".
   *   Enter   opens the highlighted call's detail — which is where it already
   *           goes on selection, so this is really about not losing the
   *           selection when the list re-sorts under a live update.
   *   Esc     clears the selection.
   *   J / K   the same as ↓ / ↑, for anyone who expects them.
   *
   * Typing in a field is excluded, or filtering the queue for a street called
   * "Kearny" would walk the selection while you spell it.
   * ────────────────────────────────────────────────────────────────────────
   */
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const down = event.key === 'ArrowDown' || event.key === 'j';
      const up = event.key === 'ArrowUp' || event.key === 'k';
      if (!down && !up && event.key !== 'Escape') return;

      if (event.key === 'Escape') {
        setSelectedId(null);
        return;
      }
      if (queue.length === 0) return;
      event.preventDefault();

      const index = queue.findIndex((i) => i.id === selectedId);
      // No selection yet: down starts at the top of the queue — the most
      // important call — and up starts at the bottom.
      const next = index === -1
        ? (down ? 0 : queue.length - 1)
        : Math.min(queue.length - 1, Math.max(0, index + (down ? 1 : -1)));
      setSelectedId(queue[next]!.id);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [queue, selectedId]);

  const counts = board?.counts ?? null;
  const activeFilters = countActiveDispatchFilters(filter);

  function toggleIn<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  if (board === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert tone="danger" title="Dispatch is unavailable" className="max-w-lg">
          The dispatch service could not be reached. Nothing shown elsewhere should be
          treated as current.
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Panic is the first thing on the screen, above the filters. It is the
          only thing here that can outrank whatever the operator is doing. */}
      {panics.length > 0 ? (
        <PanicBanner
          panics={panics}
          canAcknowledge={capabilities?.canAcknowledgePanic ?? false}
          onChanged={refresh}
        />
      ) : null}

      {connection === 'reconnecting' || connection === 'failed' ? (
        <div className="px-3 pt-3">
          <Alert
            tone={connection === 'failed' ? 'danger' : 'warning'}
            title={connection === 'failed' ? 'Dispatch feed stopped' : 'Reconnecting'}
          >
            {connectionDetail ?? 'The board may be out of date.'}
          </Alert>
        </div>
      ) : null}

      <FilterBar
        activeCount={activeFilters}
        onClearAll={() => setFilter(EMPTY_DISPATCH_FILTER)}
        trailing={
          <>
            <SearchInput
              value={filter.query}
              onValueChange={(query) => setFilter((f) => ({ ...f, query }))}
              placeholder="Find a call…"
              inputSize="sm"
              className="w-[190px]"
            />
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw aria-hidden /> Refresh
            </Button>
            {capabilities?.canCreateIncident ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden /> New call
              </Button>
            ) : null}
          </>
        }
      >
        <span className="mr-1 text-2xs uppercase tracking-wide text-text-tertiary">Priority</span>
        {PRIORITY_LIST.map((p) => (
          <FilterChip
            key={p.value}
            label={p.label}
            title={`${p.name} — ${p.description}`}
            color={`var(${p.token})`}
            active={filter.priorities.includes(p.value)}
            count={incidents.filter((i) => i.priority === p.value
              && INCIDENT_STATUSES[i.status].isOpen).length}
            onToggle={() => setFilter((f) => ({
              ...f, priorities: toggleIn(f.priorities, p.value),
            }))}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <FilterChip
          label="My unit's calls"
          active={filter.onlyMine}
          onToggle={() => setFilter((f) => ({ ...f, onlyMine: !f.onlyMine }))}
        />
      </FilterBar>

      {counts !== null ? <CountsStrip counts={counts} /> : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(300px,360px)] gap-3 p-3">
        {/* Queue */}
        <Panel flush className="min-h-0">
          <PanelHeader
            title="Call queue"
            actions={
              <span className="flex items-center gap-2">
                {/* The shortcut is stated where it applies. A keyboard path
                    nobody knows about is a keyboard path nobody uses. */}
                <span className="hidden items-center gap-1 text-2xs text-text-tertiary lg:flex">
                  <kbd className="rounded-xs border border-border px-1">↑</kbd>
                  <kbd className="rounded-xs border border-border px-1">↓</kbd>
                  to move
                </span>
                <Badge variant="neutral" mono>{queue.length}</Badge>
              </span>
            }
          />
          <div className="border-b border-border-subtle px-2 pb-2">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="open">Open</TabsTrigger>
                <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
                <TabsTrigger value="closed">Closed</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {queue.length === 0 ? (
              <EmptyState
                variant={activeFilters > 0 ? 'filtered' : 'empty'}
                title={activeFilters > 0 ? 'No calls match' : 'No calls'}
                description={activeFilters > 0
                  ? 'Adjust the filters above.'
                  : tab === 'closed' ? 'No closed calls in the recent window.' : 'The board is clear.'}
              />
            ) : (
              queue.map((incident) => (
                <QueueRow
                  key={incident.id}
                  incident={incident}
                  now={now}
                  selected={incident.id === selectedId}
                  isMine={self?.unitId !== null && self?.unitId !== undefined
                    && incident.assignedUnitIds.includes(self.unitId)}
                  onSelect={() => setSelectedId(incident.id)}
                />
              ))
            )}
          </div>
        </Panel>

        {/* Detail */}
        <div className="flex min-h-0 flex-col">
          {selected === null ? (
            <Panel className="min-h-0 flex-1">
              <EmptyState
                icon={<Radio aria-hidden />}
                title="No call selected"
                description="Choose a call from the queue to see its detail and timeline."
              />
            </Panel>
          ) : (
            <IncidentDetailPanel
              key={selected.id}
              summary={selected}
              units={units}
              capabilities={capabilities}
              onChanged={refresh}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>

        {/* Right column: self, then units */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          {self !== null ? (
            <StatusControl
              self={self}
              statuses={board.statuses}
              units={units}
              onChanged={refresh}
            />
          ) : null}
          <UnitBoard
            units={units}
            selfUnitId={self?.unitId ?? null}
            focusedUnitId={focusUnitId}
            canManage={capabilities?.canManageUnits ?? false}
            onChanged={refresh}
            onSelectIncident={setSelectedId}
          />
        </div>
      </div>

      {creating ? (
        <NewIncidentDialog
          incidentTypes={board.incidentTypes}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
            toast.push({ tone: 'success', title: 'Call created' });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The board header.
 *
 * Exactly the figures the brief asks for, computed server-side over the rows
 * this caller may see. Counts are shown next to the lists they describe, so a
 * count that disagreed with its list would be visible immediately — which is
 * why they are derived from the same payload rather than queried separately.
 */
function CountsStrip({ counts }: { counts: NonNullable<DispatchBoard['counts']> }) {
  const items: { label: string; value: number; tone?: 'danger' | 'warning' }[] = [
    { label: 'Open', value: counts.openIncidents },
    { label: 'Unassigned', value: counts.unassignedIncidents, tone: counts.unassignedIncidents > 0 ? 'warning' : undefined },
    { label: 'Critical', value: counts.criticalIncidents, tone: counts.criticalIncidents > 0 ? 'danger' : undefined },
    { label: 'Available', value: counts.unitsAvailable },
    { label: 'Busy', value: counts.unitsBusy },
    { label: 'In operation', value: counts.unitsInOperation },
    { label: 'At HQ', value: counts.unitsAtHq },
    { label: 'Panic', value: counts.unitsPanic, tone: counts.unitsPanic > 0 ? 'danger' : undefined },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border-subtle px-3 py-1.5">
      {items.map((item) => (
        <span key={item.label} className="flex items-baseline gap-1.5 text-xs">
          <span
            className={cn(
              'font-mono text-sm font-semibold tabular',
              item.tone === 'danger' ? 'text-danger'
                : item.tone === 'warning' ? 'text-warning' : 'text-text-primary',
            )}
          >
            {item.value}
          </span>
          <span className="text-text-tertiary">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function QueueRow({
  incident, now, selected, isMine, onSelect,
}: {
  incident: DispatchIncidentSummary;
  now: number;
  selected: boolean;
  isMine: boolean;
  onSelect: () => void;
}) {
  /**
   * Keep the selected call on screen.
   *
   * Arrowing through a queue longer than the panel is pointless if the
   * selection walks off the bottom. `block: 'nearest'` scrolls only when it has
   * to, so clicking a row that is already visible does not jump the list under
   * the pointer.
   */
  const rowRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const status = INCIDENT_STATUSES[incident.status];
  const priority = PRIORITY_LIST[incident.priority - 1]!;
  const unassigned = incident.assignedUnitIds.length === 0 && status.isOpen;

  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-2 border-b border-border-subtle px-3 py-2 text-left',
        'transition-colors duration-(--duration-fast)',
        // The selected row is marked by a LEADING RULE as well as a tint. The
        // tint had to come down for contrast (see globals.css), and a rule is
        // the clearer signal on a dense list anyway — it survives greyscale and
        // does not compete with the priority stripe for attention.
        selected ? 'border-l-2 border-l-accent bg-active pl-[10px]' : 'hover:bg-hover',
      )}
    >
      {/* A priority stripe, so the queue is scannable by shape before colour. */}
      <span
        className="mt-0.5 w-1 shrink-0 self-stretch rounded-full"
        style={{ backgroundColor: `var(${priority.token})` }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-2xs text-text-tertiary">{incident.number}</span>
          <span
            className="rounded-[2px] px-1 text-[10px] font-semibold"
            style={{ color: `var(${priority.token})` }}
          >
            {priority.label}
          </span>
          {isMine ? (
            <span className="text-[9px] uppercase tracking-wide text-accent">mine</span>
          ) : null}
          <span className="ml-auto font-mono text-2xs text-text-tertiary">
            {now === 0 ? '—' : formatElapsed(new Date(incident.createdAt), new Date(now))}
          </span>
        </div>
        <p className="truncate text-xs font-medium text-text-primary">{incident.title}</p>
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <span style={{ color: `var(${status.token})` }}>{status.label}</span>
          {incident.locationText ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{incident.locationText}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className={cn(unassigned && 'text-warning')}>
            {unassigned ? 'no units' : `${incident.assignedUnitIds.length} unit(s)`}
          </span>
        </div>
      </div>
      {incident.priority === 1 && status.isOpen ? (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
      ) : null}
    </button>
  );
}
