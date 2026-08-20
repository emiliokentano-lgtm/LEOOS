'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, Radio, TriangleAlert } from 'lucide-react';
import {
  BACKSTOP_POLL_MS, DASHBOARD_POLL_MS, INCIDENT_STATUSES, PRIORITY_LIST,
  type DashboardAlert, type DashboardSnapshot, type DispatchIncidentSummary,
  type DispatchUnit, type OperationalStatusMeta,
} from '@leoos/contracts';
import {
  Alert, Badge, Button, EmptyState, Panel, PanelHeader, SkeletonRows, useToast,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { StatusChip } from '@/components/domain/status-chip';
import { useDutyStatus } from '@/components/shell/duty-status-context';
import { Icon } from '@/components/icon';
import {
  HttpDashboardSource, type DashboardConnectionState,
} from '@/lib/dashboard/dashboard-source';
import { useNow } from '@/lib/map/use-now';
import { useAuth } from '@/components/shell/auth-context';
import { useRealtimeRefresh, useRealtimeStatus } from '@/lib/realtime/realtime-context';
import { BOARD_EVENTS, dashboardTopics } from '@/lib/realtime/topics';
import { cn, formatElapsed } from '@/lib/utils';
import { CountTile, MetricTile } from './metric-tile';

/**
 * Operational overview.
 *
 * Everything that needs a decision is above the fold on a 1920×1080 display: an
 * operator should not scroll to discover a P1 is unassigned.
 *
 * Alerts first, then three columns — active incidents (primary, widest), unit
 * and personnel figures (centre), the operator's own state (right). No
 * decorative widgets: no donut charts, no trend sparklines, no greeting.
 *
 * Every figure here is computed server-side over exactly the rows this caller
 * may see. The screen aggregates nothing, which is what keeps it consistent with
 * the dispatch board it links to.
 */
export function DashboardView({
  initialSnapshot,
}: {
  initialSnapshot: DashboardSnapshot | null;
}) {
  const [snapshot, setSnapshot] = React.useState<DashboardSnapshot | null>(initialSnapshot);
  const [connection, setConnection] = React.useState<DashboardConnectionState>('connecting');
  const [connectionDetail, setConnectionDetail] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<string | null>(null);

  const sourceRef = React.useRef<HttpDashboardSource | null>(null);
  const duty = useDutyStatus();
  const now = useNow();
  const auth = useAuth();
  const realtime = useRealtimeStatus();

  /**
   * The backstop feed.
   *
   * Covers every event the brief lists — incident created, incident updated,
   * unit status changed, unit joined or left, panic, personnel status changed —
   * because all six move the shared dispatch revision. The WebSocket below
   * delivers the same six in under a second; this is what keeps the figures
   * moving for a console whose socket cannot connect.
   */
  React.useEffect(() => {
    const feed = new HttpDashboardSource();
    sourceRef.current = feed;
    feed.start({
      onSnapshot: setSnapshot,
      onStateChange(state, detail) {
        setConnection(state);
        setConnectionDetail(detail);
      },
    });
    return () => feed.stop();
  }, []);

  const refresh = React.useCallback(() => sourceRef.current?.refresh(), []);

  // ── Live updates ────────────────────────────────────────────────────────
  //
  // The dashboard is composed from the dispatch reads and shares its revision
  // (docs/architecture/10-dashboard.md §3), so refetching on an event is what
  // keeps its counts from drifting away from the board it links to. Patching
  // them from payloads would reintroduce exactly that drift.
  const topics = React.useMemo(
    () => dashboardTopics({ userId: auth.userId, organizationId: auth.activeOrganizationId }),
    [auth.userId, auth.activeOrganizationId],
  );
  useRealtimeRefresh(topics, refresh, { interestingTypes: BOARD_EVENTS });

  React.useEffect(() => {
    sourceRef.current?.setPollMs(
      realtime.state === 'live' ? BACKSTOP_POLL_MS : DASHBOARD_POLL_MS,
    );
  }, [realtime.state]);

  // ── Loading and error states ────────────────────────────────────────────
  if (snapshot === null && connection === 'connecting') {
    return (
      <PageContainer>
        <div className="flex flex-col gap-3">
          <SkeletonRows rows={3} />
          <SkeletonRows rows={6} />
        </div>
      </PageContainer>
    );
  }

  if (snapshot === null) {
    return (
      <PageContainer>
        <Alert tone="danger" title="The dashboard is unavailable" className="max-w-xl">
          The operational data could not be loaded, so nothing on this screen would
          be trustworthy. {connectionDetail ?? ''}
        </Alert>
      </PageContainer>
    );
  }

  const { self, counts, statistics, alerts, incidents, units, statuses } = snapshot;

  const visibleUnits = statusFilter === null
    ? units
    : units.filter((u) => u.status.key === statusFilter);

  return (
    <PageContainer padded={false} className="overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
        {connection === 'reconnecting' || connection === 'failed' ? (
          <Alert
            tone={connection === 'failed' ? 'danger' : 'warning'}
            title={connection === 'failed' ? 'Live updates stopped' : 'Reconnecting'}
          >
            {connectionDetail ?? 'These figures may be out of date.'}
          </Alert>
        ) : null}

        {/* Alerts first. Nothing above them. */}
        {alerts.length > 0 ? (
          <AlertPanel
            alerts={alerts}
            overflow={snapshot.alertOverflow}
            now={now}
          />
        ) : null}

        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(280px,0.9fr)]">
          {/* Active incidents */}
          <Panel flush className="min-h-0">
            <PanelHeader
              title="Active incidents"
              actions={
                <div className="flex items-center gap-2">
                  <Badge variant="neutral" mono>{counts.activeIncidents}</Badge>
                  <Link
                    href="/dispatch"
                    className="flex items-center gap-0.5 text-2xs text-accent hover:underline"
                  >
                    Dispatch <ArrowUpRight className="size-3" aria-hidden />
                  </Link>
                </div>
              }
            />
            <div className="min-h-0 flex-1 overflow-auto">
              {incidents.length === 0 ? (
                <EmptyState
                  title="No active incidents"
                  description="The board is clear."
                />
              ) : (
                incidents.map((incident) => (
                  <IncidentRow key={incident.id} incident={incident} units={units} now={now} />
                ))
              )}
            </div>
          </Panel>

          {/* Units and statistics */}
          <div className="flex min-h-0 flex-col gap-3">
            <Panel flush>
              <PanelHeader
                title="Units"
                actions={
                  <div className="flex items-center gap-2">
                    {statusFilter !== null ? (
                      <Button variant="ghost" size="xs" onClick={() => setStatusFilter(null)}>
                        Clear
                      </Button>
                    ) : null}
                    <Badge variant="neutral" mono>{counts.unitsTotal}</Badge>
                  </div>
                }
              />
              {/* Clicking a figure filters the list below it — the units are
                  right there, so navigating away to see six rows would be worse
                  than showing them in place. */}
              <div className="grid grid-cols-3 gap-1.5 p-2">
                <UnitCount label="Available" value={counts.unitsAvailable}
                  statusKey="available" filter={statusFilter} onFilter={setStatusFilter} />
                <UnitCount label="Busy" value={counts.unitsBusy}
                  statusKey="busy" filter={statusFilter} onFilter={setStatusFilter} />
                <UnitCount label="In operation" value={counts.unitsInOperation}
                  statusKey="in_operation" filter={statusFilter} onFilter={setStatusFilter} />
                <UnitCount label="At HQ" value={counts.unitsAtHq}
                  statusKey="at_hq" filter={statusFilter} onFilter={setStatusFilter} />
                <UnitCount label="Panic" value={counts.unitsPanic} tone="danger"
                  statusKey="panic" filter={statusFilter} onFilter={setStatusFilter} />
                <UnitCount label="Offline" value={counts.unitsOffline}
                  statusKey="off_duty" filter={statusFilter} onFilter={setStatusFilter} />
              </div>

              {statusFilter !== null ? (
                <div className="max-h-[220px] overflow-auto border-t border-border-subtle">
                  {visibleUnits.length === 0 ? (
                    <EmptyState variant="filtered" title="No units in that status" />
                  ) : (
                    visibleUnits.map((unit) => (
                      <UnitLine key={unit.id} unit={unit} />
                    ))
                  )}
                </div>
              ) : null}
            </Panel>

            <Panel flush className="min-h-0">
              <PanelHeader
                title="Today"
                actions={
                  <span className="text-2xs text-text-tertiary">
                    since {new Date(statistics.windowStart).toLocaleTimeString([], {
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                }
              />
              <div className="grid grid-cols-2 gap-1.5 p-2">
                <CountTile label="Calls opened" value={statistics.incidentsToday} />
                <CountTile label="Calls closed" value={statistics.incidentsClosedToday} />
                <CountTile label="On duty" value={counts.personnelOnDuty}
                  sub={`of ${counts.personnelTotal} personnel`} />
                <CountTile label="Signed in" value={counts.personnelSignedIn}
                  sub="live sessions" />
              </div>
              <div className="grid grid-cols-1 gap-1.5 border-t border-border-subtle p-2 sm:grid-cols-3">
                <MetricTile
                  label="To first unit"
                  metric={statistics.timeToFirstUnit}
                  hint="Median time from a call being created to its first unit being assigned. This is time to dispatch, not response time."
                />
                <MetricTile
                  label="To active"
                  metric={statistics.timeToActive}
                  hint="Median time from a call being created to a dispatcher marking it Active."
                />
                <MetricTile
                  label="Response time"
                  metric={statistics.responseTime}
                  hint="Dispatch to arrival on scene. Nothing records an arrival yet, so this is not measured rather than estimated."
                />
              </div>
            </Panel>
          </div>

          {/* The operator */}
          <SelfPanel
            self={self}
            statuses={statuses}
            canOperate={self.canOperate}
            pendingStatus={duty.loading}
            onSetStatus={async (key) => {
              const result = await duty.setStatus(key);
              if (result.ok) refresh();
              return result;
            }}
          />
        </div>
      </div>
    </PageContainer>
  );
}

// ── Alerts ─────────────────────────────────────────────────────────────────

function AlertPanel({
  alerts, overflow, now,
}: {
  alerts: DashboardAlert[];
  overflow: number;
  now: number;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xs border border-border-subtle bg-surface p-2"
      role="region"
      aria-label="Operational alerts"
    >
      {alerts.map((alert) => (
        <AlertLine key={alert.id} alert={alert} now={now} />
      ))}
      {overflow > 0 ? (
        <Link
          href="/dispatch"
          className="px-1 text-2xs text-text-tertiary hover:text-text-secondary hover:underline"
        >
          + {overflow} more requiring attention
        </Link>
      ) : null}
    </div>
  );
}

function AlertLine({ alert, now }: { alert: DashboardAlert; now: number }) {
  /**
   * Critical without being overwhelming.
   *
   * A danger alert gets a coloured left edge and a bold label; it does not get a
   * filled red row. Six filled red rows is a screen an operator stops reading,
   * which is the opposite of what an alert is for. Panic is the single exception
   * and is the only thing here that animates.
   */
  const body = (
    <div
      className={cn(
        'flex items-center gap-2 rounded-xs border-l-2 px-2 py-1 text-xs',
        alert.tone === 'danger' ? 'border-l-danger bg-danger/5'
          : alert.tone === 'warning' ? 'border-l-warning bg-warning/5'
            : 'border-l-border-strong bg-raised',
      )}
    >
      <TriangleAlert
        className={cn(
          'size-3.5 shrink-0',
          alert.tone === 'danger' ? 'text-danger'
            : alert.tone === 'warning' ? 'text-warning' : 'text-text-tertiary',
          alert.kind === 'panic' && 'animate-panic',
        )}
        aria-hidden
      />
      <span
        className={cn(
          'shrink-0 text-2xs font-semibold uppercase tracking-wide',
          alert.tone === 'danger' ? 'text-danger'
            : alert.tone === 'warning' ? 'text-warning' : 'text-text-tertiary',
        )}
      >
        {alert.kind === 'critical-incident' ? 'Critical'
          : alert.kind === 'unassigned' ? 'Waiting'
            : alert.kind === 'system' ? 'System' : 'Panic'}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-primary">{alert.title}</span>
      {alert.detail !== null ? (
        <span className="hidden shrink-0 text-text-tertiary md:inline">{alert.detail}</span>
      ) : null}
      {alert.since !== null && now !== 0 ? (
        <span className="shrink-0 font-mono text-2xs text-text-tertiary">
          {formatElapsed(new Date(alert.since), new Date(now))}
        </span>
      ) : null}
    </div>
  );

  // The API names a screen; the route table lives here, where it belongs.
  if (alert.target === null) return body;
  return (
    <Link
      href={alert.target === 'map' ? '/map' : '/dispatch'}
      className="block hover:brightness-125"
    >
      {body}
    </Link>
  );
}

// ── Incidents ──────────────────────────────────────────────────────────────

function IncidentRow({
  incident, units, now,
}: {
  incident: DispatchIncidentSummary;
  units: DispatchUnit[];
  now: number;
}) {
  const status = INCIDENT_STATUSES[incident.status];
  const priority = PRIORITY_LIST[incident.priority - 1]!;
  const assigned = units.filter((u) => incident.assignedUnitIds.includes(u.id));
  const unassigned = assigned.length === 0;

  return (
    <Link
      href="/dispatch"
      prefetch={false}
      className="flex items-start gap-2 border-b border-border-subtle px-3 py-2 transition-colors hover:bg-hover"
    >
      <span
        className="mt-0.5 w-1 shrink-0 self-stretch rounded-full"
        style={{ backgroundColor: `var(${priority.token})` }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-2xs text-text-tertiary">{incident.number}</span>
          <span
            className="text-[10px] font-semibold"
            style={{ color: `var(${priority.token})` }}
          >
            {priority.label} {priority.name}
          </span>
          <span className="text-2xs" style={{ color: `var(${status.token})` }}>
            {status.label}
          </span>
          <span className="ml-auto font-mono text-2xs text-text-tertiary">
            {now === 0 ? '—' : formatElapsed(new Date(incident.createdAt), new Date(now))}
          </span>
        </div>
        <p className="truncate text-xs font-medium text-text-primary">{incident.title}</p>
        <div className="flex items-center gap-1.5 text-2xs">
          {incident.locationText !== null ? (
            <span className="truncate text-text-tertiary">{incident.locationText}</span>
          ) : (
            <span className="text-text-disabled">No location</span>
          )}
          <span aria-hidden className="text-text-disabled">·</span>
          {unassigned ? (
            <span className="font-medium text-warning">No units assigned</span>
          ) : (
            <span className="truncate text-text-secondary">
              {assigned.length} unit{assigned.length === 1 ? '' : 's'}:{' '}
              <span className="font-mono">{assigned.map((u) => u.callsign).join(', ')}</span>
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

// ── Units ──────────────────────────────────────────────────────────────────

function UnitCount({
  label, value, statusKey, filter, onFilter, tone,
}: {
  label: string;
  value: number;
  statusKey: string;
  filter: string | null;
  onFilter: (key: string | null) => void;
  tone?: 'danger';
}) {
  return (
    <CountTile
      label={label}
      value={value}
      tone={tone ?? (value === 0 ? undefined : undefined)}
      active={filter === statusKey}
      onClick={() => onFilter(filter === statusKey ? null : statusKey)}
    />
  );
}

function UnitLine({ unit }: { unit: DispatchUnit }) {
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs last:border-b-0">
      <span className="font-mono font-semibold text-text-primary">{unit.callsign}</span>
      <span
        className="rounded-[2px] border px-1 text-[9px]"
        style={{ borderColor: unit.organization.color, color: unit.organization.color }}
      >
        {unit.organization.shortName}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-tertiary">
        {unit.crew.length === 0 ? 'Uncrewed' : unit.crew.map((c) => c.name).join(', ')}
      </span>
      {unit.incident !== null ? (
        <span className="shrink-0 font-mono text-2xs text-accent">{unit.incident.number}</span>
      ) : null}
    </div>
  );
}

// ── The operator ───────────────────────────────────────────────────────────

function SelfPanel({
  self, statuses, canOperate, pendingStatus, onSetStatus,
}: {
  self: DashboardSnapshot['self'];
  statuses: OperationalStatusMeta[];
  canOperate: boolean;
  pendingStatus: boolean;
  onSetStatus: (key: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [busy, setBusy] = React.useState(false);
  const toast = useToast();
  const current = statuses.find((s) => s.key === self.statusKey) ?? null;
  const pickable = statuses.filter((s) => !s.isPanic);

  async function pick(key: string) {
    setBusy(true);
    const result = await onSetStatus(key);
    setBusy(false);
    if (!result.ok) {
      toast.push({ tone: 'danger', title: 'Status not changed', description: result.error });
    }
  }

  return (
    <Panel flush className="min-h-0">
      <PanelHeader title="You" actions={<StatusChip status={current} />} />

      <dl className="flex flex-col gap-1.5 border-b border-border-subtle p-3 text-xs">
        <Fact label="Name">{self.displayName}</Fact>
        <Fact label="Organization">
          {self.organization === null ? (
            <span className="text-text-tertiary">None</span>
          ) : (
            <span
              className="rounded-[2px] border px-1 text-[10px] font-medium"
              style={{ borderColor: self.organization.color, color: self.organization.color }}
            >
              {self.organization.shortName}
            </span>
          )}
        </Fact>
        <Fact label="Rank">{self.rankName ?? <span className="text-text-tertiary">—</span>}</Fact>
        <Fact label="Callsign">
          {self.memberCallsign !== null ? (
            <span className="font-mono">{self.memberCallsign}</span>
          ) : (
            <span className="text-text-tertiary">—</span>
          )}
        </Fact>
        <Fact label="Unit">
          {self.unitId === null ? (
            <span className="text-text-tertiary">None</span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="font-mono">{self.unitCallsign}</span>
              {self.isUnitLeader ? (
                <span className="text-[9px] uppercase tracking-wide text-text-tertiary">lead</span>
              ) : null}
            </span>
          )}
        </Fact>
        <Fact label="Assignment">
          {self.assignment === null ? (
            <span className="text-text-tertiary">None</span>
          ) : (
            <Link href="/dispatch" className="font-mono text-accent hover:underline">
              {self.assignment.number}
            </Link>
          )}
        </Fact>
      </dl>

      {canOperate ? (
        <div className="p-3">
          <p className="mb-1.5 text-2xs uppercase tracking-wide text-text-disabled">
            Set your status
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {pickable.map((status) => {
              const active = status.key === self.statusKey;
              return (
                <button
                  key={status.key}
                  type="button"
                  disabled={busy || pendingStatus}
                  onClick={() => { void pick(status.key); }}
                  aria-pressed={active}
                  className={cn(
                    'flex items-center gap-1.5 rounded-xs border px-2 py-1.5 text-xs',
                    'transition-colors duration-(--duration-fast) disabled:opacity-50',
                    active
                      ? 'border-border-strong bg-active text-text-primary'
                      : 'border-border bg-raised text-text-secondary hover:border-border-strong',
                  )}
                  style={active ? { borderColor: `var(${status.colorToken})` } : undefined}
                >
                  <span className="shrink-0" style={{ color: `var(${status.colorToken})` }}>
                    <Icon name={status.icon} className="size-3.5" />
                  </span>
                  <span className="truncate">{status.label}</span>
                </button>
              );
            })}
          </div>
          <Link
            href="/dispatch"
            className="mt-2 flex items-center justify-center gap-1 rounded-xs border border-border bg-raised py-1.5 text-xs text-text-secondary transition-colors hover:border-border-strong"
          >
            <Radio className="size-3.5" aria-hidden /> Open dispatch
          </Link>
        </div>
      ) : (
        <p className="p-3 text-xs text-text-tertiary">
          {self.organizationId === null
            ? 'You are not acting in an organization, so you cannot go on duty.'
            : 'Your membership is not active, so you cannot go on duty.'}
        </p>
      )}
    </Panel>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-text-tertiary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}
