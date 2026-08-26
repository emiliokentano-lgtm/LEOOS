import { sql } from 'drizzle-orm';
import { TASK_DUE_SOON_MS, type TaskDto, type TaskListDto } from '@leoos/contracts';
import type { Database } from '@leoos/db';
import type { DispatchScope } from '../dispatch/dispatch.scope.js';

/**
 * Reading tasks.
 *
 * OVERDUE IS DERIVED, in SQL, against the database clock — the same rule the
 * DTO's `taskState` applies in the browser. A stored flag would be wrong
 * between the moment a deadline passes and whatever job noticed.
 */

type Row = {
  id: string;
  title: string;
  detail: string | null;
  priority_key: string;
  priority_label: string;
  priority_short: string;
  priority_color: string;
  priority_sort: number;
  assignee_member_id: string;
  assignee_name: string;
  assignee_callsign: string | null;
  creator_member_id: string | null;
  creator_name: string | null;
  creator_callsign: string | null;
  completed_member_id: string | null;
  completed_name: string | null;
  completed_callsign: string | null;
  created_at: string;
  due_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  viewer_is_assignee: boolean;
  viewer_created: boolean;
};

function toDto(row: Row): TaskDto {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    priority: {
      key: row.priority_key,
      label: row.priority_label,
      shortLabel: row.priority_short,
      colorToken: row.priority_color,
      sortOrder: Number(row.priority_sort),
    },
    assignee: {
      memberId: row.assignee_member_id,
      displayName: row.assignee_name,
      callsign: row.assignee_callsign,
    },
    createdBy: row.creator_member_id === null ? null : {
      memberId: row.creator_member_id,
      displayName: row.creator_name ?? 'Unknown',
      callsign: row.creator_callsign,
    },
    createdAt: new Date(row.created_at).toISOString(),
    dueAt: row.due_at === null ? null : new Date(row.due_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    completedBy: row.completed_member_id === null ? null : {
      memberId: row.completed_member_id,
      displayName: row.completed_name ?? 'Unknown',
      callsign: row.completed_callsign,
    },
    cancelledAt: row.cancelled_at === null ? null : new Date(row.cancelled_at).toISOString(),
    cancelledReason: row.cancelled_reason,
    viewerIsAssignee: row.viewer_is_assignee,
    viewerCreated: row.viewer_created,
  };
}

const SELECT = sql`
  SELECT
    t.id, t.title, t.detail,
    t.priority_key,
    p.label AS priority_label, p.short_label AS priority_short,
    p.color_token AS priority_color, p.sort_order AS priority_sort,
    t.assignee_member_id,
    au.display_name AS assignee_name, am.callsign AS assignee_callsign,
    t.created_by_member_id AS creator_member_id,
    cu.display_name AS creator_name, cm.callsign AS creator_callsign,
    t.completed_by_member_id AS completed_member_id,
    du.display_name AS completed_name, dm.callsign AS completed_callsign,
    t.created_at, t.due_at, t.completed_at, t.cancelled_at, t.cancelled_reason
  FROM task t
  JOIN task_priority p ON p.key = t.priority_key
  JOIN organization_member am ON am.id = t.assignee_member_id
  JOIN user_account au ON au.id = am.user_id
  LEFT JOIN organization_member cm ON cm.id = t.created_by_member_id
  LEFT JOIN user_account cu ON cu.id = cm.user_id
  LEFT JOIN organization_member dm ON dm.id = t.completed_by_member_id
  LEFT JOIN user_account du ON du.id = dm.user_id
`;

/**
 * The caller's own open tasks.
 *
 * What the dashboard panel shows. Scoped to the CALLER'S membership, so there
 * is no argument that widens it — a parameter naming somebody else's member id
 * would simply not be read.
 */
export async function listOwnTasks(
  db: Database,
  scope: DispatchScope,
  options: { includeCompleted?: boolean } = {},
): Promise<TaskListDto> {
  if (scope.organizationId === null) {
    return { tasks: [], counts: { overdue: 0, dueSoon: 0, open: 0 } };
  }

  const member = await db.execute<{ id: string }>(sql`
    SELECT id FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
  `);
  const memberId = member[0]?.id;
  if (!memberId) return { tasks: [], counts: { overdue: 0, dueSoon: 0, open: 0 } };

  /**
   * Completed tasks are included only on request, and only RECENT ones.
   *
   * A panel that grows without bound as a shift ticks things off stops being a
   * to-do list and becomes a log. Twenty-four hours is enough to see what you
   * finished today and undo a mistaken tick.
   */
  const completedFilter = options.includeCompleted
    ? sql`AND (t.completed_at IS NULL OR t.completed_at > now() - interval '24 hours')`
    : sql`AND t.completed_at IS NULL`;

  const rows = await db.execute<Row>(sql`
    ${SELECT}
    WHERE t.assignee_member_id = ${memberId}
      AND t.cancelled_at IS NULL
      ${completedFilter}
    ORDER BY t.due_at ASC NULLS LAST, p.sort_order ASC, t.created_at ASC
    LIMIT 100
  `);

  const [counts] = await db.execute<{ overdue: number; due_soon: number; open: number }>(sql`
    SELECT
      count(*) FILTER (WHERE t.due_at IS NOT NULL AND t.due_at <= now())::int AS overdue,
      count(*) FILTER (
        WHERE t.due_at IS NOT NULL AND t.due_at > now()
          AND t.due_at <= now() + ${`${TASK_DUE_SOON_MS / 1000} seconds`}::interval
      )::int AS due_soon,
      count(*)::int AS open
      FROM task t
     WHERE t.assignee_member_id = ${memberId}
       AND t.completed_at IS NULL AND t.cancelled_at IS NULL
  `);

  return {
    tasks: rows.map((row) => ({
      ...toDto(row),
      viewerIsAssignee: true,
      viewerCreated: row.creator_member_id === memberId,
    })),
    counts: {
      overdue: counts?.overdue ?? 0,
      dueSoon: counts?.due_soon ?? 0,
      open: counts?.open ?? 0,
    },
  };
}

/**
 * Open tasks across the organization.
 *
 * For somebody who assigns work and wants to see what is outstanding. Gated on
 * `tasks.assign` — a member who cannot assign has no reason to read everybody
 * else's workload, and letting them would make this a surveillance surface.
 */
export async function listOrganizationTasks(
  db: Database,
  scope: DispatchScope,
): Promise<TaskListDto> {
  if (scope.organizationId === null || !scope.canAssignTasks) {
    return { tasks: [], counts: { overdue: 0, dueSoon: 0, open: 0 } };
  }

  const member = await db.execute<{ id: string }>(sql`
    SELECT id FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
  `);
  const memberId = member[0]?.id ?? null;

  const rows = await db.execute<Row>(sql`
    ${SELECT}
    WHERE t.organization_id = ${scope.organizationId}
      AND t.completed_at IS NULL AND t.cancelled_at IS NULL
    ORDER BY t.due_at ASC NULLS LAST, p.sort_order ASC, t.created_at ASC
    LIMIT 200
  `);

  return {
    tasks: rows.map((row) => ({
      ...toDto(row),
      viewerIsAssignee: row.assignee_member_id === memberId,
      viewerCreated: row.creator_member_id === memberId,
    })),
    counts: { overdue: 0, dueSoon: 0, open: rows.length },
  };
}
