import {
  DUTY_STATUSES, INCIDENT_STATUSES, PRIORITIES,
  type DutyStatusKey, type IncidentStatusKey, type IncidentPriority,
} from '@leoos/contracts';

/**
 * Bridges the shared status catalogues to the CSS token layer.
 *
 * Components never hardcode a status colour — they call these helpers, so that a
 * status added to the catalogue renders consistently everywhere it appears
 * without touching a single component (engineering rules 5-7).
 */

export function dutyStatusColor(key: DutyStatusKey): string {
  return `var(${DUTY_STATUSES[key].token})`;
}

export function incidentStatusColor(key: IncidentStatusKey): string {
  return `var(${INCIDENT_STATUSES[key].token})`;
}

export function priorityColor(priority: IncidentPriority): string {
  return `var(${PRIORITIES[priority].token})`;
}

/**
 * Age thresholds for the dispatch queue's colour ramp. An incident that has been
 * waiting is escalated visually — an operator should never have to compute
 * elapsed time to notice a call going stale.
 */
export function incidentAgeSeverity(
  createdAt: Date | string,
  priority: IncidentPriority,
  now: Date = new Date(),
): 'normal' | 'aging' | 'overdue' {
  const start = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  const minutes = (now.getTime() - start.getTime()) / 60000;
  // Higher priority calls go overdue sooner.
  const agingAt = priority <= 2 ? 2 : priority === 3 ? 8 : 20;
  const overdueAt = priority <= 2 ? 5 : priority === 3 ? 20 : 45;
  if (minutes >= overdueAt) return 'overdue';
  if (minutes >= agingAt) return 'aging';
  return 'normal';
}
