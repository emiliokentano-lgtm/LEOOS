'use client';

import { cn, formatElapsed } from '@/lib/utils';
import { incidentAgeSeverity } from '@/lib/status';
import { IncidentStatusBadge, OrgBadge, PriorityBadge } from '@/components/ui';
import type { MockIncident } from '@/mocks/operations';
import { MOCK_NOW } from '@/mocks/operations';
import { mockOrg } from '@/mocks/organizations';

/**
 * One incident in a queue.
 *
 * Age is escalated visually — an operator should never have to compute elapsed
 * time to notice a call going stale. The ramp is priority-aware: a P1 goes
 * overdue after five minutes, a P4 after forty-five.
 */
export function IncidentRow({
  incident, selected, onSelect,
}: {
  incident: MockIncident;
  selected?: boolean;
  onSelect?: (incident: MockIncident) => void;
}) {
  const org = mockOrg(incident.organizationId);
  const severity = incidentAgeSeverity(incident.createdAt, incident.priority, MOCK_NOW);

  return (
    <button
      type="button"
      onClick={() => onSelect?.(incident)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-2.5 border-b border-border-subtle px-3 py-2 text-left',
        'transition-colors duration-(--duration-fast)',
        selected ? 'bg-active' : 'hover:bg-hover',
        severity === 'overdue' && 'border-l-2 border-l-danger',
        severity === 'aging' && 'border-l-2 border-l-warning',
      )}
    >
      <PriorityBadge priority={incident.priority} className="mt-0.5" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-text-primary">{incident.type}</span>
          <OrgBadge shortName={org.shortName} color={org.color} size="sm" />
        </div>
        <p className="mt-0.5 truncate text-xs text-text-secondary">{incident.title}</p>
        <p className="mt-0.5 truncate text-2xs text-text-tertiary">{incident.locationText}</p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span
          className={cn(
            'font-mono text-xs tabular',
            severity === 'overdue' ? 'text-danger'
              : severity === 'aging' ? 'text-warning' : 'text-text-tertiary',
          )}
        >
          {formatElapsed(incident.createdAt, MOCK_NOW)}
        </span>
        <IncidentStatusBadge status={incident.status} size="sm" />
        {incident.assignedUnitIds.length > 0 ? (
          <span className="font-mono text-2xs text-text-tertiary">
            {incident.assignedUnitIds.length} unit{incident.assignedUnitIds.length > 1 ? 's' : ''}
          </span>
        ) : (
          <span className="font-mono text-2xs text-warning">unassigned</span>
        )}
      </div>
    </button>
  );
}
