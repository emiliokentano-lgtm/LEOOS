import { sql } from 'drizzle-orm';
import type { Database } from '@leoos/db';

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

  await tx.execute(sql`
    SELECT id FROM organization_member
    WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]`)})
    ORDER BY id
    FOR UPDATE
  `);
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

  await tx.execute(sql`
    SELECT id FROM organization_member
    WHERE organization_id = ${organizationId}
      AND user_id = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]`)})
    ORDER BY id
    FOR UPDATE
  `);
}
