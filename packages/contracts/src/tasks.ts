/**
 * Tasks: work one member asked another to do.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PERMISSION-GATED, NOT RANK-GATED
 *
 * The hierarchy rules exist because rank is AUTHORITY. A task is not authority
 * — it is a request with a deadline, and the assignee can complete it, ignore
 * it, or take it up with their supervisor. So `tasks.assign` decides who may
 * assign, and an organization that wants only lieutenants doing so grants it to
 * lieutenants. See docs/architecture/10-dashboard.md §4b.
 *
 * The consequence, stated rather than hidden: a sergeant holding the permission
 * can assign work to the chief. It is visible, audited, and closable — and an
 * agency that considers it insubordinate withholds the permission.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface TaskPriorityMeta {
  key: string;
  label: string;
  shortLabel: string;
  /** A CSS custom property name. The catalogue owns the colour, not a component. */
  colorToken: string;
  sortOrder: number;
}

/**
 * Where a task stands, as one word.
 *
 * `overdue` and `due_soon` are DERIVED from `dueAt` against a clock — never
 * stored. A stored flag would be wrong between the moment a deadline passes and
 * whatever job noticed.
 */
export type TaskState = 'overdue' | 'due_soon' | 'open' | 'completed' | 'cancelled';

/** Within this of the deadline, a task is "due soon" rather than merely open. */
export const TASK_DUE_SOON_MS = 24 * 60 * 60 * 1000;

export interface TaskPerson {
  memberId: string;
  displayName: string;
  callsign: string | null;
}

export interface TaskDto {
  id: string;
  title: string;
  detail: string | null;
  priority: TaskPriorityMeta;
  /** Who it is for. */
  assignee: TaskPerson;
  /** Who asked. Null when that member's row is gone — rare, but not impossible. */
  createdBy: TaskPerson | null;
  createdAt: string;
  dueAt: string | null;
  completedAt: string | null;
  completedBy: TaskPerson | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  /** True when the CALLER is the assignee — the only person who ticks it off. */
  viewerIsAssignee: boolean;
  /** True when the caller created it — they may edit and cancel it. */
  viewerCreated: boolean;
}

export interface TaskListDto {
  tasks: TaskDto[];
  counts: {
    overdue: number;
    dueSoon: number;
    open: number;
  };
}

/**
 * Where a task stands, computed.
 *
 * Takes the clock as an argument rather than reading one, so the function stays
 * pure and the API and the browser cannot disagree about whether something is
 * overdue — the same shape `matchesUnitFilter` and `isFieldRequestLive` use.
 */
export function taskState(
  task: Pick<TaskDto, 'dueAt' | 'completedAt' | 'cancelledAt'>,
  now: number,
): TaskState {
  if (task.cancelledAt !== null) return 'cancelled';
  if (task.completedAt !== null) return 'completed';
  if (task.dueAt === null) return 'open';

  const due = Date.parse(task.dueAt);
  if (due <= now) return 'overdue';
  if (due - now <= TASK_DUE_SOON_MS) return 'due_soon';
  return 'open';
}

/**
 * Ordering for the dashboard: most urgent first, without a click.
 *
 * Overdue before due-soon before open; within a band, the earlier deadline
 * first; a task with no deadline sorts after ones that have passed, by
 * priority. An operator glancing at this panel must see the thing that is
 * already late at the top, and not have to sort to find it.
 */
export function compareTasks(a: TaskDto, b: TaskDto, now: number): number {
  const rank: Record<TaskState, number> = {
    overdue: 0, due_soon: 1, open: 2, completed: 3, cancelled: 4,
  };
  const byState = rank[taskState(a, now)] - rank[taskState(b, now)];
  if (byState !== 0) return byState;

  const byPriority = a.priority.sortOrder - b.priority.sortOrder;
  if (byPriority !== 0) return byPriority;

  // A deadline beats no deadline within the same band and priority.
  if (a.dueAt !== null && b.dueAt !== null) return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  if (a.dueAt !== null) return -1;
  if (b.dueAt !== null) return 1;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** What a client may send. The organization and the creator are derived. */
export interface CreateTaskInput {
  assigneeMemberId: string;
  title: string;
  detail?: string | null;
  priorityKey: string;
  dueAt?: string | null;
}
