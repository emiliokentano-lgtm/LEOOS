import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, userAccount } from '@leoos/db';
import {
  CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, cookiesFrom, createActiveUser,
  createHarness, resetAccounts, setAccountStatus, signIn, uniqueUser, type TestHarness,
} from './harness.js';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await resetAccounts(h.db);
  h.mail.clear();
  // Every test registers from the same IP, so the production limits would
  // throttle the suite itself. Cleared here rather than raised in config, so the
  // real limits stay under test — see the dedicated rate-limit case below.
  h.app.limiter.resetAll();
});

const url = (path: string) => `/api/v1/auth${path}`;

// ═══════════════════════════════════════════════════════════════════════════
describe('registration', () => {
  it('accepts a valid registration and creates an unprivileged account', async () => {
    const creds = uniqueUser('reg');
    const res = await h.app.inject({ method: 'POST', url: url('/register'), payload: creds });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true });

    const rows = await h.db
      .select()
      .from(userAccount)
      .where(eq(userAccount.email, creds.email));

    expect(rows).toHaveLength(1);
    const account = rows[0]!;

    // New accounts start with the lowest possible privilege: unverified, no
    // membership, no role, no global capability.
    expect(account.status).toBe('pending_verification');
    expect(account.emailVerifiedAt).toBeNull();

    const memberships = await h.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM organization_member WHERE user_id = ${account.id}`,
    );
    expect(memberships[0]?.count).toBe(0);

    const globals = await h.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM user_global_role WHERE user_id = ${account.id}`,
    );
    expect(globals[0]?.count).toBe(0);
  });

  it('never stores the password in plaintext', async () => {
    const creds = uniqueUser('hash');
    await h.app.inject({ method: 'POST', url: url('/register'), payload: creds });

    const rows = await h.db.select().from(userAccount).where(eq(userAccount.email, creds.email));
    const stored = rows[0]!.passwordHash;

    expect(stored).not.toContain(creds.password);
    expect(stored).toMatch(/^\$argon2id\$/);

    // And it must not have leaked into the audit trail either.
    const audits = await h.db.execute<{ hit: number }>(sql`
      SELECT count(*)::int AS hit FROM audit_log
      WHERE before::text LIKE ${'%' + creds.password + '%'}
         OR after::text  LIKE ${'%' + creds.password + '%'}
         OR metadata::text LIKE ${'%' + creds.password + '%'}
    `);
    expect(audits[0]?.hit).toBe(0);
  });

  it('does not disclose that an account already exists', async () => {
    const creds = uniqueUser('dup');
    const first = await h.app.inject({ method: 'POST', url: url('/register'), payload: creds });
    expect(first.statusCode).toBe(202);

    const second = await h.app.inject({
      method: 'POST',
      url: url('/register'),
      payload: { ...creds, username: `${creds.username}b`, password: 'a-different-passphrase-99' },
    });

    // Identical status and shape — a different response here would be an
    // account-enumeration oracle.
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ accepted: true });

    // Exactly one account exists, and the duplicate attempt was audited.
    const rows = await h.db.select().from(userAccount).where(eq(userAccount.email, creds.email));
    expect(rows).toHaveLength(1);

    const denied = await h.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM audit_log
      WHERE action = 'user.created' AND outcome = 'denied'
    `);
    expect(denied[0]!.count).toBeGreaterThan(0);
  });

  it('rejects a weak or breached password', async () => {
    const weak = await h.app.inject({
      method: 'POST', url: url('/register'),
      payload: { ...uniqueUser('weak'), password: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    const breached = await h.app.inject({
      method: 'POST', url: url('/register'),
      payload: { ...uniqueUser('breach'), password: 'correcthorsebatterystaple' },
    });
    expect(breached.statusCode).toBe(400);
    expect(JSON.stringify(breached.json())).toMatch(/breach/i);
  });

  it('rejects a password containing the username', async () => {
    const creds = uniqueUser('selfref');
    const res = await h.app.inject({
      method: 'POST', url: url('/register'),
      payload: { ...creds, password: `${creds.username}-padding-xyz` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('login', () => {
  it('signs in with valid credentials and sets a session cookie', async () => {
    const creds = await createActiveUser(h, 'login');
    const res = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: creds.password },
    });

    expect(res.statusCode).toBe(200);
    const jar = cookiesFrom(res.headers);
    expect(jar[SESSION_COOKIE]).toBeTruthy();
    expect(jar[CSRF_COOKIE]).toBeTruthy();

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const body = res.json() as { session: { user: { username: string }; memberships: unknown[] } };
    expect(body.session.user.username).toBe(creds.username);
    expect(body.session.memberships).toEqual([]);
  });

  it('accepts either username or email as the identifier', async () => {
    const creds = await createActiveUser(h, 'ident');
    for (const identifier of [creds.username, creds.email]) {
      const res = await h.app.inject({
        method: 'POST', url: url('/login'), payload: { identifier, password: creds.password },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('never returns the password hash', async () => {
    const creds = await createActiveUser(h, 'nohash');
    const res = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: creds.password },
    });
    const raw = res.body;
    expect(raw).not.toMatch(/argon2/i);
    expect(raw).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash/);
  });

  it('refuses an invalid password with a generic message', async () => {
    const creds = await createActiveUser(h, 'badpw');
    const res = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: 'definitely-not-the-password' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    // Must not say which half was wrong.
    expect(body.error.message).toMatch(/incorrect username or password/i);
    expect(body.error.message).not.toMatch(/no such|not found|does not exist|unknown|disabled|locked/i);
  });

  it('gives an identical response for an unknown account', async () => {
    const creds = await createActiveUser(h, 'known');
    const wrongPassword = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: 'wrong-password-here' },
    });
    const unknownUser = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: 'nobody-at-all-here', password: 'wrong-password-here' },
    });

    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownUser.json()).toEqual({
      ...(wrongPassword.json() as Record<string, unknown>),
      requestId: (unknownUser.json() as { requestId: string }).requestId,
    });
  });

  it('locks the account after repeated failures', async () => {
    const creds = await createActiveUser(h, 'lock');
    for (let i = 0; i < h.config.LOGIN_MAX_ATTEMPTS; i += 1) {
      // Lockout and rate limiting are two independent defences; the limiter
      // would otherwise stop this test before lockout is reached. The limiter
      // has its own test below.
      h.app.limiter.resetAll();
      await h.app.inject({
        method: 'POST', url: url('/login'),
        payload: { identifier: creds.email, password: `wrong-${i}-attempt` },
      });
    }
    const rows = await h.db.select().from(userAccount).where(eq(userAccount.email, creds.email));
    expect(rows[0]!.lockedUntil).not.toBeNull();

    // Even the CORRECT password is refused while locked.
    const res = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.email, password: creds.password },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rate-limits repeated attempts against one identifier', async () => {
    const creds = await createActiveUser(h, 'ratelimit');
    let sawLimit = false;
    for (let i = 0; i < 8; i += 1) {
      const res = await h.app.inject({
        method: 'POST', url: url('/login'),
        payload: { identifier: creds.username, password: `nope-${i}` },
      });
      if (res.statusCode === 429) {
        sawLimit = true;
        expect(res.headers['retry-after']).toBeTruthy();
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it('rotates the session identifier on login (session fixation)', async () => {
    const creds = await createActiveUser(h, 'fixation');
    const first = await signIn(h, creds);
    const second = await signIn(h, creds);
    expect(first.jar[SESSION_COOKIE]).not.toBe(second.jar[SESSION_COOKIE]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('account status', () => {
  it('refuses login to an unverified account', async () => {
    const creds = uniqueUser('unverified');
    await h.app.inject({ method: 'POST', url: url('/register'), payload: creds });
    const res = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: creds.password },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('refuses login to a disabled account', async () => {
    const creds = await createActiveUser(h, 'disabled');
    await setAccountStatus(h.db, creds.email, 'disabled');

    const res = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: creds.password },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ACCOUNT_UNAVAILABLE');
    expect(body.error.message).toMatch(/not available/i);
  });

  it('invalidates a live session when the account is suspended', async () => {
    const creds = await createActiveUser(h, 'suspend');
    const auth = await signIn(h, creds);

    const before = await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers });
    expect(before.statusCode).toBe(200);

    await setAccountStatus(h.db, creds.email, 'suspended');

    // The existing cookie must stop working immediately — not at expiry.
    const after = await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers });
    expect(after.statusCode).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('logout and protected endpoints', () => {
  it('reaches a protected endpoint with a session and not without', async () => {
    const creds = await createActiveUser(h, 'protected');
    const auth = await signIn(h, creds);

    const withSession = await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers });
    expect(withSession.statusCode).toBe(200);

    const without = await h.app.inject({ method: 'GET', url: url('/me') });
    expect(without.statusCode).toBe(401);
    expect((without.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged session token', async () => {
    const res = await h.app.inject({
      method: 'GET', url: url('/me'),
      headers: { cookie: `${SESSION_COOKIE}=${'a'.repeat(43)}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logs out and invalidates the session immediately', async () => {
    const creds = await createActiveUser(h, 'logout');
    const auth = await signIn(h, creds);

    const out = await h.app.inject({ method: 'POST', url: url('/logout'), headers: auth.headers });
    expect(out.statusCode).toBe(200);

    const after = await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers });
    expect(after.statusCode).toBe(401);

    // The row is retained with a revocation reason rather than deleted, so the
    // audit trail can show when and why access ended.
    const revoked = await h.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM "session"
      WHERE revoked_at IS NOT NULL AND revoked_reason = 'logout'
    `);
    expect(revoked[0]!.count).toBeGreaterThan(0);
  });

  it('treats logout without a session as success', async () => {
    const res = await h.app.inject({ method: 'POST', url: url('/logout') });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a state-changing request whose CSRF header does not match', async () => {
    const creds = await createActiveUser(h, 'csrf');
    const auth = await signIn(h, creds);

    const res = await h.app.inject({
      method: 'POST', url: url('/sessions/revoke-others'),
      headers: { cookie: auth.headers.cookie, [CSRF_HEADER]: 'not-the-right-token' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
  });

  it('rejects a state-changing request from a foreign origin', async () => {
    const creds = await createActiveUser(h, 'origin');
    const auth = await signIn(h, creds);

    const res = await h.app.inject({
      method: 'POST', url: url('/sessions/revoke-others'),
      headers: { ...auth.headers, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ORIGIN_REJECTED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('password reset flow', () => {
  it('completes the full reset flow and revokes existing sessions', async () => {
    const creds = await createActiveUser(h, 'reset');
    const auth = await signIn(h, creds);

    const request = await h.app.inject({
      method: 'POST', url: url('/password/forgot'), payload: { email: creds.email },
    });
    expect(request.statusCode).toBe(200);
    const token = (request.json() as { devResetToken?: string }).devResetToken;
    expect(token).toBeTruthy();

    // The mail went out through the transport, which reports it delivers nothing.
    expect(h.mail.lastTo(creds.email)).toBeTruthy();
    expect(h.mail.delivers).toBe(false);

    const newPassword = 'a-brand-new-passphrase-77';
    const reset = await h.app.inject({
      method: 'POST', url: url('/password/reset'), payload: { token, newPassword },
    });
    expect(reset.statusCode).toBe(200);

    // Old password no longer works.
    const oldPw = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: creds.password },
    });
    expect(oldPw.statusCode).toBe(401);

    // New password does.
    const newPw = await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: newPassword },
    });
    expect(newPw.statusCode).toBe(200);

    // The session held before the reset is dead — otherwise a reset triggered by
    // a compromise would leave the attacker signed in.
    const stale = await h.app.inject({ method: 'GET', url: url('/me'), headers: auth.headers });
    expect(stale.statusCode).toBe(401);
  });

  it('cannot reuse a reset token', async () => {
    const creds = await createActiveUser(h, 'reuse');
    const request = await h.app.inject({
      method: 'POST', url: url('/password/forgot'), payload: { email: creds.email },
    });
    const token = (request.json() as { devResetToken: string }).devResetToken;

    const first = await h.app.inject({
      method: 'POST', url: url('/password/reset'),
      payload: { token, newPassword: 'first-new-passphrase-11' },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: 'POST', url: url('/password/reset'),
      payload: { token, newPassword: 'second-new-passphrase-22' },
    });
    expect(second.statusCode).toBe(400);
  });

  it('invalidates an earlier token when a new one is requested', async () => {
    const creds = await createActiveUser(h, 'reissue');
    const first = await h.app.inject({
      method: 'POST', url: url('/password/forgot'), payload: { email: creds.email },
    });
    const firstToken = (first.json() as { devResetToken: string }).devResetToken;

    await h.app.inject({
      method: 'POST', url: url('/password/forgot'), payload: { email: creds.email },
    });

    const res = await h.app.inject({
      method: 'POST', url: url('/password/reset'),
      payload: { token: firstToken, newPassword: 'superseded-passphrase-33' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not reveal whether the email exists', async () => {
    const creds = await createActiveUser(h, 'enum');
    const known = await h.app.inject({
      method: 'POST', url: url('/password/forgot'), payload: { email: creds.email },
    });
    const unknown = await h.app.inject({
      method: 'POST', url: url('/password/forgot'),
      payload: { email: 'nobody-here-at-all@test.invalid' },
    });

    expect(unknown.statusCode).toBe(known.statusCode);
    const knownBody = known.json() as Record<string, unknown>;
    const unknownBody = unknown.json() as Record<string, unknown>;
    expect(unknownBody.message).toBe(knownBody.message);
    expect(unknownBody.accepted).toBe(knownBody.accepted);
  });

  it('rejects a reset token that never existed', async () => {
    const res = await h.app.inject({
      method: 'POST', url: url('/password/reset'),
      payload: { token: 'x'.repeat(43), newPassword: 'irrelevant-passphrase-44' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the password policy on reset', async () => {
    const creds = await createActiveUser(h, 'weakreset');
    const request = await h.app.inject({
      method: 'POST', url: url('/password/forgot'), payload: { email: creds.email },
    });
    const token = (request.json() as { devResetToken: string }).devResetToken;

    const res = await h.app.inject({
      method: 'POST', url: url('/password/reset'), payload: { token, newPassword: 'password123' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('session management', () => {
  it('lists active sessions and marks the current one', async () => {
    const creds = await createActiveUser(h, 'sessions');
    const first = await signIn(h, creds);
    await signIn(h, creds);

    const res = await h.app.inject({ method: 'GET', url: url('/sessions'), headers: first.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: { current: boolean }[] };
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
  });

  it('revokes other sessions without ending the current one', async () => {
    const creds = await createActiveUser(h, 'revoke');
    const keep = await signIn(h, creds);
    const other = await signIn(h, creds);

    const res = await h.app.inject({
      method: 'POST', url: url('/sessions/revoke-others'), headers: keep.headers,
    });
    expect(res.statusCode).toBe(200);

    expect(
      (await h.app.inject({ method: 'GET', url: url('/me'), headers: keep.headers })).statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: url('/me'), headers: other.headers })).statusCode,
    ).toBe(401);
  });

  it('does not expose another user\'s session', async () => {
    const a = await createActiveUser(h, 'usera');
    const b = await createActiveUser(h, 'userb');
    const authA = await signIn(h, a);
    const authB = await signIn(h, b);

    const bSessions = await h.app.inject({ method: 'GET', url: url('/sessions'), headers: authB.headers });
    const bId = (bSessions.json() as { sessions: { id: string }[] }).sessions[0]!.id;

    // Not 403 — a 403 would confirm the session exists (§B.8).
    const res = await h.app.inject({
      method: 'DELETE', url: url(`/sessions/${bId}`), headers: authA.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('auditing', () => {
  it('records login, logout and failures', async () => {
    const creds = await createActiveUser(h, 'audit');
    await h.app.inject({
      method: 'POST', url: url('/login'),
      payload: { identifier: creds.username, password: 'wrong-password-value' },
    });
    const auth = await signIn(h, creds);
    await h.app.inject({ method: 'POST', url: url('/logout'), headers: auth.headers });

    const rows = await h.db
      .select({ action: auditLog.action, outcome: auditLog.outcome })
      .from(auditLog)
      .orderBy(sql`${auditLog.occurredAt} DESC`)
      .limit(20);

    const actions = rows.map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toContain('auth.login_failed:denied');
    expect(actions).toContain('auth.login:success');
    expect(actions).toContain('auth.logout:success');
  });

  it('carries a request id on every response', async () => {
    const res = await h.app.inject({ method: 'GET', url: url('/me') });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect((res.json() as { requestId: string }).requestId).toBeTruthy();
  });
});
