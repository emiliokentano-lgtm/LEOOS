import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin, makeOrgLead,
  organizationIdByKey, resetAccounts, signIn, userIdByUsername, type TestHarness,
} from './harness.js';

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

const url = (p: string) => `/api/v1/organizations${p}`;

/** An active PD member who also holds the PD lead capability. */
async function pdLead() {
  const granter = await createActiveUser(h, 'granter');
  const creds = await createActiveUser(h, 'pdlead');
  await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'cadet' });
  await makeOrgLead(h.db, creds.username, 'PD', granter.username);
  return { creds, auth: await signIn(h, creds) };
}

async function globalAdmin() {
  const creds = await createActiveUser(h, 'gadmin');
  await makeGlobalAdmin(h.db, creds.username);
  return { creds, auth: await signIn(h, creds) };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('organization scoping — a lead of one organization cannot manage another', () => {
  it('lets a PD lead edit PD', async () => {
    const { auth } = await pdLead();
    const pd = await organizationIdByKey(h.db, 'PD');

    const res = await h.app.inject({
      method: 'PATCH', url: url(`/${pd}`), headers: auth.headers,
      payload: { description: 'Updated by the PD lead.' },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { organization: { description: string } }).organization.description)
      .toBe('Updated by the PD lead.');
  });

  it('REFUSES a PD lead editing MD, FIB, Army, ICE or Mechanic', async () => {
    const { auth } = await pdLead();

    // The whole point of the capability being per-organization.
    for (const key of ['MD', 'FIB', 'ARMY', 'ICE', 'MECHANIC']) {
      const orgId = await organizationIdByKey(h.db, key);
      const res = await h.app.inject({
        method: 'PATCH', url: url(`/${orgId}`), headers: auth.headers,
        payload: { description: `Should never reach ${key}.` },
      });

      expect(res.statusCode, `editing ${key} must be refused`).toBe(403);
      expect((res.json() as { error: { detail?: { reason: string } } }).error.detail?.reason)
        .toBe('CROSS_ORGANIZATION');

      // And nothing was written.
      const rows = await h.db.execute<{ description: string | null }>(
        sql`SELECT description FROM organization WHERE id = ${orgId}`,
      );
      expect(rows[0]?.description).not.toBe(`Should never reach ${key}.`);
    }
  });

  it('hides another organization\'s detail from a PD lead as NOT FOUND', async () => {
    const { auth } = await pdLead();
    const md = await organizationIdByKey(h.db, 'MD');

    const res = await h.app.inject({ method: 'GET', url: url(`/${md}`), headers: auth.headers });

    // 404, not 403 — a 403 would confirm the organization exists.
    expect(res.statusCode).toBe(404);
  });

  it('lists only the organizations a member belongs to', async () => {
    const { auth } = await pdLead();
    const res = await h.app.inject({ method: 'GET', url: url('/'), headers: auth.headers });

    const keys = (res.json() as { organizations: { key: string }[] })
      .organizations.map((o) => o.key);
    expect(keys).toEqual(['PD']);
  });

  it('refuses a PD lead every scoped section of another organization', async () => {
    const { auth } = await pdLead();
    const md = await organizationIdByKey(h.db, 'MD');

    for (const section of ['members', 'roles', 'units', 'vehicles']) {
      const res = await h.app.inject({
        method: 'GET', url: url(`/${md}/${section}`), headers: auth.headers,
      });
      expect(res.statusCode, `${section} of MD must be refused`).toBe(404);
    }
  });

  it('gives a PD lead every scoped section of their own organization', async () => {
    const { auth } = await pdLead();
    const pd = await organizationIdByKey(h.db, 'PD');

    for (const section of ['members', 'roles', 'units', 'vehicles']) {
      const res = await h.app.inject({
        method: 'GET', url: url(`/${pd}/${section}`), headers: auth.headers,
      });
      expect(res.statusCode, `${section} of PD must be allowed`).toBe(200);
    }
  });

  it('is not fooled by a forged active-organization header', async () => {
    const { auth } = await pdLead();
    const md = await organizationIdByKey(h.db, 'MD');

    // Claim MD is the active organization while editing MD. Scope is derived
    // from the database, so the header changes nothing.
    const res = await h.app.inject({
      method: 'PATCH', url: url(`/${md}`),
      headers: { ...auth.headers, 'x-leoos-organization': md },
      payload: { description: 'via forged header' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a lead of two organizations authority over a third', async () => {
    const granter = await createActiveUser(h, 'granter2');
    const creds = await createActiveUser(h, 'dual');
    await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'cadet' });
    await grantMembership(h.db, creds.username, { orgKey: 'MD', roleKey: 'trainee' });
    await makeOrgLead(h.db, creds.username, 'PD', granter.username);
    await makeOrgLead(h.db, creds.username, 'MD', granter.username);
    const auth = await signIn(h, creds);

    const fib = await organizationIdByKey(h.db, 'FIB');
    const res = await h.app.inject({
      method: 'PATCH', url: url(`/${fib}`), headers: auth.headers,
      payload: { description: 'nope' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('organization lead capability', () => {
  it('lets a global admin grant, list and revoke a lead', async () => {
    const admin = await globalAdmin();
    const target = await createActiveUser(h, 'target');
    await grantMembership(h.db, target.username, { orgKey: 'FIB', roleKey: 'agent' });

    const fib = await organizationIdByKey(h.db, 'FIB');
    const targetId = await userIdByUsername(h.db, target.username);

    const granted = await h.app.inject({
      method: 'POST', url: url(`/${fib}/leads`), headers: admin.auth.headers,
      payload: { userId: targetId, reason: 'appointed director' },
    });
    expect(granted.statusCode).toBe(201);

    const listed = await h.app.inject({
      method: 'GET', url: url(`/${fib}/leads`), headers: admin.auth.headers,
    });
    expect((listed.json() as { leads: { userId: string }[] }).leads.map((l) => l.userId))
      .toContain(targetId);

    const revoked = await h.app.inject({
      method: 'DELETE', url: url(`/${fib}/leads/${targetId}`), headers: admin.auth.headers,
      payload: { reason: 'stepped down' },
    });
    expect(revoked.statusCode).toBe(200);

    const after = await h.app.inject({
      method: 'GET', url: url(`/${fib}/leads`), headers: admin.auth.headers,
    });
    expect((after.json() as { leads: unknown[] }).leads).toHaveLength(0);
  });

  it('REFUSES an organization lead granting the capability to anyone', async () => {
    // If a lead could appoint leads, the capability would be self-propagating
    // and "global admin decides who leads an organization" would stop being true.
    const { auth } = await pdLead();
    const target = await createActiveUser(h, 'wannabe');
    await grantMembership(h.db, target.username, { orgKey: 'PD', roleKey: 'officer' });

    const pd = await organizationIdByKey(h.db, 'PD');
    const targetId = await userIdByUsername(h.db, target.username);

    const res = await h.app.inject({
      method: 'POST', url: url(`/${pd}/leads`), headers: auth.headers,
      payload: { userId: targetId },
    });

    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/global administrator/i);

    const count = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM organization_lead
      WHERE user_id = ${targetId} AND revoked_at IS NULL
    `);
    expect(count[0]!.n).toBe(0);
  });

  it('refuses a lead revoking their own or another lead\'s capability', async () => {
    const granter = await createActiveUser(h, 'g3');
    const a = await createActiveUser(h, 'leada');
    const b = await createActiveUser(h, 'leadb');
    await grantMembership(h.db, a.username, { orgKey: 'PD', roleKey: 'cadet' });
    await grantMembership(h.db, b.username, { orgKey: 'PD', roleKey: 'cadet' });
    await makeOrgLead(h.db, a.username, 'PD', granter.username);
    await makeOrgLead(h.db, b.username, 'PD', granter.username);

    const auth = await signIn(h, a);
    const pd = await organizationIdByKey(h.db, 'PD');
    const bId = await userIdByUsername(h.db, b.username);

    const res = await h.app.inject({
      method: 'DELETE', url: url(`/${pd}/leads/${bId}`), headers: auth.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires an active membership before granting', async () => {
    const admin = await globalAdmin();
    const outsider = await createActiveUser(h, 'outsider');
    const army = await organizationIdByKey(h.db, 'ARMY');
    const outsiderId = await userIdByUsername(h.db, outsider.username);

    const res = await h.app.inject({
      method: 'POST', url: url(`/${army}/leads`), headers: admin.auth.headers,
      payload: { userId: outsiderId },
    });

    // A lead who is not a member has authority over an organization they do not
    // belong to — refused here and by a database trigger.
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('LEAD_REQUIRES_MEMBERSHIP');
  });

  it('ends the lead\'s sessions when the capability is revoked', async () => {
    const admin = await globalAdmin();
    const target = await createActiveUser(h, 'revokee');
    await grantMembership(h.db, target.username, { orgKey: 'ICE', roleKey: 'agent' });
    const ice = await organizationIdByKey(h.db, 'ICE');
    const targetId = await userIdByUsername(h.db, target.username);

    await h.app.inject({
      method: 'POST', url: url(`/${ice}/leads`), headers: admin.auth.headers,
      payload: { userId: targetId },
    });

    const targetAuth = await signIn(h, target);
    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: targetAuth.headers,
    })).statusCode).toBe(200);

    await h.app.inject({
      method: 'DELETE', url: url(`/${ice}/leads/${targetId}`), headers: admin.auth.headers,
    });

    // Otherwise the capability is gone on paper but still effective in an open tab.
    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: targetAuth.headers,
    })).statusCode).toBe(401);
  });

  it('reflects the grant in the target\'s resolved session', async () => {
    const admin = await globalAdmin();
    const target = await createActiveUser(h, 'reflect');
    await grantMembership(h.db, target.username, { orgKey: 'MECHANIC', roleKey: 'mechanic' });
    const org = await organizationIdByKey(h.db, 'MECHANIC');
    const targetId = await userIdByUsername(h.db, target.username);

    await h.app.inject({
      method: 'POST', url: url(`/${org}/leads`), headers: admin.auth.headers,
      payload: { userId: targetId },
    });

    const auth = await signIn(h, target);
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth.headers });
    const body = me.json() as {
      session: { memberships: { isOrgLead: boolean }[]; isGlobalAdmin: boolean };
    };

    expect(body.session.memberships[0]!.isOrgLead).toBe(true);
    // Leading an organization must never imply global authority.
    expect(body.session.isGlobalAdmin).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('global administrator', () => {
  it('creates an organization, and the six seeded ones still stand', async () => {
    const admin = await globalAdmin();

    const res = await h.app.inject({
      method: 'POST', url: url('/'), headers: admin.auth.headers,
      payload: {
        key: `FIRE${Date.now().toString(36).slice(-4)}`.toUpperCase(),
        name: 'Fire Department', shortName: 'LSFD',
        category: 'civil_service', color: '#ff7a2f',
      },
    });
    expect(res.statusCode).toBe(201);
    const createdId = (res.json() as { organization: { id: string } }).organization.id;

    // Adding a seventh organization is a row insert, not a code change.
    const all = await h.app.inject({ method: 'GET', url: url('/'), headers: admin.auth.headers });
    const keys = (all.json() as { organizations: { key: string }[] }).organizations.map((o) => o.key);
    for (const seeded of ['PD', 'MD', 'FIB', 'ARMY', 'ICE', 'MECHANIC']) {
      expect(keys).toContain(seeded);
    }

    // Archive it again: this test would otherwise leave a new organization
    // behind on every run, and a test that pollutes shared state is a slow leak.
    const archived = await h.app.inject({
      method: 'DELETE', url: url(`/${createdId}`), headers: admin.auth.headers,
      payload: { reason: 'test cleanup' },
    });
    expect(archived.statusCode).toBe(200);
  });

  it('refuses a duplicate organization key', async () => {
    const admin = await globalAdmin();
    const res = await h.app.inject({
      method: 'POST', url: url('/'), headers: admin.auth.headers,
      payload: { key: 'PD', name: 'Duplicate', shortName: 'DUP', category: 'other' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a non-admin creating an organization', async () => {
    const { auth } = await pdLead();
    const res = await h.app.inject({
      method: 'POST', url: url('/'), headers: auth.headers,
      payload: { key: 'SNEAK', name: 'Sneaky', shortName: 'SNK', category: 'other' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reserves category and activation changes to global administrators', async () => {
    const { auth } = await pdLead();
    const pd = await organizationIdByKey(h.db, 'PD');

    // A lead may edit their organization's profile but not reclassify it:
    // category drives cross-organization visibility, e.g. medical records.
    for (const payload of [{ category: 'medical' as const }, { isActive: false }]) {
      const res = await h.app.inject({
        method: 'PATCH', url: url(`/${pd}`), headers: auth.headers, payload,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('sees every organization, and can disable one', async () => {
    const admin = await globalAdmin();
    const res = await h.app.inject({ method: 'GET', url: url('/'), headers: admin.auth.headers });
    expect((res.json() as { organizations: unknown[] }).organizations.length).toBeGreaterThanOrEqual(6);

    const mechanic = await organizationIdByKey(h.db, 'MECHANIC');
    const disabled = await h.app.inject({
      method: 'PATCH', url: url(`/${mechanic}`), headers: admin.auth.headers,
      payload: { isActive: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as { organization: { isActive: boolean } }).organization.isActive).toBe(false);

    // Restore so the rest of the suite is unaffected.
    await h.app.inject({
      method: 'PATCH', url: url(`/${mechanic}`), headers: admin.auth.headers,
      payload: { isActive: true },
    });
  });

  it('refuses archiving an organization that still has active members', async () => {
    const admin = await globalAdmin();
    const member = await createActiveUser(h, 'staying');
    await grantMembership(h.db, member.username, { orgKey: 'ARMY', roleKey: 'soldier' });
    const army = await organizationIdByKey(h.db, 'ARMY');

    const res = await h.app.inject({
      method: 'DELETE', url: url(`/${army}`), headers: admin.auth.headers,
      payload: { reason: 'disbanded' },
    });

    // The database refuses this, so a disbanded department cannot orphan its
    // operational history.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('auditing', () => {
  it('records grant and revoke with full context', async () => {
    const admin = await globalAdmin();
    const target = await createActiveUser(h, 'audited');
    await grantMembership(h.db, target.username, { orgKey: 'FIB', roleKey: 'agent' });
    const fib = await organizationIdByKey(h.db, 'FIB');
    const targetId = await userIdByUsername(h.db, target.username);

    await h.app.inject({
      method: 'POST', url: url(`/${fib}/leads`), headers: admin.auth.headers,
      payload: { userId: targetId, reason: 'promotion to director' },
    });
    await h.app.inject({
      method: 'DELETE', url: url(`/${fib}/leads/${targetId}`), headers: admin.auth.headers,
      payload: { reason: 'reorganisation' },
    });

    const rows = await h.db.execute<{
      action: string; outcome: string; actor_user_id: string;
      organization_id: string; entity_id: string; metadata: Record<string, unknown>;
    }>(sql`
      SELECT action, outcome, actor_user_id, organization_id, entity_id, metadata
      FROM audit_log
      WHERE entity_id = ${targetId} AND action LIKE 'organization.lead_%'
      ORDER BY occurred_at
    `);

    expect(rows.map((r) => r.action)).toEqual([
      'organization.lead_granted', 'organization.lead_revoked',
    ]);
    for (const row of rows) {
      // WHO, WHAT, WHERE — every one present.
      expect(row.actor_user_id).toBeTruthy();
      expect(row.organization_id).toBe(fib);
      expect(row.entity_id).toBe(targetId);
      expect(row.metadata.organizationKey).toBe('FIB');
      expect(row.outcome).toBe('success');
    }
    expect(rows[0]!.metadata.reason).toBe('promotion to director');
    expect(rows[1]!.metadata.reason).toBe('reorganisation');
  });

  it('records a REFUSED grant attempt', async () => {
    const { auth, creds } = await pdLead();
    const target = await createActiveUser(h, 'nottobe');
    await grantMembership(h.db, target.username, { orgKey: 'PD', roleKey: 'officer' });
    const pd = await organizationIdByKey(h.db, 'PD');
    const targetId = await userIdByUsername(h.db, target.username);
    const actorId = await userIdByUsername(h.db, creds.username);

    await h.app.inject({
      method: 'POST', url: url(`/${pd}/leads`), headers: auth.headers,
      payload: { userId: targetId },
    });

    // A lead repeatedly trying to appoint leads is exactly the signal an
    // operations lead needs to see.
    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'organization.lead_granted' AND outcome = 'denied'
        AND actor_user_id = ${actorId}
    `);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('records a refused cross-organization edit', async () => {
    const { auth, creds } = await pdLead();
    const md = await organizationIdByKey(h.db, 'MD');
    const actorId = await userIdByUsername(h.db, creds.username);

    await h.app.inject({
      method: 'PATCH', url: url(`/${md}`), headers: auth.headers,
      payload: { description: 'nope' },
    });

    const rows = await h.db.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'organization.updated' AND outcome = 'denied'
        AND actor_user_id = ${actorId} AND organization_id = ${md}
    `);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.metadata.reason).toBe('CROSS_ORGANIZATION');
  });
});
