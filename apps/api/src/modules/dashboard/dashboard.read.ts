import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  incident, memberStatus, operationalStatus, organizationMember, type Database,
} from '@leoos/db';
import type { DispatchScope } from '../dispatch/dispatch.scope.js';

/**
 * Dashboard statistics.
 *
 * Everything here is scoped the same way the dispatch board is — these are
 * counts over exactly the rows the caller may see, for the same reason search
 * counts are: "MD: 12 on duty" leaks the size of another service's shift even if
 * you cannot list them.
 *
 * The queries live here rather than in the dispatch module because they are
 * statistics rather than operational state, but they take the SAME
 * `DispatchScope`. Dispatch and the dashboard are two views of one situation;
 * giving them two scope types would be two places for the rules to drift apart.
 */

function orgFilter(scope: DispatchScope, column: Parameters<typeof inArray>[0]) {
  if (scope.canViewAllOrganizations) return undefined;
  if (scope.organizationIds.length === 0) return sql`false`;
  return inArray(column, scope.organizationIds);
}

/**
 * Organization restriction for the raw statistics queries.
 *
 * Built from Drizzle's `inArray` and embedded, NOT hand-written as
 * `= ANY(${ids}::uuid[])`. That form looks correct and is not: Drizzle's `sql`
 * template expands a JS array into one placeholder per element, so a
 * single-element array binds as a scalar and Postgres rejects the literal. This
 * has now bitten three times across the map and dispatch modules.
 *
 * The queries below therefore reference the `incident` table UNALIASED, so the
 * qualified column name Drizzle emits (`"incident"."organization_id"`) resolves.
 *
 * Multi-agency calls (`organization_id IS NULL`) are included: they belong to
 * everyone, and excluding them would under-report every statistic on a joint
 * incident.
 */
function statisticsOrgFilter(scope: DispatchScope) {
  if (scope.canViewAllOrganizations) return sql`true`;
  if (scope.organizationIds.length === 0) return sql`incident.organization_id IS NULL`;
  return sql`(${inArray(incident.organizationId, scope.organizationIds)}
              OR incident.organization_id IS NULL)`;
}

// ── Personnel ──────────────────────────────────────────────────────────────

export interface PersonnelCounts {
  onDuty: number;
  signedIn: number;
  inUnits: number;
  total: number;
}

/**
 * Who is on shift, measured two ways.
 *
 * `onDuty` reads `member_status` joined to the status CATALOGUE rather than
 * comparing against a hardcoded key list, so an organization's own status counts
 * correctly the moment it is added (engineering rules 5-7).
 *
 * `signedIn` counts live sessions. The two differ a lot: a status stays where it
 * was left, so a member who went available last week and never came back is
 * still "on duty" and is emphatically not online. Reporting either one alone
 * under the word "online" would be a claim the data does not support, so both
 * are returned and both are labelled for what they are.
 */
export async function countPersonnel(
  db: Database,
  scope: DispatchScope,
): Promise<PersonnelCounts> {
  const [row] = await db
    .select({
      onDuty: sql<number>`count(*) FILTER (
        WHERE ${operationalStatus.isOnDuty} AND ${organizationMember.status} = 'active'
      )::int`,
      signedIn: sql<number>`count(*) FILTER (
        WHERE ${organizationMember.status} = 'active' AND EXISTS (
          SELECT 1 FROM "session" s
           WHERE s.user_id = ${organizationMember.userId}
             AND s.revoked_at IS NULL
             AND s.expires_at > now()
        )
      )::int`,
      inUnits: sql<number>`count(*) FILTER (
        WHERE ${memberStatus.unitId} IS NOT NULL AND ${organizationMember.status} = 'active'
      )::int`,
      total: sql<number>`count(*) FILTER (
        WHERE ${organizationMember.status} = 'active'
      )::int`,
    })
    .from(organizationMember)
    .leftJoin(memberStatus, eq(memberStatus.memberId, organizationMember.id))
    .leftJoin(operationalStatus, eq(operationalStatus.key, memberStatus.statusKey))
    .where(orgFilter(scope, organizationMember.organizationId));

  return {
    onDuty: row?.onDuty ?? 0,
    signedIn: row?.signedIn ?? 0,
    inUnits: row?.inUnits ?? 0,
    total: row?.total ?? 0,
  };
}

// ── Today ──────────────────────────────────────────────────────────────────

export interface TodayCounts {
  opened: number;
  closed: number;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Calls opened and closed in the current server-local day.
 *
 * The window is computed here and RETURNED, so the payload states which day it
 * means rather than leaving the browser to assume its own timezone matches the
 * server's. On a roleplay server whose operators span timezones that assumption
 * is wrong most of the time.
 */
export async function countToday(db: Database, scope: DispatchScope): Promise<TodayCounts> {
  const restriction = scope.canViewAllOrganizations
    ? undefined
    : scope.organizationIds.length === 0
      ? isNull(incident.organizationId)
      : sql`(${inArray(incident.organizationId, scope.organizationIds)}
             OR ${incident.organizationId} IS NULL)`;

  const [row] = await db
    .select({
      opened: sql<number>`count(*) FILTER (
        WHERE ${incident.createdAt} >= date_trunc('day', now())
      )::int`,
      closed: sql<number>`count(*) FILTER (
        WHERE ${incident.closedAt} >= date_trunc('day', now())
      )::int`,
      /**
       * Epoch seconds, not a timestamp.
       *
       * A raw `sql` expression in a projection comes back as a STRING rather
       * than a Date, and the exact text format varies with the server's
       * DateStyle — parsing it is a guess. Epoch is an unambiguous number and
       * converts back to the same instant.
       */
      windowStartEpoch: sql<string>`extract(epoch from date_trunc('day', now()))::text`,
      windowEndEpoch: sql<string>`extract(epoch from now())::text`,
    })
    .from(incident)
    .where(and(isNull(incident.deletedAt), restriction));

  const toDate = (epoch: string | undefined, fallback: Date): Date => {
    const seconds = epoch === undefined ? Number.NaN : Number(epoch);
    return Number.isFinite(seconds) ? new Date(seconds * 1000) : fallback;
  };

  const now = new Date();
  return {
    opened: row?.opened ?? 0,
    closed: row?.closed ?? 0,
    windowStart: toDate(row?.windowStartEpoch, now),
    windowEnd: toDate(row?.windowEndEpoch, now),
  };
}

// ── Durations ──────────────────────────────────────────────────────────────

export interface DurationSample {
  medianSeconds: number | null;
  sampleSize: number;
}

/**
 * Median seconds from a call being created to its first unit being assigned.
 *
 * TIME TO DISPATCH, not response time. It is a real, well-defined number — the
 * assignment row carries its own timestamp — and it is labelled as exactly what
 * it measures rather than borrowed to stand in for something it does not.
 *
 * Median rather than mean: one call left open overnight before anyone touched it
 * would drag a mean somewhere useless, and the figure is read as "what a typical
 * call looks like".
 */
export async function measureTimeToFirstUnit(
  db: Database,
  scope: DispatchScope,
): Promise<DurationSample> {
  const rows = await db.execute<{ median: string | null; n: number }>(sql`
    WITH first_assignment AS (
      SELECT ia.incident_id, min(ia.created_at) AS assigned_at
        FROM incident_assignment ia
       GROUP BY ia.incident_id
    )
    SELECT
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (fa.assigned_at - incident.created_at))
      )::text AS median,
      count(*)::int AS n
      FROM first_assignment fa
      JOIN incident ON incident.id = fa.incident_id
     WHERE incident.deleted_at IS NULL
       AND incident.created_at >= date_trunc('day', now())
       AND fa.assigned_at >= incident.created_at
       AND ${statisticsOrgFilter(scope)}
  `);

  const row = rows[0];
  const median = row?.median == null ? null : Number(row.median);
  return {
    medianSeconds: median === null || Number.isNaN(median) ? null : median,
    sampleSize: row?.n ?? 0,
  };
}

/**
 * Median seconds from a call being created to it being marked Active.
 *
 * Read from the timeline's status transitions. This measures when a DISPATCHER
 * marked the call active, not when a unit physically arrived — those are
 * different events and only the first is recorded anywhere.
 *
 * Only incidents whose transition passed through the dispatch service are
 * counted, so early in a deployment the sample will be small; that is what the
 * sample size on the metric is for.
 */
export async function measureTimeToActive(
  db: Database,
  scope: DispatchScope,
): Promise<DurationSample> {
  const rows = await db.execute<{ median: string | null; n: number }>(sql`
    WITH first_active AS (
      SELECT il.incident_id, min(il.created_at) AS active_at
        FROM incident_log il
       WHERE il.entry_type = 'status_change'
         AND il.metadata ->> 'to' = 'on_scene'
       GROUP BY il.incident_id
    )
    SELECT
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (fa.active_at - incident.created_at))
      )::text AS median,
      count(*)::int AS n
      FROM first_active fa
      JOIN incident ON incident.id = fa.incident_id
     WHERE incident.deleted_at IS NULL
       AND incident.created_at >= date_trunc('day', now())
       AND fa.active_at >= incident.created_at
       AND ${statisticsOrgFilter(scope)}
  `);

  const row = rows[0];
  const median = row?.median == null ? null : Number(row.median);
  return {
    medianSeconds: median === null || Number.isNaN(median) ? null : median,
    sampleSize: row?.n ?? 0,
  };
}

// ── Self ───────────────────────────────────────────────────────────────────

export interface SelfDetailRow extends Record<string, unknown> {
  displayName: string;
  rankName: string | null;
  memberCallsign: string | null;
  employeeNumber: string | null;
  organizationId: string;
  organizationKey: string;
  organizationShortName: string;
  organizationColor: string;
}

/**
 * The signed-in member's identity for the dashboard header.
 *
 * Rank is the member's HIGHEST role by hierarchy level — the same rule the
 * authorization kernel uses for their effective level, so the badge on screen
 * matches the authority the server actually grants them.
 */
export async function getSelfDetail(
  db: Database,
  userId: string,
  organizationId: string | null,
): Promise<SelfDetailRow | null> {
  if (organizationId === null) return null;

  const rows = await db.execute<SelfDetailRow>(sql`
    SELECT
      coalesce(p.first_name || ' ' || p.last_name, ua.display_name) AS "displayName",
      (SELECT r.name FROM member_role mr
         JOIN role r ON r.id = mr.role_id
        WHERE mr.member_id = om.id
        ORDER BY r.hierarchy_level DESC
        LIMIT 1) AS "rankName",
      om.callsign AS "memberCallsign",
      om.employee_number AS "employeeNumber",
      o.id AS "organizationId",
      o.key AS "organizationKey",
      o.short_name AS "organizationShortName",
      o.color AS "organizationColor"
      FROM organization_member om
      JOIN user_account ua ON ua.id = om.user_id
      JOIN organization o ON o.id = om.organization_id
      LEFT JOIN person p ON p.id = om.person_id
     WHERE om.user_id = ${userId} AND om.organization_id = ${organizationId}
     LIMIT 1
  `);

  return rows[0] ?? null;
}
