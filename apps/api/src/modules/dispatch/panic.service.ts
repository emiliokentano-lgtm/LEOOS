import { eq, sql } from 'drizzle-orm';
import {
  AUDIT_ACTIONS, memberStatus, memberStatusHistory, panicEvent, unit, type Database,
} from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from './dispatch.scope.js';
import type { DispatchOutcome } from './dispatch.events.js';

/**
 * Panic.
 *
 * THE BRIEF IS EXPLICIT that panic must not be "merely a visual frontend state",
 * and this file is where that is made true. A panic is:
 *
 *   1. a ROW in `panic_event`, with its own lifecycle — raised, acknowledged,
 *      resolved — because each of those is a fact somebody will later need to
 *      establish, and "who saw it and when" is the first question asked;
 *   2. a STATUS change on the member and their unit, so every board, the unit
 *      list and the map all show it without any of them knowing about panic
 *      specifically;
 *   3. an AUDIT record, written in the same transaction;
 *   4. a bump to the dispatch revision, so every polling client picks it up on
 *      its next tick — which is what "other authorized users receive a real-time
 *      notification" means until the WebSocket lands.
 *
 * None of that is reversible by a browser. A client that never renders the alert
 * changes nothing about the fact that it happened.
 *
 * The WebSocket now carries point 4 as well: a `panic.triggered` event goes to
 * `org:<id>:panic`, a topic gated on `dispatch.view` in the subscriber's own
 * organization. The revision bump remains, and is what a client that has lost
 * its socket still recovers from — the feed is an accelerator, not the only
 * path.
 *
 * WHO CAN RAISE ONE. `dispatch.panic` is seeded to essentially everyone, and the
 * check here is deliberately the weakest in the module: the moment someone needs
 * this is the worst possible moment to discover they lack a permission. What is
 * gated properly is ACKNOWLEDGING and RESOLVING — those are dispatcher actions
 * and they are what the record is read for.
 */

async function lockOwnMembership(tx: Database, scope: DispatchScope) {
  if (scope.organizationId === null) return null;
  const rows = await tx.execute<{
    id: string; organization_id: string; status: string;
  }>(sql`
    SELECT id, organization_id, status FROM organization_member
     WHERE user_id = ${scope.actorUserId} AND organization_id = ${scope.organizationId}
     FOR UPDATE
  `);
  return rows[0] ?? null;
}

export interface TriggerPanicInput {
  /** Where the alert was raised, when the client knows. */
  x: number | null;
  y: number | null;
  /** `web` today; the FiveM bridge will raise with its own source. */
  source: string;
}

export async function triggerPanic(
  db: Database,
  scope: DispatchScope,
  input: TriggerPanicInput,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string }>> {
  if (!scope.canTriggerPanic) throw new ForbiddenError('You cannot raise a panic alert.');

  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) throw new ForbiddenError('You are not a member of this organization.');
    if (membership.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot raise a panic alert.');
    }

    /**
     * An existing unresolved panic is returned rather than duplicated.
     *
     * Someone in trouble hits the button repeatedly — that is what people do.
     * Ten rows for one emergency makes the board harder to read at the exact
     * moment it matters most, and the second press is not new information.
     */
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM panic_event
       WHERE member_id = ${membership.id} AND resolved_at IS NULL
       ORDER BY created_at DESC LIMIT 1
    `);
    // A repeat press is answered with the live alert and emits nothing: the
    // board already shows it, and a second toast for the same emergency is noise
    // at the moment noise costs most.
    if (existing[0]) return { result: { id: existing[0].id }, events: [] };

    const crewing = await tx.execute<{ unit_id: string | null }>(sql`
      SELECT unit_id FROM unit_member
       WHERE member_id = ${membership.id} AND left_at IS NULL
    `);
    const unitId = crewing[0]?.unit_id ?? null;

    /**
     * Position falls back to the unit's last known one.
     *
     * A browser has no idea where the character is; the unit's cached position
     * is the best available answer and is far better than none. It is recorded
     * on the event rather than read live later, because where they were WHEN
     * they called is the operational question.
     */
    let posX = input.x;
    let posY = input.y;
    if ((posX === null || posY === null) && unitId !== null) {
      const pos = await tx.execute<{ pos_x: number | null; pos_y: number | null }>(sql`
        SELECT pos_x, pos_y FROM unit WHERE id = ${unitId}
      `);
      posX = posX ?? pos[0]?.pos_x ?? null;
      posY = posY ?? pos[0]?.pos_y ?? null;
    }

    let incidentId: string | null = null;
    if (unitId !== null) {
      const call = await tx.execute<{ incident_id: string }>(sql`
        SELECT incident_id FROM incident_assignment
         WHERE unit_id = ${unitId} AND released_at IS NULL
         ORDER BY created_at DESC LIMIT 1
      `);
      incidentId = call[0]?.incident_id ?? null;
    }

    const [created] = await tx.insert(panicEvent).values({
      memberId: membership.id,
      organizationId: membership.organization_id,
      unitId,
      incidentId,
      posX,
      posY,
      source: input.source,
    }).returning({ id: panicEvent.id });

    if (!created) throw new ConflictError('PANIC_FAILED', 'The alert could not be raised.');

    // The status change is what makes the alert visible everywhere without any
    // screen having to know about panic specifically — the map desaturates and
    // rings it, the board counts it, the unit list shows it.
    const before = await tx.execute<{ status_key: string }>(sql`
      SELECT status_key FROM member_status WHERE member_id = ${membership.id}
    `);
    const previous = before[0]?.status_key ?? null;

    await tx.insert(memberStatus)
      .values({ memberId: membership.id, statusKey: 'panic', unitId })
      .onConflictDoUpdate({
        target: memberStatus.memberId,
        set: { statusKey: 'panic', since: new Date(), updatedAt: new Date() },
      });

    await tx.insert(memberStatusHistory).values({
      memberId: membership.id,
      fromStatusKey: previous,
      toStatusKey: 'panic',
      unitId,
      changedBy: scope.actorUserId,
    });

    let unitCallsign: string | null = null;
    if (unitId !== null) {
      const crewed = await tx.execute<{ callsign: string }>(sql`
        SELECT callsign FROM unit WHERE id = ${unitId}
      `);
      unitCallsign = crewed[0]?.callsign ?? null;
      await tx.update(unit).set({ statusKey: 'panic' }).where(eq(unit.id, unitId));
    }

    const who = await tx.execute<{ display_name: string; callsign: string | null }>(sql`
      SELECT ua.display_name, om.callsign
        FROM organization_member om
        JOIN user_account ua ON ua.id = om.user_id
       WHERE om.id = ${membership.id}
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PANIC_TRIGGERED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'panic_event', entityId: created.id,
      metadata: {
        memberId: membership.id, unitId, incidentId,
        position: posX === null || posY === null ? null : { x: posX, y: posY },
        source: input.source,
      },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    return {
      result: created,
      events: [{
        kind: 'panic.triggered',
        organizationId: membership.organization_id,
        payload: {
          panicId: created.id,
          memberId: membership.id,
          memberName: who[0]?.display_name ?? 'Unknown',
          callsign: who[0]?.callsign ?? null,
          unitId,
          unitCallsign,
          // The position is sent because a dispatcher needs to know WHERE, and
          // it is null rather than guessed when nothing is known. A panic marker
          // at a made-up coordinate is worse than no marker.
          position: posX === null || posY === null ? null : { x: posX, y: posY },
        },
      }],
    };
  });
}

/**
 * Marks a panic as SEEN.
 *
 * Acknowledgement deliberately does NOT clear the alert or restore the status.
 * "A dispatcher has seen this" and "the officer is safe" are different facts,
 * and collapsing them would let an alert disappear from every board while the
 * situation is still running.
 */
export async function acknowledgePanic(
  db: Database,
  scope: DispatchScope,
  panicId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string; organization_id: string; acknowledged_at: Date | null; resolved_at: Date | null;
    }>(sql`
      SELECT id, organization_id, acknowledged_at, resolved_at FROM panic_event
       WHERE id = ${panicId}
       FOR UPDATE
    `);
    const event = rows[0];
    if (!event) throw new NotFoundError('panic alert');

    if (!scope.canViewAllOrganizations
      && !scope.organizationIds.includes(event.organization_id)) {
      throw new NotFoundError('panic alert');
    }
    if (!scope.canAcknowledgePanic) {
      throw new ForbiddenError('You cannot acknowledge panic alerts.');
    }
    if (event.resolved_at !== null) {
      throw new ConflictError('PANIC_RESOLVED', 'That alert is already resolved.');
    }
    // First acknowledgement wins. A second one would overwrite who actually
    // responded first, which is the fact the record exists to hold.
    if (event.acknowledged_at !== null) return { result: null, events: [] };

    await tx.update(panicEvent).set({
      acknowledgedBy: scope.actorUserId,
      acknowledgedAt: new Date(),
    }).where(eq(panicEvent.id, panicId));

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PANIC_ACKNOWLEDGED,
      actorUserId: scope.actorUserId,
      organizationId: event.organization_id,
      entityType: 'panic_event', entityId: panicId,
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * Acknowledgement emits nothing on the panic topic.
     *
     * It is not a change to the emergency — the officer is exactly as much in
     * trouble as they were a second ago — and firing an event for it would put a
     * second alert-shaped message on every console for a fact that is only
     * interesting inside the alert's own detail. The dispatch revision carries
     * it, which is where a board reads it from.
     */
    return { result: null, events: [] };
  });
}

/**
 * Ends a panic.
 *
 * Two ways in, both legitimate: a dispatcher stands it down, or the officer who
 * raised it stands themselves down. The second matters — the person best placed
 * to know it is over is usually the one who called it — so it is allowed without
 * the acknowledge permission, and the audit records which of the two it was.
 */
export async function resolvePanic(
  db: Database,
  scope: DispatchScope,
  panicId: string,
  restoreStatusKey: string | null,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string; organization_id: string; member_id: string;
      unit_id: string | null; resolved_at: Date | null;
    }>(sql`
      SELECT id, organization_id, member_id, unit_id, resolved_at FROM panic_event
       WHERE id = ${panicId}
       FOR UPDATE
    `);
    const event = rows[0];
    if (!event) throw new NotFoundError('panic alert');

    if (!scope.canViewAllOrganizations
      && !scope.organizationIds.includes(event.organization_id)) {
      throw new NotFoundError('panic alert');
    }
    if (event.resolved_at !== null) return { result: null, events: [] };

    const own = await tx.execute<{ id: string }>(sql`
      SELECT id FROM organization_member
       WHERE id = ${event.member_id} AND user_id = ${scope.actorUserId}
    `);
    const isOwnAlert = own.length > 0;

    if (!isOwnAlert && !scope.canAcknowledgePanic) {
      throw new ForbiddenError('You cannot stand down another member’s alert.');
    }

    const now = new Date();
    await tx.update(panicEvent).set({ resolvedAt: now }).where(eq(panicEvent.id, panicId));

    /**
     * Restore a working status.
     *
     * Left at `panic`, the member would still read as in distress on every board
     * after the situation ended. `busy` rather than `available` is the
     * deliberate default: somebody who has just been through this is not
     * immediately ready for the next call, and a dispatcher can see them and
     * decide.
     */
    const target = restoreStatusKey ?? 'busy';
    const allowed = await tx.execute<{ key: string }>(sql`
      SELECT key FROM operational_status
       WHERE key = ${target} AND is_active AND key <> 'panic'
         AND (organization_id IS NULL OR organization_id = ${event.organization_id})
    `);
    const restored = allowed[0]?.key ?? 'busy';

    await tx.update(memberStatus)
      .set({ statusKey: restored, since: now, updatedAt: now })
      .where(eq(memberStatus.memberId, event.member_id));

    await tx.insert(memberStatusHistory).values({
      memberId: event.member_id,
      fromStatusKey: 'panic',
      toStatusKey: restored,
      unitId: event.unit_id,
      changedBy: scope.actorUserId,
    });

    if (event.unit_id !== null) {
      await tx.update(unit).set({ statusKey: restored }).where(eq(unit.id, event.unit_id));
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PANIC_RESOLVED,
      actorUserId: scope.actorUserId,
      organizationId: event.organization_id,
      entityType: 'panic_event', entityId: panicId,
      metadata: { selfResolved: isOwnAlert, restoredStatus: restored },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    const who = await tx.execute<{ display_name: string }>(sql`
      SELECT ua.display_name
        FROM organization_member om
        JOIN user_account ua ON ua.id = om.user_id
       WHERE om.id = ${event.member_id}
    `);

    return {
      result: null,
      events: [{
        kind: 'panic.resolved',
        organizationId: event.organization_id,
        payload: {
          panicId,
          memberId: event.member_id,
          memberName: who[0]?.display_name ?? 'Unknown',
          selfResolved: isOwnAlert,
        },
      }],
    };
  });
}
