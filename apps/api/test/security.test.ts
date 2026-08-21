import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AUDIT_ACTIONS } from '@leoos/db';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin, makeOrgLead,
  organizationIdByKey, resetAccounts, signIn, userIdByUsername, type TestHarness,
} from './harness.js';

/**
 * Security regressions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE DESCRIBE PER VULNERABILITY FOUND BY THE SECURITY AUDIT
 *
 * Every test in this file FAILED before its fix. They are written against the
 * HTTP surface rather than against the functions, because each of these got
 * past a unit test that was checking the wrong layer: the kernel was right and
 * a caller did not consult it, or a rule existed in the application and not in
 * the database.
 *
 * Where a test asserts a refusal it also asserts the ALLOWED case beside it.
 * A security fix that quietly broke the legitimate flow would otherwise pass
 * here and be discovered in operation.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await resetAccounts(h.db);
});

beforeEach(() => {
  // See admin.test.ts: this file registers dozens of accounts from one address.
  h.app.limiter.resetAll();
});

afterAll(async () => {
  await h.close();
});

async function freshUser(prefix: string) {
  h.app.limiter.resetAll();
  return createActiveUser(h, prefix);
}

async function operator(prefix: string, orgKey = 'PD', roleKey = 'lieutenant') {
  const creds = await freshUser(prefix);
  const membership = await grantMembership(h.db, creds.username, { orgKey, roleKey });
  const session = await signIn(h, creds);
  return { creds, ...membership, ...session };
}

/**
 * Sets a membership status directly.
 *
 * Deliberately NOT through the termination endpoint: the point is to reproduce
 * the state, not the route that reaches it, and a lead grant survives every
 * route that produces this state.
 */
async function setMemberStatus(memberId: string, status: string) {
  await h.db.execute(sql`
    UPDATE organization_member
       SET status = ${status}::membership_status,
           left_at = CASE WHEN ${status} = 'terminated' THEN now() ELSE NULL END,
           termination_reason = CASE WHEN ${status} = 'terminated' THEN 'regression test' ELSE NULL END
     WHERE id = ${memberId}
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
// F1 · A lead grant does not survive the membership it leads
// ═══════════════════════════════════════════════════════════════════════════

describe('F1 — a terminated Organization Lead reaches nothing', () => {
  /**
   * `organization_lead` and `organization_member.status` are separate rows
   * changed by separate operations, so firing somebody does not revoke their
   * lead grant. `toActorContext` conferred `isOrgLead: true` and
   * `level: UNBOUNDED_LEVEL` from the grant alone, and the three organization
   * VIEW decisions read `isOrgLead` without checking whether the membership was
   * still active — so a fired chief kept reading the roster of the organization
   * that had just fired them.
   */
  async function firedLead(prefix: string, status: 'terminated' | 'suspended') {
    const granter = await operator(`${prefix}granter`, 'PD', 'chief');
    await makeGlobalAdmin(h.db, granter.creds.username);

    const lead = await operator(`${prefix}lead`, 'PD', 'chief');
    await makeOrgLead(h.db, lead.creds.username, 'PD', granter.creds.username);
    await setMemberStatus(lead.memberId, status);

    const organizationId = await organizationIdByKey(h.db, 'PD');
    return { lead, organizationId, headers: { ...lead.headers, 'x-leoos-organization': organizationId } };
  }

  const SECTIONS = ['', '/members', '/units', '/vehicles', '/personnel', '/roles', '/leads'];

  it('cannot read the organization it used to lead, in any section', async () => {
    const { organizationId, headers } = await firedLead('f1term', 'terminated');

    for (const section of SECTIONS) {
      const res = await h.app.inject({
        method: 'GET', url: `/api/v1/organizations/${organizationId}${section}`, headers,
      });
      // 404, not 403: out of scope must not confirm the organization exists.
      expect(res.statusCode, `GET …${section || '(detail)'}`).toBe(404);
    }
  });

  it('is equally refused while merely suspended', async () => {
    const { organizationId, headers } = await firedLead('f1susp', 'suspended');

    for (const section of SECTIONS) {
      const res = await h.app.inject({
        method: 'GET', url: `/api/v1/organizations/${organizationId}${section}`, headers,
      });
      expect(res.statusCode, `GET …${section || '(detail)'}`).toBe(404);
    }
  });

  it('cannot hire, promote or edit either — the write side was already closed', async () => {
    const { organizationId, headers } = await firedLead('f1write', 'terminated');
    const victim = await operator('f1victim', 'PD', 'officer');

    const rank = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/personnel/${victim.memberId}/rank`,
      headers,
      payload: { roleId: victim.roleId, reason: 'by a fired lead' },
    });
    expect([403, 404]).toContain(rank.statusCode);

    const edit = await h.app.inject({
      method: 'PATCH', url: `/api/v1/organizations/${organizationId}`,
      headers, payload: { name: 'Renamed by a fired lead' },
    });
    expect([403, 404]).toContain(edit.statusCode);
  });

  it('still lets an ACTIVE lead through, so the fix did not close the door', async () => {
    const granter = await operator('f1okgranter', 'PD', 'chief');
    await makeGlobalAdmin(h.db, granter.creds.username);

    const lead = await operator('f1oklead', 'PD', 'officer');
    await makeOrgLead(h.db, lead.creds.username, 'PD', granter.creds.username);
    const organizationId = await organizationIdByKey(h.db, 'PD');

    for (const section of SECTIONS) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}${section}`,
        headers: { ...lead.headers, 'x-leoos-organization': organizationId },
      });
      expect(res.statusCode, `GET …${section || '(detail)'}`).toBe(200);
    }
  });
});

describe('F1b — a suspended membership reaches no operational surface either', () => {
  /**
   * The same root cause seen from the other side. An inactive membership now
   * resolves to `membershipActive: false`, `isOrgLead: false`, `level: 0` and an
   * empty permission set — so the ACTIVE ORGANIZATION header still names the
   * organization (they are, after all, still a suspended member of it) and it
   * confers nothing at all.
   */
  it('is refused the map, dispatch, the roster and search results', async () => {
    const user = await operator('f1bsusp', 'PD', 'lieutenant');
    await setMemberStatus(user.memberId, 'suspended');
    const organizationId = await organizationIdByKey(h.db, 'PD');
    const headers = { ...user.headers, 'x-leoos-organization': organizationId };

    for (const url of [
      '/api/v1/map/units',
      '/api/v1/dispatch/board',
      '/api/v1/dispatch/self',
      `/api/v1/organizations/${organizationId}/personnel`,
    ]) {
      const res = await h.app.inject({ method: 'GET', url, headers });
      expect([403, 404], url).toContain(res.statusCode);
    }

    // Search must not become a second, weaker door: a suspended member searches
    // nothing rather than searching everything.
    const search = await h.app.inject({
      method: 'GET', url: '/api/v1/search?q=aa', headers,
    });
    if (search.statusCode === 200) {
      const body = search.body;
      expect(body).not.toMatch(/"personnel":\s*\[\s*\{/);
      expect(body).not.toMatch(/"incidents":\s*\[\s*\{/);
    }
  });

  it('cannot raise a panic — a suspended member is not on duty', async () => {
    const user = await operator('f1bpanic', 'PD', 'officer');
    await setMemberStatus(user.memberId, 'suspended');

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic',
      headers: user.headers, payload: {},
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F2 · A WebSocket does not outlive its session
// ═══════════════════════════════════════════════════════════════════════════

describe('F2 — a revoked session cannot keep a socket open', () => {
  /**
   * The socket authenticates ONCE, with a single-use ticket, and then holds only
   * a session id. Nothing on that path re-checked the session, so logging out,
   * revoking a session, disabling an account or changing a password left the
   * connection streaming live officer positions and panic alerts until the
   * process restarted — while every HTTP request from the same person was
   * correctly refused.
   */
  function fakeSocket() {
    const sent: string[] = [];
    const closed: { code?: number }[] = [];
    return {
      sent,
      closed,
      send: (data: string) => { sent.push(data); },
      close: (code?: number) => { closed.push({ code }); },
    };
  }

  /**
   * Session liveness is cached for one second on the socket path.
   *
   * That cache is deliberate — without it a burst of events would run the
   * liveness query once per event per subscriber — and one second is the
   * WORST-CASE latency between a revocation and the socket closing. The waits
   * below are that window, made explicit: they are asserting the bound, not
   * working around a flake.
   */
  const SESSION_CACHE_MS = 1_000;
  const outliveCache = () => new Promise((r) => setTimeout(r, SESSION_CACHE_MS + 150));

  async function connected(prefix: string) {
    const person = await operator(prefix, 'PD', 'lieutenant');
    const userId = await userIdByUsername(h.db, person.creds.username);
    const [live] = await h.db.execute<{ id: string }>(sql`
      SELECT id FROM "session" WHERE user_id = ${userId} AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1
    `);
    const socket = fakeSocket();
    const connection = h.app.realtime.add({
      userId,
      sessionId: live!.id,
      organizationId: person.organizationId,
      socket,
    });
    return { person, userId, sessionId: live!.id, socket, connection };
  }

  it('subscribes happily while the session is live', async () => {
    const { person, connection } = await connected('f2live');
    const result = await h.app.realtime.subscribe(connection.id, [
      `org:${person.organizationId}:panic`,
    ]);
    expect(result.ok.map((t) => t.topic)).toEqual([`org:${person.organizationId}:panic`]);
  });

  it('refuses to subscribe once the session is revoked, and closes the socket', async () => {
    const { person, sessionId, socket, connection } = await connected('f2revoked');

    await h.db.execute(sql`
      UPDATE "session" SET revoked_at = now(), revoked_reason = 'logout' WHERE id = ${sessionId}
    `);
    await outliveCache();

    const result = await h.app.realtime.subscribe(connection.id, [
      `org:${person.organizationId}:panic`,
    ]);
    expect(result.ok).toEqual([]);
    expect(socket.closed.length, 'the socket should have been closed').toBeGreaterThan(0);
    expect(socket.closed[0]?.code).toBe(4001);
  });

  it('stops delivering to an already-subscribed connection when the session dies', async () => {
    const { person, sessionId, socket, connection } = await connected('f2deliver');
    await h.app.realtime.subscribe(connection.id, [`org:${person.organizationId}:panic`]);

    // Proof the subscription works before the revocation.
    await h.app.realtime.publish(
      { type: 'panic.triggered', payload: {} } as never,
      [`org:${person.organizationId}:panic`],
    );
    const before = socket.sent.length;
    expect(before).toBeGreaterThan(0);

    await h.db.execute(sql`
      UPDATE "session" SET revoked_at = now(), revoked_reason = 'admin' WHERE id = ${sessionId}
    `);
    await outliveCache();

    await h.app.realtime.publish(
      { type: 'panic.triggered', payload: {} } as never,
      [`org:${person.organizationId}:panic`],
    );
    expect(socket.closed.length, 'the socket should have been closed').toBeGreaterThan(0);
  });

  it('closes the socket when the ACCOUNT is disabled, not only when a session is revoked', async () => {
    const { person, userId, socket, connection } = await connected('f2disabled');
    await h.app.realtime.subscribe(connection.id, [`org:${person.organizationId}:panic`]);

    await h.db.execute(sql`
      UPDATE user_account SET status = 'disabled' WHERE id = ${userId}
    `);
    await outliveCache();

    const result = await h.app.realtime.subscribe(connection.id, [
      `org:${person.organizationId}:units`,
    ]);
    expect(result.ok).toEqual([]);
    expect(socket.closed.length).toBeGreaterThan(0);
  });

  it('closes the socket when the password changes, which supersedes older sessions', async () => {
    const { person, userId, socket, connection } = await connected('f2password');
    await h.app.realtime.subscribe(connection.id, [`org:${person.organizationId}:panic`]);

    // The same rule `resolveSession` applies on the HTTP path: a session issued
    // before the password changed is not a session.
    await h.db.execute(sql`
      UPDATE user_account SET password_changed_at = now() + interval '1 second' WHERE id = ${userId}
    `);
    await outliveCache();

    const result = await h.app.realtime.subscribe(connection.id, [
      `org:${person.organizationId}:units`,
    ]);
    expect(result.ok).toEqual([]);
    expect(socket.closed.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F3 · A multi-agency call is visible to all, writable by the involved
// ═══════════════════════════════════════════════════════════════════════════

describe('F3 — an uninvolved organization cannot rewrite a joint call', () => {
  /**
   * A multi-agency incident has `organization_id IS NULL`, so the ownership
   * check that guards every other incident had nothing to compare against and
   * was skipped entirely — for reads AND writes. Any dispatcher in any
   * organization could note on, re-prioritise or CLOSE a joint operation their
   * service had nothing to do with.
   */
  async function jointCall(prefix: string) {
    const coordinator = await operator(`${prefix}coord`, 'PD', 'chief');
    await makeGlobalAdmin(h.db, coordinator.creds.username);
    const session = await signIn(h, coordinator.creds);

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents',
      headers: session.headers,
      payload: { title: 'Joint operation', priority: 2, organizationId: null },
    });
    expect(created.statusCode, created.body).toBe(201);
    return { coordinator: session, call: created.json() as { id: string; number: string } };
  }

  it('is READABLE by another organization — a joint call belongs on every board', async () => {
    const { call } = await jointCall('f3read');
    const outsider = await operator('f3reader', 'MD', 'doctor');

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/dispatch/incidents/${call.id}`, headers: outsider.headers,
    });
    expect(res.statusCode).toBe(200);
  });

  it('is NOT writable by an organization with no unit on it', async () => {
    const { call } = await jointCall('f3write');
    const outsider = await operator('f3writer', 'MD', 'doctor');

    for (const [what, method, url, payload] of [
      ['note', 'POST', `/api/v1/dispatch/incidents/${call.id}/notes`, { body: 'not our call' }],
      ['priority', 'POST', `/api/v1/dispatch/incidents/${call.id}/priority`, { priority: 5 }],
      ['status', 'POST', `/api/v1/dispatch/incidents/${call.id}/status`, { status: 'on_hold' }],
      ['edit', 'PATCH', `/api/v1/dispatch/incidents/${call.id}`, { title: 'Renamed' }],
      ['close', 'POST', `/api/v1/dispatch/incidents/${call.id}/close`, { cancelled: false }],
    ] as const) {
      const res = await h.app.inject({
        method, url, headers: outsider.headers, payload: payload as never,
      });
      expect(res.statusCode, `${what} should be refused`).toBe(404);
    }
  });

  it('becomes writable once that organization actually has a unit on it', async () => {
    const { call } = await jointCall('f3join');
    const responder = await operator('f3joiner', 'MD', 'doctor');

    const unit = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/units',
      headers: responder.headers,
      payload: { callsign: `J-${Date.now().toString(36)}`, unitType: 'ems', joinSelf: false },
    });
    expect(unit.statusCode, unit.body).toBe(201);
    const { id: unitId } = unit.json() as { id: string };

    // Assigning is deliberately still open: it is how an organization JOINS a
    // joint call, and a rule that required prior involvement would make a
    // multi-agency incident permanently unresponable.
    const assigned = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/units`,
      headers: responder.headers, payload: { unitId },
    });
    expect(assigned.statusCode, assigned.body).toBe(201);

    const note = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/notes`,
      headers: responder.headers, payload: { body: 'MD on scene' },
    });
    expect(note.statusCode, note.body).toBe(201);
  });

  it('leaves single-agency scoping exactly as it was', async () => {
    const owner = await operator('f3owner', 'PD', 'lieutenant');
    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents',
      headers: owner.headers, payload: { title: 'PD call', priority: 3 },
    });
    const call = created.json() as { id: string };

    const outsider = await operator('f3outsider', 'MD', 'doctor');
    const read = await h.app.inject({
      method: 'GET', url: `/api/v1/dispatch/incidents/${call.id}`, headers: outsider.headers,
    });
    expect(read.statusCode).toBe(404);

    const own = await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${call.id}/notes`,
      headers: owner.headers, payload: { body: 'our call' },
    });
    expect(own.statusCode).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F4 · An unauthenticated request cannot poison the replay-protection store
// ═══════════════════════════════════════════════════════════════════════════

describe('F4 — the nonce is consumed only after the signature verifies', () => {
  /**
   * The nonce check used to sit at position 5 of 7, ahead of the HMAC, on a
   * "cheapest check first" principle. That principle is right for checks and
   * wrong for a check that WRITES: `remember` inserts.
   *
   * The key id is a header, not a secret. So anyone who had ever seen one could,
   * with no valid signature at all, insert unlimited entries into the
   * in-process nonce store — and, more pointedly, PRE-BURN the nonce of a
   * request they could observe, so that the genuine request was then refused as
   * a replay. A denial of service against a game server's telemetry, mounted
   * from outside, past a rate limiter that is applied per credential after
   * authentication and therefore never saw it.
   *
   * These tests exercise the store directly: the ordering property is a
   * property of `verifyFiveMRequest`, and `apps/api/test/fivem.test.ts` already
   * proves end-to-end that a bad signature is refused. What is asserted here is
   * that the refusal leaves NO TRACE.
   */
  /**
   * The ORDERING half of this fix lives in `apps/api/test/fivem.test.ts`, under
   * "a forged signature records nothing". It needs a real credential and a real
   * secret box, which that suite's harness already provides — and the test only
   * means something with a key id the server RECOGNISES, because that is the
   * attacker's position: the key id travels in clear on every request.
   */

  it('the store is bounded, so it cannot be grown without limit', async () => {
    const { NonceStore } = await import('../src/modules/fivem/nonce-store.js');

    // A long TTL so nothing expires on its own — the bound is what has to hold.
    const nonces = new NonceStore(60 * 60 * 1000);
    // Comfortably past the ceiling, and past it AGAIN after the first eviction,
    // so the batch-reclaim path is exercised more than once.
    for (let i = 0; i < 130_000; i += 1) nonces.remember('k', `n${i}`);

    expect(nonces.size).toBeLessThanOrEqual(100_000);
    // Still functioning: eviction must not turn into refusal.
    expect(nonces.remember('k', 'fresh')).toBe(true);
    expect(nonces.remember('k', 'fresh'), 'a genuine replay is still caught').toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F5 · The audit log cannot be erased
// ═══════════════════════════════════════════════════════════════════════════

describe('F5 — the append-only tables refuse TRUNCATE as well as UPDATE and DELETE', () => {
  /**
   * The append-only trigger has existed since migration 0001, on UPDATE and
   * DELETE. TRUNCATE fires NEITHER: it is its own statement type with its own
   * trigger event, so `TRUNCATE audit_log` removed the entire legal record in
   * one statement while the append-only guarantee did nothing.
   *
   * The REVOKE beside it was the only obstacle, and it is wrapped in a role
   * check that silently does nothing unless the application connects as a role
   * named `leoos_app` — a deployment detail rather than a guarantee.
   */
  const APPEND_ONLY = ['audit_log', 'incident_log', 'member_status_history'];

  /**
   * The database's own words for why a statement was refused.
   *
   * Drizzle wraps the driver error, so the trigger's message is in the cause
   * rather than in `err.message`. Asserting on the wrapper would pass for ANY
   * failure — including a typo in the statement — which is exactly the kind of
   * test that looks green while proving nothing.
   */
  async function refusalFor(statement: string): Promise<string> {
    try {
      await h.db.execute(sql.raw(statement));
      return 'THE STATEMENT SUCCEEDED';
    } catch (error) {
      const chain: string[] = [];
      let current: unknown = error;
      for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
        chain.push(current.message);
        current = (current as { cause?: unknown }).cause;
      }
      return chain.join(' | ');
    }
  }

  for (const table of APPEND_ONLY) {
    it(`refuses TRUNCATE on ${table}`, async () => {
      await expect(refusalFor(`TRUNCATE TABLE "${table}"`)).resolves.toMatch(/append-only/i);
    });

    it(`refuses DELETE and UPDATE on ${table}`, async () => {
      await expect(refusalFor(`DELETE FROM "${table}" WHERE false`)).resolves.toMatch(/append-only/i);
      await expect(
        refusalFor(`UPDATE "${table}" SET id = id WHERE false`),
      ).resolves.toMatch(/append-only/i);
    });
  }

  it('leaves the log readable and still growing', async () => {
    const [before] = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log`,
    );
    // Any audited action will do; a failed login is the cheapest.
    await h.app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { identifier: 'nobody-at-all', password: 'wrong-password-here' },
    });
    const [after] = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log`,
    );
    expect(after!.n).toBeGreaterThan(before!.n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F6 · An attack does not go dark once the lockout engages
// ═══════════════════════════════════════════════════════════════════════════

describe('F6 — attempts against a locked account are audited', () => {
  /**
   * Every other refusal on the login path wrote an audit row. The lockout
   * branch returned silently, so the log went quiet at exactly the moment it
   * became interesting: the hours of continued attempts AFTER the lock engages
   * are what distinguish a forgetful user from somebody working a password
   * list, and none of them were recorded.
   */
  it('records every attempt, including the ones the lockout refuses', async () => {
    const victim = await freshUser('f6locked');
    const userId = await userIdByUsername(h.db, victim.username);

    const attemptsAudited = async () => {
      const [row] = await h.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_log
         WHERE action = ${AUDIT_ACTIONS.LOGIN_FAILED} AND actor_user_id = ${userId}
      `);
      return row!.n;
    };

    // Lock the account outright rather than spending the limiter on wrong
    // guesses: the branch under test is the one that runs while locked.
    await h.db.execute(sql`
      UPDATE user_account
         SET failed_login_count = 99, locked_until = now() + interval '1 hour'
       WHERE id = ${userId}
    `);

    const before = await attemptsAudited();

    for (let i = 0; i < 3; i += 1) {
      h.app.limiter.resetAll();
      const res = await h.app.inject({
        method: 'POST', url: '/api/v1/auth/login',
        payload: { identifier: victim.username, password: victim.password },
      });
      // Even the CORRECT password is refused while locked, and that refusal is
      // the single most interesting row this log can hold.
      expect(res.statusCode).toBe(401);
    }

    expect(await attemptsAudited() - before).toBe(3);

    const [latest] = await h.db.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM audit_log
       WHERE action = ${AUDIT_ACTIONS.LOGIN_FAILED} AND actor_user_id = ${userId}
       ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(latest!.metadata).toMatchObject({ reason: 'account_locked' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F7 · A placeholder internal token cannot reach production
// ═══════════════════════════════════════════════════════════════════════════

describe('F7 — the internal service token is refused if it is guessable', () => {
  /**
   * `plugins/auth.ts` exempts any request carrying this token from the origin
   * check and from the CSRF double-submit — correctly, because the web tier is
   * not a browser. The consequence is that whoever knows the string can make
   * state-changing requests from anywhere.
   *
   * The schema's `min(16)` accepted the value printed in `.env.example`
   * (`change-me-at-least-16-chars`, 27 characters), so an installation that
   * copied the example and never read it shipped with a PUBLICLY DOCUMENTED
   * CSRF bypass. This is the one variable where "we forgot" is
   * indistinguishable from "there is no CSRF protection".
   */
  const base = {
    DATABASE_URL: 'postgres://u@localhost:5432/db',
    ALLOWED_ORIGINS: 'https://leoos.example',
  };

  async function load(env: Record<string, string>) {
    const { loadConfig } = await import('../src/config.js');
    return () => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);
  }

  it('refuses the documented placeholder in production', async () => {
    const run = await load({
      NODE_ENV: 'production',
      // Long enough to clear the length rule, so it is the PLACEHOLDER rule
      // being tested rather than the one before it.
      INTERNAL_API_TOKEN: 'change-me-at-least-16-chars-and-then-some-more',
    });
    expect(run).toThrow(/placeholder/i);
  });

  it('refuses a short token in production', async () => {
    const run = await load({
      NODE_ENV: 'production',
      INTERNAL_API_TOKEN: 'abcdefghijklmnopqrst',
    });
    expect(run).toThrow(/32 characters/i);
  });

  it('accepts a real one', async () => {
    const run = await load({
      NODE_ENV: 'production',
      INTERNAL_API_TOKEN: 'Zx8kQ2mR7pL4vN1sT6yB9cW3eH5jF0gA',
    });
    expect(run).not.toThrow();
  });

  it('does not obstruct development, where the placeholder is harmless', async () => {
    const run = await load({
      NODE_ENV: 'development',
      INTERNAL_API_TOKEN: 'change-me-at-least-16-chars',
    });
    expect(run).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The ten hierarchy attacks, as asked for, end to end
// ═══════════════════════════════════════════════════════════════════════════

describe('hierarchy and privilege-escalation attacks are all refused', () => {
  /**
   * Each of these is stated in the security brief. Several are already covered
   * by `roles.test.ts`, `personnel.test.ts` and `admin.test.ts` at the level
   * they belong to; they are repeated here as ONE READABLE LIST so that "was
   * this attack tested?" has a single place to be answered, and so a refactor
   * that moves a check cannot quietly drop one.
   */
  async function roleIdFor(orgKey: string, roleKey: string): Promise<string> {
    const [row] = await h.db.execute<{ id: string }>(sql`
      SELECT r.id FROM role r
        JOIN organization o ON o.id = r.organization_id
       WHERE o.key = ${orgKey} AND r.key = ${roleKey}
    `);
    return row!.id;
  }

  it('1 — an officer cannot promote a lieutenant', async () => {
    const officer = await operator('h1officer', 'PD', 'officer');
    const lieutenant = await operator('h1lt', 'PD', 'lieutenant');
    const organizationId = officer.organizationId;

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/personnel/${lieutenant.memberId}/rank`,
      headers: officer.headers,
      payload: { roleId: await roleIdFor('PD', 'commander'), reason: 'escalation attempt' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('2 — a sergeant cannot assign the chief role', async () => {
    const sergeant = await operator('h2sgt', 'PD', 'sergeant');
    const victim = await operator('h2victim', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${sergeant.organizationId}/personnel/${victim.memberId}/rank`,
      headers: sergeant.headers,
      payload: { roleId: await roleIdFor('PD', 'chief'), reason: 'escalation attempt' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('3 — an Organization Lead cannot manage another organization', async () => {
    const granter = await operator('h3granter', 'PD', 'chief');
    await makeGlobalAdmin(h.db, granter.creds.username);
    const lead = await operator('h3lead', 'PD', 'chief');
    await makeOrgLead(h.db, lead.creds.username, 'PD', granter.creds.username);

    const foreign = await operator('h3foreign', 'MD', 'doctor');

    const read = await h.app.inject({
      method: 'GET', url: `/api/v1/organizations/${foreign.organizationId}`,
      headers: lead.headers,
    });
    expect(read.statusCode).toBe(404);

    const write = await h.app.inject({
      method: 'PATCH', url: `/api/v1/organizations/${foreign.organizationId}`,
      headers: lead.headers, payload: { name: 'Annexed' },
    });
    expect([403, 404]).toContain(write.statusCode);

    const fire = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${foreign.organizationId}/personnel/${foreign.memberId}/termination`,
      headers: lead.headers, payload: { reason: 'cross-organization attempt' },
    });
    expect([403, 404]).toContain(fire.statusCode);
  });

  it('4 — an Organization Lead cannot grant themselves global permissions', async () => {
    const granter = await operator('h4granter', 'PD', 'chief');
    await makeGlobalAdmin(h.db, granter.creds.username);
    const lead = await operator('h4lead', 'PD', 'chief');
    await makeOrgLead(h.db, lead.creds.username, 'PD', granter.creds.username);
    const leadUserId = await userIdByUsername(h.db, lead.creds.username);

    // Directly, through the capability endpoint.
    const direct = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${leadUserId}/capabilities`,
      headers: lead.headers, payload: { capability: 'global_admin' },
    });
    expect(direct.statusCode).toBe(403);

    // Indirectly, by writing a global permission onto a role they control.
    const roleId = await roleIdFor('PD', 'chief');
    const viaRole = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${lead.organizationId}/roles/${roleId}/permissions`,
      headers: lead.headers,
      payload: { permissions: ['admin.users', 'admin.audit_logs'] },
    });
    expect([400, 403]).toContain(viaRole.statusCode);

    // And the grant did not appear by any other route.
    const [held] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM user_global_role WHERE user_id = ${leadUserId}
    `);
    expect(held!.n).toBe(0);
  });

  it('5 — a user cannot modify another organization’s incident', async () => {
    const owner = await operator('h5owner', 'PD', 'lieutenant');
    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents',
      headers: owner.headers, payload: { title: 'PD only', priority: 3 },
    });
    const call = created.json() as { id: string };

    const outsider = await operator('h5outsider', 'MD', 'doctor');
    for (const [method, url, payload] of [
      ['PATCH', `/api/v1/dispatch/incidents/${call.id}`, { title: 'Hijacked' }],
      ['POST', `/api/v1/dispatch/incidents/${call.id}/close`, { cancelled: true }],
      ['POST', `/api/v1/dispatch/incidents/${call.id}/notes`, { body: 'not mine' }],
    ] as const) {
      const res = await h.app.inject({
        method, url, headers: outsider.headers, payload: payload as never,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('6 — an ordinary user cannot call admin endpoints directly', async () => {
    const user = await operator('h6user', 'PD', 'officer');
    const target = await operator('h6target', 'PD', 'officer');
    const targetUserId = await userIdByUsername(h.db, target.creds.username);

    for (const url of [
      '/api/v1/admin/users',
      '/api/v1/admin/leads',
      '/api/v1/admin/permissions',
      '/api/v1/admin/audit',
      '/api/v1/admin/system',
    ]) {
      const res = await h.app.inject({ method: 'GET', url, headers: user.headers });
      expect(res.statusCode, url).toBe(403);
    }

    const disable = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetUserId}/status`,
      headers: user.headers, payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(403);
  });

  it('7 — a user cannot change their own organization by asking for one', async () => {
    const user = await operator('h7user', 'PD', 'officer');
    const otherOrg = await organizationIdByKey(h.db, 'MD');

    const me = await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { ...user.headers, 'x-leoos-organization': otherOrg },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { session: { organization: { id: string } | null } };
    // The header names an organization they are not a member of, so it resolves
    // to nothing rather than being echoed back.
    expect(body.session.organization?.id).not.toBe(otherOrg);

    // And it buys no reach: MD's roster is still invisible.
    const roster = await h.app.inject({
      method: 'GET', url: `/api/v1/organizations/${otherOrg}/members`,
      headers: { ...user.headers, 'x-leoos-organization': otherOrg },
    });
    expect(roster.statusCode).toBe(404);
  });

  it('8 — a user cannot assign themselves a higher role', async () => {
    const officer = await operator('h8officer', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${officer.organizationId}/personnel/${officer.memberId}/rank`,
      headers: officer.headers,
      payload: { roleId: await roleIdFor('PD', 'chief'), reason: 'self-promotion' },
    });
    expect(res.statusCode).toBe(403);

    const roles = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${officer.organizationId}/personnel/${officer.memberId}/roles`,
      headers: officer.headers,
      payload: { roleId: await roleIdFor('PD', 'chief') },
    });
    expect(roles.statusCode).toBe(403);
  });

  it('9 — a user cannot grant themselves permissions', async () => {
    // A COMMANDER who genuinely may edit roles below them still cannot add a
    // permission they do not hold — the subset rule (H4). PD's commander holds
    // no medical permissions, and cannot write one onto a role they control and
    // then take it.
    const commander = await operator('h9commander', 'PD', 'commander');
    const sergeantRole = await roleIdFor('PD', 'sergeant');

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/organizations/${commander.organizationId}/roles/${sergeantRole}/permissions`,
      headers: commander.headers,
      payload: { permissions: ['persons.medical.view', 'persons.medical.edit'] },
    });
    expect([400, 403]).toContain(res.statusCode);
  });

  it('10 — nobody can delete audit logs, by endpoint or by statement', async () => {
    const admin = await operator('h10admin', 'PD', 'chief');
    await makeGlobalAdmin(h.db, admin.creds.username);
    const session = await signIn(h, admin.creds);

    // There is no delete route, and a global administrator does not get one.
    for (const [method, url] of [
      ['DELETE', '/api/v1/admin/audit'],
      ['POST', '/api/v1/admin/audit/purge'],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: session.headers });
      expect([404, 405], `${method} ${url}`).toContain(res.statusCode);
    }

    // And the database refuses it even with a direct statement — see F5.
    const [before] = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log`,
    );
    await expect(h.db.execute(sql`DELETE FROM audit_log`)).rejects.toThrow();
    const [after] = await h.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log`,
    );
    expect(after!.n).toBeGreaterThanOrEqual(before!.n);
  });
});
