import { sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, type Database } from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from '../dispatch/dispatch.scope.js';
import { notificationEmissions, type DispatchOutcome } from '../dispatch/dispatch.events.js';
import { createNotifications } from '../notifications/notification.service.js';

/**
 * Tasks.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE RULES, AND THEY ARE DIFFERENT FROM EACH OTHER
 *
 *   ASSIGNING  needs `tasks.assign` and a shared organization. Not a rank
 *              ceiling: a task is a request with a deadline, not authority, so
 *              importing H1–H8 would answer a question tasks do not raise.
 *              See docs/architecture/10-dashboard.md §4b.
 *
 *   COMPLETING is the ASSIGNEE's, and nobody else's. Not the creator's, not a
 *              supervisor's. Somebody else ticking off your work would make the
 *              record say you did something you did not.
 *
 *   CANCELLING is the CREATOR's. They asked for it; they can say it is no
 *              longer needed. The assignee cannot make work disappear by
 *              deciding it does not matter.
 *
 * All three are decided inside the transaction against rows read under lock.
 * ────────────────────────────────────────────────────────────────────────────
 */

type LockedMembership = {
  id: string;
  organization_id: string;
  status: string;
};

async function lockOwnMembership(
  tx: Database,
  scope: DispatchScope,
): Promise<LockedMembership | null> {
  if (scope.organizationId === null) return null;
  const rows = await tx.execute<LockedMembership>(sql`
    SELECT id, organization_id, status FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
     FOR UPDATE
  `);
  return rows[0] ?? null;
}

export interface CreateTaskInput {
  assigneeMemberId: string;
  title: string;
  detail: string | null;
  priorityKey: string;
  dueAt: Date | null;
}

export async function createTask(
  db: Database,
  scope: DispatchScope,
  input: CreateTaskInput,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string }>> {
  if (!scope.canAssignTasks) {
    throw new ForbiddenError('You cannot assign tasks.');
  }

  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) {
      throw new ForbiddenError('You are not a member of this organization.');
    }
    if (membership.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot assign tasks.');
    }

    /**
     * The assignee must be an ACTIVE member of the SAME organization.
     *
     * Read here, under lock, rather than trusted from the request. A member id
     * from another agency resolves to nothing — the caller is told the person
     * was not found rather than that they exist elsewhere, which is the same
     * rule the rest of the product follows about other organizations.
     */
    const assignee = await tx.execute<{ id: string; user_id: string; status: string }>(sql`
      SELECT id, user_id, status FROM organization_member
       WHERE id = ${input.assigneeMemberId}
         AND organization_id = ${membership.organization_id}
       FOR UPDATE
    `);
    const target = assignee[0];
    if (!target) {
      throw new NotFoundError('That person is not in your organization.');
    }
    if (target.status !== 'active') {
      throw new ConflictError(
        'ASSIGNEE_NOT_ACTIVE',
        'That membership is not active. A task assigned to somebody who has left '
        + 'would sit open forever.',
      );
    }

    const priority = await tx.execute<{ key: string }>(sql`
      SELECT key FROM task_priority WHERE key = ${input.priorityKey} AND is_active
    `);
    if (!priority[0]) {
      throw new ValidationError([{ path: 'priorityKey', message: 'Unknown priority.' }]);
    }

    /**
     * A deadline in the past is refused.
     *
     * Not clamped and not accepted: a task created already overdue is either a
     * typo or a way of making the panel look alarming, and both are better
     * answered at the moment of typing than discovered on somebody's screen.
     */
    if (input.dueAt !== null && input.dueAt.getTime() < Date.now() - 60_000) {
      throw new ValidationError([{ path: 'dueAt', message: 'A deadline cannot be in the past.' }]);
    }

    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO task
        (organization_id, assignee_member_id, created_by_member_id,
         title, detail, priority_key, due_at)
      VALUES
        (${membership.organization_id}, ${target.id}, ${membership.id},
         ${input.title}, ${input.detail}, ${input.priorityKey},
         ${input.dueAt === null ? null : input.dueAt.toISOString()}::timestamptz)
      RETURNING id
    `);
    if (!row) throw new ConflictError('TASK_NOT_CREATED', 'The task could not be created.');

    /**
     * The assignee is told, inside this transaction.
     *
     * A rolled-back assignment must leave no "you were assigned" in anybody's
     * bell — which is why the notification row is written here and the
     * DELIVERY happens in the route, after the commit.
     */
    const deliveries = await createNotifications(
      tx,
      [{ userId: target.user_id, memberId: target.id }],
      {
        type: 'task.assigned',
        organizationId: membership.organization_id,
        title: `New task: ${input.title}`,
        body: input.detail,
        href: '/dashboard',
        entityType: 'task',
        entityId: row.id,
      },
    );

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.TASK_ASSIGNED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'task',
      entityId: row.id,
      metadata: {
        assigneeMemberId: target.id,
        priorityKey: input.priorityKey,
        dueAt: input.dueAt?.toISOString() ?? null,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return { result: { id: row.id }, events: notificationEmissions(deliveries) };
  });
}

/**
 * Ticking a task off.
 *
 * THE ASSIGNEE'S, AND NOBODY ELSE'S — not the creator's, not a supervisor's.
 * Somebody else marking your work done would make the record say you did
 * something you did not, and the record is the whole point of having a row
 * rather than a message in a chat.
 */
export async function completeTask(
  db: Database,
  scope: DispatchScope,
  taskId: string,
  done: boolean,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string; completed: boolean }>> {
  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) {
      throw new ForbiddenError('You are not a member of this organization.');
    }

    const rows = await tx.execute<{
      id: string;
      assignee_member_id: string;
      organization_id: string;
      completed_at: string | null;
      cancelled_at: string | null;
    }>(sql`
      SELECT id, assignee_member_id, organization_id, completed_at, cancelled_at
        FROM task WHERE id = ${taskId} FOR UPDATE
    `);
    const found = rows[0];
    // Another organization's task is NOT FOUND, not forbidden.
    if (!found || found.organization_id !== membership.organization_id) {
      throw new NotFoundError('That task no longer exists.');
    }
    if (found.assignee_member_id !== membership.id) {
      throw new ForbiddenError('Only the person a task is assigned to can complete it.');
    }
    if (found.cancelled_at !== null) {
      throw new ConflictError('TASK_CANCELLED', 'That task was cancelled.');
    }

    /**
     * Re-opening is allowed, and it is why this takes a boolean.
     *
     * People tick the wrong row. Making completion one-way would mean the only
     * fix is a new task, which loses the deadline and the history — and would
     * teach operators to be careful with a checkbox instead of teaching the
     * checkbox to be forgiving.
     */
    await tx.execute(sql`
      UPDATE task
         SET completed_at = ${done ? sql`now()` : sql`NULL`},
             completed_by_member_id = ${done ? membership.id : null}
       WHERE id = ${taskId}
    `);

    await writeAudit(tx, {
      action: done ? AUDIT_ACTIONS.TASK_COMPLETED : AUDIT_ACTIONS.TASK_REOPENED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'task',
      entityId: taskId,
      metadata: {},
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return { result: { id: taskId, completed: done }, events: [] };
  });
}

/**
 * Cancelling.
 *
 * THE CREATOR'S. They asked for it, so they can say it is no longer needed.
 * The assignee deliberately cannot: making work disappear by deciding it does
 * not matter is the one thing this feature must not enable.
 */
export async function cancelTask(
  db: Database,
  scope: DispatchScope,
  taskId: string,
  reason: string | null,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string }>> {
  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) {
      throw new ForbiddenError('You are not a member of this organization.');
    }

    const rows = await tx.execute<{
      id: string;
      created_by_member_id: string | null;
      organization_id: string;
      completed_at: string | null;
      cancelled_at: string | null;
    }>(sql`
      SELECT id, created_by_member_id, organization_id, completed_at, cancelled_at
        FROM task WHERE id = ${taskId} FOR UPDATE
    `);
    const found = rows[0];
    if (!found || found.organization_id !== membership.organization_id) {
      throw new NotFoundError('That task no longer exists.');
    }
    if (found.created_by_member_id !== membership.id) {
      throw new ForbiddenError('Only the person who assigned a task can cancel it.');
    }
    if (found.cancelled_at !== null) {
      throw new ConflictError('TASK_CANCELLED', 'That task is already cancelled.');
    }

    // Soft, per ADR-0008: what was asked for and then not needed is a fact.
    await tx.execute(sql`
      UPDATE task SET cancelled_at = now(), cancelled_reason = ${reason},
                      completed_at = NULL, completed_by_member_id = NULL
       WHERE id = ${taskId}
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.TASK_CANCELLED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'task',
      entityId: taskId,
      metadata: { reason },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return { result: { id: taskId }, events: [] };
  });
}

/**
 * Cancels the open tasks of somebody who has left.
 *
 * Called from the termination path, in ITS transaction. They cannot do them,
 * and leaving open work pointing at somebody who has gone makes every count on
 * every dashboard wrong. Tasks they CREATED are untouched: the work still needs
 * doing, and who asked for it is part of the record.
 *
 * Returns the number cancelled so the caller can record it.
 */
export async function cancelTasksForDepartedMember(
  tx: Database,
  memberId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE task
       SET cancelled_at = now(),
           cancelled_reason = 'The person this was assigned to left the organization.'
     WHERE assignee_member_id = ${memberId}
       AND completed_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `);
  return rows.length;
}
