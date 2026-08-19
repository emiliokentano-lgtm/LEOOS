import { describe, expect, it } from 'vitest';
import {
  MAX_LISTED_ALERTS, MIN_METRIC_SAMPLE, compareIncidentsForDashboard, explainUnavailable,
  formatDurationMetric, metric, unavailable, type Metric,
} from '../src/dashboard';
// The incident shape belongs to dispatch; the dashboard consumes it rather than
// re-exporting it.
import type { DispatchIncidentSummary } from '../src/dispatch';

const ORG = { id: 'org-pd', key: 'pd', shortName: 'PD', color: '#3b82f6' };

function call(over: Partial<DispatchIncidentSummary> = {}): DispatchIncidentSummary {
  return {
    id: 'i1', number: 'INC-1', title: 'Call', typeKey: null, typeLabel: null,
    priority: 3, status: 'pending', organization: ORG, locationText: null,
    position: null, assignedUnitIds: [], createdAt: '2026-08-19T10:00:00.000Z',
    closedAt: null, ...over,
  };
}

describe('metric honesty', () => {
  it('represents an unavailable metric without a value', () => {
    const m = unavailable('not-measured');
    expect(m.available).toBe(false);
    // The type must make it impossible to read a number off an unavailable
    // metric — this is the whole reason the union exists.
    expect('value' in m).toBe(false);
  });

  it('explains each reason in words an operator can act on', () => {
    expect(explainUnavailable(unavailable('no-data') as Extract<Metric, { available: false }>))
      .toMatch(/nothing recorded/i);
    expect(explainUnavailable(
      unavailable('insufficient-sample', 2) as Extract<Metric, { available: false }>,
    )).toMatch(/too few/i);
    expect(explainUnavailable(
      unavailable('not-measured') as Extract<Metric, { available: false }>,
    )).toMatch(/not measured/i);
  });

  it('prefers a supplied detail over the generic explanation', () => {
    const m = unavailable('not-measured', 0, 'Arrival is not recorded.');
    expect(explainUnavailable(m as Extract<Metric, { available: false }>))
      .toBe('Arrival is not recorded.');
  });

  it('carries the sample size alongside an available value', () => {
    // A median over six calls and one over six hundred are different claims.
    const m = metric(42, 17);
    expect(m).toEqual({ available: true, value: 42, sampleSize: 17 });
  });

  it('sets a sample floor that is more than a couple of observations', () => {
    expect(MIN_METRIC_SAMPLE).toBeGreaterThan(2);
  });
});

describe('duration formatting', () => {
  it('never renders a sub-second value as zero', () => {
    // "0s" reads as broken rather than fast, and rounding 0.4s to zero is a
    // claim the measurement does not make.
    expect(formatDurationMetric(0.0136)).toBe('<1s');
    expect(formatDurationMetric(0.9)).toBe('<1s');
  });

  it('formats seconds, minutes and hours', () => {
    expect(formatDurationMetric(42)).toBe('42s');
    expect(formatDurationMetric(90)).toBe('1m 30s');
    expect(formatDurationMetric(120)).toBe('2m');
    expect(formatDurationMetric(3900)).toBe('1h 5m');
  });
});

describe('dashboard ordering', () => {
  it('puts worse priorities first', () => {
    expect(compareIncidentsForDashboard(call({ priority: 1 }), call({ priority: 3 })))
      .toBeLessThan(0);
  });

  /**
   * The difference from the dispatch queue.
   *
   * The queue is worked top to bottom, so it is strictly worst-first-oldest-first.
   * The dashboard is SCANNED, so a P1 nobody has picked up outranks a P1 three
   * units are already on: the first needs a decision, the second is handled.
   */
  it('puts an unassigned call ahead of an assigned one at the same priority', () => {
    const unassigned = call({ id: 'a', priority: 1, assignedUnitIds: [] });
    const assigned = call({ id: 'b', priority: 1, assignedUnitIds: ['u1', 'u2'] });
    expect(compareIncidentsForDashboard(unassigned, assigned)).toBeLessThan(0);
  });

  it('does not let assignment outrank priority', () => {
    // An assigned P1 still beats an unassigned P3.
    const assignedCritical = call({ id: 'a', priority: 1, assignedUnitIds: ['u1'] });
    const unassignedMedium = call({ id: 'b', priority: 3, assignedUnitIds: [] });
    expect(compareIncidentsForDashboard(assignedCritical, unassignedMedium)).toBeLessThan(0);
  });

  it('breaks a full tie by age, oldest first', () => {
    const older = call({ id: 'a', createdAt: '2026-08-19T09:00:00.000Z' });
    const newer = call({ id: 'b', createdAt: '2026-08-19T10:00:00.000Z' });
    expect(compareIncidentsForDashboard(older, newer)).toBeLessThan(0);
  });

  it('is a total order — sorting is stable and deterministic', () => {
    const calls = [
      call({ id: 'c', priority: 3, assignedUnitIds: ['u'] }),
      call({ id: 'a', priority: 1, assignedUnitIds: [] }),
      call({ id: 'b', priority: 1, assignedUnitIds: ['u'] }),
      call({ id: 'd', priority: 2, assignedUnitIds: [] }),
    ];
    const once = [...calls].sort(compareIncidentsForDashboard).map((c) => c.id);
    const twice = [...calls].reverse().sort(compareIncidentsForDashboard).map((c) => c.id);
    expect(once).toEqual(['a', 'b', 'd', 'c']);
    expect(twice).toEqual(once);
  });
});

describe('alert capping', () => {
  it('caps the listed alerts so the panel cannot become a second queue', () => {
    // Prominent without becoming overwhelming: a dozen filled red rows is a
    // screen an operator stops reading.
    expect(MAX_LISTED_ALERTS).toBeGreaterThan(2);
    expect(MAX_LISTED_ALERTS).toBeLessThanOrEqual(10);
  });
});
