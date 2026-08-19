import { and, asc, eq, inArray } from 'drizzle-orm';
import { organizationMember, type Database } from '@leoos/db';

/**
 * Row locking for personnel mutations.
 *
 * Every personnel change is a decision about two people: the actor's rank and
 * the target's. Both must be held still while the decision is made and applied,
 * or the decision is a guess about the past.
 *
 * THE RACE THIS CLOSES
 *
 *   t0  the Chief demotes Sgt. A from Sergeant (50) to Officer (30)
 *   t0  Sgt. A concurrently submits "promote B to level 45"
 *
 * Without a lock, A's context can be read before the demotion commits, so a
 * stale check approves an action A is no longer entitled to perform. Fire enough
 * parallel requests and this is reliably exploitable, not theoretical
 * (docs/architecture/02-authorization.md §B.5).
 *
 * THE DEADLOCK THIS AVOIDS
 *
 * If A manages B while B manages A, each transaction wants the other's row.
 * Locking in ascending id order means both take the same row first, so one waits
 * instead of both waiting on each other.
 */
export async function lockMemberships(
  tx: Database,
  memberIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(memberIds.filter(Boolean))];
  if (ids.length === 0) return;

  /**
   * Built with the query builder rather than raw SQL.
   *
   * The ids come from internal state today, which is exactly the reasoning that
   * turns into an injection the first time someone reuses this helper with a
   * value off a request body. Interpolating them was the original form; binding
   * them into a raw `= ANY(...)` was the obvious fix and is WRONG — Drizzle's
   * `sql` template expands a JS array into one placeholder per element, so a
   * single-element array binds as a scalar and Postgres rejects the literal.
   *
   * `inArray` handles it, is typechecked, and keeps the ORDER BY ... FOR UPDATE
   * that the deadlock note above depends on.
   */
  await tx
    .select({ id: organizationMember.id })
    .from(organizationMember)
    .where(inArray(organizationMember.id, ids))
    .orderBy(asc(organizationMember.id))
    .for('update');
}

/**
 * Locks by user id rather than membership id, for the actor whose membership row
 * may not be known yet.
 */
export async function lockMembershipsByUser(
  tx: Database,
  organizationId: string,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;

  // Same reasoning as above: query builder, bound ids, ordered lock.
  await tx
    .select({ id: organizationMember.id })
    .from(organizationMember)
    .where(and(
      eq(organizationMember.organizationId, organizationId),
      inArray(organizationMember.userId, ids),
    ))
    .orderBy(asc(organizationMember.id))
    .for('update');
}
