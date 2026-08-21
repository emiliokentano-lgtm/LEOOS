/**
 * A database at realistic FiveM RP scale.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Every query in this codebase is fast against the fifty rows the test suite
 * creates. That says nothing. A sequential scan over fifty rows and an index
 * scan over fifty rows are indistinguishable, so a missing index is invisible
 * until it is in production on a Saturday night.
 *
 * These numbers are what a busy roleplay server looks like after a year:
 *
 *   persons        50 000   — everyone who has ever been run through a check
 *   vehicles      120 000   — plates outnumber people
 *   personnel       1 200   — 200 per organization across six
 *   units             500   — the peak the brief asks the map to carry
 *   incidents      30 000   — a year of calls, mostly closed
 *   audit_log     400 000   — every read of a person is a row
 *   notifications 200 000   — the table that grows fastest per operator
 *   positions   1 000 000   — the downsampled history, one row per unit per 30 s
 *
 * Generated in SQL rather than through the API: this is about the shape of the
 * data, not about the write paths, and 1.8 million rows through Fastify would
 * take a day.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POINT THIS AT ITS OWN DATABASE.
 *
 * It generates a hundred thousand people with ten surnames between them, which
 * is fine for measuring a plan and ruinous for a test suite: a test that
 * searches for a surname prefix and expects its own fixture in the top 25 stops
 * finding it. That is not a hypothetical — it is what happened the first time
 * this was run against the shared development database.
 *
 * The benchmark database is disposable. Create it, load it, measure, and leave
 * it alone:
 *
 *   createdb -p 5433 leoos_bench
 *   DATABASE_URL=postgres://leoos@localhost:5433/leoos_bench pnpm --filter @leoos/db migrate
 *   DATABASE_URL=postgres://leoos@localhost:5433/leoos_bench pnpm --filter @leoos/db seed
 *   DATABASE_URL=postgres://leoos@localhost:5433/leoos_bench node scripts/load-fixture.mjs
 *   DATABASE_URL=postgres://leoos@localhost:5433/leoos_bench node scripts/bench-queries.mjs
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Usage:  DATABASE_URL=… node scripts/load-fixture.mjs [--drop]
 * ────────────────────────────────────────────────────────────────────────────
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL.'); process.exit(2); }

/**
 * Refuses to load into anything not named for benchmarking.
 *
 * A guard rather than a comment, because the comment was there and the mistake
 * was still made. `--force` exists for a deliberate exception.
 */
if (!/bench|load|perf/i.test(DATABASE_URL) && !process.argv.includes('--force')) {
  console.error(
    'Refusing to load a fixture of this size into a database not named for it.\n'
    + 'This makes surname searches collide with test fixtures and is very hard to\n'
    + 'undo — `audit_log` is append-only. Create a benchmark database (see the\n'
    + 'header of this file), or pass --force if you really mean it.',
  );
  process.exit(2);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {}, max: 4 });
const log = (m) => console.error(`[load] ${m}`);

const SCALE = {
  persons: Number(process.env.LOAD_PERSONS ?? 50_000),
  vehicles: Number(process.env.LOAD_VEHICLES ?? 120_000),
  personnelPerOrg: Number(process.env.LOAD_PERSONNEL ?? 200),
  units: Number(process.env.LOAD_UNITS ?? 500),
  incidents: Number(process.env.LOAD_INCIDENTS ?? 30_000),
  auditRows: Number(process.env.LOAD_AUDIT ?? 400_000),
  notifications: Number(process.env.LOAD_NOTIFICATIONS ?? 200_000),
  positions: Number(process.env.LOAD_POSITIONS ?? 1_000_000),
};

async function timed(label, fn) {
  const started = Date.now();
  const result = await fn();
  log(`${label.padEnd(28)} ${String(Date.now() - started).padStart(7)} ms`);
  return result;
}

const orgs = await sql`SELECT id, key FROM organization WHERE deleted_at IS NULL ORDER BY key`;
if (orgs.length === 0) throw new Error('Seed the organizations first.');
log(`${orgs.length} organizations`);

if (process.argv.includes('--drop')) {
  await timed('clearing generated rows', async () => {
    await sql`DELETE FROM position_history`;
    await sql`DELETE FROM notification WHERE title LIKE 'LOAD %'`;
    await sql`DELETE FROM audit_log WHERE metadata->>'loadFixture' = 'true'`;
    await sql`DELETE FROM vehicle WHERE notes = 'LOAD'`;
    await sql`DELETE FROM person WHERE notes = 'LOAD'`;
  });
}

// ── Persons ────────────────────────────────────────────────────────────────
await timed(`persons (${SCALE.persons})`, () => sql`
  INSERT INTO person (first_name, last_name, date_of_birth, phone_number, status, notes)
  SELECT
    (ARRAY['James','Maria','Chen','Aisha','Diego','Nina','Omar','Sofia','Liam','Yuki'])[1 + (i % 10)]
      || (i % 997),
    (ARRAY['Vasquez','Okafor','Lindqvist','Haddad','Moreau','Tanaka','Silva','Novak','Brennan','Adeyemi'])[1 + ((i / 10)::int % 10)]
      || (i % 89),
    DATE '1960-01-01' + ((i * 7) % 16000),
    '555-' || lpad((i % 10000)::text, 4, '0'),
    'alive',
    'LOAD'
  FROM generate_series(1, ${SCALE.persons}) AS i
`);

// ── Vehicles ───────────────────────────────────────────────────────────────
/**
 * Owners are joined by ROW NUMBER, not by OFFSET.
 *
 * The obvious way to spread 120 000 vehicles over 50 000 owners is a LATERAL
 * `OFFSET (i % 50000) LIMIT 1`, which re-scans the person table once per
 * vehicle: quadratic, and measured at 232 seconds. Numbering the people once and
 * joining on that number is a single hash join.
 */
await timed(`vehicles (${SCALE.vehicles})`, () => sql`
  WITH owners AS (
    SELECT id, (row_number() OVER (ORDER BY id)) - 1 AS rn
    FROM person WHERE notes = 'LOAD'
  )
  INSERT INTO vehicle (plate, model, color, display_name, owner_person_id, notes)
  SELECT
    upper(substr(md5(i::text), 1, 8)),
    (ARRAY['Sultan','Buffalo','Police Cruiser','Ambulance','Bison','Elegy','Dominator'])[1 + (i % 7)],
    (ARRAY['black','white','blue','red','silver'])[1 + (i % 5)],
    /**
     * A NAMED MINORITY, because that is what the column is for.
     *
     * `display_name` holds the name a fleet vehicle is actually called on the
     * radio — "Air-1", "Chief's car" — and most vehicles do not have one. An
     * earlier version of this fixture left the column NULL for every row, which
     * made the global-search benchmark meaningless: the branch matched nothing,
     * so the query was fast with or without an index on it, and the case
     * reported no difference where the application sees a sequential scan.
     */
    CASE WHEN i % 200 = 0 THEN 'Fleet ' || ((i / 200) % 300) ELSE NULL END,
    o.id,
    'LOAD'
  FROM generate_series(1, ${SCALE.vehicles}) AS i
  JOIN owners o ON o.rn = i % (SELECT count(*) FROM owners)
  ON CONFLICT DO NOTHING
`);

// ── Personnel ──────────────────────────────────────────────────────────────
//
// Real accounts, because the roster query joins user_account and the planner's
// choices depend on the join being real.
await timed(`personnel (${SCALE.personnelPerOrg}/org)`, async () => {
  /**
   * A borrowed hash, or a placeholder.
   *
   * These accounts exist to make the roster JOIN real; nobody signs in as one.
   * Hashing 1 200 passwords at production cost would dominate the load time for
   * no benefit, so an existing hash is reused where the database has one. A
   * freshly seeded benchmark database has none, hence the fallback — which is
   * deliberately not a hash of anything, so it cannot be mistaken for a
   * credential that works.
   */
  const existing = await sql`
    SELECT password_hash AS hash FROM user_account
     WHERE password_hash LIKE '$argon2%' LIMIT 1
  `;
  const hash = existing[0]?.hash
    ?? '$argon2id$v=19$m=19456,t=2,p=1$TE9BRC1GSVhUVVJFLU5PVC1BLUNSRURFTlRJQUw$'
      + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  for (const org of orgs) {
    await sql`
      WITH created AS (
        INSERT INTO user_account (email, username, display_name, password_hash, status, email_verified_at)
        SELECT
          'load.' || ${org.key} || '.' || i || '@load.invalid',
          'load_' || lower(${org.key}) || '_' || i,
          'Load ' || ${org.key} || ' ' || i,
          ${hash}, 'active', now()
        FROM generate_series(1, ${SCALE.personnelPerOrg}) AS i
        ON CONFLICT (username) DO NOTHING
        RETURNING id, username
      ), member AS (
        INSERT INTO organization_member
          (user_id, organization_id, callsign, employee_number, status, joined_at)
        SELECT c.id, ${org.id},
               upper(${org.key}) || '-' || row_number() OVER (ORDER BY c.username),
               'L' || ${org.key} || row_number() OVER (ORDER BY c.username),
               'active', now() - (random() * interval '400 days')
        FROM created c
        ON CONFLICT (user_id, organization_id) DO NOTHING
        RETURNING id
      ), roled AS (
        INSERT INTO member_role (member_id, role_id)
        SELECT m.id, r.id
        FROM member m
        CROSS JOIN LATERAL (
          SELECT id FROM role
           WHERE organization_id = ${org.id} AND deleted_at IS NULL AND is_active
           ORDER BY hierarchy_level LIMIT 1
        ) r
        ON CONFLICT DO NOTHING
        RETURNING member_id
      )
      INSERT INTO member_status (member_id, status_key)
      SELECT member_id, 'available' FROM roled
      ON CONFLICT (member_id) DO NOTHING
    `;
  }
});

// ── Units ──────────────────────────────────────────────────────────────────
await timed(`units (${SCALE.units})`, async () => {
  for (const org of orgs) {
    const per = Math.ceil(SCALE.units / orgs.length);
    await sql`
      INSERT INTO unit
        (organization_id, callsign, unit_type, status_key, is_covert, pos_x, pos_y, position_updated_at)
      SELECT ${org.id},
             upper(${org.key}) || '-U' || i,
             (ARRAY['patrol','supervisor','k9','air','ems'])[1 + (i % 5)],
             (ARRAY['available','busy','transporting','on_scene'])[1 + (i % 4)],
             (i % 20) = 0,
             -3000 + (random() * 7000), -3000 + (random() * 7000),
             now() - (random() * interval '5 minutes')
      FROM generate_series(1, ${per}) AS i
      ON CONFLICT DO NOTHING
    `;
  }
});

// ── Incidents ──────────────────────────────────────────────────────────────
await timed(`incidents (${SCALE.incidents})`, async () => {
  const orgIds = orgs.map((o) => o.id);
  await sql`
    INSERT INTO incident
      (organization_id, priority, status, title, location_text, pos_x, pos_y,
       source, created_at, closed_at)
    SELECT
      (${orgIds}::uuid[])[1 + (i % ${orgIds.length})],
      1 + (i % 5),
      -- Mostly closed: a year of calls with a live handful, which is what makes
      -- the partial "open queue" index worth having.
      (CASE WHEN i % 40 = 0 THEN 'pending' WHEN i % 40 = 1 THEN 'dispatched'
            WHEN i % 40 = 2 THEN 'on_scene' ELSE 'closed' END)::incident_status,
      (ARRAY['Armed robbery','Traffic collision','Domestic disturbance','Medical emergency','Suspicious vehicle'])[1 + (i % 5)]
        || ' #' || i,
      (ARRAY['Legion Square','Vespucci Beach','Sandy Shores','Mirror Park','Vinewood'])[1 + (i % 5)],
      -3000 + (random() * 7000), -3000 + (random() * 7000),
      'manual',
      now() - (random() * interval '365 days'),
      CASE WHEN i % 40 > 2 THEN now() - (random() * interval '300 days') ELSE NULL END
    FROM generate_series(1, ${SCALE.incidents}) AS i
  `;
});

await timed('incident assignments', () => sql`
  INSERT INTO incident_assignment (incident_id, unit_id, released_at)
  SELECT i.id, u.id,
         CASE WHEN i.status = 'closed' THEN i.closed_at ELSE NULL END
  FROM (SELECT id, status, closed_at, row_number() OVER () AS rn FROM incident) i
  CROSS JOIN LATERAL (
    SELECT id FROM unit WHERE organization_id IS NOT NULL
     OFFSET (i.rn % GREATEST((SELECT count(*) FROM unit), 1)) LIMIT 1
  ) u
  WHERE i.rn % 2 = 0
  ON CONFLICT DO NOTHING
`);

// ── Audit log ──────────────────────────────────────────────────────────────
await timed(`audit_log (${SCALE.auditRows})`, async () => {
  const orgIds = orgs.map((o) => o.id);
  await sql`
    INSERT INTO audit_log
      (occurred_at, actor_type, actor_user_id, actor_label, action, outcome,
       entity_type, entity_id, organization_id, metadata, ip)
    SELECT
      now() - (random() * interval '365 days'),
      'user',
      (SELECT id FROM user_account OFFSET (i % GREATEST((SELECT count(*) FROM user_account),1)) LIMIT 1),
      'load actor',
      (ARRAY['person.viewed','vehicle.viewed','search.performed','auth.login',
             'personnel.promoted','incident.created','role.updated','user.disabled'])[1 + (i % 8)],
      (CASE WHEN i % 50 = 0 THEN 'denied' ELSE 'success' END)::audit_outcome,
      'person',
      NULL,
      (${orgIds}::uuid[])[1 + (i % ${orgIds.length})],
      '{"loadFixture":true}'::jsonb,
      '10.0.0.1'
    FROM generate_series(1, ${SCALE.auditRows}) AS i
  `;
});

// ── Notifications ──────────────────────────────────────────────────────────
await timed(`notifications (${SCALE.notifications})`, () => sql`
  INSERT INTO notification
    (user_id, organization_id, severity, type, title, body, created_at, read_at, dispatched_at)
  SELECT
    u.id, NULL,
    (ARRAY['info','warning','critical'])[1 + (i % 3)]::notification_severity,
    (ARRAY['incident.updated','incident.assigned','panic.triggered','organization.announcement'])[1 + (i % 4)],
    'LOAD notification ' || i, 'body',
    now() - (random() * interval '60 days'),
    CASE WHEN i % 5 = 0 THEN NULL ELSE now() - (random() * interval '30 days') END,
    now()
  FROM generate_series(1, ${SCALE.notifications}) AS i
  CROSS JOIN LATERAL (
    SELECT id FROM user_account
     WHERE username LIKE 'load\\_%'
     OFFSET (i % GREATEST((SELECT count(*) FROM user_account WHERE username LIKE 'load\\_%'), 1))
     LIMIT 1
  ) u
`);

// ── Position history ───────────────────────────────────────────────────────
await timed(`position_history (${SCALE.positions})`, () => sql`
  INSERT INTO position_history (unit_id, organization_id, pos_x, pos_y, heading, recorded_at)
  SELECT u.id, u.organization_id,
         -3000 + (random() * 7000), -3000 + (random() * 7000), (random() * 360)::int,
         now() - (i * interval '30 seconds')
  FROM generate_series(1, ${Math.ceil(SCALE.positions / 500)}) AS i
  CROSS JOIN (SELECT id, organization_id FROM unit LIMIT 500) u
`);

await timed('ANALYZE', () => sql`ANALYZE`);

const [sizes] = await sql`
  SELECT string_agg(t || ': ' || n, ', ' ORDER BY t) AS s FROM (
    SELECT 'person' t, count(*)::text n FROM person
    UNION ALL SELECT 'vehicle', count(*)::text FROM vehicle
    UNION ALL SELECT 'member', count(*)::text FROM organization_member
    UNION ALL SELECT 'unit', count(*)::text FROM unit
    UNION ALL SELECT 'incident', count(*)::text FROM incident
    UNION ALL SELECT 'audit_log', count(*)::text FROM audit_log
    UNION ALL SELECT 'notification', count(*)::text FROM notification
    UNION ALL SELECT 'position_history', count(*)::text FROM position_history
  ) x
`;
log(sizes.s);
await sql.end();
