import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  expectRejection, makeMember, makeUser, orgIdByKey, roleIdByKey, setupDatabase, unique,
  type Harness,
} from './helpers.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let h: Harness;

beforeAll(async () => {
  h = await setupDatabase();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('migration & seed', () => {
  it('applies every migration in the folder from an empty schema', async () => {
    // Counted from the journal rather than hard-coded: a literal here breaks on
    // every migration added, which trains people to bump the number without
    // reading what changed — and stops asserting anything real.
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };

    const rows = await h.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(rows[0]?.count)).toBe(journal.entries.length);
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('seeds exactly the six initial organizations', async () => {
    const rows = await h.db.execute<{ key: string }>(
      sql`SELECT key::text FROM organization ORDER BY key`,
    );
    expect(rows.map((r) => r.key).sort()).toEqual(
      ['ARMY', 'FIB', 'ICE', 'MD', 'MECHANIC', 'PD'].sort(),
    );
  });

  it('gives every organization exactly one default role', async () => {
    const rows = await h.db.execute<{ key: string; defaults: number }>(sql`
      SELECT o.key::text AS key, count(*) FILTER (WHERE r.is_default)::int AS defaults
      FROM organization o JOIN role r ON r.organization_id = o.id
      GROUP BY o.key
    `);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.defaults).toBe(1);
  });

  it('seeds the permission catalogue with no drift from @leoos/contracts', async () => {
    const { verifyPermissionCatalogue, hasDrift } = await import('../src/seed/permissions.js');
    const drift = await verifyPermissionCatalogue(h.db);
    expect(hasDrift(drift), JSON.stringify(drift)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('uuidv7', () => {
  it('sets version 7 and the RFC 4122 variant', async () => {
    const rows = await h.db.execute<{ v: string; variant: string }>(sql`
      SELECT substring(uuidv7()::text from 15 for 1) AS v,
             substring(uuidv7()::text from 20 for 1) AS variant
    `);
    expect(rows[0]?.v).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(rows[0]?.variant);
  });

  it('is strictly increasing within a single millisecond burst', async () => {
    const rows = await h.db.execute<{ ok: boolean }>(sql`
      WITH g AS (SELECT uuidv7() AS id, generate_series(1, 500) AS n)
      SELECT bool_and(prev IS NULL OR prev < id) AS ok
      FROM (SELECT id, lag(id) OVER (ORDER BY n) AS prev FROM g) s
    `);
    expect(rows[0]?.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('authorization invariants (triggers)', () => {
  it('refuses a cross-organization role assignment', async () => {
    const { memberId } = await makeMember(h.db, 'ICE');
    const pdChief = await roleIdByKey(h.db, 'PD', 'chief');

    // This is the attack: attach a PD Chief role to an ICE membership and the
    // authorization kernel would honour a rank the member never earned.
    await expectRejection(
      () =>
        h.db.execute(
          sql`INSERT INTO member_role (member_id, role_id) VALUES (${memberId}, ${pdChief})`,
        ),
      /cross-organization role assignment refused/,
    );
  });

  it('allows a role from the member\'s own organization', async () => {
    const { memberId } = await makeMember(h.db, 'PD');
    const officer = await roleIdByKey(h.db, 'PD', 'officer');
    await h.db.execute(
      sql`INSERT INTO member_role (member_id, role_id) VALUES (${memberId}, ${officer})`,
    );
    const rows = await h.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM member_role WHERE member_id = ${memberId}`,
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('refuses a global-scope permission on an organization role', async () => {
    const officer = await roleIdByKey(h.db, 'PD', 'officer');
    // This is what stops a chief writing themselves an admin role.
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO role_permission (role_id, permission_key)
          VALUES (${officer}, 'admin.users')
        `),
      /global-scope permission .* cannot be attached to organization role/,
    );
  });

  it('permits a global permission on a global role', async () => {
    const rows = await h.db.execute<{ id: string }>(sql`
      INSERT INTO role (organization_id, key, name, hierarchy_level)
      VALUES (NULL, ${unique('global-role')}, 'Platform Admin', 100)
      RETURNING id
    `);
    const roleId = rows[0]!.id;
    await h.db.execute(sql`
      INSERT INTO role_permission (role_id, permission_key) VALUES (${roleId}, 'admin.users')
    `);
    const check = await h.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM role_permission WHERE role_id = ${roleId}`,
    );
    expect(check[0]?.count).toBe(1);
  });

  it('refuses an organization lead without an active membership', async () => {
    const userId = await makeUser(h.db, 'outsider');
    const grantor = await makeUser(h.db, 'admin');
    const orgId = await orgIdByKey(h.db, 'FIB');

    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO organization_lead (user_id, organization_id, granted_by)
          VALUES (${userId}, ${orgId}, ${grantor})
        `),
      /organization lead refused: user .* has no active membership/,
    );
  });

  it('refuses to archive a role that is still assigned', async () => {
    const { memberId } = await makeMember(h.db, 'MD');
    const emt = await roleIdByKey(h.db, 'MD', 'emt');
    await h.db.execute(
      sql`INSERT INTO member_role (member_id, role_id) VALUES (${memberId}, ${emt})`,
    );
    const actor = await makeUser(h.db, 'actor');

    // Archiving would silently leave the holder without authority.
    await expectRejection(
      () =>
        h.db.execute(sql`
          UPDATE role SET deleted_at = now(), deleted_by = ${actor}, deletion_reason = 'test'
          WHERE id = ${emt}
        `),
      /cannot archive role .*: still assigned to 1 member/,
    );
  });

  it('refuses to archive an organization with active members', async () => {
    await makeMember(h.db, 'ARMY');
    const orgId = await orgIdByKey(h.db, 'ARMY');
    const actor = await makeUser(h.db, 'actor');

    await expectRejection(
      () =>
        h.db.execute(sql`
          UPDATE organization SET deleted_at = now(), deleted_by = ${actor}, deletion_reason = 'test'
          WHERE id = ${orgId}
        `),
      /cannot archive organization .*: \d+ active member/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('append-only records', () => {
  it('refuses UPDATE and DELETE on the audit log', async () => {
    await h.db.execute(sql`
      INSERT INTO audit_log (actor_type, action, outcome)
      VALUES ('system', 'test.action', 'success')
    `);

    await expectRejection(
      () => h.db.execute(sql`UPDATE audit_log SET action = 'tampered'`),
      /audit_log is append-only: UPDATE refused/,
    );
    await expectRejection(
      () => h.db.execute(sql`DELETE FROM audit_log`),
      /audit_log is append-only: DELETE refused/,
    );
  });

  it('refuses UPDATE and DELETE on the incident timeline', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    const inc = await h.db.execute<{ id: string }>(sql`
      INSERT INTO incident (organization_id, title, priority) VALUES (${orgId}, 'test', 3)
      RETURNING id
    `);
    await h.db.execute(sql`
      INSERT INTO incident_log (incident_id, entry_type, body)
      VALUES (${inc[0]!.id}, 'note', 'original')
    `);

    await expectRejection(
      () => h.db.execute(sql`UPDATE incident_log SET body = 'rewritten'`),
      /incident_log is append-only/,
    );
    await expectRejection(
      () => h.db.execute(sql`DELETE FROM incident_log`),
      /incident_log is append-only/,
    );
  });
});
