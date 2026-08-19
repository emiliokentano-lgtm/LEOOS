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

export async function createHarness(): Promise<TestHarness> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    INTERNAL_API_TOKEN: 'test-internal-token-0123456789',
    LOG_LEVEL: 'silent',
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

export async function setAccountStatus(
  db: Database,
  email: string,
  status: 'active' | 'suspended' | 'disabled' | 'pending_verification',
): Promise<void> {
  await db.update(userAccount).set({ status }).where(eq(userAccount.email, email));
}


/**
 * Gives an account a real membership, role and duty status.
 *
 * Exists because the whole permission-resolution path — memberships, roles,
 * permission grants, overrides — is dead code for an account with no
 * membership. A suite that only ever creates bare accounts never executes it,
 * which is exactly how a query bug reached a running server.
 */
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

  const suffix = Math.floor(Math.random() * 100000);
  const [member] = await db.execute<{ id: string }>(sql`
    INSERT INTO organization_member (user_id, organization_id, callsign, employee_number, status)
    VALUES (${user.id}, ${org.id}, ${`T-${suffix}`}, ${String(suffix)}, 'active')
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
}
