import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, setPermissionOverride,
  signIn, userIdByUsername, type TestHarness,
} from './harness.js';

/**
 * Field requests: asking for backup, and sharing where you are.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR
 *
 * The feature is small; the ways it could go wrong are not. A request is a
 * broadcast to colleagues and an invitation to attach yourself to somebody
 * else's call, so the questions are:
 *
 *   1. Can somebody in ANOTHER organization see it, take it, or learn it
 *      exists?
 *   2. Can it be taken twice, taken late, taken by the person who raised it, or
 *      taken after somebody already passed on it?
 *   3. Does the record survive — the acceptance, and equally the DECLINE, which
 *      is the fact a supervisor asks about afterwards?
 *   4. Does accepting reach the right call, and does it fail SAFELY when there
 *      is no call to reach?
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
  // Requests raised by one test are still live for the next — memberships are
  // never deleted, by design — so they are settled here rather than leaking.
  await h.db.execute(sql`
    UPDATE field_request SET status = 'cancelled', resolved_at = now()
     WHERE status = 'pending'
  `);
});

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

async function get(who: Person, url: string) {
  const res = await h.app.inject({ method: 'GET', url, headers: who.headers });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** On duty, so they are in the derived audience. */
async function goOnDuty(who: Person) {
  await h.db.execute(sql`
    INSERT INTO member_status (member_id, status_key) VALUES (${who.memberId}, 'available')
    ON CONFLICT (member_id) DO UPDATE SET status_key = 'available', updated_at = now()
  `);
}

async function raise(who: Person, kind = 'backup', note: string | null = null) {
  return post(who, '/api/v1/dispatch/field-requests', { kind, note });
}

// ── Raising ─────────────────────────────────────────────────────────────────

describe('raising a request', () => {
  it('creates one, and returns the SAME one for a repeat press', async () => {
    const officer = await member('fr1', 'PD', 'officer');
    await goOnDuty(officer);

    const first = await raise(officer);
    expect(first.status).toBe(201);
    expect(first.body.alreadyLive).toBe(false);

    /**
     * People hold keys down and networks retry.
     *
     * Four identical prompts on everybody's screen is worse than one, and the
     * second press carries no new information. 200 rather than 201, because
     * nothing was created — telling the client otherwise would have it render a
     * second card for one request.
     */
    const second = await raise(officer);
    expect(second.status).toBe(200);
    expect(second.body.alreadyLive).toBe(true);
    expect(second.body.id).toBe(first.body.id);
  });

  it('allows a backup request AND a location share at the same time', async () => {
    // Different kinds are different situations. The one-live rule is per kind.
    const officer = await member('fr2', 'PD', 'officer');
    await goOnDuty(officer);

    expect((await raise(officer, 'backup')).status).toBe(201);
    expect((await raise(officer, 'location_share')).status).toBe(201);
  });

  it('REFUSES a kind that does not exist', async () => {
    const officer = await member('fr3', 'PD', 'officer');
    const res = await raise(officer, 'summon_helicopter');
    expect(res.status).toBe(400);
  });

  it('REFUSES an operator without the permission', async () => {
    const officer = await member('fr4', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'dispatch.request_backup', 'deny');

    const res = await raise(officer, 'backup');
    expect(res.status).toBe(403);

    // And the two permissions are separate: denying one leaves the other.
    const share = await raise(officer, 'location_share');
    expect(share.status).toBe(201);
  });

  it('records who it was OFFERED to, in the audit row', async () => {
    const asker = await member('fr5a', 'PD', 'officer');
    const colleague = await member('fr5b', 'PD', 'officer');
    await goOnDuty(asker);
    await goOnDuty(colleague);

    const res = await raise(asker);
    expect(res.status).toBe(201);

    const audit = await h.db.execute<{ metadata: { offeredTo: number } }>(sql`
      SELECT metadata FROM audit_log
       WHERE action = 'dispatch.field_request_raised' AND entity_id = ${res.body.id as string}
    `);
    expect(audit.length).toBe(1);
    expect(audit[0]!.metadata.offeredTo).toBeGreaterThanOrEqual(1);
  });

  it('notifies on-duty colleagues and NOT the asker', async () => {
    const asker = await member('fr6a', 'PD', 'officer');
    const colleague = await member('fr6b', 'PD', 'officer');
    await goOnDuty(asker);
    await goOnDuty(colleague);

    await raise(asker);

    const rows = await h.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM notification WHERE type = 'field_request.backup'
    `);
    const recipients = rows.map((r) => r.user_id);
    expect(recipients).toContain(colleague.userId);
    // Being told about your own request is noise at the moment noise costs most.
    expect(recipients).not.toContain(asker.userId);
  });

  it('does NOT notify another organization', async () => {
    const pd = await member('fr7pd', 'PD', 'officer');
    const md = await member('fr7md', 'MD', 'paramedic');
    await goOnDuty(pd);
    await goOnDuty(md);

    await raise(pd);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notification
       WHERE type = 'field_request.backup' AND user_id = ${md.userId}
    `);
    expect(rows[0]!.n).toBe(0);
  });
});

// ── Seeing it ───────────────────────────────────────────────────────────────

describe('who can see a request', () => {
  it('shows it to the asker\'s organization', async () => {
    const asker = await member('fr8a', 'PD', 'officer');
    const colleague = await member('fr8b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const list = await get(colleague, '/api/v1/dispatch/field-requests');

    expect(list.status).toBe(200);
    const ids = (list.body.requests as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(raised.body.id);
  });

  it('HIDES it from another organization entirely', async () => {
    const pd = await member('fr9pd', 'PD', 'officer');
    const md = await member('fr9md', 'MD', 'paramedic');
    await goOnDuty(pd);

    const raised = await raise(pd);
    const list = await get(md, '/api/v1/dispatch/field-requests');

    const ids = (list.body.requests as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(raised.body.id);
  });

  it('tells the caller what THEY did about it, and whether it is theirs', async () => {
    const asker = await member('fr10a', 'PD', 'officer');
    const colleague = await member('fr10b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);

    const own = await get(asker, '/api/v1/dispatch/field-requests');
    const mine = (own.body.requests as { id: string; viewerIsAsker: boolean }[])
      .find((r) => r.id === raised.body.id);
    expect(mine?.viewerIsAsker).toBe(true);

    const theirs = await get(colleague, '/api/v1/dispatch/field-requests');
    const seen = (theirs.body.requests as {
      id: string; viewerIsAsker: boolean; viewerResponse: string | null;
    }[]).find((r) => r.id === raised.body.id);
    expect(seen?.viewerIsAsker).toBe(false);
    expect(seen?.viewerResponse).toBeNull();
  });
});

// ── Responding ──────────────────────────────────────────────────────────────

describe('responding', () => {
  it('accepts, and records who', async () => {
    const asker = await member('fr11a', 'PD', 'officer');
    const helper = await member('fr11b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const res = await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    const row = await h.db.execute<{ status: string; resolved_by: string }>(sql`
      SELECT status, resolved_by FROM field_request WHERE id = ${raised.body.id as string}
    `);
    expect(row[0]!.status).toBe('accepted');
    expect(row[0]!.resolved_by).toBe(helper.memberId);
  });

  it('tells the ASKER that help is coming', async () => {
    const asker = await member('fr12a', 'PD', 'officer');
    const helper = await member('fr12b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );

    // Scoped to THIS request. Notifications accumulate across the file — the
    // first version of this test counted every accepted-request notification
    // the suite had ever produced.
    const rows = await h.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM notification
       WHERE type = 'field_request.accepted' AND entity_id = ${raised.body.id as string}
    `);
    // An audience of exactly one, and still derived: it is the member_id on the
    // row, not a user id anybody supplied.
    expect(rows.map((r) => r.user_id)).toEqual([asker.userId]);
  });

  it('RECORDS A DECLINE rather than treating it as silence', async () => {
    /**
     * The distinction this whole table exists for.
     *
     * "Eight people dismissed this" is a different fact from "nobody saw it",
     * and it is the first question asked when somebody reviews why help did not
     * arrive.
     */
    const asker = await member('fr13a', 'PD', 'officer');
    const passer = await member('fr13b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const res = await post(
      passer, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'decline' },
    );
    expect(res.status).toBe(200);

    const responses = await h.db.execute<{ response: string }>(sql`
      SELECT response FROM field_request_response
       WHERE field_request_id = ${raised.body.id as string} AND member_id = ${passer.memberId}
    `);
    expect(responses[0]!.response).toBe('declined');

    const audit = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'dispatch.field_request_declined'
         AND entity_id = ${raised.body.id as string}
    `);
    expect(audit[0]!.n).toBe(1);
  });

  it('a DECLINE leaves the request live for everybody else', async () => {
    const asker = await member('fr14a', 'PD', 'officer');
    const passer = await member('fr14b', 'PD', 'officer');
    const helper = await member('fr14c', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    await post(
      passer, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'decline' },
    );

    // One person saying "not me" must not cancel a colleague's call for help.
    const accepted = await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(accepted.status).toBe(200);
  });

  it('REFUSES a second response from the same person', async () => {
    const asker = await member('fr15a', 'PD', 'officer');
    const helper = await member('fr15b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const url = `/api/v1/dispatch/field-requests/${raised.body.id}/respond`;
    expect((await post(helper, url, { action: 'decline' })).status).toBe(200);
    expect((await post(helper, url, { action: 'accept' })).status).toBe(409);
  });

  it('REFUSES a second ACCEPT from somebody else', async () => {
    const asker = await member('fr16a', 'PD', 'officer');
    const first = await member('fr16b', 'PD', 'officer');
    const second = await member('fr16c', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const url = `/api/v1/dispatch/field-requests/${raised.body.id}/respond`;
    expect((await post(first, url, { action: 'accept' })).status).toBe(200);

    // Already answered. Two people "taking" one request would have the asker
    // expecting two units and the board recording one.
    expect((await post(second, url, { action: 'accept' })).status).toBe(409);
  });

  it('REFUSES the asker responding to their own request', async () => {
    const asker = await member('fr17', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const res = await post(
      asker, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(res.status).toBe(409);
  });

  it('REFUSES somebody from ANOTHER ORGANIZATION, as NOT FOUND', async () => {
    /**
     * Not forbidden — NOT FOUND.
     *
     * A 403 would confirm the request exists, which is itself information about
     * another agency's operations. The rest of the product answers this way and
     * so does this.
     */
    const pd = await member('fr18pd', 'PD', 'officer');
    const md = await member('fr18md', 'MD', 'paramedic');
    await goOnDuty(pd);

    const raised = await raise(pd);
    const res = await post(
      md, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(res.status).toBe(404);

    // And nothing was recorded against it.
    const responses = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM field_request_response
       WHERE field_request_id = ${raised.body.id as string}
    `);
    expect(responses[0]!.n).toBe(0);
  });

  it('REFUSES an EXPIRED request', async () => {
    const asker = await member('fr19a', 'PD', 'officer');
    const helper = await member('fr19b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);

    // A client can hold a prompt in a pocket for ten minutes. The deadline is
    // enforced where the decision is made, not where the button is drawn.
    await h.db.execute(sql`
      UPDATE field_request SET expires_at = now() - interval '1 second'
       WHERE id = ${raised.body.id as string}
    `);

    const res = await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(res.status).toBe(409);
    expect(String(res.body.error ?? '')).toContain('');
  });

  it('an expired request disappears from the list', async () => {
    const asker = await member('fr20a', 'PD', 'officer');
    const colleague = await member('fr20b', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    await h.db.execute(sql`
      UPDATE field_request SET expires_at = now() - interval '1 second'
       WHERE id = ${raised.body.id as string}
    `);

    const list = await get(colleague, '/api/v1/dispatch/field-requests');
    const ids = (list.body.requests as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(raised.body.id);
  });
});

// ── Cancelling ──────────────────────────────────────────────────────────────

describe('cancelling', () => {
  it('lets the asker withdraw their own', async () => {
    const asker = await member('fr21', 'PD', 'officer');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const res = await post(asker, `/api/v1/dispatch/field-requests/${raised.body.id}/cancel`);
    expect(res.status).toBe(200);

    const row = await h.db.execute<{ status: string }>(sql`
      SELECT status FROM field_request WHERE id = ${raised.body.id as string}
    `);
    expect(row[0]!.status).toBe('cancelled');
  });

  it('REFUSES anybody else, including a chief', async () => {
    /**
     * Cancelling somebody else's call for help is not a thing this product
     * lets anybody do — not a supervisor, not a dispatcher, not the chief.
     */
    const asker = await member('fr22a', 'PD', 'officer');
    const chief = await member('fr22b', 'PD', 'chief');
    await goOnDuty(asker);

    const raised = await raise(asker);
    const res = await post(chief, `/api/v1/dispatch/field-requests/${raised.body.id}/cancel`);
    expect(res.status).toBe(403);
  });
});

// ── The attachment ──────────────────────────────────────────────────────────

describe('what accepting attaches you to', () => {
  it('assigns the accepting unit to the asker\'s call', async () => {
    const asker = await member('fr23a', 'PD', 'sergeant');
    const helper = await member('fr23b', 'PD', 'sergeant');
    await goOnDuty(asker);

    // The asker is crewed and on a call.
    const askerUnit = await post(asker, '/api/v1/dispatch/units', {
      callsign: `FRA${Date.now() % 10000}`, joinSelf: true,
    });
    const incident = await post(asker, '/api/v1/dispatch/incidents', {
      title: 'Backup attachment test', priority: 2,
    });
    await post(
      asker,
      `/api/v1/dispatch/incidents/${incident.body.id}/units`,
      { unitId: askerUnit.body.id },
    );

    const helperUnit = await post(helper, '/api/v1/dispatch/units', {
      callsign: `FRB${Date.now() % 10000}`, joinSelf: true,
    });

    const raised = await raise(asker);
    await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );

    const assigned = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident_assignment
       WHERE incident_id = ${incident.body.id as string}
         AND unit_id = ${helperUnit.body.id as string}
         AND released_at IS NULL
    `);
    expect(assigned[0]!.n).toBe(1);
  });

  it('attaches to NOTHING when the asker has no call, and does not invent one', async () => {
    /**
     * The refusal that keeps the call queue honest.
     *
     * Auto-creating an incident to have something to attach to would put an
     * untitled call on the board that nobody requested and nobody will close.
     * The acceptance still stands — they said they are coming.
     */
    const asker = await member('fr24a', 'PD', 'officer');
    const helper = await member('fr24b', 'PD', 'officer');
    await goOnDuty(asker);

    const before = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident WHERE deleted_at IS NULL
    `);

    const raised = await raise(asker);
    const res = await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(res.status).toBe(200);
    expect(res.body.attachedToIncidentId).toBeNull();

    const after = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident WHERE deleted_at IS NULL
    `);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('a LOCATION SHARE attaches nobody to anything, and places a marker', async () => {
    const asker = await member('fr25a', 'PD', 'sergeant');
    const helper = await member('fr25b', 'PD', 'sergeant');
    await goOnDuty(asker);

    // Give the asker a unit with a position UNIQUE TO THIS RUN, so the marker
    // assertion below cannot pick up one an earlier run left behind — markers
    // are soft-deleted operational records and outlive `resetAccounts`.
    const x = 100 + (Date.now() % 1000) / 100;
    const unit = await post(asker, '/api/v1/dispatch/units', {
      callsign: `FRS${Date.now() % 10000}`, joinSelf: true,
    });
    await h.db.execute(sql`
      UPDATE unit SET pos_x = ${x}, pos_y = -430.25 WHERE id = ${unit.body.id as string}
    `);

    const raised = await raise(asker, 'location_share');
    const res = await post(
      helper, `/api/v1/dispatch/field-requests/${raised.body.id}/respond`, { action: 'accept' },
    );
    expect(res.status).toBe(200);
    expect(res.body.attachedToIncidentId).toBeNull();

    const markers = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM map_marker
       WHERE description = 'Shared location' AND deleted_at IS NULL
         AND pos_x = ${x} AND pos_y = -430.25
    `);
    expect(markers[0]!.n).toBe(1);
  });
});

// ── The record ──────────────────────────────────────────────────────────────

describe('the record survives', () => {
  it('puts a backup request on the call\'s TIMELINE', async () => {
    const asker = await member('fr26', 'PD', 'sergeant');
    await goOnDuty(asker);

    const unit = await post(asker, '/api/v1/dispatch/units', {
      callsign: `FRT${Date.now() % 10000}`, joinSelf: true,
    });
    const incident = await post(asker, '/api/v1/dispatch/incidents', {
      title: 'Timeline test', priority: 3,
    });
    await post(
      asker, `/api/v1/dispatch/incidents/${incident.body.id}/units`, { unitId: unit.body.id },
    );

    await raise(asker);

    const entries = await h.db.execute<{ body: string }>(sql`
      SELECT body FROM incident_log
       WHERE incident_id = ${incident.body.id as string} AND body LIKE '%requested backup%'
    `);
    expect(entries.length).toBe(1);
  });

  it('does NOT put a location share on a timeline', async () => {
    // A share is not about the call. Putting it in the call's record would be
    // noise in the one place that has to stay readable.
    const asker = await member('fr27', 'PD', 'sergeant');
    await goOnDuty(asker);

    const unit = await post(asker, '/api/v1/dispatch/units', {
      callsign: `FRU${Date.now() % 10000}`, joinSelf: true,
    });
    const incident = await post(asker, '/api/v1/dispatch/incidents', {
      title: 'Share timeline test', priority: 3,
    });
    await post(
      asker, `/api/v1/dispatch/incidents/${incident.body.id}/units`, { unitId: unit.body.id },
    );

    await raise(asker, 'location_share');

    const entries = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident_log
       WHERE incident_id = ${incident.body.id as string} AND body LIKE '%location%'
    `);
    expect(entries[0]!.n).toBe(0);
  });

  it('moves the dispatch revision, so a polling board notices', async () => {
    const asker = await member('fr28a', 'PD', 'officer');
    const watcher = await member('fr28b', 'PD', 'officer');
    await goOnDuty(asker);

    const before = await get(watcher, '/api/v1/dispatch/board');
    await raise(asker);
    const after = await get(watcher, '/api/v1/dispatch/board');

    expect(after.body.revision).not.toBe(before.body.revision);
  });
});

// ── The note ────────────────────────────────────────────────────────────────

describe('the note', () => {
  it('is carried to colleagues, and bounded', async () => {
    const asker = await member('fr29a', 'PD', 'officer');
    const colleague = await member('fr29b', 'PD', 'officer');
    await goOnDuty(asker);
    await goOnDuty(colleague);

    const res = await raise(asker, 'backup', 'Two suspects, one armed');
    expect(res.status).toBe(201);

    const rows = await h.db.execute<{ body: string | null }>(sql`
      SELECT body FROM notification
       WHERE type = 'field_request.backup' AND user_id = ${colleague.userId}
    `);
    expect(rows[0]!.body).toBe('Two suspects, one armed');

    // Bounded, because it is the one free-text field here and an unbounded
    // string from a client is an allocation somebody else chooses the size of.
    const long = await raise(asker, 'location_share', 'x'.repeat(500));
    expect(long.status).toBe(400);
  });

  it('REFUSES a recipient list smuggled into the body', async () => {
    /**
     * The audience is derived. There is nowhere to put a recipient list, and
     * `.strict()` is what makes "nowhere" true rather than "ignored" — a client
     * that tries finds out immediately rather than believing it worked.
     */
    const asker = await member('fr30', 'PD', 'officer');
    const res = await post(asker, '/api/v1/dispatch/field-requests', {
      kind: 'backup',
      recipients: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(res.status).toBe(400);
  });

  it('REFUSES an organization smuggled into the body', async () => {
    const asker = await member('fr31', 'PD', 'officer');
    const res = await post(asker, '/api/v1/dispatch/field-requests', {
      kind: 'backup',
      organizationId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(400);
  });
});
