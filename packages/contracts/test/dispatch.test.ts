import { describe, expect, it } from 'vitest';
import {
  EMPTY_DISPATCH_FILTER, INCIDENT_TRANSITIONS, canTransitionIncident,
  compareIncidentsForQueue, countActiveDispatchFilters, isTerminalIncidentStatus,
  matchesDispatchIncident,
  type DispatchFilterState, type DispatchIncidentSummary,
} from '../src/dispatch';
import {
  INCIDENT_STATUSES, INCIDENT_STATUS_LIST, OPEN_INCIDENT_STATUSES, PRIORITIES,
  type IncidentStatusKey,
} from '../src/statuses';

const ORG_PD = { id: 'org-pd', key: 'pd', shortName: 'PD', color: '#3b82f6' };
const ORG_MD = { id: 'org-md', key: 'md', shortName: 'MD', color: '#ef4444' };

function incident(over: Partial<DispatchIncidentSummary> = {}): DispatchIncidentSummary {
  return {
    id: 'i1', number: 'INC-1024', title: 'Burglary in progress',
    typeKey: 'burglary', typeLabel: 'Burglary', priority: 2, status: 'dispatched',
    organization: ORG_PD, locationText: 'Legion Square', position: { x: 0, y: 0 },
    assignedUnitIds: ['u1'], createdAt: '2026-08-19T09:00:00.000Z', closedAt: null,
    ...over,
  };
}

function filter(over: Partial<DispatchFilterState> = {}): DispatchFilterState {
  return { ...EMPTY_DISPATCH_FILTER, ...over };
}

describe('incident lifecycle', () => {
  it('treats closed and cancelled as terminal', () => {
    expect(INCIDENT_TRANSITIONS.closed).toEqual([]);
    expect(INCIDENT_TRANSITIONS.cancelled).toEqual([]);
    expect(isTerminalIncidentStatus('closed')).toBe(true);
    expect(isTerminalIncidentStatus('cancelled')).toBe(true);
  });

  it('refuses to move a closed call by a status change', () => {
    // Reopening exists, but as its own action with its own permission — it has
    // to justify itself in the timeline rather than slipping through as an edit.
    for (const target of INCIDENT_STATUS_LIST) {
      expect(canTransitionIncident('closed', target.key)).toBe(false);
    }
  });

  it('lets a contained call go back to active', () => {
    // Situations get worse again. A lifecycle that only moved forward would
    // force a dispatcher to record something untrue.
    expect(canTransitionIncident('contained', 'on_scene')).toBe(true);
  });

  it('lets any open call be cancelled', () => {
    for (const status of OPEN_INCIDENT_STATUSES) {
      expect(canTransitionIncident(status, 'cancelled')).toBe(true);
    }
  });

  it('lets any open call be closed', () => {
    for (const status of OPEN_INCIDENT_STATUSES) {
      expect(canTransitionIncident(status, 'closed')).toBe(true);
    }
  });

  it('never allows a transition to itself', () => {
    for (const status of INCIDENT_STATUS_LIST) {
      expect(canTransitionIncident(status.key, status.key)).toBe(false);
    }
  });

  it('only ever names real statuses', () => {
    const known = new Set(INCIDENT_STATUS_LIST.map((s) => s.key));
    for (const [from, targets] of Object.entries(INCIDENT_TRANSITIONS)) {
      expect(known.has(from as IncidentStatusKey)).toBe(true);
      for (const to of targets) expect(known.has(to)).toBe(true);
    }
  });

  it('covers every status in the table', () => {
    // A status with no entry would throw on lookup rather than deny cleanly.
    for (const status of INCIDENT_STATUS_LIST) {
      expect(INCIDENT_TRANSITIONS[status.key]).toBeDefined();
    }
  });

  it('reaches every open status from the initial one', () => {
    // A state nothing can reach is dead configuration.
    const reachable = new Set<IncidentStatusKey>(['pending']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reachable]) {
        for (const to of INCIDENT_TRANSITIONS[from]) {
          if (!reachable.has(to)) { reachable.add(to); grew = true; }
        }
      }
    }
    for (const status of INCIDENT_STATUS_LIST) {
      expect(reachable.has(status.key)).toBe(true);
    }
  });
});

describe('vocabulary', () => {
  it('presents the requested lifecycle names over the stored keys', () => {
    // The stored enum is not renamed; the labels are what the service says.
    expect(INCIDENT_STATUSES.pending.label).toBe('Open');
    expect(INCIDENT_STATUSES.on_scene.label).toBe('Active');
    expect(INCIDENT_STATUSES.contained.label).toBe('Contained');
    expect(INCIDENT_STATUSES.closed.label).toBe('Closed');
  });

  it('carries both a radio form and a worded form for priority', () => {
    expect(PRIORITIES[1].label).toBe('P1');
    expect(PRIORITIES[1].name).toBe('Critical');
    expect(PRIORITIES[4].name).toBe('Low');
  });

  it('orders priority so that 1 is worst', () => {
    expect(compareIncidentsForQueue(incident({ priority: 1 }), incident({ priority: 3 })))
      .toBeLessThan(0);
  });

  it('breaks a priority tie by age, oldest first', () => {
    const older = incident({ id: 'a', createdAt: '2026-08-19T08:00:00.000Z' });
    const newer = incident({ id: 'b', createdAt: '2026-08-19T09:00:00.000Z' });
    expect(compareIncidentsForQueue(older, newer)).toBeLessThan(0);
  });
});

describe('queue filtering', () => {
  it('passes everything through an empty filter', () => {
    expect(matchesDispatchIncident(incident(), EMPTY_DISPATCH_FILTER, null)).toBe(true);
  });

  it('filters by priority and status', () => {
    expect(matchesDispatchIncident(incident(), filter({ priorities: [1] }), null)).toBe(false);
    expect(matchesDispatchIncident(incident(), filter({ priorities: [2] }), null)).toBe(true);
    expect(matchesDispatchIncident(incident(), filter({ statuses: ['pending'] }), null)).toBe(false);
  });

  it('keeps a multi-agency call visible under any organization filter', () => {
    const multiAgency = incident({ organization: null });
    expect(matchesDispatchIncident(multiAgency, filter({ organizationIds: [ORG_MD.id] }), null))
      .toBe(true);
  });

  it('filters to unassigned calls', () => {
    expect(matchesDispatchIncident(incident(), filter({ onlyUnassigned: true }), null)).toBe(false);
    expect(matchesDispatchIncident(
      incident({ assignedUnitIds: [] }), filter({ onlyUnassigned: true }), null,
    )).toBe(true);
  });

  it('matches nothing for "my calls" when the operator is in no unit', () => {
    // The honest reading: you have no unit, so no call is yours.
    expect(matchesDispatchIncident(incident(), filter({ onlyMine: true }), null)).toBe(false);
  });

  it('matches calls the operator unit is assigned to', () => {
    expect(matchesDispatchIncident(incident(), filter({ onlyMine: true }), 'u1')).toBe(true);
    expect(matchesDispatchIncident(incident(), filter({ onlyMine: true }), 'u2')).toBe(false);
  });

  it('searches number, title and location', () => {
    expect(matchesDispatchIncident(incident(), filter({ query: 'inc-1024' }), null)).toBe(true);
    expect(matchesDispatchIncident(incident(), filter({ query: 'legion' }), null)).toBe(true);
    expect(matchesDispatchIncident(incident(), filter({ query: 'arson' }), null)).toBe(false);
  });

  it('counts active filters', () => {
    expect(countActiveDispatchFilters(EMPTY_DISPATCH_FILTER)).toBe(0);
    expect(countActiveDispatchFilters(filter({ priorities: [1, 2], onlyMine: true }))).toBe(3);
  });
});
