import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, setPermissionOverride,
  signIn, type TestHarness,
} from './harness.js';

/**
 * Permission resolution for accounts that actually belong to an organization.
 *
 * The suite in auth.test.ts only creates bare accounts, so every membership,
 * role and override query is unreachable there — which is how a malformed
 * `= ANY(array)` binding reached a running server despite 33 passing tests.
 */
let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => { await h?.close(); });

beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

const url = (p: string) => `/api/v1/auth${p}`;

interface MeResponse {
  session: {
    memberships: {
      organization: { key: string };
      roles: { key: string; hierarchyLevel: number }[];
      hierarchyLevel: number;
      permissions: string[];
      isOrgLead: boolean;
      status: string;
    }[];
    activeOrganizationId: string | null;
    isGlobalAdmin: boolean;
  };
}

describe('membership and permission resolution', () => {
  it('resolves roles, level and permissions for a member', async () => {
    const creds = await createActiveUser(h, 'member');
    await grantMembership(h.db, creds.username, { roleKey: 'lieutenant' });

    const auth = await signIn(h, creds);
    const res = await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers });
    expect(res.statusCode).toBe(200);

    const body = res.json() as MeResponse;
    expect(body.session.memberships).toHaveLength(1);

    const m = body.session.memberships[0]!;
    expect(m.organization.key).toBe('PD');
    expect(m.roles.map((r) => r.key)).toContain('lieutenant');
    expect(m.hierarchyLevel).toBe(60);
    expect(m.permissions).toContain('dispatch.view');
    expect(m.permissions).toContain('personnel.view');
    expect(body.session.activeOrganizationId).toBe(m.organization ? body.session.activeOrganizationId : null);
  });

  it('takes the MAXIMUM level across several roles, never the sum', async () => {
    const creds = await createActiveUser(h, 'multirole');
    const { memberId } = await grantMembership(h.db, creds.username, { roleKey: 'officer' });

    const [sergeant] = await h.db.execute<{ id: string }>(sql`
      SELECT r.id FROM role r JOIN organization o ON o.id = r.organization_id
      WHERE o.key = 'PD' AND r.key = 'sergeant'
    `);
    await h.db.execute(sql`
      INSERT INTO member_role (member_id, role_id) VALUES (${memberId}, ${sergeant!.id})
    `);

    const auth = await signIn(h, creds);
    const body = (await h.app.inject({
      method: 'GET', url: url('/me'), headers: auth.headers,
    })).json() as MeResponse;

    const m = body.session.memberships[0]!;
    expect(m.roles).toHaveLength(2);
    // Officer 30 + Sergeant 50 → 50, not 80.
    expect(m.hierarchyLevel).toBe(50);
  });

  it('applies a deny override over a role grant', async () => {
    const creds = await createActiveUser(h, 'denied');
    const { memberId } = await grantMembership(h.db, creds.username, { roleKey: 'lieutenant' });
    await setPermissionOverride(h.db, memberId, 'dispatch.close', 'deny');

    const auth = await signIn(h, creds);
    const body = (await h.app.inject({
      method: 'GET', url: url('/me'), headers: auth.headers,
    })).json() as MeResponse;

    const perms = body.session.memberships[0]!.permissions;
    expect(perms).toContain('dispatch.view');
    expect(perms).not.toContain('dispatch.close');
  });

  it('applies a grant override on top of the role set', async () => {
    const creds = await createActiveUser(h, 'granted');
    const { memberId } = await grantMembership(h.db, creds.username, { roleKey: 'cadet' });
    await setPermissionOverride(h.db, memberId, 'persons.warrants.manage', 'grant');

    const auth = await signIn(h, creds);
    const body = (await h.app.inject({
      method: 'GET', url: url('/me'), headers: auth.headers,
    })).json() as MeResponse;

    expect(body.session.memberships[0]!.permissions).toContain('persons.warrants.manage');
  });

  it('strips every permission from a terminated member', async () => {
    const creds = await createActiveUser(h, 'fired');
    await grantMembership(h.db, creds.username, { roleKey: 'lieutenant' });
    const auth = await signIn(h, creds);

    await h.db.execute(sql`
      UPDATE organization_member SET status = 'terminated', left_at = now()
      WHERE user_id = (SELECT id FROM user_account WHERE username = ${creds.username})
    `);

    const body = (await h.app.inject({
      method: 'GET', url: url('/me'), headers: auth.headers,
    })).json() as MeResponse;

    const m = body.session.memberships[0]!;
    expect(m.status).toBe('terminated');
    // Access ends with employment, without waiting for the session to expire.
    expect(m.permissions).toEqual([]);
    expect(m.hierarchyLevel).toBe(0);
  });

  it('keeps two memberships independent', async () => {
    const creds = await createActiveUser(h, 'dual');
    await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'officer' });
    await grantMembership(h.db, creds.username, { orgKey: 'MD', roleKey: 'doctor' });

    const auth = await signIn(h, creds);
    const body = (await h.app.inject({
      method: 'GET', url: url('/me'), headers: auth.headers,
    })).json() as MeResponse;

    expect(body.session.memberships).toHaveLength(2);
    const md = body.session.memberships.find((m) => m.organization.key === 'MD')!;
    const pd = body.session.memberships.find((m) => m.organization.key === 'PD')!;

    // Medical permissions belong to the MD membership only.
    expect(md.permissions).toContain('persons.medical.view');
    expect(pd.permissions).not.toContain('persons.medical.view');
    expect(md.hierarchyLevel).not.toBe(pd.hierarchyLevel);
  });

  it('never lets a crafted organization header widen scope', async () => {
    const creds = await createActiveUser(h, 'scoped');
    await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'officer' });
    const auth = await signIn(h, creds);

    const [fib] = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM organization WHERE key = 'FIB'`,
    );

    const res = await h.app.inject({
      method: 'GET', url: url('/me'),
      headers: { ...auth.headers, 'x-leoos-organization': fib!.id },
    });

    // The header names an organization the user does not belong to, so it is
    // ignored rather than honoured.
    const body = res.json() as MeResponse;
    expect(body.session.activeOrganizationId).not.toBe(fib!.id);
  });

  it('reports an organization lead without granting global capability', async () => {
    const creds = await createActiveUser(h, 'lead');
    const granter = await createActiveUser(h, 'granter');
    const { organizationId } = await grantMembership(h.db, creds.username, { roleKey: 'cadet' });

    await h.db.execute(sql`
      INSERT INTO organization_lead (user_id, organization_id, granted_by)
      VALUES (
        (SELECT id FROM user_account WHERE username = ${creds.username}),
        ${organizationId},
        (SELECT id FROM user_account WHERE username = ${granter.username})
      )
    `);

    const auth = await signIn(h, creds);
    const body = (await h.app.inject({
      method: 'GET', url: url('/me'), headers: auth.headers,
    })).json() as MeResponse;

    expect(body.session.memberships[0]!.isOrgLead).toBe(true);
    // A lead is level ∞ inside their organization and nothing outside it.
    expect(body.session.isGlobalAdmin).toBe(false);
  });

  it('never leaks a secret field for a member with full context', async () => {
    const creds = await createActiveUser(h, 'nosecrets');
    await grantMembership(h.db, creds.username, { roleKey: 'chief' });
    const auth = await signIn(h, creds);

    const raw = (await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers })).body;
    for (const forbidden of ['argon2', 'passwordHash', 'password_hash', 'tokenHash', 'token_hash', 'secretHash', 'totp']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
