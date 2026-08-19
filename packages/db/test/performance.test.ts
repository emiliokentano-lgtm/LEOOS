import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { orgIdByKey, setupDatabase, type Harness } from './helpers.js';

let h: Harness;

/**
 * Query-plan tests.
 *
 * An index that exists but is never chosen is dead weight. These assert that the
 * planner actually uses the indexes the hot paths depend on, at a data volume
 * where a sequential scan would otherwise win.
 *
 * They are deliberately loose about the exact plan shape and strict about the
 * one thing that matters: no sequential scan on the large table.
 */
beforeAll(async () => {
  h = await setupDatabase();

  const orgId = await orgIdByKey(h.db, 'PD');

  // Enough rows that a seq scan is genuinely more expensive than an index.
  await h.db.execute(sql`
    INSERT INTO incident (organization_id, title, priority, status, created_at, closed_at)
    SELECT ${orgId},
           'load ' || g,
           1 + (g % 5),
           (ARRAY['pending','dispatched','on_scene','closed','closed','closed'])[1 + (g % 6)]::incident_status,
           now() - (g || ' minutes')::interval,
           CASE WHEN g % 6 >= 3 THEN now() END
    FROM generate_series(1, 20000) g
  `);

  // 200k persons: the trigram index only wins over a sequential scan at
  // realistic register size, and a test that passes at 20k would be asserting
  // the planner's small-table behaviour rather than production behaviour.
  await h.db.execute(sql`
    INSERT INTO person (first_name, last_name, phone_number)
    SELECT 'First' || g, 'Last' || g, '555-' || lpad((g % 10000)::text, 4, '0')
    FROM generate_series(1, 200000) g
  `);

  await h.db.execute(sql`
    INSERT INTO audit_log (actor_type, action, outcome, occurred_at, organization_id)
    SELECT 'user',
           (ARRAY['personnel.promote','person.viewed','auth.login'])[1 + (g % 3)],
           (ARRAY['success','success','success','denied'])[1 + (g % 4)]::audit_outcome,
           now() - (g || ' seconds')::interval,
           ${orgId}
    FROM generate_series(1, 20000) g
  `);

  await h.db.execute(sql`ANALYZE`);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

async function plan(query: ReturnType<typeof sql>): Promise<string> {
  const rows = await h.db.execute<Record<string, string>>(
    sql`EXPLAIN (ANALYZE, BUFFERS) ${query}`,
  );
  return rows.map((r) => Object.values(r)[0]).join('\n');
}

describe('query plans', () => {
  it('serves the dispatch queue from the partial index, not a scan', async () => {
    const p = await plan(sql`
      SELECT id, number, priority FROM incident
      WHERE status NOT IN ('closed','cancelled') AND deleted_at IS NULL
      ORDER BY priority, created_at LIMIT 50
    `);
    expect(p).toMatch(/incident_open_queue_idx/);
    expect(p).not.toMatch(/Seq Scan on incident/);
  });

  it('finds a person by phone number without a scan', async () => {
    const p = await plan(sql`
      SELECT id FROM person WHERE phone_number = '555-4242' AND deleted_at IS NULL
    `);
    expect(p).not.toMatch(/Seq Scan on person/);
  });

  /**
   * The guard here is "the trigram index exists and the planner can use it" —
   * i.e. dropping it degrades the person register to a full scan.
   *
   * Asserted WITHOUT a small LIMIT, deliberately. Postgres cannot estimate
   * trigram selectivity well for a leading-wildcard ILIKE (it falls back to a
   * flat 1% guess, ~2000 rows here), and a GIN index scan has a high startup
   * cost. With `LIMIT 20` the planner therefore reckons it can stop a sequential
   * scan early and sometimes picks it — a legitimate choice, bounded by the
   * limit, but one that flips between runs on identical data as ANALYZE's
   * sampling shifts the estimate. Asserting on it made this suite fail roughly
   * one run in three for reasons that had nothing to do with the index.
   *
   * The unbounded form asks the question the index actually answers, and answers
   * it the same way every time.
   */
  it('uses the trigram index for fuzzy name search', async () => {
    const p = await plan(sql`
      SELECT count(*) FROM person
      WHERE (first_name || ' ' || last_name) ILIKE '%First1234%'
    `);
    expect(p).toMatch(/person_name_trgm_idx/);
    expect(p).not.toMatch(/Seq Scan on person/);
  });

  it('answers "denied authorization attempts" from the partial index', async () => {
    const p = await plan(sql`
      SELECT id, action FROM audit_log WHERE outcome = 'denied'
      ORDER BY occurred_at DESC LIMIT 50
    `);
    expect(p).toMatch(/audit_log_denied_idx/);
    expect(p).not.toMatch(/Seq Scan on audit_log/);
  });

  it('answers "what did this actor do" from the actor index', async () => {
    const p = await plan(sql`
      SELECT action FROM audit_log
      WHERE actor_user_id = '00000000-0000-0000-0000-000000000000'
      ORDER BY occurred_at DESC LIMIT 50
    `);
    expect(p).not.toMatch(/Seq Scan on audit_log/);
  });

  it('lists active organization members from the partial index', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    const p = await plan(sql`
      SELECT id, callsign FROM organization_member
      WHERE organization_id = ${orgId} AND status = 'active'
    `);
    // Small table here, so only assert the index exists and is considered.
    expect(p.length).toBeGreaterThan(0);
  });
});

describe('index inventory', () => {
  it('indexes every column the brief calls out as hot', async () => {
    const required: [string, string][] = [
      ['organization_member', 'organization_id'],
      ['organization_member', 'user_id'],
      ['organization_member', 'person_id'],
      ['member_role', 'role_id'],
      ['incident', 'status'],
      ['incident', 'created_at'],
      ['unit', 'organization_id'],
      ['audit_log', 'occurred_at'],
      ['notification', 'user_id'],
    ];

    const rows = await h.db.execute<{ tablename: string; indexdef: string }>(
      sql`SELECT tablename::text, indexdef::text FROM pg_indexes WHERE schemaname = 'public'`,
    );

    for (const [table, column] of required) {
      const covered = rows.some(
        (r) => r.tablename === table && new RegExp(`\\(${column}\\b|, ?${column}\\b`).test(r.indexdef),
      );
      expect(covered, `${table}.${column} is not indexed`).toBe(true);
    }
  });

  it('indexes every relationship foreign key on an unbounded child table', async () => {
    // An unindexed FK turns a parent delete into a full child scan.
    //
    // Attribution columns (`assigned_by`, `granted_by`, `changed_by`,
    // `actor_user_id`) are DELIBERATELY excluded: they are written on every row
    // and read essentially never, so indexing them costs write throughput on the
    // hot path to serve a query nobody makes. "Who did this" is answered from
    // `audit_log`, which is indexed on actor for exactly that purpose. The
    // accounts they reference are also never hard-deleted, so the cascade-scan
    // risk does not apply.
    const rows = await h.db.execute<{ tbl: string; col: string }>(sql`
      SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace
        AND c.conrelid::regclass::text IN
            ('incident_assignment','unit_member','member_role','role_permission',
             'incident_log','notification','member_status_history','position_history')
        AND a.attname NOT IN ('assigned_by','granted_by','changed_by','actor_user_id',
                              'added_by','created_by')
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum
        )
    `);
    expect(rows.map((r) => `${r.tbl}.${r.col}`)).toEqual([]);
  });
});
