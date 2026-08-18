'use client';

import Link from 'next/link';
import { Activity, ArrowUpRight, Clock, Radio, TriangleAlert, Users } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import { DUTY_STATUSES, DUTY_STATUS_LIST } from '@leoos/contracts';
import {
  Alert, Badge, Button, DutyStatusBadge, Panel, PanelHeader, StatTile,
  EmptyState, Tooltip,
} from '@/components/ui';
import { PageContainer } from '@/components/shell/page-container';
import { useDutyStatus } from '@/components/shell/duty-status-context';
import { IncidentRow } from '@/components/domain/incident-row';
import { UnitRow } from '@/components/domain/unit-row';
import type { Session } from '@/lib/session';
import { cn, timeAgo } from '@/lib/utils';
import {
  MOCK_ACTIVITY, MOCK_INCIDENTS, MOCK_NOW, MOCK_UNITS,
} from '@/mocks/operations';

/**
 * Operational overview.
 *
 * Three columns: incidents (primary, left), units (centre), alerts and
 * statistics (right). Everything that needs attention is above the fold — an
 * operator should not scroll to discover a P1 is unassigned.
 *
 * No decorative widgets: no donut charts, no trend sparklines, no greeting.
 */
export function DashboardView({
  session, organization,
}: {
  session: Session;
  organization: OrganizationSummary;
}) {
  const { status } = useDutyStatus();

  const openIncidents = MOCK_INCIDENTS.filter((i) => i.status !== 'closed' && i.status !== 'cancelled');
  const unassigned = openIncidents.filter((i) => i.assignedUnitIds.length === 0);
  const p1 = openIncidents.filter((i) => i.priority === 1);
  const onDuty = MOCK_UNITS.filter((u) => DUTY_STATUSES[u.status].isOnDuty);
  const available = MOCK_UNITS.filter((u) => DUTY_STATUSES[u.status].isAvailable);

  const myUnit = MOCK_UNITS.find((u) => u.memberNames.includes(session.displayName));
  const myIncident = myUnit?.incidentId
    ? MOCK_INCIDENTS.find((i) => i.id === myUnit.incidentId)
    : undefined;

  // Unit counts per status, for the board header.
  const statusCounts = DUTY_STATUS_LIST.map((meta) => ({
    meta,
    count: MOCK_UNITS.filter((u) => u.status === meta.key).length,
  })).filter((s) => s.count > 0);

  return (
    <PageContainer padded={false} className="overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
        {/* Alerts first. Nothing above them. */}
        {p1.length > 0 ? (
          <Alert
            tone="danger"
            title={`${p1.length} priority-1 incident${p1.length > 1 ? 's' : ''} active`}
            action={
              <Button asChild variant="danger" size="sm">
                <Link href="/dispatch">Open dispatch</Link>
              </Button>
            }
          >
            {p1.map((i) => i.title).join(' · ')}
          </Alert>
        ) : null}

        {unassigned.length > 0 ? (
          <Alert tone="warning" title={`${unassigned.length} incident${unassigned.length > 1 ? 's' : ''} awaiting assignment`}>
            Oldest: {unassigned[unassigned.length - 1]?.title}
          </Alert>
        ) : null}

        {/* Statistics strip */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Open incidents" value={openIncidents.length} icon={<Activity />} />
          <StatTile
            label="Priority 1" value={p1.length}
            tone={p1.length > 0 ? 'danger' : 'default'} icon={<TriangleAlert />}
          />
          <StatTile
            label="Unassigned" value={unassigned.length}
            tone={unassigned.length > 0 ? 'warning' : 'default'} icon={<Clock />}
          />
          <StatTile label="Units on duty" value={onDuty.length} icon={<Radio />} />
          <StatTile
            label="Available" value={available.length}
            tone={available.length === 0 ? 'danger' : 'success'} icon={<Users />}
          />
          <StatTile
            label="Avg. response" value="4:12"
            hint="Last 24 h, all priorities" icon={<Clock />}
          />
        </div>

        {/* Main three-column grid. Collapses to one column below xl so a laptop
            shows full-width panels rather than three cramped ones. */}
        {/* Fills the remaining height on tall displays so the board reaches the
            bottom of the screen rather than floating with dead space beneath. */}
        <div className="grid min-h-[420px] flex-1 grid-cols-1 gap-3 xl:grid-cols-[1.4fr_1fr_1fr]">
          {/* Active incidents */}
          <Panel flush className="min-h-[320px]">
            <PanelHeader
              title="Active incidents"
              icon={<Activity />}
              actions={
                <>
                  <Badge variant="neutral" mono>{openIncidents.length}</Badge>
                  <Button asChild variant="ghost" size="xs">
                    <Link href="/dispatch">
                      Dispatch <ArrowUpRight aria-hidden />
                    </Link>
                  </Button>
                </>
              }
            />
            <div className="min-h-0 flex-1 overflow-auto">
              {openIncidents.length === 0 ? (
                <EmptyState title="No active incidents" description="The board is clear." />
              ) : (
                [...openIncidents]
                  .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime())
                  .map((incident) => <IncidentRow key={incident.id} incident={incident} />)
              )}
            </div>
          </Panel>

          {/* Unit status board */}
          <Panel flush className="min-h-[320px]">
            <PanelHeader
              title="Units"
              icon={<Radio />}
              actions={
                <div className="flex items-center gap-1">
                  {statusCounts.map(({ meta, count }) => (
                    <Tooltip key={meta.key} content={`${count} ${meta.label}`}>
                      <span className="flex items-center gap-0.5">
                        <span
                          className="size-1.5 rounded-full"
                          style={{ backgroundColor: `var(${meta.token})` }}
                          aria-hidden
                        />
                        <span className="font-mono text-2xs text-text-tertiary">{count}</span>
                      </span>
                    </Tooltip>
                  ))}
                </div>
              }
            />
            <div className="min-h-0 flex-1 overflow-auto">
              {MOCK_UNITS.filter((u) => DUTY_STATUSES[u.status].isOnDuty).map((unit) => (
                <UnitRow key={unit.id} unit={unit} />
              ))}
            </div>
          </Panel>

          {/* Right column: own status + recent activity */}
          <div className="flex min-h-0 flex-col gap-3">
            <Panel flush>
              <PanelHeader title="Your status" icon={<Users />} />
              <div className="flex flex-col gap-2.5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">Operational status</span>
                  <DutyStatusBadge status={status} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">Organization</span>
                  <span className="flex items-center gap-1.5 text-xs text-text-primary">
                    <span
                      className="size-2 rounded-[1px]"
                      style={{ backgroundColor: organization.color }}
                      aria-hidden
                    />
                    {organization.shortName}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">Rank</span>
                  <span className="text-xs text-text-primary">{session.roleName}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">Callsign</span>
                  <span className="font-mono text-xs text-text-primary">{session.callsign}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-tertiary">Current unit</span>
                  <span className="font-mono text-xs text-text-primary">
                    {myUnit ? myUnit.callsign : '—'}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-2 border-t border-border-subtle pt-2.5">
                  <span className="shrink-0 text-xs text-text-tertiary">Assignment</span>
                  {myIncident ? (
                    <span className="text-right text-xs text-text-primary">
                      <span className="font-mono">{myIncident.number}</span>
                      <br />
                      <span className="text-text-secondary">{myIncident.type}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-text-tertiary">None</span>
                  )}
                </div>
              </div>
            </Panel>

            <Panel flush className="min-h-0 flex-1">
              <PanelHeader title="Recent activity" icon={<Clock />} />
              <ul className="min-h-0 flex-1 overflow-auto">
                {MOCK_ACTIVITY.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-start gap-2 border-b border-border-subtle px-3 py-1.5 last:border-b-0"
                  >
                    <span
                      className={cn(
                        'mt-1.5 size-1.5 shrink-0 rounded-full',
                        entry.tone === 'danger' && 'bg-danger',
                        entry.tone === 'warning' && 'bg-warning',
                        entry.tone === 'default' && 'bg-text-disabled',
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-text-secondary">
                        <span className="text-text-primary">{entry.actor}</span> {entry.action}
                      </p>
                      <p className="truncate text-2xs text-text-tertiary">{entry.target}</p>
                    </div>
                    <span className="shrink-0 font-mono text-2xs text-text-tertiary">
                      {timeAgo(entry.at, MOCK_NOW)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
