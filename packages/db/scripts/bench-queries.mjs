/**
 * Times the application's real read paths against a loaded database.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MEASURE FIRST
 *
 * Every query below is the SQL the application actually issues, copied from the
 * module named beside it — not a simplified stand-in. A benchmark of a query
 * nobody runs tells you nothing, and the expensive part of a real query is
 * usually the bit a simplification drops (a correlated subquery in an ORDER BY,
 * an EXISTS per row, a COUNT over the same predicate as the page).
 *
 * Each is run `RUNS` times after a warm-up and reported by MEDIAN, because a
 * mean over a cold cache measures the disk rather than the plan.
 *
 * Usage:  DATABASE_URL=… node scripts/bench-queries.mjs [--explain]
 * ────────────────────────────────────────────────────────────────────────────
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Set DATABASE_URL.'); process.exit(2); }

const sql = postgres(DATABASE_URL, { onnotice: () => {}, max: 2 });
const EXPLAIN = process.argv.includes('--explain');
const RUNS = Number(process.env.BENCH_RUNS ?? 7);

const [org] = await sql`SELECT id FROM organization WHERE key = 'PD'`;
const [user] = await sql`SELECT id FROM user_account WHERE username LIKE 'load\\_pd\\_%' LIMIT 1`;
const orgId = org.id;
const userId = user?.id ?? null;

/**
 * The filter values are READ FROM THE DATA, not written down here.
 *
 * A benchmark that filters on a value the fixture never produced measures an
 * empty index scan and reports it as fast. That happened: the audit filter was
 * pinned to `person.viewed` and the fixture spreads actions round-robin across
 * organizations, so PD had none of them and the case timed 0.3 ms over 0 rows
 * for several runs before anybody looked at the row count.
 */
const [topAction] = await sql`
  SELECT action FROM audit_log WHERE organization_id = ${orgId}
   GROUP BY action ORDER BY count(*) DESC LIMIT 1
`;
const auditAction = topAction?.action ?? 'auth.login';

const cases = [];
const bench = (name, source, query) => cases.push({ name, source, query });

// ── personnel.read.ts — the roster page ────────────────────────────────────
bench('personnel: roster page', 'personnel.read.ts listPersonnel', () => sql`
  SELECT m.id, m.user_id, u.display_name, u.username, m.status, m.callsign,
         m.employee_number, m.joined_at, m.left_at, ms.status_key, un.callsign,
         COALESCE((SELECT MAX(r.hierarchy_level) FROM member_role mr
                    JOIN role r ON r.id = mr.role_id
                   WHERE mr.member_id = m.id AND r.deleted_at IS NULL), 0)::int AS lvl,
         EXISTS (SELECT 1 FROM organization_lead ol
                  WHERE ol.user_id = m.user_id AND ol.organization_id = ${orgId}
                    AND ol.revoked_at IS NULL) AS is_lead
    FROM organization_member m
    JOIN user_account u ON u.id = m.user_id
    LEFT JOIN member_status ms ON ms.member_id = m.id
    LEFT JOIN unit un ON un.id = ms.unit_id
   WHERE m.organization_id = ${orgId} AND m.status = 'active'
   ORDER BY COALESCE((SELECT MAX(r.hierarchy_level) FROM member_role mr
                       JOIN role r ON r.id = mr.role_id
                      WHERE mr.member_id = m.id AND r.deleted_at IS NULL), 0)::int DESC,
            u.display_name ASC, m.id ASC
   LIMIT 50 OFFSET 0
`);

bench('personnel: roster count', 'personnel.read.ts listPersonnel (total)', () => sql`
  SELECT COUNT(*)::int FROM organization_member m
    JOIN user_account u ON u.id = m.user_id
    LEFT JOIN member_status ms ON ms.member_id = m.id
   WHERE m.organization_id = ${orgId} AND m.status = 'active'
`);

bench('personnel: search by name', 'personnel.read.ts listPersonnel (search)', () => sql`
  SELECT m.id FROM organization_member m
    JOIN user_account u ON u.id = m.user_id
   WHERE m.organization_id = ${orgId} AND m.status = 'active'
     AND (u.display_name ILIKE '%Load PD 1%' OR u.username::text ILIKE '%Load PD 1%'
          OR m.callsign::text ILIKE '%Load PD 1%')
   LIMIT 50
`);

// ── person.read.ts — the register ──────────────────────────────────────────
/**
 * The register page, with its REAL predicate and its REAL ordering.
 *
 * This case used to match on the name alone and order by `(last_name,
 * first_name)`, and it reported 49 ms — because that ordering is exactly what
 * `person_last_first_idx` serves, so the planner walked the name index and
 * filtered 45 000 rows rather than touching a trigram index at all.
 *
 * The application does not issue that query. It matches name OR phone OR
 * address and sorts wanted-first, which no single index can serve, so the
 * planner builds a bitmap OR across the three trigram indexes and top-N sorts
 * the result. That is the plan worth timing, and it is three times faster than
 * the simplification that was standing in for it — a good reminder that a
 * benchmark which is not the real query can be wrong in either direction.
 */
bench('persons: register search', 'person.read.ts searchPersons', () => sql`
  SELECT p.id, p.first_name, p.last_name FROM person p
   WHERE p.deleted_at IS NULL
     AND ((p.first_name || ' ' || p.last_name) ILIKE '%Vasquez%'
          OR p.phone_number ILIKE '%Vasquez%'
          OR p.address ILIKE '%Vasquez%')
   ORDER BY EXISTS (SELECT 1 FROM warrant w
                     WHERE w.person_id = p.id AND w.status = 'active') DESC,
            p.last_name, p.first_name, p.id
   LIMIT 25
`);

bench('persons: trigram search', 'search.read.ts persons', () => sql`
  SELECT id, first_name, last_name FROM person
   WHERE deleted_at IS NULL
     AND (first_name || ' ' || last_name) % 'Vasquez'
   ORDER BY similarity(first_name || ' ' || last_name, 'Vasquez') DESC LIMIT 25
`);

// ── vehicle.read.ts ────────────────────────────────────────────────────────
bench('vehicles: plate prefix', 'vehicle.read.ts searchVehicles', () => sql`
  SELECT id, plate, model FROM vehicle
   WHERE deleted_at IS NULL AND plate::text ILIKE 'AB%'
   ORDER BY plate LIMIT 25
`);

/**
 * Global search over vehicles: plate OR model OR display_name.
 *
 * This is the case migration 0010 was written for. `display_name` was the one
 * branch with no trigram index, and an OR the planner cannot fully bitmap is a
 * sequential scan — so the indexes on plate and model bought nothing while it
 * was missing.
 */
bench('vehicles: global search', 'search.read.ts vehicles', () => sql`
  SELECT id, plate, model FROM vehicle
   WHERE deleted_at IS NULL
     AND (plate::text ILIKE '%Fleet 17%'
          OR model ILIKE '%Fleet 17%'
          OR display_name ILIKE '%Fleet 17%')
   ORDER BY plate, id LIMIT 25
`);

bench('vehicles: by owner', 'person profile — owned vehicles', () => sql`
  SELECT v.id, v.plate FROM vehicle v
   WHERE v.owner_person_id = (SELECT id FROM person WHERE notes = 'LOAD' LIMIT 1)
     AND v.deleted_at IS NULL
`);

// ── dispatch.read.ts — the board ───────────────────────────────────────────
bench('dispatch: open queue', 'dispatch.read.ts listIncidents', () => sql`
  SELECT i.id, i.number, i.priority, i.status, i.title, i.created_at
    FROM incident i
   WHERE i.deleted_at IS NULL AND i.closed_at IS NULL
     AND (i.organization_id = ${orgId} OR i.organization_id IS NULL)
   ORDER BY i.priority ASC, i.created_at ASC LIMIT 100
`);

bench('dispatch: assignments for page', 'dispatch.read.ts listAssignments', () => sql`
  SELECT a.incident_id, a.unit_id, u.callsign
    FROM incident_assignment a JOIN unit u ON u.id = a.unit_id
   WHERE a.incident_id IN (
     SELECT id FROM incident WHERE deleted_at IS NULL AND closed_at IS NULL LIMIT 100
   ) AND a.released_at IS NULL
`);

bench('dispatch: unit roster', 'dispatch.read.ts listUnits', () => sql`
  SELECT u.id, u.callsign, u.status_key, u.pos_x, u.pos_y, u.position_updated_at,
         u.current_incident_id
    FROM unit u
   WHERE u.organization_id = ${orgId} AND u.status = 'active'
   ORDER BY u.callsign
`);

// ── map.read.ts ────────────────────────────────────────────────────────────
bench('map: visible units', 'map.read.ts listMapUnits', () => sql`
  SELECT u.id, u.callsign, u.unit_type, u.status_key, u.pos_x, u.pos_y,
         u.heading, u.position_updated_at, u.is_covert, u.organization_id
    FROM unit u
   WHERE u.status = 'active' AND u.disbanded_at IS NULL
     AND (u.organization_id = ${orgId} OR u.is_covert = false)
`);

bench('map: crew per unit', 'map.read.ts crews', () => sql`
  SELECT um.unit_id, m.id, u.display_name
    FROM unit_member um
    JOIN organization_member m ON m.id = um.member_id
    JOIN user_account u ON u.id = m.user_id
   WHERE um.left_at IS NULL
`);

// ── audit.read.ts ──────────────────────────────────────────────────────────
bench('audit: keyset page', 'audit.read.ts searchAuditLog', () => sql`
  SELECT a.id, a.occurred_at, a.action, a.outcome, a.entity_type, a.entity_id
    FROM audit_log a
   ORDER BY a.occurred_at DESC, a.id DESC LIMIT 50
`);

bench('audit: filtered by action', 'audit.read.ts searchAuditLog (action)', () => sql`
  SELECT a.id, a.occurred_at FROM audit_log a
   WHERE a.action = ${auditAction} AND a.organization_id = ${orgId}
   ORDER BY a.occurred_at DESC, a.id DESC LIMIT 50
`);

bench('audit: denied only', 'audit.read.ts severity filter', () => sql`
  SELECT a.id FROM audit_log a
   WHERE a.outcome = 'denied'
   ORDER BY a.occurred_at DESC LIMIT 50
`);

bench('audit: bounded total', 'audit.read.ts countAuditMatches', () => sql`
  SELECT count(*)::int FROM (
    SELECT 1 FROM audit_log a WHERE a.organization_id = ${orgId} LIMIT 10000
  ) x
`);

// ── notifications ──────────────────────────────────────────────────────────
if (userId) {
  bench('notifications: unread badge', 'notification.service.ts unreadSummary', () => sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE severity = 'critical')::int AS critical
      FROM notification WHERE user_id = ${userId} AND read_at IS NULL
  `);

  bench('notifications: head page', 'notification.service.ts listNotifications', () => sql`
    SELECT n.id, n.type, n.severity, n.title, n.created_at, n.read_at
      FROM notification n LEFT JOIN organization o ON o.id = n.organization_id
     WHERE n.user_id = ${userId}
     ORDER BY n.created_at DESC, n.id DESC LIMIT 31
  `);
}

// ── dashboard ──────────────────────────────────────────────────────────────
bench('dashboard: counts', 'dashboard.read.ts', () => sql`
  SELECT
    (SELECT count(*)::int FROM incident
      WHERE deleted_at IS NULL AND closed_at IS NULL
        AND (organization_id = ${orgId} OR organization_id IS NULL)) AS open_calls,
    (SELECT count(*)::int FROM unit
      WHERE organization_id = ${orgId} AND status = 'active') AS units,
    (SELECT count(*)::int FROM organization_member
      WHERE organization_id = ${orgId} AND status = 'active') AS personnel
`);

// ── position history ───────────────────────────────────────────────────────
bench('positions: unit replay window', 'map history', () => sql`
  SELECT pos_x, pos_y, recorded_at FROM position_history
   WHERE unit_id = (SELECT id FROM unit LIMIT 1)
     AND recorded_at > now() - interval '1 hour'
   ORDER BY recorded_at
`);

// ── Run ────────────────────────────────────────────────────────────────────
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log('name'.padEnd(34) + 'median'.padStart(9) + 'p-max'.padStart(9) + '  rows  source');
console.log('─'.repeat(110));

const slow = [];
for (const c of cases) {
  await c.query(); // warm
  const times = [];
  let rows = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = process.hrtime.bigint();
    const r = await c.query();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    rows = r.length;
  }
  const m = median(times);
  const mx = Math.max(...times);
  const flag = m > 50 ? ' ← SLOW' : m > 15 ? ' ← watch' : '';
  console.log(
    c.name.padEnd(34)
    + `${m.toFixed(1)}ms`.padStart(9)
    + `${mx.toFixed(1)}ms`.padStart(9)
    + `  ${String(rows).padStart(5)}  ${c.source}${flag}`,
  );
  if (m > 15) slow.push({ ...c, median: m });
}

if (EXPLAIN && slow.length > 0) {
  for (const c of slow) {
    console.log(`\n═══ ${c.name} (${c.median.toFixed(1)} ms) ═══`);
    // `query` is a thunk over a tagged template; re-issue it under EXPLAIN by
    // asking Postgres to explain the most recent equivalent statement shape.
    console.log('  (run with psql for the plan — the thunk hides the text)');
  }
}

await sql.end();
