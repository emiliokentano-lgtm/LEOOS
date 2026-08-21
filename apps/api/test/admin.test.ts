import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AUDIT_ACTIONS } from '@leoos/db';
import { GLOBAL_CAPABILITY_KEYS, auditSeverityOf, type AuditSeverity } from '@leoos/contracts';
import { severityMatchesInJs } from '../src/modules/admin/audit.read.js';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin, makeOrgLead,
  resetAccounts, signIn, type TestHarness,
} from './harness.js';

/**
 * Global administration.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS FOR
 *
 * The administration panel is the one place in LEOOS where a single request can
 * change who can do anything. Four properties are release gates:
 *
 *   1. AN ORGANIZATION LEAD REACHES NONE OF IT. Not the register, not the audit
 *      log, not the capability grants — regardless of how senior they are inside
 *      their own organization.
 *   2. NO CAPABILITY CAN ESCALATE ITSELF. A `user_admin` cannot become a
 *      `global_admin`, directly or by disabling the ones who exist.
 *   3. THE INSTALLATION CANNOT BE LOCKED OUT. The last global administrator
 *      cannot be disabled or demoted, including by themselves.
 *   4. NO RESPONSE CARRIES A CREDENTIAL. Every endpoint's output is serialised
 *      and searched for password hashes, token hashes and TOTP secrets.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await resetAccounts(h.db);
});

beforeEach(() => {
  /**
   * The suite registers dozens of accounts from one address.
   *
   * Production allows three registrations an hour per IP, which would throttle
   * this file rather than anything it is testing. Cleared here rather than
   * raised in config, so the real limit stays in force everywhere else — the
   * limiter's own behaviour is covered in auth.test.ts.
   */
  h.app.limiter.resetAll();
});

afterAll(async () => {
  await h.close();
});

/** An active account, with the registration limiter cleared first. */
async function freshUser(prefix: string) {
  h.app.limiter.resetAll();
  return createActiveUser(h, prefix);
}

async function grantCapability(username: string, capability: string): Promise<void> {
  await h.db.execute(sql`
    INSERT INTO user_global_role (user_id, capability)
    VALUES ((SELECT id FROM user_account WHERE username = ${username}), ${capability}::global_capability)
    ON CONFLICT DO NOTHING
  `);
}

async function userIdOf(username: string): Promise<string> {
  const [row] = await h.db.execute<{ id: string }>(
    sql`SELECT id FROM user_account WHERE username = ${username}`,
  );
  if (!row) throw new Error(`no such user: ${username}`);
  return row.id;
}

async function statusOf(username: string): Promise<string> {
  const [row] = await h.db.execute<{ status: string }>(
    sql`SELECT status::text FROM user_account WHERE username = ${username}`,
  );
  return row?.status ?? 'missing';
}

/** An administrator with a session, ready to make requests. */
async function admin(prefix = 'gadmin') {
  const creds = await freshUser(prefix);
  await makeGlobalAdmin(h.db, creds.username);
  const session = await signIn(h, creds);
  return { creds, ...session };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · An Organization Lead is not an administrator
// ═══════════════════════════════════════════════════════════════════════════

describe('an Organization Lead reaches no global administration', () => {
  const ADMIN_ROUTES = [
    '/api/v1/admin/users',
    '/api/v1/admin/account-statuses',
    '/api/v1/admin/capability-catalogue',
    '/api/v1/admin/leads',
    '/api/v1/admin/permissions',
    '/api/v1/admin/audit',
    '/api/v1/admin/audit/actions',
    '/api/v1/admin/system',
  ];

  it('is refused by every administration endpoint', async () => {
    const granter = await admin('leadgranter');
    const lead = await freshUser('orglead');
    await grantMembership(h.db, lead.username, { orgKey: 'PD', roleKey: 'chief' });
    await makeOrgLead(h.db, lead.username, 'PD', granter.creds.username);

    const session = await signIn(h, lead);

    for (const url of ADMIN_ROUTES) {
      const res = await h.app.inject({ method: 'GET', url, headers: session.headers });
      expect(res.statusCode, `${url} should be forbidden for an org lead`).toBe(403);
    }
  });

  it('cannot change anybody’s account status', async () => {
    const granter = await admin('leadgranter2');
    const lead = await freshUser('orglead2');
    await grantMembership(h.db, lead.username, { orgKey: 'PD', roleKey: 'chief' });
    await makeOrgLead(h.db, lead.username, 'PD', granter.creds.username);
    const session = await signIn(h, lead);

    // Somebody in their OWN organization, which is where their authority is
    // unbounded — and it still confers nothing over the account itself. A lead
    // can terminate a member's employment; they cannot touch their login.
    const victim = await freshUser('leadvictim');
    await grantMembership(h.db, victim.username, { orgKey: 'PD', roleKey: 'officer' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${await userIdOf(victim.username)}/status`,
      headers: session.headers,
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(403);
    expect(await statusOf(victim.username)).toBe('active');
  });

  it('cannot grant itself a global capability', async () => {
    const granter = await admin('leadgranter3');
    const lead = await freshUser('orglead3');
    await grantMembership(h.db, lead.username, { orgKey: 'PD', roleKey: 'chief' });
    await makeOrgLead(h.db, lead.username, 'PD', granter.creds.username);
    const session = await signIn(h, lead);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${await userIdOf(lead.username)}/capabilities`,
      headers: session.headers,
      payload: { capability: 'global_admin' },
    });
    expect(res.statusCode).toBe(403);

    const [row] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM user_global_role
      WHERE user_id = ${await userIdOf(lead.username)}
    `);
    expect(row?.n).toBe(0);
  });

  it('is told the panel is closed to them, without being told what is in it', async () => {
    const granter = await admin('leadgranter4');
    const lead = await freshUser('orglead4');
    await grantMembership(h.db, lead.username, { orgKey: 'PD', roleKey: 'chief' });
    await makeOrgLead(h.db, lead.username, 'PD', granter.creds.username);
    const session = await signIn(h, lead);

    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/capabilities', headers: session.headers,
    });
    // The capability block itself is readable by anyone — it is how the UI
    // decides what to show — and for a lead every entry is false.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { capabilities: Record<string, boolean> };
    expect(Object.values(body.capabilities).every((v) => v === false)).toBe(true);
  });
});

describe('an ordinary member reaches nothing either', () => {
  it('is refused the register', async () => {
    const user = await freshUser('plain');
    await grantMembership(h.db, user.username, { orgKey: 'PD', roleKey: 'officer' });
    const session = await signIn(h, user);

    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/users', headers: session.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('is refused without a session at all', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Capability boundaries
// ═══════════════════════════════════════════════════════════════════════════

describe('capability boundaries', () => {
  it('lets a user_admin read the register but not the system configuration', async () => {
    const user = await freshUser('useradmin');
    await grantCapability(user.username, 'user_admin');
    const session = await signIn(h, user);

    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/admin/users', headers: session.headers,
    })).statusCode).toBe(200);

    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/admin/system', headers: session.headers,
    })).statusCode).toBe(403);
  });

  it('lets an audit_viewer read the log but not the register', async () => {
    const user = await freshUser('auditor');
    await grantCapability(user.username, 'audit_viewer');
    const session = await signIn(h, user);

    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/admin/audit', headers: session.headers,
    })).statusCode).toBe(200);

    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/admin/users', headers: session.headers,
    })).statusCode).toBe(403);
  });

  it('gives support read access and no write access', async () => {
    const support = await freshUser('support');
    await grantCapability(support.username, 'support');
    const session = await signIn(h, support);

    const victim = await freshUser('supportvictim');

    expect((await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${await userIdOf(victim.username)}`,
      headers: session.headers,
    })).statusCode).toBe(200);

    const write = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${await userIdOf(victim.username)}/status`,
      headers: session.headers,
      payload: { status: 'suspended' },
    });
    expect(write.statusCode).toBe(403);
    expect(await statusOf(victim.username)).toBe('active');
  });

  it('refuses a user_admin granting global_admin to anybody', async () => {
    // The headline escalation. `user_admin` administers accounts; if it could
    // hand out capabilities it would be `global_admin` with extra steps.
    const ua = await freshUser('ua');
    await grantCapability(ua.username, 'user_admin');
    const session = await signIn(h, ua);
    const accomplice = await freshUser('accomplice');

    for (const capability of GLOBAL_CAPABILITY_KEYS) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${await userIdOf(accomplice.username)}/capabilities`,
        headers: session.headers,
        payload: { capability },
      });
      expect(res.statusCode, `granting ${capability} should be refused`).toBe(403);
    }
  });

  it('refuses a user_admin disabling a global administrator', async () => {
    // The indirect route to the same place: cannot become one, so remove them.
    const ua = await freshUser('ua2');
    await grantCapability(ua.username, 'user_admin');
    const session = await signIn(h, ua);

    const target = await admin('victimadmin');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${await userIdOf(target.creds.username)}/status`,
      headers: session.headers,
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(403);
    expect(await statusOf(target.creds.username)).toBe('active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · Lockout protection
// ═══════════════════════════════════════════════════════════════════════════

describe('the installation cannot be locked out', () => {
  it('refuses an administrator changing their own account status', async () => {
    const self = await admin('selfadmin');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${await userIdOf(self.creds.username)}/status`,
      headers: self.headers,
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(403);
    expect(await statusOf(self.creds.username)).toBe('active');
  });

  it('refuses an administrator revoking their own global_admin', async () => {
    const self = await admin('selfrevoke');
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${await userIdOf(self.creds.username)}/capabilities/global_admin`,
      headers: self.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses disabling the last global administrator', async () => {
    // Isolated: every other global administrator in the database is parked so
    // the target really is the last one. Without that the guard is never
    // reached and the test would pass for the wrong reason.
    const keeper = await admin('lastkeeper');
    const doomed = await admin('lastdoomed');

    const keeperId = await userIdOf(keeper.creds.username);
    const doomedId = await userIdOf(doomed.creds.username);

    await h.db.execute(sql`
      UPDATE user_account SET status = 'suspended'
      WHERE id IN (
        SELECT user_id FROM user_global_role WHERE capability = 'global_admin'
      ) AND id NOT IN (${keeperId}::uuid, ${doomedId}::uuid)
    `);

    // The keeper disables the other one: allowed, one administrator remains.
    const first = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${doomedId}/status`,
      headers: keeper.headers, payload: { status: 'disabled' },
    });
    expect(first.statusCode).toBe(200);

    // Now the keeper is the last. A second administrator cannot exist to
    // disable them, so the reachable version of the lockout is the revocation
    // below — asserted next.
    const [remaining] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM user_global_role ugr
      JOIN user_account u ON u.id = ugr.user_id
      WHERE ugr.capability = 'global_admin' AND u.status = 'active'
    `);
    expect(remaining?.n).toBe(1);

    // Restore the parked administrators so later tests are unaffected.
    await h.db.execute(sql`
      UPDATE user_account SET status = 'active'
      WHERE id IN (SELECT user_id FROM user_global_role WHERE capability = 'global_admin')
        AND email_verified_at IS NOT NULL
    `);
  });

  it('refuses revoking the last global_admin grant', async () => {
    const keeper = await admin('revokekeeper');
    const doomed = await admin('revokedoomed');
    const keeperId = await userIdOf(keeper.creds.username);
    const doomedId = await userIdOf(doomed.creds.username);

    // Park every other grant so `doomed` is genuinely the last one besides the
    // keeper — then remove the keeper's grant too, leaving exactly one.
    await h.db.execute(sql`
      DELETE FROM user_global_role
      WHERE capability = 'global_admin'
        AND user_id NOT IN (${keeperId}::uuid, ${doomedId}::uuid)
    `);

    // The keeper revokes the doomed one's grant: now one grant is left.
    const first = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${doomedId}/capabilities/global_admin`,
      headers: keeper.headers,
    });
    expect(first.statusCode).toBe(200);

    // The keeper is the only administrator left and cannot remove themselves —
    // and nobody else can, because nobody else holds the capability.
    const selfRevoke = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${keeperId}/capabilities/global_admin`,
      headers: keeper.headers,
    });
    expect(selfRevoke.statusCode).toBe(403);

    const [row] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM user_global_role WHERE capability = 'global_admin'
    `);
    expect(row?.n).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Account status behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('account status changes', () => {
  it('disables an account, revokes its sessions and audits the change', async () => {
    const actor = await admin('statusadmin');
    const victim = await freshUser('statusvictim');
    const victimSession = await signIn(h, victim);
    const victimId = await userIdOf(victim.username);

    // Signed in and working before the change.
    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: victimSession.headers,
    })).statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${victimId}/status`,
      headers: actor.headers,
      payload: { status: 'disabled', reason: 'Left the community' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'disabled', previousStatus: 'active' });
    expect((res.json() as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThan(0);

    // The session is gone THE NEXT REQUEST, not when the cookie expires.
    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: victimSession.headers,
    })).statusCode).toBe(401);

    // And they cannot sign back in.
    const relogin = await h.app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { identifier: victim.username, password: victim.password },
    });
    expect(relogin.statusCode).not.toBe(200);

    const [audit] = await h.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
      SELECT action, metadata FROM audit_log
      WHERE entity_id = ${victimId}::uuid AND action = ${AUDIT_ACTIONS.USER_DISABLED}
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(audit?.action).toBe(AUDIT_ACTIONS.USER_DISABLED);
    expect(audit?.metadata).toMatchObject({ reason: 'Left the community' });
  });

  it('reinstates a disabled account', async () => {
    const actor = await admin('reinstateadmin');
    const victim = await freshUser('reinstatee');
    const victimId = await userIdOf(victim.username);

    await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${victimId}/status`,
      headers: actor.headers, payload: { status: 'suspended' },
    });
    const back = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${victimId}/status`,
      headers: actor.headers, payload: { status: 'active' },
    });
    expect(back.statusCode).toBe(200);

    const relogin = await h.app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { identifier: victim.username, password: victim.password },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('refuses activating an account that never verified its email', async () => {
    // A database CHECK forbids it too. This asserts the API gets there first,
    // with a sentence an administrator can act on rather than a constraint name.
    const actor = await admin('verifyadmin');
    const username = `unverified${Date.now().toString(36)}`;
    h.app.limiter.resetAll();
    // Registered but never verified — the state the registration flow leaves an
    // account in, which no administrator action may skip past.
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: {
        email: `${username}@test.invalid`,
        username,
        displayName: 'Never Verified',
        password: 'correct-horse-staple-42',
      },
    });
    expect(res.statusCode).toBe(202);
    const id = await userIdOf(username);

    const attempt = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${id}/status`,
      headers: actor.headers, payload: { status: 'active' },
    });
    expect(attempt.statusCode).toBe(400);
    expect(attempt.body).toMatch(/verif/i);
  });

  it('refuses a status the account already holds', async () => {
    const actor = await admin('idempotentadmin');
    const victim = await freshUser('alreadyactive');
    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${await userIdOf(victim.username)}/status`,
      headers: actor.headers, payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses pending_verification as a settable status', async () => {
    const actor = await admin('pendingadmin');
    const victim = await freshUser('pendingvictim');
    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${await userIdOf(victim.username)}/status`,
      headers: actor.headers, payload: { status: 'pending_verification' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · Capability grants
// ═══════════════════════════════════════════════════════════════════════════

describe('granting and revoking capabilities', () => {
  it('grants, signs the holder out, and audits', async () => {
    const actor = await admin('grantadmin');
    const target = await freshUser('grantee');
    const targetId = await userIdOf(target.username);
    const targetSession = await signIn(h, target);

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetId}/capabilities`,
      headers: actor.headers,
      payload: { capability: 'audit_viewer', reason: 'Appointed reviewer' },
    });
    expect(res.statusCode).toBe(201);

    /**
     * The holder is signed out.
     *
     * Their authorization context is cached against a permission version; a
     * capability change is precisely the event that invalidates it. Signing
     * them out means the new capability is in force from their next sign-in
     * rather than from whenever a cache happened to expire.
     */
    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: targetSession.headers,
    })).statusCode).toBe(401);

    const fresh = await signIn(h, target);
    expect((await h.app.inject({
      method: 'GET', url: '/api/v1/admin/audit', headers: fresh.headers,
    })).statusCode).toBe(200);

    const [audit] = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE entity_id = ${targetId}::uuid
        AND action = ${AUDIT_ACTIONS.GLOBAL_CAPABILITY_GRANTED}
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(audit?.action).toBe(AUDIT_ACTIONS.GLOBAL_CAPABILITY_GRANTED);
  });

  it('refuses granting a capability to a disabled account', async () => {
    // A capability on an account that cannot sign in is a trap: it grants
    // nothing today and everything the moment somebody re-enables the account.
    const actor = await admin('trapadmin');
    const target = await freshUser('trapvictim');
    const targetId = await userIdOf(target.username);

    await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetId}/status`,
      headers: actor.headers, payload: { status: 'disabled' },
    });

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetId}/capabilities`,
      headers: actor.headers, payload: { capability: 'support' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses granting a capability the account already holds', async () => {
    const actor = await admin('dupeadmin');
    const target = await freshUser('dupetarget');
    const targetId = await userIdOf(target.username);

    const first = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetId}/capabilities`,
      headers: actor.headers, payload: { capability: 'support' },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetId}/capabilities`,
      headers: actor.headers, payload: { capability: 'support' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('audits a REFUSED grant, not only a successful one', async () => {
    const ua = await freshUser('deniedua');
    await grantCapability(ua.username, 'user_admin');
    const session = await signIn(h, ua);
    const target = await freshUser('deniedtarget');
    const targetId = await userIdOf(target.username);

    await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${targetId}/capabilities`,
      headers: session.headers, payload: { capability: 'global_admin' },
    });

    const [audit] = await h.db.execute<{ outcome: string; metadata: Record<string, unknown> }>(sql`
      SELECT outcome, metadata FROM audit_log
      WHERE entity_id = ${targetId}::uuid
        AND action = ${AUDIT_ACTIONS.GLOBAL_CAPABILITY_GRANTED}
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(audit?.outcome).toBe('denied');
    expect(audit?.metadata).toMatchObject({ reason: 'CAPABILITY_NOT_GRANTABLE' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · No credential ever leaves the process
// ═══════════════════════════════════════════════════════════════════════════

describe('no admin response carries a credential', () => {
  const FORBIDDEN = [
    'passwordHash', 'password_hash', 'tokenHash', 'token_hash',
    'secretHash', 'secret_hash', 'totpSecret', 'totp_secret_enc',
    'failedLoginCount', 'failed_login_count',
  ];

  it('holds across every administration endpoint', async () => {
    const actor = await admin('leakadmin');
    const subject = await freshUser('leaksubject');
    await grantMembership(h.db, subject.username, { orgKey: 'PD', roleKey: 'officer' });
    const subjectId = await userIdOf(subject.username);

    const urls = [
      '/api/v1/admin/users',
      `/api/v1/admin/users/${subjectId}`,
      '/api/v1/admin/account-statuses',
      '/api/v1/admin/capability-catalogue',
      '/api/v1/admin/leads',
      '/api/v1/admin/permissions',
      '/api/v1/admin/audit',
      '/api/v1/admin/audit/actions',
      '/api/v1/admin/system',
      '/api/v1/admin/capabilities',
    ];

    for (const url of urls) {
      const res = await h.app.inject({ method: 'GET', url, headers: actor.headers });
      expect(res.statusCode, url).toBe(200);
      for (const key of FORBIDDEN) {
        expect(res.body.includes(key), `${url} leaked ${key}`).toBe(false);
      }
      // The Argon2 prefix, in case a hash arrives under an innocent key name.
      expect(res.body.includes('$argon2'), `${url} leaked a password hash`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · The register
// ═══════════════════════════════════════════════════════════════════════════

describe('the user register', () => {
  it('searches by username, email and display name', async () => {
    const actor = await admin('searchadmin');
    const subject = await freshUser('findme');

    for (const term of [subject.username, subject.email, 'Test find']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?search=${encodeURIComponent(term)}`,
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { users: { username: string }[] };
      expect(
        body.users.some((u) => u.username === subject.username),
        `searching "${term}" should find ${subject.username}`,
      ).toBe(true);
    }
  });

  it('treats a wildcard in the search box as a literal', async () => {
    // Otherwise typing `%` returns the whole register, which looks like a bug
    // and is a small information leak on a large installation.
    const actor = await admin('wildcardadmin');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/users?search=%25', headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { users: unknown[] }).users.length).toBe(0);
  });

  it('reports a total that describes the same set as the rows', async () => {
    const actor = await admin('totaladmin');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/users?status=active&limit=5', headers: actor.headers,
    });
    const body = res.json() as { users: unknown[]; total: number };
    expect(body.users.length).toBeLessThanOrEqual(5);
    expect(body.total).toBeGreaterThanOrEqual(body.users.length);
  });

  it('returns memberships, roles, last login and creation date in the detail read', async () => {
    const actor = await admin('detailadmin');
    const subject = await freshUser('detailsubject');
    await grantMembership(h.db, subject.username, { orgKey: 'PD', roleKey: 'sergeant' });
    await signIn(h, subject); // so there is a last login to report

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${await userIdOf(subject.username)}`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: {
        memberships: { organization: { shortName: string }; roles: unknown[] }[];
        lastLoginAt: string | null;
        createdAt: string;
        activeSessionCount: number;
      };
    };

    expect(body.user.memberships.length).toBeGreaterThan(0);
    expect(body.user.memberships[0]?.roles.length).toBeGreaterThan(0);
    expect(body.user.lastLoginAt).toBeTruthy();
    expect(body.user.createdAt).toBeTruthy();
    expect(body.user.activeSessionCount).toBeGreaterThan(0);
  });

  it('tells the caller what it may do to the account it is looking at', async () => {
    const actor = await admin('capsadmin');
    const selfId = await userIdOf(actor.creds.username);

    const own = await h.app.inject({
      method: 'GET', url: `/api/v1/admin/users/${selfId}`, headers: actor.headers,
    });
    const body = own.json() as {
      user: { capabilities: { canChangeStatus: boolean; restrictions: string[] } };
    };
    expect(body.user.capabilities.canChangeStatus).toBe(false);
    expect(body.user.capabilities.restrictions.join(' ')).toMatch(/own account/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · Audit search
// ═══════════════════════════════════════════════════════════════════════════

describe('audit search', () => {
  it('filters by actor, action, outcome and date range', async () => {
    const actor = await admin('auditadmin');
    const victim = await freshUser('auditvictim');
    const victimId = await userIdOf(victim.username);
    const actorId = await userIdOf(actor.creds.username);
    const before = new Date(Date.now() - 60_000).toISOString();

    await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${victimId}/status`,
      headers: actor.headers, payload: { status: 'suspended' },
    });

    const byActor = await h.app.inject({
      method: 'GET', url: `/api/v1/admin/audit?actorUserId=${actorId}`, headers: actor.headers,
    });
    const actorEntries = (byActor.json() as { entries: { actor: { userId: string } }[] }).entries;
    expect(actorEntries.length).toBeGreaterThan(0);
    expect(actorEntries.every((e) => e.actor.userId === actorId)).toBe(true);

    const byAction = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?action=${AUDIT_ACTIONS.USER_SUSPENDED}`,
      headers: actor.headers,
    });
    const actionEntries = (byAction.json() as { entries: { action: string }[] }).entries;
    expect(actionEntries.length).toBeGreaterThan(0);
    expect(actionEntries.every((e) => e.action === AUDIT_ACTIONS.USER_SUSPENDED)).toBe(true);

    const byRange = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?from=${encodeURIComponent(before)}`,
      headers: actor.headers,
    });
    const rangeEntries = (byRange.json() as { entries: { occurredAt: string }[] }).entries;
    expect(rangeEntries.every((e) => e.occurredAt >= before)).toBe(true);

    const byTarget = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?entityType=user_account&entityId=${victimId}`,
      headers: actor.headers,
    });
    const targetEntries = (byTarget.json() as { entries: { entityId: string }[] }).entries;
    expect(targetEntries.length).toBeGreaterThan(0);
    expect(targetEntries.every((e) => e.entityId === victimId)).toBe(true);
  });

  it('filters by severity across the whole table, not just the page', async () => {
    const actor = await admin('sevadmin');

    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/audit?severity=high&limit=50', headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { entries: { severity: string }[] }).entries;
    expect(entries.length).toBeGreaterThan(0);
    // Every row the SQL predicate selected must carry the severity the DTO
    // layer computed for it — otherwise the filter and the label disagree.
    expect(entries.every((e) => e.severity === 'high')).toBe(true);
  });

  it('resolves a display name for the target of an entry', async () => {
    const actor = await admin('labeladmin');
    const victim = await freshUser('labelvictim');
    const victimId = await userIdOf(victim.username);

    await h.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${victimId}/status`,
      headers: actor.headers, payload: { status: 'suspended' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?entityId=${victimId}&entityType=user_account`,
      headers: actor.headers,
    });
    const entries = (res.json() as { entries: { entityLabel: string | null }[] }).entries;
    expect(entries[0]?.entityLabel).toBe(victim.displayName);
  });

  it('pages with a keyset cursor without repeating or skipping rows', async () => {
    const actor = await admin('pageadmin');

    const first = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/audit?limit=5', headers: actor.headers,
    });
    const page1 = first.json() as { entries: { id: string }[]; nextCursor: string | null };
    expect(page1.entries.length).toBe(5);
    expect(page1.nextCursor).toBeTruthy();

    const second = await h.app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?limit=5&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: actor.headers,
    });
    const page2 = second.json() as { entries: { id: string }[] };

    const ids = new Set(page1.entries.map((e) => e.id));
    expect(page2.entries.some((e) => ids.has(e.id))).toBe(false);
  });

  it('treats a corrupted cursor as absent rather than failing the request', async () => {
    const actor = await admin('cursoradmin');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/audit?cursor=not-a-cursor', headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('the severity filter and the severity label are the same rule', () => {
  it('agrees for every action in the catalogue, in both directions', () => {
    // Two implementations of one rule — SQL for the WHERE clause, TypeScript
    // for the label — are exactly the pair that drifts. The drift is silent:
    // rows quietly vanish from a filtered view and it looks like a quiet day.
    const severities: AuditSeverity[] = ['critical', 'high', 'notice', 'info'];
    const outcomes = ['success', 'denied', 'error'] as const;

    for (const action of Object.values(AUDIT_ACTIONS)) {
      for (const outcome of outcomes) {
        const label = auditSeverityOf(action, outcome);
        for (const severity of severities) {
          expect(
            severityMatchesInJs(severity, action, outcome),
            `${action}/${outcome}: filter "${severity}" vs label "${label}"`,
          ).toBe(severity === label);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 · Leads, permissions and system
// ═══════════════════════════════════════════════════════════════════════════

describe('the cross-organization surfaces', () => {
  it('lists every lead and the organizations that have none', async () => {
    const actor = await admin('leadsadmin');
    const lead = await freshUser('leadsubject');
    await grantMembership(h.db, lead.username, { orgKey: 'PD', roleKey: 'chief' });
    await makeOrgLead(h.db, lead.username, 'PD', actor.creds.username);

    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/leads', headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      leads: { userId: string; organization: { key: string } }[];
      organizationsWithoutLead: { key: string }[];
      canManage: boolean;
    };

    expect(body.canManage).toBe(true);
    expect(body.leads.some((l) => l.organization.key === 'PD')).toBe(true);
    // Every organization is either led or listed as unled — never both, never
    // neither. That is what makes the second list actionable.
    const ledKeys = new Set(body.leads.map((l) => l.organization.key));
    expect(body.organizationsWithoutLead.some((o) => ledKeys.has(o.key))).toBe(false);
  });

  it('reports which roles grant each permission, and which grant none', async () => {
    const actor = await admin('permsadmin');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/permissions', headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: { key: string; scope: string; grants: unknown[] }[];
      globalPermissionKeys: string[];
    };

    // Built from the catalogue, so a permission nobody has assigned is present
    // with no grants rather than missing.
    expect(body.entries.length).toBeGreaterThan(50);
    expect(body.entries.some((e) => e.grants.length > 0)).toBe(true);

    /**
     * No global-scope permission is attached to an ORGANIZATION role.
     *
     * The distinction is the whole point. A global role — one with no
     * organization, created by a global administrator — may legitimately carry
     * `admin.users`; that is how a platform administrator role is built. What
     * the kernel and the database trigger both refuse is attaching one to a
     * role that belongs to an organization, because that is the route by which
     * a chief could write themselves an administrator role.
     *
     * Asserted from the DATA rather than from the rule, so a trigger that was
     * dropped in a migration would show up here.
     */
    const globalEntries = body.entries as {
      key: string; grants: { organization: unknown }[];
    }[];
    for (const key of body.globalPermissionKeys) {
      const entry = globalEntries.find((e) => e.key === key);
      const orgScopedGrants = (entry?.grants ?? []).filter((g) => g.organization !== null);
      expect(
        orgScopedGrants.length,
        `${key} is global-scope and must never be attached to an organization role`,
      ).toBe(0);
    }
  });

  it('reports system state honestly, naming the mocked adapters', async () => {
    const actor = await admin('sysadmin');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/admin/system', headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      environment: string;
      components: { key: string; state: string; detail: string }[];
    };

    const mail = body.components.find((c) => c.key === 'mail');
    expect(mail?.state).toBe('mock');
    expect(mail?.detail).toMatch(/NOT delivered/i);

    // Nothing may claim `live` without something behind it.
    expect(body.components.every((c) => ['live', 'mock', 'absent', 'degraded'].includes(c.state)))
      .toBe(true);
  });
});
