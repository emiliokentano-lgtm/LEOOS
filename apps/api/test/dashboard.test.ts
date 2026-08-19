import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MIN_METRIC_SAMPLE } from '@leoos/contracts';
import {
  createActiveUser, createHarness, grantMembership, organizationIdByKey,
  resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';

/**
 * Dashboard.
 *
 * Two things make an operational dashboard trustworthy, and both are what this
 * file tests:
 *
 *   1. IT DOES NOT FABRICATE. A figure the system cannot compute must be
 *      reported as unavailable with a reason — never as a zero, which is itself
 *      a claim. "No incidents today" and "we cannot count incidents today" look
 *      identical on a tile and mean opposite things.
 *
 *   2. IT AGREES WITH THE SCREEN IT LINKS TO. The dashboard is composed from the
 *      dispatch reads precisely so a count here cannot disagree with the board
 *      an operator opens next.
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
  await h.db.execute(sql`
    UPDATE panic_event SET resolved_at = now() WHERE resolved_at IS NULL
  `);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}${Date.now().toString(36).slice(-4)}`;
}

interface Person {
  username: string;
  userId: string;
  memberId: string;
  organizationId: string;
  headers: Record<string, string>;
}

async function member(prefix: string, orgKey: string, roleKey: string): Promise<Person> {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  const m = await grantMembership(h.db, creds.username, { orgKey, roleKey });
  const auth = await signIn(h, creds);
  return {
    username: creds.username,
    userId: await userIdByUsername(h.db, creds.username),
    memberId: m.memberId,
    organizationId: m.organizationId,
    headers: auth.headers,
  };
}

interface MetricBody {
  available: boolean;
  value?: number;
  sampleSize: number;
  reason?: string;
  detail?: string;
}

interface DashboardBody {
  self: {
    displayName: string; rankName: string | null; memberCallsign: string | null;
    unitCallsign: string | null; statusKey: string | null; canOperate: boolean;
    assignment: { number: string } | null;
    organization: { key: string } | null;
  };
  /**
   * Named explicitly rather than as `Record<string, number>`: under
   * `noUncheckedIndexedAccess` an index read is `number | undefined`, so the
   * loose type turns every assertion into a null check and hides typos behind
   * `undefined` instead of failing.
   */
  counts: {
    activeIncidents: number; unassignedIncidents: number; criticalIncidents: number;
    unitsAvailable: number; unitsBusy: number; unitsInOperation: number;
    unitsAtHq: number; unitsPanic: number; unitsOffline: number; unitsTotal: number;
    personnelOnDuty: number; personnelSignedIn: number;
    personnelInUnits: number; personnelTotal: number;
  };
  statistics: {
    windowStart: string; windowEnd: string;
    incidentsToday: number; incidentsClosedToday: number;
    timeToFirstUnit: MetricBody; timeToActive: MetricBody; responseTime: MetricBody;
  };
  alerts: { id: string; kind: string; tone: string; title: string; target: string | null }[];
  alertOverflow: number;
  incidents: { id: string; priority: number; assignedUnitIds: string[] }[];
  units: { id: string; callsign: string }[];
  revision: string;
}

async function dashboard(who: Person): Promise<{ status: number; body: DashboardBody; raw: string }> {
  const res = await h.app.inject({
    method: 'GET', url: '/api/v1/dashboard', headers: who.headers,
  });
  return { status: res.statusCode, body: res.json() as DashboardBody, raw: res.body };
}

async function dispatchBoard(who: Person) {
  const res = await h.app.inject({
    method: 'GET', url: '/api/v1/dispatch/board', headers: who.headers,
  });
  return res.json() as {
    counts: {
      openIncidents: number; unitsAvailable: number; unitsPanic: number;
    };
    incidents: unknown[];
  };
}

async function makeIncident(who: Person, over: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: 'POST', url: '/api/v1/dispatch/incidents', headers: who.headers,
    payload: { title: unique('Call '), priority: 3, ...over },
  });
  return res.json() as { id: string; number: string };
}

async function makeUnit(orgKey: string): Promise<{ id: string; callsign: string }> {
  const callsign = unique('DB').toUpperCase();
  const orgId = await organizationIdByKey(h.db, orgKey);
  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO unit (organization_id, callsign, unit_type, status_key)
    VALUES (${orgId}, ${callsign}, 'patrol', 'available')
    RETURNING id
  `);
  return { id: rows[0]!.id, callsign };
}

// ── Access ─────────────────────────────────────────────────────────────────

describe('dashboard access', () => {
  it('serves a snapshot to a member who can view dispatch', async () => {
    const sgt = await member('dbsgt', 'PD', 'sergeant');
    const result = await dashboard(sgt);
    expect(result.status).toBe(200);
    expect(result.body.self.canOperate).toBe(true);
  });

  it('returns 404 without dispatch.view', async () => {
    // The dashboard is a summary of exactly the dispatch data, so a caller who
    // may not see the board must not see its totals either.
    const officer = await member('dbdenied', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'dispatch.view', 'deny');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/dashboard', headers: officer.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('does not leak another organization units', async () => {
    const foreign = await makeUnit('MD');
    const officer = await member('dbscope', 'PD', 'officer');
    const result = await dashboard(officer);
    expect(result.body.units.map((u) => u.id)).not.toContain(foreign.id);
    expect(result.raw).not.toContain(foreign.callsign);
  });
});

// ── Honesty ────────────────────────────────────────────────────────────────

describe('statistics honesty', () => {
  /**
   * THE CENTRAL TEST OF THIS FILE.
   *
   * Nothing records a unit arriving on scene — the timeline has an `arrival`
   * entry type but no code path writes one. Reporting either available proxy
   * under the name "response time" would be inventing a number.
   */
  it('reports response time as NOT MEASURED, never as a value', async () => {
    const sgt = await member('dbresponse', 'PD', 'sergeant');
    const { responseTime } = (await dashboard(sgt)).body.statistics;

    expect(responseTime.available).toBe(false);
    expect(responseTime.reason).toBe('not-measured');
    expect(responseTime.value).toBeUndefined();
    // And it says why, so the gap reads as a missing capability rather than a
    // quiet shift.
    expect(responseTime.detail).toMatch(/arrival/i);
  });

  it('refuses to average too few observations', async () => {
    const sgt = await member('dbsample', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/units`,
      headers: sgt.headers, payload: { unitId: unit.id },
    });
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/status`,
      headers: sgt.headers, payload: { status: 'on_scene' },
    });

    const { timeToActive } = (await dashboard(sgt)).body.statistics;
    if (!timeToActive.available) {
      expect(['no-data', 'insufficient-sample']).toContain(timeToActive.reason);
      expect(timeToActive.value).toBeUndefined();
    } else {
      // If it IS available it must have cleared the floor.
      expect(timeToActive.sampleSize).toBeGreaterThanOrEqual(MIN_METRIC_SAMPLE);
    }
  });

  it('never reports an available metric below the sample floor', async () => {
    const sgt = await member('dbfloor', 'PD', 'sergeant');
    const { statistics } = (await dashboard(sgt)).body;

    for (const key of ['timeToFirstUnit', 'timeToActive', 'responseTime'] as const) {
      const m = statistics[key];
      if (m.available) expect(m.sampleSize).toBeGreaterThanOrEqual(MIN_METRIC_SAMPLE);
    }
  });

  it('states the window its "today" figures cover', async () => {
    // An average without a window is not a statistic, and the browser must not
    // have to assume its timezone matches the server's.
    const sgt = await member('dbwindow', 'PD', 'sergeant');
    const { statistics } = (await dashboard(sgt)).body;

    const start = Date.parse(statistics.windowStart);
    const end = Date.parse(statistics.windowEnd);
    expect(Number.isNaN(start)).toBe(false);
    expect(Number.isNaN(end)).toBe(false);
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it('counts a call opened today', async () => {
    const sgt = await member('dbtoday', 'PD', 'sergeant');
    const before = (await dashboard(sgt)).body.statistics.incidentsToday;
    await makeIncident(sgt);
    const after = (await dashboard(sgt)).body.statistics.incidentsToday;
    expect(after).toBe(before + 1);
  });

  /**
   * "Online" is ambiguous, so it is not reported.
   *
   * A duty status stays where it was left, so counting on-duty statuses as
   * "online" would report members who have not been seen in days. Both figures
   * are exact and both are named for what they measure.
   */
  it('reports on-duty and signed-in separately', async () => {
    const sgt = await member('dbpersonnel', 'PD', 'sergeant');
    const { counts } = (await dashboard(sgt)).body;

    expect(typeof counts.personnelOnDuty).toBe('number');
    expect(typeof counts.personnelSignedIn).toBe('number');
    expect(counts).not.toHaveProperty('personnelOnline');
    // Everyone signed in has an active membership, so it cannot exceed the total.
    expect(counts.personnelSignedIn).toBeLessThanOrEqual(counts.personnelTotal);
  });

  it('counts the signed-in member themselves', async () => {
    const sgt = await member('dbsignedin', 'PD', 'sergeant');
    const { counts } = (await dashboard(sgt)).body;
    expect(counts.personnelSignedIn).toBeGreaterThanOrEqual(1);
  });
});

// ── Agreement with dispatch ────────────────────────────────────────────────

describe('agreement with the dispatch board', () => {
  it('reports the same open incident count', async () => {
    // Composed from the same reads precisely so this can never drift.
    const sgt = await member('dbagree', 'PD', 'sergeant');
    await makeIncident(sgt);

    const dash = await dashboard(sgt);
    const board = await dispatchBoard(sgt);
    expect(dash.body.counts.activeIncidents).toBe(board.counts.openIncidents);
  });

  it('reports the same unit availability', async () => {
    const sgt = await member('dbagreeunits', 'PD', 'sergeant');
    await makeUnit('PD');

    const dash = await dashboard(sgt);
    const board = await dispatchBoard(sgt);
    expect(dash.body.counts.unitsAvailable).toBe(board.counts.unitsAvailable);
    expect(dash.body.counts.unitsPanic).toBe(board.counts.unitsPanic);
  });

  it('shares the dispatch revision so the two cannot lag each other', async () => {
    const sgt = await member('dbrevision', 'PD', 'sergeant');
    const dash = await dashboard(sgt);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/board/poll',
      headers: sgt.headers, payload: { revision: dash.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(false);
  });
});

// ── Ordering and alerts ────────────────────────────────────────────────────

describe('ordering and alerts', () => {
  it('orders by operational importance, unassigned first within a priority', async () => {
    const sgt = await member('dborder', 'PD', 'sergeant');
    const assigned = await makeIncident(sgt, { title: unique('Assigned '), priority: 1 });
    const unassigned = await makeIncident(sgt, { title: unique('Unassigned '), priority: 1 });
    const unit = await makeUnit('PD');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${assigned.id}/units`,
      headers: sgt.headers, payload: { unitId: unit.id },
    });

    const { incidents } = (await dashboard(sgt)).body;
    const iUnassigned = incidents.findIndex((i) => i.id === unassigned.id);
    const iAssigned = incidents.findIndex((i) => i.id === assigned.id);
    expect(iUnassigned).toBeGreaterThanOrEqual(0);
    expect(iAssigned).toBeGreaterThanOrEqual(0);
    expect(iUnassigned).toBeLessThan(iAssigned);
  });

  it('raises a critical incident as an alert', async () => {
    const sgt = await member('dbalert', 'PD', 'sergeant');
    const call = await makeIncident(sgt, { title: unique('Critical '), priority: 1 });

    const { alerts, alertOverflow } = (await dashboard(sgt)).body;
    const listed = alerts.some((a) => a.id === `critical:${call.id}`);
    // Either it is listed or it is in the overflow — never silently dropped.
    expect(listed || alertOverflow > 0).toBe(true);
  });

  it('raises a live panic as the top alert', async () => {
    const officer = await member('dbpanic', 'PD', 'officer');
    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: officer.headers, payload: {},
    });

    const { alerts } = (await dashboard(officer)).body;
    expect(alerts[0]?.kind).toBe('panic');
    expect(alerts[0]?.tone).toBe('danger');
  });

  it('caps the alert list and counts the remainder rather than dropping it', async () => {
    const sgt = await member('dbcap', 'PD', 'sergeant');
    for (let i = 0; i < 9; i += 1) {
      await makeIncident(sgt, { title: unique('Crit '), priority: 1 });
    }

    const { alerts, alertOverflow } = (await dashboard(sgt)).body;
    expect(alerts.length).toBeLessThanOrEqual(6);
    expect(alertOverflow).toBeGreaterThan(0);
  });

  it('names a screen rather than a URL', async () => {
    // The API has no business knowing the web app's routing table.
    const sgt = await member('dbtarget', 'PD', 'sergeant');
    await makeIncident(sgt, { priority: 1 });
    const { alerts } = (await dashboard(sgt)).body;

    for (const alert of alerts) {
      if (alert.target !== null) expect(['dispatch', 'map']).toContain(alert.target);
      expect(alert).not.toHaveProperty('href');
    }
  });

  it('reports the FiveM bridge as a system alert while it is not connected', async () => {
    // Engineering rules 34, 35, 45: an operator reading unit positions needs to
    // know they are simulated.
    const sgt = await member('dbsystem', 'PD', 'sergeant');
    const { alerts, alertOverflow } = (await dashboard(sgt)).body;
    const hasSystem = alerts.some((a) => a.kind === 'system');
    expect(hasSystem || alertOverflow > 0).toBe(true);
  });
});

// ── The operator ───────────────────────────────────────────────────────────

describe('current user', () => {
  it('reports organization, rank, callsign, unit, status and assignment', async () => {
    const sgt = await member('dbself', 'PD', 'sergeant');
    const unit = await makeUnit('PD');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/self/unit/${unit.id}`, headers: sgt.headers,
    });
    const call = await makeIncident(sgt);
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/units`,
      headers: sgt.headers, payload: { unitId: unit.id },
    });

    const { self } = (await dashboard(sgt)).body;
    expect(self.organization?.key.toUpperCase()).toBe('PD');
    expect(self.rankName).toBe('Sergeant');
    expect(self.unitCallsign).toBe(unit.callsign);
    expect(self.assignment?.number).toBe(call.number);
    expect(self.statusKey).not.toBeNull();
  });

  it('distinguishes the member callsign from the unit callsign', async () => {
    // They are different things: an officer has a personal callsign whether or
    // not they are in a car.
    const sgt = await member('dbcallsign', 'PD', 'sergeant');
    const unit = await makeUnit('PD');
    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/self/unit/${unit.id}`, headers: sgt.headers,
    });

    const { self } = (await dashboard(sgt)).body;
    expect(self.unitCallsign).toBe(unit.callsign);
    expect(self.memberCallsign).not.toBeNull();
    expect(self.memberCallsign).not.toBe(self.unitCallsign);
  });

  it('reports a suspended membership as unable to operate', async () => {
    const officer = await member('dbsuspended', 'PD', 'officer');
    await h.db.execute(sql`
      UPDATE organization_member SET status = 'suspended' WHERE id = ${officer.memberId}
    `);
    // A suspended membership resolves no permissions, so the dashboard is gone
    // entirely — the stronger answer.
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/dashboard', headers: officer.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Poll ───────────────────────────────────────────────────────────────────

describe('dashboard poll', () => {
  it('reports no change when nothing has moved', async () => {
    const sgt = await member('dbpoll', 'PD', 'sergeant');
    const first = await dashboard(sgt);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dashboard/poll',
      headers: sgt.headers, payload: { revision: first.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(false);
  });

  it('reports a change after every event the brief lists', async () => {
    const sgt = await member('dbpollevents', 'PD', 'sergeant');
    const unit = await makeUnit('PD');

    const events: [string, () => Promise<unknown>][] = [
      ['incident created', () => makeIncident(sgt)],
      ['unit status changed', () => h.app.inject({
        method: 'POST', url: `/api/v1/dispatch/units/${unit.id}/status`,
        headers: sgt.headers, payload: { statusKey: 'busy' },
      })],
      ['unit joined', () => h.app.inject({
        method: 'POST', url: `/api/v1/dispatch/self/unit/${unit.id}`, headers: sgt.headers,
      })],
      ['personnel status changed', () => h.app.inject({
        method: 'POST', url: '/api/v1/dispatch/self/status',
        headers: sgt.headers, payload: { statusKey: 'in_operation' },
      })],
      ['unit left', () => h.app.inject({
        method: 'DELETE', url: '/api/v1/dispatch/self/unit', headers: sgt.headers,
      })],
      ['panic', () => h.app.inject({
        method: 'POST', url: '/api/v1/dispatch/self/panic',
        headers: sgt.headers, payload: {},
      })],
    ];

    for (const [name, fire] of events) {
      const before = (await dashboard(sgt)).body.revision;
      await fire();
      const res = await h.app.inject({
        method: 'POST', url: '/api/v1/dashboard/poll',
        headers: sgt.headers, payload: { revision: before },
      });
      const changed = (res.json() as { changed: boolean }).changed;
      expect(changed, `${name} should move the revision`).toBe(true);
    }
  });
});
