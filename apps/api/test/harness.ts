import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createDatabase, userAccount, type Database } from '@leoos/db';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MockMailTransport } from '../src/modules/auth/mail.js';
import { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER } from '../src/plugins/auth.js';

export interface TestHarness {
  app: FastifyInstance;
  db: Database;
  mail: MockMailTransport;
  config: AppConfig;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /**
   * Extra environment for this harness only.
   *
   * Used by suites that need a variable the rest do not — the FiveM tests need
   * an ingest encryption key, and setting one globally would make every other
   * suite's configuration differ from the default it is meant to exercise.
   */
  env?: Record<string, string>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const config = loadConfig({
    ...process.env,
    ...options.env,
    NODE_ENV: 'test',
    INTERNAL_API_TOKEN: 'test-internal-token-0123456789',
    LOG_LEVEL: process.env.HARNESS_LOG ?? 'silent',
    // Argon2 at production cost would make this suite take minutes. Reduced
    // ONLY for tests; production parameters are validated in config.ts and
    // asserted by a test of their own.
    ARGON2_MEMORY_KIB: '512',
    ARGON2_TIME_COST: '1',
  } as NodeJS.ProcessEnv);

  const { db, sql: raw, close: closeDb } = createDatabase({
    url: config.DATABASE_URL, max: 5, statementTimeoutMs: 15_000, ssl: false,
  });

  const mail = new MockMailTransport();
  const app = await buildApp({ config, db, mail });
  await app.ready();

  // Clear authority left behind by a run that did not finish. See the function.
  await revokeStaleTestLeads(db);

  return {
    app, db, mail, config,
    close: async () => {
      await app.close();
      await raw.end({ timeout: 5 }).catch(() => {});
      await closeDb().catch(() => {});
    },
  };
}

/**
 * Clears session state between tests.
 *
 * Deliberately does NOT delete accounts. Memberships are protected by
 * ON DELETE RESTRICT and `member_status_history` is append-only — by design,
 * because operational history must survive (engineering rule 24). Fighting those
 * constraints in a test helper would mean weakening them in the schema, so tests
 * use unique identifiers instead and accounts simply accumulate in the test
 * database.
 */
export async function resetAccounts(db: Database): Promise<void> {
  const testAccounts = sql`SELECT id FROM user_account WHERE email LIKE '%@test.invalid'`;
  await db.execute(sql`DELETE FROM "session" WHERE user_id IN (${testAccounts})`);
  await db.execute(sql`DELETE FROM auth_token WHERE user_id IN (${testAccounts})`);
}

/**
 * Revokes organization-lead grants left behind by a run that did not finish.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The test database keeps its accounts and memberships on purpose — operational
 * history must survive, so `resetAccounts` deliberately does not delete them.
 * `organization_lead` accumulates the same way, and unlike a membership it is a
 * grant of AUTHORITY: a test that grants one and is killed before it revokes it
 * leaves a live lead behind, and the next run of any suite that reasons about
 * "who leads this organization" starts from a state no test created.
 *
 * That is not hypothetical. Two suites were run against this database at the
 * same time, one was interrupted mid-test, and the leftover grant failed an
 * unrelated assertion in the next run — with a message about a list length,
 * which points nowhere near the cause.
 *
 * Run ONCE per harness, not per test: a suite is entitled to grant a lead in
 * `beforeAll` and rely on it across its tests, and sweeping in `beforeEach`
 * would quietly break that. This clears the wreckage of a previous PROCESS,
 * which is the only thing it is for.
 *
 * Revoked rather than deleted, because that is what the application does and
 * the row is a record.
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function revokeStaleTestLeads(db: Database): Promise<number> {
  // `organization_lead` is keyed on (user_id, organization_id) — there is no id
  // column to return.
  const rows = await db.execute<{ user_id: string }>(sql`
    UPDATE organization_lead SET revoked_at = now()
     WHERE revoked_at IS NULL
       AND user_id IN (SELECT id FROM user_account WHERE email LIKE '%@test.invalid')
    RETURNING user_id
  `);
  return rows.length;
}

export function cookiesFrom(headers: unknown): Record<string, string> {
  const raw = (headers as Record<string, string | string[]>)['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(';');
    const idx = pair?.indexOf('=') ?? -1;
    if (idx > 0 && pair) out[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
  }
  return out;
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

export { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER };

let counter = 0;
export function uniqueUser(prefix = 'user') {
  counter += 1;
  const tag = `${prefix}${Date.now().toString(36)}${counter}`;
  return {
    email: `${tag}@test.invalid`,
    username: tag,
    displayName: `Test ${tag}`,
    password: 'correct-horse-staple-42',
  };
}

/** Registers and verifies, returning credentials for an active account. */
export async function createActiveUser(h: TestHarness, prefix = 'user') {
  const creds = uniqueUser(prefix);
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: creds });
  const body = res.json() as { devVerificationToken?: string };
  if (!body.devVerificationToken) throw new Error('no verification token returned');
  await h.app.inject({
    method: 'POST', url: '/api/v1/auth/verify',
    payload: { token: body.devVerificationToken },
  });
  return creds;
}

/** Logs in and returns a ready-to-use cookie jar plus CSRF header value. */
export async function signIn(h: TestHarness, creds: { username: string; password: string }) {
  const res = await h.app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { identifier: creds.username, password: creds.password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  }
  const jar = cookiesFrom(res.headers);
  return {
    jar,
    headers: { cookie: cookieHeader(jar), [CSRF_HEADER]: jar[CSRF_COOKIE] ?? '' },
    body: res.json() as Record<string, unknown>,
  };
}

/**
 * Bumps a user's permission version the way the real services do.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVERY DIRECT-SQL HELPER BELOW CALLS THIS
 *
 * Identity resolution is cached on `user_account.permission_version` (see
 * `resolveIdentityCached`). Every application path that changes a user's
 * effective authority bumps that column inside its own transaction, so a
 * demotion is visible on the very next request.
 *
 * The helpers in this file deliberately bypass those paths — a scoping test
 * must be able to SET UP the state it then proves is refused, without depending
 * on the endpoint that produces it working. Bypassing the service also bypasses
 * the bump, which would leave the test asserting against an identity resolved
 * before its own setup ran.
 *
 * So the helpers bump too. This is not a workaround for the cache: it makes the
 * fixtures behave the way the production writers behave. A test that changes
 * authorization state with raw SQL of its own must do the same.
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function bumpVersionForUser(db: Database, userId: string): Promise<void> {
  await db.execute(
    sql`UPDATE user_account SET permission_version = permission_version + 1 WHERE id = ${userId}`,
  );
}

/** Same, addressed by username — the shape most helpers here already have. */
export async function bumpVersionForUsername(db: Database, username: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_account SET permission_version = permission_version + 1
     WHERE username = ${username}
  `);
}

/** Same, addressed by membership — used where only the member id is to hand. */
export async function bumpVersionForMember(db: Database, memberId: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_account SET permission_version = permission_version + 1
     WHERE id = (SELECT user_id FROM organization_member WHERE id = ${memberId})
  `);
}

export async function setAccountStatus(
  db: Database,
  email: string,
  status: 'active' | 'suspended' | 'disabled' | 'pending_verification',
): Promise<void> {
  await db.update(userAccount).set({ status }).where(eq(userAccount.email, email));
  await db.execute(sql`
    UPDATE user_account SET permission_version = permission_version + 1 WHERE email = ${email}
  `);
}


/**
 * Gives an account a real membership, role and duty status.
 *
 * Exists because the whole permission-resolution path — memberships, roles,
 * permission grants, overrides — is dead code for an account with no
 * membership. A suite that only ever creates bare accounts never executes it,
 * which is exactly how a query bug reached a running server.
 */
let membershipCounter = 0;

export async function grantMembership(
  db: Database,
  username: string,
  opts: { orgKey?: string; roleKey?: string } = {},
): Promise<{ memberId: string; organizationId: string; roleId: string }> {
  const orgKey = opts.orgKey ?? 'PD';
  const roleKey = opts.roleKey ?? 'lieutenant';

  const [user] = await db.execute<{ id: string }>(
    sql`SELECT id FROM user_account WHERE username = ${username}`,
  );
  const [org] = await db.execute<{ id: string }>(
    sql`SELECT id FROM organization WHERE key = ${orgKey}`,
  );
  if (!user || !org) throw new Error(`cannot grant membership: ${username} / ${orgKey}`);

  const [role] = await db.execute<{ id: string }>(sql`
    SELECT id FROM role WHERE organization_id = ${org.id} AND key = ${roleKey}
  `);
  if (!role) throw new Error(`no role ${orgKey}/${roleKey}`);

  // Callsigns and employee numbers are unique per ACTIVE member per
  // organization, and the test database keeps its members on purpose (see
  // `resetAccounts`). A random suffix collides more often the longer the
  // database lives, so the suffix is drawn from the clock plus a counter.
  membershipCounter += 1;
  const suffix = `${Date.now().toString(36)}${membershipCounter}`;
  const [member] = await db.execute<{ id: string }>(sql`
    INSERT INTO organization_member (user_id, organization_id, callsign, employee_number, status)
    VALUES (${user.id}, ${org.id}, ${`T-${suffix}`}, ${suffix}, 'active')
    ON CONFLICT (user_id, organization_id) DO UPDATE SET status = 'active'
    RETURNING id
  `);
  if (!member) throw new Error('membership insert failed');

  await db.execute(sql`
    INSERT INTO member_role (member_id, role_id) VALUES (${member.id}, ${role.id})
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO member_status (member_id, status_key) VALUES (${member.id}, 'available')
    ON CONFLICT (member_id) DO NOTHING
  `);

  await bumpVersionForUser(db, user.id);

  return { memberId: member.id, organizationId: org.id, roleId: role.id };
}

export async function setPermissionOverride(
  db: Database,
  memberId: string,
  permissionKey: string,
  effect: 'grant' | 'deny',
): Promise<void> {
  await db.execute(sql`
    INSERT INTO member_permission_override (member_id, permission_key, effect, reason)
    VALUES (${memberId}, ${permissionKey}, ${effect}::permission_override_effect, 'test')
    ON CONFLICT (member_id, permission_key)
    DO UPDATE SET effect = ${effect}::permission_override_effect
  `);
  await bumpVersionForMember(db, memberId);
}

/** Makes an account a global administrator. */
export async function makeGlobalAdmin(db: Database, username: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_global_role (user_id, capability)
    VALUES ((SELECT id FROM user_account WHERE username = ${username}), 'global_admin')
    ON CONFLICT DO NOTHING
  `);
  await bumpVersionForUsername(db, username);
}

/**
 * Grants the Organization Lead capability directly, bypassing the API.
 *
 * Used to SET UP a lead so the tests can then prove what that lead cannot do.
 * The API path for granting is tested separately; using it here would make every
 * scoping test depend on the grant endpoint working.
 */
export async function makeOrgLead(
  db: Database,
  username: string,
  orgKey: string,
  granterUsername: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO organization_lead (user_id, organization_id, granted_by)
    VALUES (
      (SELECT id FROM user_account WHERE username = ${username}),
      (SELECT id FROM organization WHERE key = ${orgKey}),
      (SELECT id FROM user_account WHERE username = ${granterUsername})
    )
    ON CONFLICT (user_id, organization_id)
    DO UPDATE SET revoked_at = NULL, revoked_by = NULL
  `);
  await bumpVersionForUsername(db, username);
}

export async function organizationIdByKey(db: Database, key: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM organization WHERE key = ${key}`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`organization ${key} not seeded`);
  return id;
}

export async function userIdByUsername(db: Database, username: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM user_account WHERE username = ${username}`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`user ${username} not found`);
  return id;
}
