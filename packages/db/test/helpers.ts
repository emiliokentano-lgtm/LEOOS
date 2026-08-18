import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { runSeed } from '../src/seed/run.js';

/**
 * Test harness.
 *
 * These tests run against a REAL PostgreSQL instance, not a mock. The guarantees
 * under test — partial unique indexes, CHECK constraints, triggers, append-only
 * enforcement — exist only in the database. A mocked test would assert nothing
 * about the property that actually matters (engineering rule 33).
 */

export interface Harness {
  db: Database;
  raw: ReturnType<typeof createDatabase>['sql'];
  close: () => Promise<void>;
}

export async function setupDatabase(): Promise<Harness> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must point at a disposable test database. ' +
        'See packages/db/README.md for a one-line local Postgres.',
    );
  }

  const { sql: raw, close } = createDatabase();

  // Full reset so every run starts from a known schema, proving the migration
  // process itself works — not just the end state (engineering rule 40).
  //
  // The `drizzle` schema holds the migration journal: dropping `public` alone
  // leaves the journal claiming both migrations are applied, so the migrator
  // silently does nothing and every table is missing.
  await raw`DROP SCHEMA IF EXISTS public CASCADE`;
  await raw`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await raw`CREATE SCHEMA public`;
  await close();

  await runMigrations();
  await runSeed();

  const fresh = createDatabase();
  return { db: fresh.db, raw: fresh.sql, close: fresh.close };
}

/**
 * Collects the message from an error and every `cause` beneath it.
 *
 * Drizzle wraps driver errors in a generic "Failed query: …" — the Postgres
 * message that says WHICH constraint fired lives in `cause`. Matching only the
 * outer message would let a test pass on the wrong failure, which is worse than
 * no test at all.
 */
function fullMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { message?: string; detail?: string; cause?: unknown };
    if (e.message) parts.push(e.message);
    if (e.detail) parts.push(e.detail);
    current = e.cause;
  }
  return parts.join('\n');
}

/** Asserts that a statement fails, and that it fails for the expected reason. */
export async function expectRejection(
  fn: () => Promise<unknown>,
  matcher: RegExp,
): Promise<string> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error(`Expected a rejection matching ${matcher}, but it succeeded.`);
  const message = fullMessage(error);
  if (!matcher.test(message)) {
    throw new Error(`Rejection did not match ${matcher}.\nActual: ${message}`);
  }
  return message;
}

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Creates a verified, active account. */
export async function makeUser(db: Database, label = 'user'): Promise<string> {
  const name = unique(label);
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO user_account (email, username, display_name, password_hash, status, email_verified_at)
    VALUES (${`${name}@test.invalid`}, ${name}, ${name}, 'x', 'active', now())
    RETURNING id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error('failed to create user');
  return id;
}

export async function orgIdByKey(db: Database, key: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM organization WHERE key = ${key}`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`organization ${key} not seeded`);
  return id;
}

export async function roleIdByKey(
  db: Database,
  orgKey: string,
  roleKey: string,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT r.id FROM role r
    JOIN organization o ON o.id = r.organization_id
    WHERE o.key = ${orgKey} AND r.key = ${roleKey}
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error(`role ${orgKey}/${roleKey} not seeded`);
  return id;
}

export async function makeMember(
  db: Database,
  orgKey: string,
  opts: { callsign?: string; status?: string } = {},
): Promise<{ memberId: string; userId: string; orgId: string }> {
  const userId = await makeUser(db, 'member');
  const orgId = await orgIdByKey(db, orgKey);
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO organization_member (user_id, organization_id, callsign, status)
    VALUES (${userId}, ${orgId}, ${opts.callsign ?? null},
            ${(opts.status ?? 'active') as 'active'}::membership_status)
    RETURNING id
  `);
  const memberId = rows[0]?.id;
  if (!memberId) throw new Error('failed to create member');
  return { memberId, userId, orgId };
}
