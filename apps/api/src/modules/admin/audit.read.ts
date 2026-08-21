import { sql, type SQL } from 'drizzle-orm';
import { auditLog, type Database } from '@leoos/db';
import type { AuditQuery, AuditSeverity } from '@leoos/contracts';
import type { AuditRow } from './admin.dto.js';

/**
 * Searching an append-only log that only ever grows.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO DECISIONS WORTH THE WORDS
 *
 * 1. KEYSET PAGING, NOT OFFSET. New rows arrive at the head of this table while
 *    somebody is reading it. `OFFSET 200` re-counts from a list that has shifted
 *    underneath the reader, so page 3 silently repeats rows from page 2 and
 *    skips others. The cursor is `(occurred_at, id)` — a position in the data
 *    rather than a distance from a moving edge.
 *
 * 2. SEVERITY IS A DERIVED FILTER, EXPANDED SERVER-SIDE. There is no severity
 *    column (see the note in packages/contracts/src/admin.ts). Filtering by it
 *    could be done in the browser over whatever page happened to load, which
 *    would make "show me critical events" mean "show me the critical events
 *    among the last fifty". Instead the severity is expanded into the WHERE
 *    clause it implies — a set of action prefixes and an outcome — so the filter
 *    searches the whole table.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Beyond this the API reports the bound it checked instead of a real count. */
const COUNT_CEILING = 5_000;

const PRIVILEGED_PREFIXES = [
  'user.', 'organization.', 'role.', 'permission.', 'admin.', 'game_server.',
];

const INFO_ACTIONS = [
  'auth.login', 'auth.logout', 'person.viewed', 'vehicle.viewed',
  'search.performed', 'map.history_viewed', 'person.medical_viewed',
];

/**
 * The severity predicate, as SQL.
 *
 * It must agree with `auditSeverityOf` in the contracts package: a row this
 * clause selects has to be a row the DTO layer then labels with the same
 * severity, or the screen shows entries that contradict the filter that found
 * them. `severityMatchesInJs` below is the same rule in TypeScript, and a test
 * runs both over the whole action catalogue rather than trusting careful
 * reading.
 */
function severityClause(severity: AuditSeverity): SQL {
  const privileged = sql.join(
    PRIVILEGED_PREFIXES.map((p) => sql`${auditLog.action} LIKE ${`${p}%`}`),
    sql` OR `,
  );
  const infoList = sql.join(INFO_ACTIONS.map((a) => sql`${a}`), sql`, `);

  switch (severity) {
    case 'critical':
      return sql`((${auditLog.outcome} = 'denied' AND (${privileged}))
        OR (${auditLog.outcome} = 'success' AND ${auditLog.action} = 'admin.record_purged'))`;
    case 'high':
      return sql`((${auditLog.outcome} = 'denied' AND NOT (${privileged}))
        OR ${auditLog.outcome} = 'error'
        OR (${auditLog.outcome} = 'success'
            AND (${privileged})
            AND ${auditLog.action} <> 'admin.record_purged'))`;
    case 'info':
      return sql`(${auditLog.outcome} = 'success'
        AND NOT (${privileged})
        AND ${auditLog.action} IN (${infoList}))`;
    case 'notice':
      return sql`(${auditLog.outcome} = 'success'
        AND NOT (${privileged})
        AND ${auditLog.action} NOT IN (${infoList}))`;
  }
}

/**
 * The severity predicate again, in TypeScript.
 *
 * Exported so a test can run BOTH implementations across every action in the
 * catalogue and assert they select the same rows. Two implementations of one
 * rule are exactly the pair that drifts, and the drift here is invisible: the
 * filter quietly omits rows and the screen looks like a quiet day.
 */
export function severityMatchesInJs(
  severity: AuditSeverity,
  action: string,
  outcome: 'success' | 'denied' | 'error',
): boolean {
  const privileged = PRIVILEGED_PREFIXES.some((p) => action.startsWith(p));
  switch (severity) {
    case 'critical':
      return (outcome === 'denied' && privileged)
        || (outcome === 'success' && action === 'admin.record_purged');
    case 'high':
      return (outcome === 'denied' && !privileged)
        || outcome === 'error'
        || (outcome === 'success' && privileged && action !== 'admin.record_purged');
    case 'info':
      return outcome === 'success' && !privileged && INFO_ACTIONS.includes(action);
    case 'notice':
      return outcome === 'success' && !privileged && !INFO_ACTIONS.includes(action);
  }
}

export interface DecodedCursor {
  occurredAt: Date;
  id: string;
}

export function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id) return null;
    const occurredAt = new Date(at);
    if (Number.isNaN(occurredAt.getTime())) return null;
    // A malformed cursor is treated as absent rather than as an error: it is a
    // navigation aid, and refusing the whole page because a URL was edited would
    // be a worse answer than showing the first page.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

function buildWhere(query: AuditQuery): SQL | undefined {
  const clauses: SQL[] = [];

  if (query.search) {
    const needle = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(sql`(${auditLog.action} ILIKE ${needle}
      OR ${auditLog.actorLabel} ILIKE ${needle}
      OR ${auditLog.entityType} ILIKE ${needle})`);
  }
  if (query.actorUserId) clauses.push(sql`${auditLog.actorUserId} = ${query.actorUserId}`);
  if (query.action) clauses.push(sql`${auditLog.action} = ${query.action}`);
  if (query.actionPrefix) {
    clauses.push(sql`${auditLog.action} LIKE ${`${query.actionPrefix}%`}`);
  }
  if (query.organizationId) {
    clauses.push(sql`${auditLog.organizationId} = ${query.organizationId}`);
  }
  if (query.entityType) clauses.push(sql`${auditLog.entityType} = ${query.entityType}`);
  if (query.entityId) clauses.push(sql`${auditLog.entityId} = ${query.entityId}`);
  if (query.outcome) clauses.push(sql`${auditLog.outcome} = ${query.outcome}`);
  if (query.severity) clauses.push(severityClause(query.severity));
  if (query.from) clauses.push(sql`${auditLog.occurredAt} >= ${query.from}`);
  if (query.to) clauses.push(sql`${auditLog.occurredAt} <= ${query.to}`);

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor) {
    // Row-value comparison, which uses the (occurred_at, id) ordering directly
    // and stays on the index.
    clauses.push(sql`(${auditLog.occurredAt}, ${auditLog.id})
      < (${cursor.occurredAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
  }

  if (clauses.length === 0) return undefined;
  return sql.join(clauses, sql` AND `);
}

export interface AuditSearchResult {
  rows: AuditRow[];
  nextCursor: string | null;
  approximateTotal: number;
  totalIsExact: boolean;
}

export async function searchAuditLog(
  db: Database,
  query: AuditQuery,
): Promise<AuditSearchResult> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where = buildWhere(query);
  const whereSql = where ? sql`WHERE ${where}` : sql``;

  /**
   * The table is NOT aliased.
   *
   * `buildWhere` composes its clauses from Drizzle column objects, which render
   * as fully-qualified `"audit_log"."action"` references. Aliasing the table to
   * `a` here would leave those references pointing at a name the query no
   * longer has, and every filtered search would fail at the database.
   */
  const rows = await db.execute<AuditRow>(sql`
    SELECT audit_log.id,
           audit_log.occurred_at      AS "occurredAt",
           audit_log.actor_type       AS "actorType",
           audit_log.actor_user_id    AS "actorUserId",
           audit_log.actor_label      AS "actorLabel",
           audit_log.action,
           audit_log.outcome,
           audit_log.entity_type      AS "entityType",
           audit_log.entity_id        AS "entityId",
           audit_log.organization_id  AS "organizationId",
           o.key                      AS "organizationKey",
           o.name                     AS "organizationName",
           o.short_name               AS "organizationShortName",
           o.category::text           AS "organizationCategory",
           o.color                    AS "organizationColor",
           audit_log.metadata,
           audit_log.ip::text         AS ip,
           audit_log.request_id       AS "requestId"
    FROM ${auditLog}
    LEFT JOIN organization o ON o.id = audit_log.organization_id
    ${whereSql}
    ORDER BY audit_log.occurred_at DESC, audit_log.id DESC
    LIMIT ${limit + 1}
  `);

  // One extra row was requested purely to learn whether another page exists,
  // which is cheaper and more truthful than a second count query.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const counted = await db.execute<{ value: number }>(sql`
    SELECT count(*)::int AS value FROM (
      SELECT 1 FROM ${auditLog} ${whereSql} LIMIT ${COUNT_CEILING + 1}
    ) capped
  `);
  const total = counted[0]?.value ?? 0;

  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(new Date(last.occurredAt), last.id) : null,
    approximateTotal: Math.min(total, COUNT_CEILING),
    totalIsExact: total <= COUNT_CEILING,
  };
}

/**
 * Display names for the entities a page of audit rows points at.
 *
 * Resolved in bulk, per entity type, rather than by joining every possible
 * target table into the main query — that join list would be a dozen LEFT JOINs
 * for a label, most of them null on any given row.
 *
 * A missing name is not an error. Audit rows outlive the things they describe
 * on purpose: an entry about a deleted role should still say what happened, and
 * the id is what it always was.
 */
export async function resolveEntityLabels(
  db: Database,
  rows: readonly { entityType: string | null; entityId: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byType = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.entityType || !row.entityId) continue;
    const set = byType.get(row.entityType) ?? new Set<string>();
    set.add(row.entityId);
    byType.set(row.entityType, set);
  }

  const lookups: Record<string, { table: string; column: string }> = {
    user_account: { table: 'user_account', column: 'display_name' },
    organization: { table: 'organization', column: 'name' },
    role: { table: 'role', column: 'name' },
    organization_member: { table: 'organization_member', column: 'callsign' },
    person: { table: 'person', column: 'last_name' },
    vehicle: { table: 'vehicle', column: 'plate' },
    incident: { table: 'incident', column: 'number' },
    unit: { table: 'unit', column: 'callsign' },
    game_server: { table: 'game_server', column: 'name' },
  };

  await Promise.all([...byType.entries()].map(async ([type, ids]) => {
    const lookup = lookups[type];
    if (!lookup) return;

    const idList = sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `);
    const found = await db.execute<{ id: string; label: string | null }>(sql`
      SELECT id::text AS id, ${sql.raw(lookup.column)}::text AS label
      FROM ${sql.raw(lookup.table)}
      WHERE id IN (${idList})
    `);
    for (const row of found) {
      if (row.label) out.set(`${type}:${row.id}`, row.label);
    }
  }));

  return out;
}

/** Distinct actions actually present in the log, for the filter bar. */
export async function distinctAuditActions(db: Database): Promise<string[]> {
  const rows = await db.execute<{ action: string }>(sql`
    SELECT DISTINCT action FROM ${auditLog} ORDER BY action
  `);
  return rows.map((r) => r.action);
}
