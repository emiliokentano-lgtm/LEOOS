import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, makeGlobalAdmin, resetAccounts, signIn,
  uniqueUser, userIdByUsername, type TestHarness,
} from './harness.js';

/**
 * The whole lifecycle, in order, through the HTTP surface only.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A SINGLE ORDERED WALK, WHEN EVERY STEP ALREADY HAS A TEST
 *
 * The other suites are organised by MODULE and each builds the state it needs
 * with direct SQL — `grantMembership`, `makeOrgLead`, `setPermissionOverride`.
 * That is the right way to test a module: a scoping test must be able to create
 * the state it then proves is refused, without depending on the endpoint that
 * produces it.
 *
 * It also means nothing was checking that the endpoints COMPOSE. Every fixture
 * shortcut is a place where the test's idea of a valid state and the
 * application's can diverge — a hire that leaves out a status row, a promotion
 * that the roster then cannot render, a termination that the dispatch board
 * disagrees with. This file uses NO fixture shortcuts after the first global
 * administrator: every piece of state is created by the request an operator
 * would actually make, in the order they would actually make it.
 *
 * It is deliberately ONE `it` per step with shared state across the file, and
 * the steps depend on each other. That is normally a smell; here it is the
 * point, and vitest runs them in declaration order within a file. A failure
 * names the step that broke rather than a setup helper three files away.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await resetAccounts(h.db);
}, 120_000);

afterAll(async () => { await h?.close(); });

/** State threaded through the walk. Assigned by the step that creates it. */
const state = {
  adminHeaders: {} as Record<string, string>,
  leadHeaders: {} as Record<string, string>,
  officerHeaders: {} as Record<string, string>,
  organizationId: '',
  organizationKey: '',
  chiefRoleId: '',
  officerRoleId: '',
  sergeantRoleId: '',
  leadUserId: '',
  officerUserId: '',
  officerMemberId: '',
  incidentId: '',
  unitId: '',
  panicId: '',
  officerCreds: { username: '', password: '' },
  adminUsername: '',
  leadCreds: { username: '', password: '' },
};

const stamp = Date.now().toString(36).slice(-5);

async function req(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
) {
  const res = await h.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  let body: Record<string, unknown> = {};
  try { body = res.json() as Record<string, unknown>; } catch { /* empty body */ }
  return { status: res.statusCode, body };
}

interface SessionShape {
  user: { id: string; username: string; status: string };
  memberships: {
    memberId: string;
    organization: { id: string; key: string };
    status: string;
    permissions: string[];
    isOrgLead: boolean;
    roles: { id: string }[];
  }[];
  isGlobalAdmin: boolean;
}

/** `GET /auth/me`, unwrapped. The response nests everything under `session`. */
async function session(headers: Record<string, string>): Promise<SessionShape> {
  const res = await req('GET', '/api/v1/auth/me', headers);
  expect(res.status, `me → ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.session as SessionShape;
}

/** Fails with the server's own message rather than a bare status code. */
function ok(
  result: { status: number; body: Record<string, unknown> },
  expected: number,
  what: string,
) {
  expect(result.status, `${what} → ${JSON.stringify(result.body)}`).toBe(expected);
  return result.body;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Registration and login
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — an account reaches the application', () => {
  it('registers, verifies and logs in', async () => {
    h.app.limiter.resetAll();
    const creds = uniqueUser(`lcadmin${stamp}`);

    const registered = await req('POST', '/api/v1/auth/register', {}, creds);
    const body = ok(registered, 202, 'register');
    const token = body.devVerificationToken as string;
    // The token is a development affordance, not a production one — but if it
    // ever stops being issued the rest of this walk cannot run, so it is
    // asserted rather than assumed.
    expect(token, 'no verification token issued').toBeTruthy();

    ok(await req('POST', '/api/v1/auth/verify', {}, { token }), 200, 'verify');

    const auth = await signIn(h, creds);
    state.adminHeaders = auth.headers;
    state.adminUsername = creds.username;

    const me = await session(auth.headers);
    expect(me.user.username).toBe(creds.username);
    // A brand-new account belongs to nothing. The walk starts from zero.
    expect(me.memberships).toEqual([]);
  });

  it('refuses the same login with a wrong password, and says nothing useful', async () => {
    h.app.limiter.resetAll();
    const username = state.adminUsername;

    const refused = await req('POST', '/api/v1/auth/login', {},
      { identifier: username, password: 'not-the-password' });
    expect(refused.status).toBe(401);
    // The refusal must not distinguish a wrong password from an unknown account.
    const unknown = await req('POST', '/api/v1/auth/login', {},
      { identifier: `nobody${stamp}`, password: 'not-the-password' });
    expect(unknown.status).toBe(401);
    // `requestId` differs by construction, so the comparison is of the part
    // that would leak: the code and the message.
    expect(refused.body.error).toEqual(unknown.body.error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Creating an organization
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — a global administrator creates an organization', () => {
  it('refuses an ordinary account first', async () => {
    const refused = await req('POST', '/api/v1/organizations', state.adminHeaders, {
      key: `LC${stamp}X`, name: 'Should Not Exist', shortName: 'SNE', category: 'law_enforcement',
    });
    expect([403, 404]).toContain(refused.status);
  });

  it('creates it once the account is a global administrator', async () => {
    await makeGlobalAdmin(h.db, state.adminUsername);

    state.organizationKey = `LC${stamp}`.toUpperCase().slice(0, 12);
    const created = ok(await req('POST', '/api/v1/organizations', state.adminHeaders, {
      key: state.organizationKey,
      name: `Lifecycle County Sheriff ${stamp}`,
      shortName: `LCS${stamp}`.slice(0, 12),
      category: 'law_enforcement',
      color: '#2f6fed',
    }), 201, 'create organization');

    state.organizationId = (created.organization as { id: string }).id;
    expect(state.organizationId).toBeTruthy();
  });

  it('appears in the register it was created in', async () => {
    const listed = ok(
      await req('GET', '/api/v1/organizations', state.adminHeaders), 200, 'list',
    );
    const keys = (listed.organizations as { key: string }[]).map((o) => o.key);
    expect(keys).toContain(state.organizationKey);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · Appointing an Organization Lead
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — the new organization starts empty', () => {
  it('has no roles at all until somebody creates them', async () => {
    const roles = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/roles`, state.adminHeaders),
      200, 'list roles');
    // Worth pinning rather than assuming either way: a hire needs a role to
    // land on, and if organization creation ever starts seeding one, the step
    // below that creates them becomes a duplicate rather than a prerequisite.
    expect(roles.roles as unknown[]).toEqual([]);
  });

  it('has no members, so nobody can be made its lead yet', async () => {
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, `lclead${stamp}`);
    state.leadCreds = { username: creds.username, password: creds.password };
    state.leadUserId = await userIdByUsername(h.db, creds.username);
    const auth = await signIn(h, creds);
    state.leadHeaders = auth.headers;

    // Not a member: the organization is not even visible to them.
    const before = await req(
      'GET', `/api/v1/organizations/${state.organizationId}`, state.leadHeaders,
    );
    expect(before.status).toBe(404);

    /**
     * A LEAD GRANT REQUIRES A MEMBERSHIP, and the API says so.
     *
     * This is the ordering constraint the walk exists to find. Appointing a
     * lead before hiring them would produce a grant attached to nobody — the
     * exact shape of the F1 security finding, where a lead grant and a
     * membership are separate rows that can disagree. The application refuses
     * it at the front door instead.
     */
    const premature = await req('POST',
      `/api/v1/organizations/${state.organizationId}/leads`, state.adminHeaders,
      { userId: state.leadUserId, reason: 'appointed sheriff' });
    expect(premature.status).toBe(409);
    expect(premature.body.error).toMatchObject({ code: 'LEAD_REQUIRES_MEMBERSHIP' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Roles and permissions
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — the rank structure is built', () => {
  it('creates a chief, a sergeant and an officer role', async () => {
    const make = async (key: string, name: string, level: number, permissions: string[]) => {
      const created = ok(await req('POST',
        `/api/v1/organizations/${state.organizationId}/roles`, state.adminHeaders,
        { key, name, hierarchyLevel: level, permissions }), 201, `create role ${key}`);
      return created.roleId as string;
    };

    state.chiefRoleId = await make('lc_chief', 'Chief', 90, [
      'organization.view', 'personnel.view', 'personnel.hire', 'personnel.promote',
      'personnel.demote', 'personnel.fire', 'roles.view', 'roles.assign',
      'dispatch.view', 'dispatch.create', 'dispatch.assign', 'dispatch.close',
      'dispatch.panic', 'dispatch.panic.acknowledge', 'units.manage',
      'map.view', 'map.track_units',
    ]);
    state.sergeantRoleId = await make('lc_sergeant', 'Sergeant', 50, [
      'organization.view', 'personnel.view',
      'dispatch.view', 'dispatch.create', 'dispatch.assign', 'dispatch.close',
      'dispatch.panic', 'units.manage', 'map.view', 'map.track_units',
    ]);
    state.officerRoleId = await make('lc_officer', 'Officer', 10, [
      'organization.view', 'dispatch.view', 'dispatch.panic',
      'map.view', 'map.track_units',
    ]);

    expect(new Set([state.chiefRoleId, state.sergeantRoleId, state.officerRoleId]).size).toBe(3);
  });

  it('reconfigures a role’s permissions through the permissions endpoint', async () => {
    ok(await req('PUT',
      `/api/v1/organizations/${state.organizationId}/roles/${state.officerRoleId}/permissions`,
      state.adminHeaders,
      { permissions: ['organization.view', 'dispatch.view', 'dispatch.panic',
        'map.view', 'map.track_units', 'persons.view'] }),
      200, 'set role permissions');

    const role = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/roles/${state.officerRoleId}`,
      state.adminHeaders), 200, 'read role');
    expect((role.role as { permissions: string[] }).permissions).toContain('persons.view');
  });

  it('refuses a role above the actor and a level outside the scale', async () => {
    const tooHigh = await req('POST',
      `/api/v1/organizations/${state.organizationId}/roles`, state.adminHeaders,
      { key: 'lc_bad', name: 'Bad', hierarchyLevel: 500, permissions: [] });
    expect(tooHigh.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Hiring
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — an employee is hired', () => {
  it('hires an account onto the officer role', async () => {
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, `lcofficer${stamp}`);
    state.officerCreds = { username: creds.username, password: creds.password };
    state.officerUserId = await userIdByUsername(h.db, creds.username);

    const hired = ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel`, state.adminHeaders,
      {
        userId: state.officerUserId,
        roleId: state.officerRoleId,
        callsign: `L-${stamp}`,
        employeeNumber: `E${stamp}`,
      }), 201, 'hire');

    state.officerMemberId = hired.memberId as string;
    expect(state.officerMemberId).toBeTruthy();
  });

  it('gives the new employee the organization on their next request', async () => {
    const auth = await signIn(h, state.officerCreds);
    state.officerHeaders = {
      ...auth.headers,
      'x-leoos-organization': state.organizationId,
    };

    const me = await session(state.officerHeaders);
    expect(me.memberships.map((m) => m.organization.id)).toContain(state.organizationId);
    expect(me.memberships[0]?.status).toBe('active');
  });

  it('appears on the roster with the role that was assigned', async () => {
    const roster = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/personnel`, state.adminHeaders),
      200, 'roster');
    const rows = roster.personnel as { memberId: string; roles: { id: string }[] }[];
    const row = rows.find((r) => r.memberId === state.officerMemberId);
    expect(row, 'new hire missing from the roster').toBeTruthy();
    expect(row!.roles.map((r) => r.id)).toEqual([state.officerRoleId]);
  });

  it('refuses to hire the same account twice into one organization', async () => {
    const again = await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel`, state.adminHeaders,
      { userId: state.officerUserId, roleId: state.officerRoleId });
    expect([409, 400]).toContain(again.status);
  });

  it('hires the future lead as chief, which is what the grant was waiting for', async () => {
    ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel`, state.adminHeaders,
      { userId: state.leadUserId, roleId: state.chiefRoleId }), 201, 'hire lead');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5b · Appointing the Organization Lead, now that they are a member
// ═══════════════════════════════════════════════════════════════════════════

describe('5b — the Organization Lead is appointed', () => {
  it('grants the lead capability', async () => {
    ok(await req('POST', `/api/v1/organizations/${state.organizationId}/leads`,
      state.adminHeaders,
      { userId: state.leadUserId, reason: 'appointed sheriff' }), 201, 'grant lead');

    const leads = ok(await req('GET', `/api/v1/organizations/${state.organizationId}/leads`,
      state.adminHeaders), 200, 'list leads');
    expect((leads.leads as { userId: string }[]).map((l) => l.userId))
      .toContain(state.leadUserId);
  });

  it('the lead sees their own organization on the next request', async () => {
    const auth = await signIn(h, state.leadCreds);
    state.leadHeaders = { ...auth.headers, 'x-leoos-organization': state.organizationId };

    const me = await session(state.leadHeaders);
    const membership = me.memberships.find((m) => m.organization.id === state.organizationId);
    expect(membership?.isOrgLead).toBe(true);
  });

  it('reaches NO global administration, however senior they are here', async () => {
    // The rule that matters most about a lead: their authority stops at the
    // organization boundary and does not extend to the installation.
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/audit', '/api/v1/admin/system']) {
      const res = await req('GET', url, state.leadHeaders);
      expect([403, 404], `${url} → ${res.status}`).toContain(res.status);
    }
  });

  it('cannot touch another organization’s roster', async () => {
    const [other] = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM organization WHERE key = 'MD'`,
    );
    const res = await req('GET',
      `/api/v1/organizations/${other!.id}/personnel`, state.leadHeaders);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · Role assignment, promotion and demotion
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — rank moves in both directions', () => {
  it('grants an additional role alongside the first', async () => {
    ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}/roles`,
      state.adminHeaders, { roleId: state.sergeantRoleId }), 201, 'assign role');

    const member = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}`,
      state.adminHeaders), 200, 'member detail');
    const roleIds = (member.member as { roles: { id: string }[] }).roles.map((r) => r.id);
    expect(roleIds).toContain(state.sergeantRoleId);
  });

  it('removes it again, leaving the original', async () => {
    ok(await req('DELETE',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}`
      + `/roles/${state.sergeantRoleId}`, state.adminHeaders), 200, 'remove role');

    const member = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}`,
      state.adminHeaders), 200, 'member detail');
    const roleIds = (member.member as { roles: { id: string }[] }).roles.map((r) => r.id);
    expect(roleIds).not.toContain(state.sergeantRoleId);
    expect(roleIds).toContain(state.officerRoleId);
  });

  it('promotes to sergeant through the rank endpoint', async () => {
    const result = ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}/rank`,
      state.adminHeaders,
      { roleId: state.sergeantRoleId, reason: 'passed the board' }), 200, 'promote');

    // The DIRECTION is derived server-side from the levels — there is no flag
    // for a client to lie about — so the response reports which it was, and the
    // levels it moved between.
    expect(result.kind).toBe('promote');
    expect(result.toLevel as number).toBeGreaterThan(result.fromLevel as number);
  });

  it('the promotion reaches the employee’s own permissions immediately', async () => {
    const me = await session(state.officerHeaders);
    const membership = me.memberships.find((m) => m.organization.id === state.organizationId);
    // Sergeant carries dispatch.assign; officer did not.
    expect(membership?.permissions).toContain('dispatch.assign');
  });

  it('demotes back to officer, and the permission goes with it', async () => {
    const result = ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}/rank`,
      state.adminHeaders,
      { roleId: state.officerRoleId, reason: 'returned to patrol' }), 200, 'demote');
    expect(result.kind).toBe('demote');
    expect(result.toLevel as number).toBeLessThan(result.fromLevel as number);

    const me = await session(state.officerHeaders);
    const membership = me.memberships.find((m) => m.organization.id === state.organizationId);
    expect(membership?.permissions).not.toContain('dispatch.assign');
  });

  it('records both moves in the member’s status history', async () => {
    const rows = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
       WHERE entity_id = ${state.officerMemberId}
         AND action IN ('personnel.promoted', 'personnel.demoted')
       ORDER BY occurred_at
    `);
    expect(rows.map((r) => r.action)).toEqual(['personnel.promoted', 'personnel.demoted']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · Dispatch: unit, incident, assignment, panic, location, close
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — a shift is worked', () => {
  it('the employee goes on duty and crews a unit', async () => {
    // Promote back to sergeant: creating a unit needs `units.manage`, and the
    // walk should exercise the state an operator would actually be in.
    ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}/rank`,
      state.adminHeaders,
      { roleId: state.sergeantRoleId, reason: 'shift supervisor' }), 200, 'promote');

    ok(await req('POST', '/api/v1/dispatch/self/status', state.officerHeaders,
      { statusKey: 'available' }), 200, 'go available');

    const unit = ok(await req('POST', '/api/v1/dispatch/units', state.officerHeaders,
      { callsign: `LU-${stamp}`, unitType: 'patrol', joinSelf: true }), 201, 'create unit');
    state.unitId = unit.id as string;

    const board = ok(await req('GET', '/api/v1/dispatch/board', state.officerHeaders),
      200, 'board');
    expect((board.self as { unitId: string | null }).unitId).toBe(state.unitId);
  });

  it('files an incident', async () => {
    const created = ok(await req('POST', '/api/v1/dispatch/incidents', state.officerHeaders,
      { title: 'Lifecycle walk — armed robbery', priority: 1, locationText: 'Vinewood Blvd' }),
      201, 'create incident');
    state.incidentId = created.id as string;

    const board = ok(await req('GET', '/api/v1/dispatch/board', state.officerHeaders),
      200, 'board');
    expect((board.incidents as { id: string }[]).map((i) => i.id)).toContain(state.incidentId);
  });

  it('assigns the unit, which advances the call to dispatched', async () => {
    ok(await req('POST', `/api/v1/dispatch/incidents/${state.incidentId}/units`,
      state.officerHeaders, { unitId: state.unitId }), 201, 'assign unit');

    const incident = ok(await req('GET', `/api/v1/dispatch/incidents/${state.incidentId}`,
      state.officerHeaders), 200, 'incident detail') as unknown as {
        status: string; assignments: { unitId: string; releasedAt: string | null }[];
      };
    expect(incident.status).toBe('dispatched');
    expect(incident.assignments.map((a) => a.unitId)).toContain(state.unitId);
  });

  it('a position arrives for the unit and the map serves it back', async () => {
    // Through the position store the FiveM ingest writes to, because that is
    // where a real position comes from — not by writing `unit.pos_x` directly.
    h.app.mapPositions.set({
      unitId: state.unitId,
      organizationId: state.organizationId,
      x: 120.5, y: -430.25, z: 30, heading: 275, speed: 18,
      sampledAt: new Date(),
    });

    const snapshot = ok(await req('GET', '/api/v1/map/snapshot', state.officerHeaders),
      200, 'map snapshot');
    const unitRow = (snapshot.units as { id: string; location: { x: number } | null }[])
      .find((u) => u.id === state.unitId);
    expect(unitRow, 'unit missing from the map snapshot').toBeTruthy();
    expect(unitRow!.location?.x).toBeCloseTo(120.5, 1);
  });

  it('the employee raises a panic, which becomes server-side state', async () => {
    const raised = ok(await req('POST', '/api/v1/dispatch/self/panic', state.officerHeaders,
      { x: 120.5, y: -430.25 }), 201, 'panic');
    state.panicId = raised.id as string;

    const board = ok(await req('GET', '/api/v1/dispatch/board', state.officerHeaders),
      200, 'board');
    expect((board.panics as { id: string }[]).map((p) => p.id)).toContain(state.panicId);

    const [row] = await h.db.execute<{ resolved_at: Date | null }>(
      sql`SELECT resolved_at FROM panic_event WHERE id = ${state.panicId}`,
    );
    expect(row!.resolved_at).toBeNull();
  });

  it('a chief acknowledges and stands it down', async () => {
    // Acknowledging is somebody ELSE's action, so it needs its own operator.
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, `lcchief${stamp}`);
    const chiefUserId = await userIdByUsername(h.db, creds.username);
    ok(await req('POST', `/api/v1/organizations/${state.organizationId}/personnel`,
      state.adminHeaders, { userId: chiefUserId, roleId: state.chiefRoleId }), 201, 'hire chief');
    const auth = await signIn(h, creds);
    const chiefHeaders = { ...auth.headers, 'x-leoos-organization': state.organizationId };

    ok(await req('POST', `/api/v1/dispatch/panics/${state.panicId}/acknowledge`, chiefHeaders),
      200, 'acknowledge');

    // Acknowledged is NOT resolved — the alert stays live until stood down.
    const [acked] = await h.db.execute<{ acknowledged_at: Date | null; resolved_at: Date | null }>(
      sql`SELECT acknowledged_at, resolved_at FROM panic_event WHERE id = ${state.panicId}`,
    );
    expect(acked!.acknowledged_at).not.toBeNull();
    expect(acked!.resolved_at).toBeNull();

    ok(await req('POST', `/api/v1/dispatch/panics/${state.panicId}/resolve`, chiefHeaders,
      { restoreStatusKey: 'available' }), 200, 'resolve');

    const [done] = await h.db.execute<{ resolved_at: Date | null }>(
      sql`SELECT resolved_at FROM panic_event WHERE id = ${state.panicId}`,
    );
    expect(done!.resolved_at).not.toBeNull();
  });

  it('closes the incident, which releases the unit', async () => {
    ok(await req('POST', `/api/v1/dispatch/incidents/${state.incidentId}/close`,
      state.officerHeaders, { notes: 'Suspect in custody' }), 200, 'close');

    const incident = ok(await req('GET', `/api/v1/dispatch/incidents/${state.incidentId}`,
      state.officerHeaders), 200, 'incident detail') as unknown as {
        status: string; assignments: { unitId: string; releasedAt: string | null }[];
      };
    expect(incident.status).toBe('closed');
    // Closing a call releases every unit on it — nobody is left committed to a
    // call that is over.
    for (const a of incident.assignments) expect(a.releasedAt).not.toBeNull();
  });

  it('leaves an append-only timeline covering the whole call', async () => {
    const rows = await h.db.execute<{ entry_type: string }>(sql`
      SELECT entry_type FROM incident_log
       WHERE incident_id = ${state.incidentId}
       ORDER BY created_at, id
    `);
    const types = rows.map((r) => r.entry_type);
    // Creation, assignment and release at the very least — three state changes,
    // three entries. The vocabulary is the stored enum's, read back rather than
    // invented here: `system` for the call being filed, `assignment` for the
    // unit arriving on it, `clear` for it being released when the call closed.
    expect(types.length).toBeGreaterThanOrEqual(3);
    expect(types).toContain('system');
    expect(types).toContain('assignment');
    expect(types).toContain('clear');

    // And it cannot be rewritten, which is what makes it a record.
    await expect(h.db.execute(sql`
      DELETE FROM incident_log WHERE incident_id = ${state.incidentId}
    `)).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · Termination
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — the employee is terminated', () => {
  it('terminates the membership', async () => {
    ok(await req('POST',
      `/api/v1/organizations/${state.organizationId}/personnel/${state.officerMemberId}/termination`,
      state.adminHeaders, { reason: 'resigned' }), 200, 'terminate');

    const [row] = await h.db.execute<{ status: string; left_at: Date | null }>(
      sql`SELECT status, left_at FROM organization_member WHERE id = ${state.officerMemberId}`,
    );
    expect(row!.status).toBe('terminated');
    expect(row!.left_at).not.toBeNull();
  });

  it('ends their session immediately rather than waiting for it to expire', async () => {
    /**
     * 401, not 404 — and that is the STRONGER answer.
     *
     * Termination revokes every session the account holds, so the next request
     * is not a member without dispatch access; it is not authenticated at all.
     * Asserting 404 here would have been asserting the weaker behaviour and
     * would have quietly passed if the revocation were ever removed.
     */
    const board = await req('GET', '/api/v1/dispatch/board', state.officerHeaders);
    expect(board.status).toBe(401);
  });

  it('refuses dispatch even after they sign in again', async () => {
    // The session revocation is not the whole defence. Signing in again gets a
    // valid session with no membership behind it, and dispatch is closed on the
    // very first request — no wait, because the termination bumped the
    // permission version the identity cache is keyed on.
    h.app.limiter.resetAll();
    const auth = await signIn(h, state.officerCreds);
    const headers = { ...auth.headers, 'x-leoos-organization': state.organizationId };
    expect((await req('GET', '/api/v1/dispatch/board', headers)).status).toBe(404);
  });

  it('keeps them on the roster as history rather than deleting them', async () => {
    const roster = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/personnel`
      + '?status=terminated', state.adminHeaders), 200, 'roster');
    const rows = roster.personnel as { memberId: string; status: string }[];
    const row = rows.find((r) => r.memberId === state.officerMemberId);
    expect(row, 'terminated member vanished from the roster').toBeTruthy();
    expect(row?.status).toBe('terminated');
  });

  it('leaves the account itself intact and able to log in', async () => {
    // Terminating a membership is not disabling an account. Somebody who leaves
    // one agency may work for another.
    h.app.limiter.resetAll();
    const auth = await signIn(h, state.officerCreds);
    const me = await session(auth.headers);
    const membership = me.memberships.find((m) => m.organization.id === state.organizationId);
    expect(membership?.status).toBe('terminated');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 · The organization is stood down
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — the organization is archived', () => {
  /**
   * The last step of the lifecycle, and the one that keeps this file honest.
   *
   * Without it every run of this suite left a permanent organization behind in
   * the shared test database. That showed up in the live-map walkthrough, which
   * printed a growing list of one-off agencies alongside the six seeded ones —
   * this file quietly polluting a different test's world.
   *
   * Archiving is also the step the walk was missing: an organization is stood
   * down by SOFT deletion, not removed, because its personnel history and its
   * incidents have to survive it.
   */
  it('refuses while people still work there, and says how many', async () => {
    /**
     * FOUND BY THIS WALK.
     *
     * The database refuses to archive an organization with active members —
     * rightly, because its personnel history would be orphaned. That rule lived
     * ONLY in a trigger, so the refusal reached the administrator as a raw
     * Postgres error: a 500 and "Something went wrong", for a condition that is
     * ordinary, expected, and entirely theirs to fix.
     */
    const refused = await req('DELETE', `/api/v1/organizations/${state.organizationId}`,
      state.adminHeaders, { reason: 'lifecycle walk complete' });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'ORGANIZATION_HAS_MEMBERS' });
    // And the message has to be actionable: a count, and what to do about it.
    expect(String((refused.body.error as { message: string }).message)).toMatch(/\d+ active member/);
  });

  it('archives it once the last member has gone, and it leaves the active register', async () => {
    // The chief and the lead are still on the books. Terminate them the way the
    // application does, rather than reaching into the table.
    const roster = ok(await req('GET',
      `/api/v1/organizations/${state.organizationId}/personnel`, state.adminHeaders),
      200, 'roster');
    const active = (roster.personnel as { memberId: string; status: string }[])
      .filter((r) => r.status === 'active');
    expect(active.length).toBeGreaterThan(0);

    for (const member of active) {
      ok(await req('POST',
        `/api/v1/organizations/${state.organizationId}/personnel/${member.memberId}/termination`,
        state.adminHeaders, { reason: 'organization stood down' }), 200, 'terminate');
    }

    ok(await req('DELETE', `/api/v1/organizations/${state.organizationId}`,
      state.adminHeaders, { reason: 'lifecycle walk complete' }), 200, 'archive');

    const listed = ok(
      await req('GET', '/api/v1/organizations', state.adminHeaders), 200, 'list',
    );
    const keys = (listed.organizations as { key: string }[]).map((o) => o.key);
    expect(keys).not.toContain(state.organizationKey);
  });

  it('is soft-deleted, so its people and its calls survive it', async () => {
    const [org] = await h.db.execute<{ deleted_at: Date | null }>(
      sql`SELECT deleted_at FROM organization WHERE id = ${state.organizationId}`,
    );
    expect(org!.deleted_at).not.toBeNull();

    // The row is still there, and so is everything that happened under it.
    const [members] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM organization_member
       WHERE organization_id = ${state.organizationId}
    `);
    expect(members!.n).toBeGreaterThan(0);

    const [incidents] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM incident WHERE id = ${state.incidentId}
    `);
    expect(incidents!.n).toBe(1);
  });

  it('still appears when archived organizations are asked for', async () => {
    const listed = ok(await req('GET', '/api/v1/organizations?includeArchived=true',
      state.adminHeaders), 200, 'list archived');
    const keys = (listed.organizations as { key: string }[]).map((o) => o.key);
    expect(keys).toContain(state.organizationKey);
  });
});
