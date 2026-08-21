import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, organizationIdByKey,
  resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';

/**
 * Dispatch authorization.
 *
 * Dispatch is where most of the day's mutations happen, and its defining risk is
 * different from the registers': everything here is ORGANIZATION-OWNED, and the
 * operations run concurrently by definition — two dispatchers work the same
 * board at the same second.
 *
 * So this file asks three questions repeatedly:
 *
 *   1. Can an operator act on ANOTHER organization's calls, units or people?
 *   2. Can an operator do something the permission model says they cannot —
 *      and in particular, can they do it to SOMEONE ELSE when they may only do
 *      it to themselves?
 *   3. Does the record survive? Every state change must leave a timeline entry
 *      and an audit row, and neither may be skippable.
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();

  /**
   * Stand down every live panic between tests.
   *
   * The suite shares the seeded organizations on purpose (see `resetAccounts`:
   * memberships are never deleted, because operational history must survive),
   * so a panic raised by one test is still live for the next one and every
   * count assertion drifts. Resolved rather than deleted — `panic_event` is a
   * record, and the tests should exercise the same lifecycle the application
   * does.
   */
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

async function post(who: Person, url: string, payload: Record<string, unknown> = {}) {
  const res = await h.app.inject({ method: 'POST', url, headers: who.headers, payload });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function del(who: Person, url: string) {
  const res = await h.app.inject({ method: 'DELETE', url, headers: who.headers });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

interface BoardBody {
  self: {
    memberId: string | null; statusKey: string | null; unitId: string | null;
    canOperate: boolean; ownPanicId: string | null;
  };
  counts: Record<string, number>;
  incidents: { id: string; number: string; status: string; priority: number;
    assignedUnitIds: string[] }[];
  units: { id: string; callsign: string; organization: { key: string } }[];
  panics: { id: string; memberName: string }[];
  statuses: { key: string; isPanic: boolean }[];
  capabilities: Record<string, boolean>;
  revision: string;
}

async function board(who: Person): Promise<{ status: number; body: BoardBody; raw: string }> {
  const res = await h.app.inject({
    method: 'GET', url: '/api/v1/dispatch/board', headers: who.headers,
  });
  return { status: res.statusCode, body: res.json() as BoardBody, raw: res.body };
}

async function makeUnit(orgKey: string): Promise<{ id: string; callsign: string }> {
  const callsign = unique('DU').toUpperCase();
  const orgId = await organizationIdByKey(h.db, orgKey);
  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO unit (organization_id, callsign, unit_type, status_key)
    VALUES (${orgId}, ${callsign}, 'patrol', 'available')
    RETURNING id
  `);
  return { id: rows[0]!.id, callsign };
}

async function makeIncident(who: Person, over: Record<string, unknown> = {}) {
  const result = await post(who, '/api/v1/dispatch/incidents', {
    title: unique('Call '), priority: 3, ...over,
  });
  return result.body as { id: string; number: string };
}

// ── Access ─────────────────────────────────────────────────────────────────

describe('dispatch access', () => {
  it('serves a board to a member who can view dispatch', async () => {
    const sgt = await member('dsgt', 'PD', 'sergeant');
    const result = await board(sgt);
    expect(result.status).toBe(200);
    expect(result.body.capabilities.canView).toBe(true);
    expect(result.body.self.canOperate).toBe(true);
  });

  it('returns 404, not 403, without dispatch.view', async () => {
    const officer = await member('ddenied', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'dispatch.view', 'deny');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/dispatch/board', headers: officer.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/dispatch/board' });
    expect(res.statusCode).toBe(401);
  });

  it('shows only the acting organization units', async () => {
    const foreign = await makeUnit('MD');
    const officer = await member('dscope', 'PD', 'officer');
    const result = await board(officer);

    expect(result.body.units.map((u) => u.id)).not.toContain(foreign.id);
    expect(result.raw).not.toContain(foreign.callsign);
  });
});

// ── Incidents ──────────────────────────────────────────────────────────────

describe('incidents', () => {
  it('creates a call owned by the actor organization', async () => {
    const sgt = await member('dcreate', 'PD', 'sergeant');
    const created = await makeIncident(sgt, { title: 'Armed robbery in progress', priority: 1 });
    expect(created.id).toBeDefined();

    const rows = await h.db.execute<{ organization_id: string; status: string }>(sql`
      SELECT organization_id, status FROM incident WHERE id = ${created.id}
    `);
    expect(rows[0]?.organization_id).toBe(sgt.organizationId);
    expect(rows[0]?.status).toBe('pending');
  });

  it('refuses to file a call onto another organization board', async () => {
    // Engineering rule 11: the owning organization comes from the actor, never
    // from the body.
    const sgt = await member('dcrossfile', 'PD', 'sergeant');
    const otherOrg = await organizationIdByKey(h.db, 'MD');
    const result = await post(sgt, '/api/v1/dispatch/incidents', {
      title: unique('Cross '), priority: 3, organizationId: otherOrg,
    });
    expect(result.status).toBe(403);
  });

  it('refuses creation without dispatch.create', async () => {
    const officer = await member('dnocreate', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'dispatch.create', 'deny');
    const result = await post(officer, '/api/v1/dispatch/incidents', {
      title: unique('Nope '), priority: 3,
    });
    expect(result.status).toBe(403);
  });

  it('hides another organization call behind a 404', async () => {
    const md = await member('dmdcall', 'MD', 'doctor');
    const call = await makeIncident(md, { title: unique('MD call ') });

    const pd = await member('dpdlook', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/dispatch/incidents/${call.id}`, headers: pd.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('enforces the transition table', async () => {
    const sgt = await member('dtrans', 'PD', 'sergeant');
    const call = await makeIncident(sgt);

    expect((await post(sgt, `/api/v1/dispatch/incidents/${call.id}/status`,
      { status: 'on_scene' })).status).toBe(200);
    // on_scene → pending is not in the table.
    const back = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/status`,
      { status: 'pending' });
    expect(back.status).toBe(409);
    expect(back.body.error).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('refuses to close through the status endpoint', async () => {
    // Closing captures notes and releases units; routing it through a plain
    // status change would skip both.
    const sgt = await member('dclosestatus', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const result = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/status`,
      { status: 'closed' });
    expect(result.status).toBe(400);
  });

  it('refuses closing without dispatch.close', async () => {
    const sgt = await member('dnoclose', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    await setPermissionOverride(h.db, sgt.memberId, 'dispatch.close', 'deny');
    const result = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/close`, {});
    expect(result.status).toBe(403);
  });

  it('refuses to edit a closed call', async () => {
    const sgt = await member('deditclosed', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/close`, {});

    const res = await h.app.inject({
      method: 'PATCH', url: `/api/v1/dispatch/incidents/${call.id}`,
      headers: sgt.headers, payload: { title: 'Rewriting history' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('reopens with a reason recorded in the timeline', async () => {
    const sgt = await member('dreopen', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/close`, {});

    const result = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/reopen`,
      { reason: 'Caller rang back, suspect returned' });
    expect(result.status).toBe(200);

    const detail = await h.app.inject({
      method: 'GET', url: `/api/v1/dispatch/incidents/${call.id}`, headers: sgt.headers,
    });
    const body = detail.json() as { status: string; timeline: { body: string | null }[] };
    expect(body.status).toBe('pending');
    expect(body.timeline.some((e) => e.body?.includes('suspect returned'))).toBe(true);
  });
});

// ── Assignment ─────────────────────────────────────────────────────────────

describe('assignment', () => {
  it('assigns a unit and advances a pending call to dispatched', async () => {
    const sgt = await member('dassign', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');

    const result = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`,
      { unitId: unit.id });
    expect(result.status).toBe(201);

    const rows = await h.db.execute<{ status: string; current: string | null }>(sql`
      SELECT i.status, u.current_incident_id AS current
        FROM incident i JOIN unit u ON u.id = ${unit.id}
       WHERE i.id = ${call.id}
    `);
    expect(rows[0]?.status).toBe('dispatched');
    // The denormalised pointer and the assignment row are written together.
    expect(rows[0]?.current).toBe(call.id);
  });

  it('refuses a unit from another organization', async () => {
    // A PD dispatcher committing an MD ambulance is the cross-organization write
    // the whole system defends against.
    const sgt = await member('dcrossassign', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const foreign = await makeUnit('MD');

    const result = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`,
      { unitId: foreign.id });
    expect(result.status).toBe(403);
  });

  it('refuses assignment without dispatch.assign', async () => {
    const sgt = await member('dnoassign', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');
    await setPermissionOverride(h.db, sgt.memberId, 'dispatch.assign', 'deny');

    const result = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`,
      { unitId: unit.id });
    expect(result.status).toBe(403);
  });

  it('refuses the same unit twice', async () => {
    const sgt = await member('ddouble', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');

    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`, { unitId: unit.id });
    const again = await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`,
      { unitId: unit.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ALREADY_ASSIGNED' });
  });

  it('releases every unit when the call closes', async () => {
    // Otherwise a unit ends its shift still committed to a call that finished
    // hours ago, and the available count drifts away from reality.
    const sgt = await member('dcloserelease', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`, { unitId: unit.id });

    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/close`, { notes: 'Done' });

    const open = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident_assignment
       WHERE incident_id = ${call.id} AND released_at IS NULL
    `);
    expect(open[0]?.n).toBe(0);

    const pointer = await h.db.execute<{ current: string | null }>(sql`
      SELECT current_incident_id AS current FROM unit WHERE id = ${unit.id}
    `);
    expect(pointer[0]?.current).toBeNull();
  });
});

// ── Self-assignment and status ─────────────────────────────────────────────

describe('self-assignment', () => {
  it('crews the caller into a unit in their own organization', async () => {
    const officer = await member('djoin', 'PD', 'officer');
    const unit = await makeUnit('PD');

    const result = await post(officer, `/api/v1/dispatch/self/unit/${unit.id}`);
    expect(result.status).toBe(200);

    const after = await board(officer);
    expect(after.body.self.unitId).toBe(unit.id);
  });

  it('refuses a unit from another organization', async () => {
    const officer = await member('djoincross', 'PD', 'officer');
    const foreign = await makeUnit('MD');
    const result = await post(officer, `/api/v1/dispatch/self/unit/${foreign.id}`);
    expect(result.status).toBe(403);
  });

  it('refuses a disbanded unit', async () => {
    const officer = await member('djoindead', 'PD', 'officer');
    const unit = await makeUnit('PD');
    await h.db.execute(sql`
      UPDATE unit SET status = 'disbanded', disbanded_at = now() WHERE id = ${unit.id}
    `);
    const result = await post(officer, `/api/v1/dispatch/self/unit/${unit.id}`);
    expect(result.status).toBe(409);
  });

  it('refuses a unit that does not exist', async () => {
    const officer = await member('djoinghost', 'PD', 'officer');
    const result = await post(
      officer, '/api/v1/dispatch/self/unit/00000000-0000-4000-8000-000000000000',
    );
    expect(result.status).toBe(404);
  });

  it('shuts a suspended membership out of dispatch entirely', async () => {
    /**
     * 404, not 403 — and that is the stronger answer.
     *
     * A suspended membership resolves no permissions at all, so `dispatch.view`
     * fails and the whole module becomes invisible before the join is even
     * considered. The five self-assignment checks are still there as a second
     * line (a membership can be suspended between the context load and the
     * mutation), but they are not what a suspended member meets first.
     */
    const officer = await member('djoininactive', 'PD', 'officer');
    const unit = await makeUnit('PD');
    await h.db.execute(sql`
      UPDATE organization_member SET status = 'suspended' WHERE id = ${officer.memberId}
    `);

    const result = await post(officer, `/api/v1/dispatch/self/unit/${unit.id}`);
    expect(result.status).toBe(404);

    const view = await h.app.inject({
      method: 'GET', url: '/api/v1/dispatch/board', headers: officer.headers,
    });
    expect(view.statusCode).toBe(404);
  });

  it('moves the caller rather than failing when they are already crewed', async () => {
    // A member is in at most one active unit, enforced by a partial unique index.
    // Joining a second should move them, not hit the constraint.
    const officer = await member('dmove', 'PD', 'officer');
    const first = await makeUnit('PD');
    const second = await makeUnit('PD');

    await post(officer, `/api/v1/dispatch/self/unit/${first.id}`);
    const result = await post(officer, `/api/v1/dispatch/self/unit/${second.id}`);
    expect(result.status).toBe(200);

    const after = await board(officer);
    expect(after.body.self.unitId).toBe(second.id);

    const active = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM unit_member
       WHERE member_id = ${officer.memberId} AND left_at IS NULL
    `);
    expect(active[0]?.n).toBe(1);
  });

  it('leaves a unit', async () => {
    const officer = await member('dleave', 'PD', 'officer');
    const unit = await makeUnit('PD');
    await post(officer, `/api/v1/dispatch/self/unit/${unit.id}`);

    expect((await del(officer, '/api/v1/dispatch/self/unit')).status).toBe(200);
    expect((await board(officer)).body.self.unitId).toBeNull();
  });
});

describe('operational status', () => {
  // NOTE: the history column is created_at, not changed_at. The Drizzle property
  // is `changedAt`, but the shared createdAt() helper names the column, and raw
  // SQL is not typechecked — this has now caught three times in this module.
  it('sets the caller own status and records history', async () => {
    const officer = await member('dstatus', 'PD', 'officer');
    expect((await post(officer, '/api/v1/dispatch/self/status',
      { statusKey: 'busy' })).status).toBe(200);

    expect((await board(officer)).body.self.statusKey).toBe('busy');

    const history = await h.db.execute<{ to_status_key: string }>(sql`
      SELECT to_status_key FROM member_status_history
       WHERE member_id = ${officer.memberId}
       ORDER BY created_at DESC LIMIT 1
    `);
    expect(history[0]?.to_status_key).toBe('busy');
  });

  it('needs no dispatch management permission', async () => {
    // An officer with no dispatch authority still has to be able to go
    // available. This is the asymmetry the module is built around.
    const officer = await member('dstatusbare', 'PD', 'officer');
    for (const key of ['dispatch.create', 'dispatch.manage', 'dispatch.assign',
      'dispatch.close', 'units.manage'] as const) {
      await setPermissionOverride(h.db, officer.memberId, key, 'deny');
    }
    const result = await post(officer, '/api/v1/dispatch/self/status', { statusKey: 'busy' });
    expect(result.status).toBe(200);
  });

  it('refuses a status outside the catalogue', async () => {
    const officer = await member('dbadstatus', 'PD', 'officer');
    const result = await post(officer, '/api/v1/dispatch/self/status',
      { statusKey: 'definitely-not-a-status' });
    expect(result.status).toBe(400);
  });

  it('refuses panic as a plain status change', async () => {
    // Panic must create the event record; setting it as a status would be the
    // "merely visual state" the brief rules out.
    const officer = await member('dpanicstatus', 'PD', 'officer');
    const result = await post(officer, '/api/v1/dispatch/self/status', { statusKey: 'panic' });
    expect(result.status).toBe(400);
  });

  it('carries the crewed unit status along with the member', async () => {
    const officer = await member('dunitstatus', 'PD', 'officer');
    const unit = await makeUnit('PD');
    await post(officer, `/api/v1/dispatch/self/unit/${unit.id}`);
    await post(officer, '/api/v1/dispatch/self/status', { statusKey: 'in_operation' });

    const rows = await h.db.execute<{ status_key: string }>(sql`
      SELECT status_key FROM unit WHERE id = ${unit.id}
    `);
    expect(rows[0]?.status_key).toBe('in_operation');
  });

  it('has no endpoint for setting someone else status', async () => {
    // A status is a statement about what a person is doing. A board where a
    // dispatcher can declare an officer "available" reads confidently and is
    // wrong — so the capability simply does not exist.
    const sgt = await member('dotherstatus', 'PD', 'sergeant');
    const victim = await member('dvictim', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/dispatch/members/${victim.memberId}/status`,
      headers: sgt.headers,
      payload: { statusKey: 'available' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Panic ──────────────────────────────────────────────────────────────────

describe('panic', () => {
  it('is server-side state, not a client flag', async () => {
    const officer = await member('dpanic', 'PD', 'officer');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});
    expect(raised.status).toBe(201);

    const rows = await h.db.execute<{ id: string; resolved_at: Date | null }>(sql`
      SELECT id, resolved_at FROM panic_event WHERE member_id = ${officer.memberId}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolved_at).toBeNull();

    const after = await board(officer);
    expect(after.body.self.statusKey).toBe('panic');
    expect(after.body.self.ownPanicId).toBe(rows[0]?.id);
    expect(after.body.panics.map((p) => p.id)).toContain(rows[0]?.id);
  });

  it('is idempotent while an alert is live', async () => {
    // People press the button repeatedly. Ten rows for one emergency makes the
    // board harder to read at the moment it matters most.
    const officer = await member('dpanictwice', 'PD', 'officer');
    const first = await post(officer, '/api/v1/dispatch/self/panic', {});
    const second = await post(officer, '/api/v1/dispatch/self/panic', {});
    expect(second.body.id).toBe(first.body.id);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM panic_event WHERE member_id = ${officer.memberId}
    `);
    expect(rows[0]?.n).toBe(1);
  });

  it('reaches other operators in the same organization', async () => {
    const officer = await member('dpanicraiser', 'PD', 'officer');
    const sgt = await member('dpanicwatcher', 'PD', 'sergeant');
    await post(officer, '/api/v1/dispatch/self/panic', {});

    const watcher = await board(sgt);
    const own = (await board(officer)).body.self.ownPanicId;
    expect(own).not.toBeNull();
    expect(watcher.body.panics.map((p) => p.id)).toContain(own);
    expect(watcher.body.counts.livePanics).toBeGreaterThan(0);
  });

  it('does not reach another organization', async () => {
    const officer = await member('dpanicpd', 'PD', 'officer');
    await post(officer, '/api/v1/dispatch/self/panic', {});

    const md = await member('dpanicmd', 'MD', 'doctor');
    const own = (await board(officer)).body.self.ownPanicId;
    const other = await board(md);
    expect(other.body.panics.map((p) => p.id)).not.toContain(own);
  });

  /**
   * ACKNOWLEDGING IS NOT RESOLVING.
   *
   * "A dispatcher has seen this" and "the officer is safe" are different facts.
   * Collapsing them would clear the alert from every board while the situation
   * is still running.
   */
  it('keeps the alert live after acknowledgement', async () => {
    const officer = await member('dack', 'PD', 'officer');
    const sgt = await member('dackdispatcher', 'PD', 'sergeant');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});

    const ack = await post(sgt, `/api/v1/dispatch/panics/${raised.body.id}/acknowledge`, {});
    expect(ack.status).toBe(200);

    const after = await board(sgt);
    expect(after.body.panics.map((p) => p.id)).toContain(raised.body.id);
  });

  it('refuses acknowledgement without the permission', async () => {
    const officer = await member('dackraiser', 'PD', 'officer');
    const other = await member('dacknoperm', 'PD', 'officer');
    await setPermissionOverride(h.db, other.memberId, 'dispatch.panic.acknowledge', 'deny');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});

    const result = await post(other, `/api/v1/dispatch/panics/${raised.body.id}/acknowledge`, {});
    expect(result.status).toBe(403);
  });

  it('lets the officer who raised it stand it down', async () => {
    // The person best placed to know it is over is usually the one who called it.
    const officer = await member('dselfresolve', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'dispatch.panic.acknowledge', 'deny');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});

    const result = await post(officer, `/api/v1/dispatch/panics/${raised.body.id}/resolve`, {});
    expect(result.status).toBe(200);

    const after = await board(officer);
    expect(after.body.panics.map((p) => p.id)).not.toContain(raised.body.id);
    expect(after.body.self.ownPanicId).toBeNull();
    // Restored to busy, not available: someone who has just been through this is
    // not immediately ready for the next call.
    expect(after.body.self.statusKey).toBe('busy');
  });

  it('refuses to stand down someone else alert without the permission', async () => {
    const officer = await member('dresolveraiser', 'PD', 'officer');
    const other = await member('dresolvenoperm', 'PD', 'officer');
    await setPermissionOverride(h.db, other.memberId, 'dispatch.panic.acknowledge', 'deny');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});

    const result = await post(other, `/api/v1/dispatch/panics/${raised.body.id}/resolve`, {});
    expect(result.status).toBe(403);
  });

  it('hides another organization alert behind a 404', async () => {
    const pd = await member('dpanichide', 'PD', 'officer');
    const raised = await post(pd, '/api/v1/dispatch/self/panic', {});

    const md = await member('dpanicmdack', 'MD', 'doctor');
    const result = await post(md, `/api/v1/dispatch/panics/${raised.body.id}/acknowledge`, {});
    expect(result.status).toBe(404);
  });

  it('audits the whole lifecycle', async () => {
    const officer = await member('dpanicaudit', 'PD', 'officer');
    const sgt = await member('dpanicauditsgt', 'PD', 'sergeant');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});
    await post(sgt, `/api/v1/dispatch/panics/${raised.body.id}/acknowledge`, {});
    await post(sgt, `/api/v1/dispatch/panics/${raised.body.id}/resolve`, {});

    const rows = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
       WHERE entity_type = 'panic_event' AND entity_id = ${raised.body.id}
       ORDER BY occurred_at
    `);
    expect(rows.map((r) => r.action)).toEqual([
      'panic.triggered', 'panic.acknowledged', 'panic.resolved',
    ]);
  });
});

// ── Units ──────────────────────────────────────────────────────────────────

describe('unit management', () => {
  it('creates a unit and crews the creator', async () => {
    const sgt = await member('dunitcreate', 'PD', 'sergeant');
    const callsign = unique('NU').toUpperCase();
    const result = await post(sgt, '/api/v1/dispatch/units', { callsign, joinSelf: true });
    expect(result.status).toBe(201);
    expect((await board(sgt)).body.self.unitId).toBe(result.body.id);
  });

  it('refuses creation without units.manage', async () => {
    const officer = await member('dunitnoperm', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'units.manage', 'deny');
    const result = await post(officer, '/api/v1/dispatch/units',
      { callsign: unique('NX').toUpperCase() });
    expect(result.status).toBe(403);
  });

  it('refuses a callsign already in use', async () => {
    const sgt = await member('dcallsign', 'PD', 'sergeant');
    const callsign = unique('DUP').toUpperCase();
    expect((await post(sgt, '/api/v1/dispatch/units',
      { callsign, joinSelf: false })).status).toBe(201);
    const again = await post(sgt, '/api/v1/dispatch/units', { callsign, joinSelf: false });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CALLSIGN_TAKEN' });
  });

  it('refuses to disband a unit that is on a call', async () => {
    // Disbanding a committed unit leaves a call with a phantom responder.
    const sgt = await member('ddisbandbusy', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`, { unitId: unit.id });

    const result = await del(sgt, `/api/v1/dispatch/units/${unit.id}`);
    expect(result.status).toBe(409);
    expect(result.body.error).toMatchObject({ code: 'UNIT_ON_CALL' });
  });

  it('hides another organization unit behind a 404 on disband', async () => {
    const sgt = await member('ddisbandcross', 'PD', 'sergeant');
    const foreign = await makeUnit('MD');
    const result = await del(sgt, `/api/v1/dispatch/units/${foreign.id}`);
    expect(result.status).toBe(404);
  });

  it('clears the crew when a unit is disbanded', async () => {
    const sgt = await member('ddisband', 'PD', 'sergeant');
    const unit = await makeUnit('PD');
    await post(sgt, `/api/v1/dispatch/self/unit/${unit.id}`);

    expect((await del(sgt, `/api/v1/dispatch/units/${unit.id}`)).status).toBe(200);
    expect((await board(sgt)).body.self.unitId).toBeNull();
  });
});

// ── Unit status, set by a dispatcher rather than by the crew ───────────────
//
// `POST /units/:unitId/status` is a different operation from `POST /self/status`
// and had no coverage of its own. It is a dispatcher marking a CAR out of
// service — a statement about the vehicle, not about the people in it — so it is
// gated on `units.manage` where the self endpoint is gated on nothing but an
// active membership. The two being adjacent in the routes file is exactly why
// this needs testing: the wrong one is easy to reach for.

describe('unit status set by a dispatcher', () => {
  it('sets the status of a unit the caller does not crew', async () => {
    const sgt = await member('dustatus', 'PD', 'sergeant');
    const unit = await makeUnit('PD');

    const result = await post(sgt, `/api/v1/dispatch/units/${unit.id}/status`,
      { statusKey: 'at_hq' });
    expect(result.status).toBe(200);

    const [row] = await h.db.execute<{ status_key: string }>(
      sql`SELECT status_key FROM unit WHERE id = ${unit.id}`,
    );
    expect(row!.status_key).toBe('at_hq');
  });

  it('refuses without units.manage, where the SELF endpoint would allow it', async () => {
    const officer = await member('dustatusperm', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'units.manage', 'deny');
    const unit = await makeUnit('PD');

    expect((await post(officer, `/api/v1/dispatch/units/${unit.id}/status`,
      { statusKey: 'at_hq' })).status).toBe(403);

    // The same operator can still set their OWN status, which is the whole
    // point of the two endpoints being separate.
    expect((await post(officer, '/api/v1/dispatch/self/status',
      { statusKey: 'busy' })).status).toBe(200);
  });

  it('hides another organization unit behind a 404', async () => {
    const sgt = await member('dustatuscross', 'PD', 'sergeant');
    const foreign = await makeUnit('MD');
    const result = await post(sgt, `/api/v1/dispatch/units/${foreign.id}/status`,
      { statusKey: 'busy' });
    expect(result.status).toBe(404);
  });

  it('refuses a status outside the catalogue', async () => {
    const sgt = await member('dustatusbad', 'PD', 'sergeant');
    const unit = await makeUnit('PD');
    const result = await post(sgt, `/api/v1/dispatch/units/${unit.id}/status`,
      { statusKey: 'definitely_not_a_status' });
    expect([400, 422]).toContain(result.status);
  });

  it('refuses to set the status of a disbanded unit', async () => {
    const sgt = await member('dustatusdead', 'PD', 'sergeant');
    const unit = await makeUnit('PD');
    expect((await del(sgt, `/api/v1/dispatch/units/${unit.id}`)).status).toBe(200);

    const result = await post(sgt, `/api/v1/dispatch/units/${unit.id}/status`,
      { statusKey: 'busy' });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatchObject({ code: 'UNIT_DISBANDED' });
  });

  it('audits the change against the unit, not against the actor member', async () => {
    const sgt = await member('dustatusaudit', 'PD', 'sergeant');
    const unit = await makeUnit('PD');
    await post(sgt, `/api/v1/dispatch/units/${unit.id}/status`, { statusKey: 'busy' });

    const rows = await h.db.execute<{ entity_type: string; metadata: Record<string, unknown> }>(sql`
      SELECT entity_type, metadata FROM audit_log
       WHERE entity_id = ${unit.id} AND action = 'status.changed'
       ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(rows[0]?.entity_type).toBe('unit');
    expect(rows[0]?.metadata).toMatchObject({ self: false });
  });
});

// ── The record ─────────────────────────────────────────────────────────────

describe('the record', () => {
  it('writes a timeline entry for every state change', async () => {
    const sgt = await member('dtimeline', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');

    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`, { unitId: unit.id });
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/status`, { status: 'on_scene' });
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/priority`, { priority: 1 });
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/notes`, { body: 'On scene, one in custody.' });
    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/close`, { notes: 'Resolved.' });

    const detail = await h.app.inject({
      method: 'GET', url: `/api/v1/dispatch/incidents/${call.id}`, headers: sgt.headers,
    });
    const body = detail.json() as { timeline: { kind: string }[] };
    expect(body.timeline.map((e) => e.kind)).toEqual([
      'system', 'assignment', 'status_change', 'status_change', 'note', 'clear',
    ]);
  });

  it('keeps the timeline append-only at the database level', async () => {
    const sgt = await member('dappendonly', 'PD', 'sergeant');
    const call = await makeIncident(sgt);

    // Not an API concern — a trigger. Tampering must require superuser access
    // rather than an application bug.
    await expect(h.db.execute(sql`
      UPDATE incident_log SET body = 'tampered' WHERE incident_id = ${call.id}
    `)).rejects.toThrow();
  });

  it('records a rolled-back change nowhere', async () => {
    // The audit row and the timeline entry are written inside the same
    // transaction as the change, so a refused change leaves no trace of having
    // succeeded.
    const sgt = await member('drollback', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const foreign = await makeUnit('MD');

    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`, { unitId: foreign.id });

    const timeline = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident_log
       WHERE incident_id = ${call.id} AND entry_type = 'assignment'
    `);
    expect(timeline[0]?.n).toBe(0);
  });
});

// ── The poll ───────────────────────────────────────────────────────────────

describe('board poll', () => {
  it('reports no change when nothing has moved', async () => {
    const sgt = await member('dpoll', 'PD', 'sergeant');
    const first = await board(sgt);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/board/poll',
      headers: sgt.headers, payload: { revision: first.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(false);
  });

  it('reports a change after a mutation', async () => {
    const sgt = await member('dpollchange', 'PD', 'sergeant');
    const first = await board(sgt);
    await makeIncident(sgt);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/board/poll',
      headers: sgt.headers, payload: { revision: first.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(true);
  });

  it('notices an assignment, which does not touch the incident own timestamp', async () => {
    const sgt = await member('dpollassign', 'PD', 'sergeant');
    const call = await makeIncident(sgt);
    const unit = await makeUnit('PD');
    const before = await board(sgt);

    await post(sgt, `/api/v1/dispatch/incidents/${call.id}/units`, { unitId: unit.id });

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/board/poll',
      headers: sgt.headers, payload: { revision: before.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(true);
  });

  it('notices a panic', async () => {
    const officer = await member('dpollpanic', 'PD', 'officer');
    const sgt = await member('dpollpanicsgt', 'PD', 'sergeant');
    const before = await board(sgt);

    await post(officer, '/api/v1/dispatch/self/panic', {});

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/board/poll',
      headers: sgt.headers, payload: { revision: before.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(true);
  });

  it('notices an acknowledgement', async () => {
    // Acknowledging changes `acknowledged_at` and nothing else — the revision
    // has to carry it or a dispatcher never learns somebody responded.
    const officer = await member('dpollack', 'PD', 'officer');
    const sgt = await member('dpollacksgt', 'PD', 'sergeant');
    const raised = await post(officer, '/api/v1/dispatch/self/panic', {});
    const before = await board(sgt);

    await post(sgt, `/api/v1/dispatch/panics/${raised.body.id}/acknowledge`, {});

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/board/poll',
      headers: sgt.headers, payload: { revision: before.body.revision },
    });
    expect((res.json() as { changed: boolean }).changed).toBe(true);
  });
});
