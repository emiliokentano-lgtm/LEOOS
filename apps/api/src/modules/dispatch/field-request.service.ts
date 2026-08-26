import { sql } from 'drizzle-orm';
import {
  FIELD_REQUEST_KINDS, fieldRequestKindMeta,
  type FieldRequestKind,
} from '@leoos/contracts';
import { AUDIT_ACTIONS, type Database } from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from './dispatch.scope.js';
import { notificationEmissions, type DispatchOutcome } from './dispatch.events.js';
import { createNotifications } from '../notifications/notification.service.js';
import { membersWithPermission } from '../notifications/recipients.js';
import { assignUnit } from './incident.service.js';

/**
 * Field requests: asking for backup, and saying where you are.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE SERVICE, TWO OUTCOMES
 *
 * Backup and location sharing are the same event — somebody raises something,
 * their colleagues are offered it, each takes it or dismisses it — and differ
 * only in what accepting does. Writing them separately would have duplicated
 * the lifecycle, the audience derivation, the expiry rule and the
 * authorization, which are four things it is important not to have two of.
 *
 * WHY THIS IS NOT AN INCIDENT, and why accepting does not create one, is argued
 * in docs/architecture/09-dispatch.md §6b. The short version: an incident is a
 * call somebody has to close, and manufacturing one so an assignment has a
 * foreign key to point at would put untitled entries on the board forever.
 * ────────────────────────────────────────────────────────────────────────────
 */

type LockedMembership = {
  id: string;
  organization_id: string;
  status: string;
};

/**
 * The actor's own membership, locked.
 *
 * `FOR UPDATE` because every decision below is made against this row and the
 * row can change underneath us — a termination committing between the read and
 * the write is exactly the race the lock exists for.
 */
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

export interface RaiseFieldRequestInput {
  kind: FieldRequestKind;
  note: string | null;
  x: number | null;
  y: number | null;
  /** `web`, or `fivem` when it came from a keypress in game. */
  source: string;
}

/**
 * Raises a request and offers it to the asker's on-duty colleagues.
 *
 * SELF-ACTION. It commits the asker and nobody else, so it needs only an active
 * membership and the permission for the kind — no authority over another
 * person is involved, and none is checked.
 */
export async function raiseFieldRequest(
  db: Database,
  scope: DispatchScope,
  input: RaiseFieldRequestInput,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string; kind: FieldRequestKind; alreadyLive: boolean }>> {
  const meta_ = fieldRequestKindMeta(input.kind);
  if (!(input.kind in FIELD_REQUEST_KINDS)) {
    throw new ValidationError([{ path: 'kind', message: 'Unknown request kind.' }]);
  }

  const permission = input.kind === 'backup'
    ? scope.canRequestBackup
    : scope.canShareLocation;
  if (!permission) {
    throw new ForbiddenError(
      input.kind === 'backup'
        ? 'You cannot request backup.'
        : 'You cannot share your location.',
    );
  }

  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) {
      throw new ForbiddenError('You are not a member of this organization.');
    }
    if (membership.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot raise a request.');
    }

    /**
     * A live request of the same kind is RETURNED, not duplicated.
     *
     * People hold keys down and networks retry. Four identical prompts on
     * everybody's screen is worse than one, and the second press carries no new
     * information. The database's partial unique index is what actually decides
     * this under concurrency; this read is the fast path that avoids relying on
     * a caught constraint violation for the common case.
     */
    const live = await tx.execute<{ id: string }>(sql`
      SELECT id FROM field_request
       WHERE member_id = ${membership.id} AND kind = ${input.kind}::field_request_kind
         AND status = 'pending' AND expires_at > now()
       LIMIT 1
    `);
    if (live[0]) {
      return {
        result: { id: live[0].id, kind: input.kind, alreadyLive: true },
        events: [],
      };
    }

    /**
     * Expire anything of this kind that has run out, so the unique index does
     * not block a new request behind a dead one.
     *
     * This is the whole of the expiry mechanism: no job, no timer. A row is
     * settled the next time somebody in its organization does something, and
     * until then it is `pending` in the table and dead to every read, because
     * every read compares `expires_at`.
     */
    await tx.execute(sql`
      UPDATE field_request
         SET status = 'expired', resolved_at = now()
       WHERE member_id = ${membership.id} AND kind = ${input.kind}::field_request_kind
         AND status = 'pending' AND expires_at <= now()
    `);

    const crewing = await tx.execute<{ unit_id: string | null }>(sql`
      SELECT unit_id FROM unit_member
       WHERE member_id = ${membership.id} AND left_at IS NULL
    `);
    const unitId = crewing[0]?.unit_id ?? null;

    /**
     * Position falls back to the unit's last known one.
     *
     * A browser has no idea where the character is standing; the unit's cached
     * position is the best available answer and far better than none. Recorded
     * on the row rather than read later, because where they were WHEN they
     * asked is the operational question — and because a share must be a
     * snapshot, not a track.
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
    // The check constraint pairs them; half a coordinate is no coordinate.
    if (posX === null || posY === null) { posX = null; posY = null; }

    /**
     * The call they are on, captured NOW.
     *
     * Read at raise time and stored, rather than resolved from the unit when
     * somebody accepts. A unit that has since been reassigned must not silently
     * redirect the people who agreed to help with something else.
     */
    let incidentId: string | null = null;
    if (unitId !== null && input.kind === 'backup') {
      const call = await tx.execute<{ incident_id: string }>(sql`
        SELECT incident_id FROM incident_assignment
         WHERE unit_id = ${unitId} AND released_at IS NULL
         ORDER BY created_at DESC LIMIT 1
      `);
      incidentId = call[0]?.incident_id ?? null;
    }

    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO field_request
        (kind, member_id, organization_id, unit_id, incident_id,
         pos_x, pos_y, note, source, expires_at)
      VALUES
        (${input.kind}::field_request_kind, ${membership.id}, ${membership.organization_id},
         ${unitId}, ${incidentId}, ${posX}, ${posY}, ${input.note}, ${input.source},
         now() + ${`${Math.round(meta_.ttlMs / 1000)} seconds`}::interval)
      RETURNING id
    `);
    if (!row) throw new ConflictError('REQUEST_NOT_CREATED', 'The request could not be raised.');

    /**
     * THE AUDIENCE IS DERIVED, NEVER SUPPLIED.
     *
     * Every active member of the asker's organization who is on duty and may
     * see dispatch, minus the asker. No contract type has a field for a
     * recipient list and no endpoint accepts one — the rule the notification
     * system already holds, applied here rather than re-litigated.
     *
     * `onDutyOnly` because an off-duty officer cannot respond to a request for
     * backup and a prompt they cannot act on is noise. Panic deliberately does
     * NOT do this; a field request is not a panic.
     */
    const recipients = await membersWithPermission(
      tx,
      membership.organization_id,
      'dispatch.view',
      { excludeUserId: scope.actorUserId, onDutyOnly: true },
    );

    const asker = await tx.execute<{ display_name: string; callsign: string | null }>(sql`
      SELECT u.display_name, m.callsign
        FROM organization_member m
        JOIN user_account u ON u.id = m.user_id
       WHERE m.id = ${membership.id}
    `);
    const askerName = asker[0]?.display_name ?? 'A colleague';
    const askerCallsign = asker[0]?.callsign ?? null;
    const who = askerCallsign ? `${askerCallsign} · ${askerName}` : askerName;

    const deliveries = await createNotifications(tx, recipients, {
      type: input.kind === 'backup' ? 'field_request.backup' : 'field_request.location',
      organizationId: membership.organization_id,
      title: input.kind === 'backup'
        ? `${who} is requesting backup`
        : `${who} shared their location`,
      /**
       * The note is carried, and that is a decision rather than an oversight.
       *
       * It is the one free-text field here, and it reaches every on-duty
       * colleague — so it is not private, and the UI says as much where it is
       * typed. What it must never carry is somebody else's record, which is why
       * the field is short and why nothing resolves an entity from it.
       */
      body: input.note,
      href: '/dispatch',
      entityType: 'field_request',
      entityId: row.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.FIELD_REQUEST_RAISED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'field_request',
      entityId: row.id,
      metadata: {
        kind: input.kind,
        source: input.source,
        unitId,
        incidentId,
        offeredTo: recipients.length,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    /**
     * A backup request on a call also goes into that call's TIMELINE.
     *
     * The timeline is the record of what happened on an incident, and "the unit
     * on scene asked for help" plainly belongs in it. A location share does not:
     * it is not about the call.
     */
    if (incidentId !== null) {
      await tx.execute(sql`
        INSERT INTO incident_log (incident_id, actor_user_id, entry_type, body, metadata)
        VALUES (${incidentId}, ${scope.actorUserId}, 'system',
                ${`${who} requested backup`},
                ${JSON.stringify({ fieldRequestId: row.id, kind: input.kind })}::jsonb)
      `);
    }

    return {
      result: { id: row.id, kind: input.kind, alreadyLive: false },
      events: [
        {
          kind: 'field_request.updated' as const,
          organizationId: membership.organization_id,
          payload: { fieldRequestId: row.id, kind: input.kind, status: 'pending' },
        },
        ...notificationEmissions(deliveries),
      ],
    };
  });
}

export type RespondAction = 'accept' | 'decline';

/**
 * Accepts or declines a request.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE AUTHORIZATION IS ABOUT THE RESPONDER, NOT THE REQUEST
 *
 * Accepting is a self-action in the sense that matters: you are volunteering
 * yourself, so no permission over another person is involved. What it must
 * never do is let somebody in another organization volunteer into a call they
 * cannot see — so the organization is compared against the RESPONDER'S live
 * membership, read inside this transaction, and never against anything the
 * request or the caller supplied.
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function respondToFieldRequest(
  db: Database,
  scope: DispatchScope,
  requestId: string,
  action: RespondAction,
  meta: RequestMeta,
): Promise<DispatchOutcome<{
  id: string;
  status: string;
  attachedToIncidentId: string | null;
  x: number | null;
  y: number | null;
}>> {
  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) {
      throw new ForbiddenError('You are not a member of this organization.');
    }
    if (membership.status !== 'active') {
      throw new ForbiddenError('An inactive membership cannot respond to a request.');
    }

    const rows = await tx.execute<{
      id: string;
      kind: FieldRequestKind;
      status: string;
      member_id: string;
      organization_id: string;
      unit_id: string | null;
      incident_id: string | null;
      pos_x: number | null;
      pos_y: number | null;
      expired: boolean;
    }>(sql`
      SELECT id, kind, status, member_id, organization_id, unit_id, incident_id,
             pos_x, pos_y, (expires_at <= now()) AS expired
        FROM field_request
       WHERE id = ${requestId}
       FOR UPDATE
    `);
    const request = rows[0];

    /**
     * A request in another organization is NOT FOUND, not forbidden.
     *
     * The same rule the rest of the product follows: a 403 would confirm the
     * request exists, which is itself information about another agency's
     * operations.
     */
    if (!request || request.organization_id !== membership.organization_id) {
      throw new NotFoundError('That request is no longer available.');
    }

    if (request.member_id === membership.id) {
      throw new ConflictError(
        'CANNOT_RESPOND_TO_OWN',
        'You raised this request. Cancel it instead.',
      );
    }

    /**
     * Expiry is checked HERE, against the database's clock.
     *
     * A client can hold a prompt in a pocket for ten minutes. Accepting past
     * the deadline would attach somebody to a situation that resolved long ago,
     * so the deadline is enforced where the decision is made rather than where
     * the button is drawn.
     */
    if (request.status !== 'pending' || request.expired) {
      throw new ConflictError(
        'REQUEST_NOT_LIVE',
        request.expired && request.status === 'pending'
          ? 'That request has expired.'
          : 'That request has already been answered.',
      );
    }

    /**
     * The response is recorded FIRST, and it is recorded for a decline too.
     *
     * "Eight people dismissed this" is a different fact from "nobody saw it",
     * and it is the first thing asked when somebody reviews why help did not
     * arrive. A conflict here means this responder already answered.
     */
    const recorded = await tx.execute<{ member_id: string }>(sql`
      INSERT INTO field_request_response (field_request_id, member_id, response)
      VALUES (${requestId}, ${membership.id}, ${action === 'accept' ? 'accepted' : 'declined'})
      ON CONFLICT (field_request_id, member_id) DO NOTHING
      RETURNING member_id
    `);
    if (recorded.length === 0) {
      throw new ConflictError('ALREADY_RESPONDED', 'You have already answered this request.');
    }

    if (action === 'decline') {
      /**
       * A DECLINE DOES NOT CLOSE THE REQUEST.
       *
       * It is still live for everybody else — one person saying "not me" must
       * not cancel a colleague's call for help. The row's status only moves
       * when somebody accepts, the asker cancels, or the clock runs out.
       */
      await writeAudit(tx, {
        action: AUDIT_ACTIONS.FIELD_REQUEST_DECLINED,
        actorUserId: scope.actorUserId,
        organizationId: membership.organization_id,
        entityType: 'field_request',
        entityId: requestId,
        metadata: { kind: request.kind },
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      });

      return {
        result: {
          id: requestId, status: 'pending', attachedToIncidentId: null,
          x: request.pos_x, y: request.pos_y,
        },
        events: [{
          kind: 'field_request.updated' as const,
          organizationId: membership.organization_id,
          payload: { fieldRequestId: requestId, kind: request.kind, status: 'pending' },
        }],
      };
    }

    // ── Accept ─────────────────────────────────────────────────────────────
    await tx.execute(sql`
      UPDATE field_request
         SET status = 'accepted', resolved_by = ${membership.id}, resolved_at = now()
       WHERE id = ${requestId}
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.FIELD_REQUEST_ACCEPTED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'field_request',
      entityId: requestId,
      metadata: { kind: request.kind, incidentId: request.incident_id },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    /**
     * Accepting a LOCATION SHARE places a marker, and that is the whole of it.
     *
     * Not a new map layer: `map_marker` already exists, already renders, already
     * carries `expires_at`, and is already gated by the map's own permissions.
     * Building a parallel "shared locations" layer would have been a second
     * thing on the map that means "somebody is here", with its own lifetime
     * rules to keep in step with these ones.
     *
     * Scoped to the ORGANIZATION rather than to the acceptor, because the map is
     * a shared picture — a marker only one person can see is a note, and this is
     * not a notes feature. Expires with the request that created it.
     */
    if (request.kind === 'location_share' && request.pos_x !== null && request.pos_y !== null) {
      const asker = await tx.execute<{ display_name: string; callsign: string | null }>(sql`
        SELECT u.display_name, m.callsign
          FROM organization_member m
          JOIN user_account u ON u.id = m.user_id
         WHERE m.id = ${request.member_id}
      `);
      const label = asker[0]?.callsign
        ? `${asker[0].callsign} · ${asker[0].display_name}`
        : (asker[0]?.display_name ?? 'Shared location');

      await tx.execute(sql`
        INSERT INTO map_marker
          (organization_id, type, label, description, pos_x, pos_y, created_by, expires_at)
        SELECT ${membership.organization_id}, 'poi', ${label},
               'Shared location', ${request.pos_x}, ${request.pos_y},
               m.user_id, fr.expires_at
          FROM field_request fr
          JOIN organization_member m ON m.id = ${membership.id}
         WHERE fr.id = ${requestId}
      `);
    }

    const responder = await tx.execute<{ display_name: string; callsign: string | null }>(sql`
      SELECT u.display_name, m.callsign
        FROM organization_member m
        JOIN user_account u ON u.id = m.user_id
       WHERE m.id = ${membership.id}
    `);
    const responderName = responder[0]?.display_name ?? 'A colleague';
    const responderWho = responder[0]?.callsign
      ? `${responder[0].callsign} · ${responderName}`
      : responderName;

    const askerUser = await tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM organization_member WHERE id = ${request.member_id}
    `);
    /**
     * An audience of exactly one — AND STILL DERIVED.
     *
     * The recipient is the `member_id` on the row, read here, not a user id the
     * caller supplied. That distinction is the whole reason no endpoint in this
     * system accepts a recipient list, and it holds even when the list would
     * have one entry.
     */
    const deliveries = askerUser[0]
      ? await createNotifications(
        tx,
        [{ userId: askerUser[0].user_id, memberId: request.member_id }],
        {
          type: 'field_request.accepted',
          organizationId: membership.organization_id,
          title: `${responderWho} is responding`,
          body: null,
          href: '/dispatch',
          entityType: 'field_request',
          entityId: requestId,
        },
      )
      : [];

    return {
      result: {
        id: requestId,
        status: 'accepted',
        /**
         * The attachment happens in the ROUTE, not here.
         *
         * `assignUnit` opens its own transaction and runs its own
         * authorization, audit and events. Calling it from inside this one
         * would nest transactions and, worse, would bypass the point of reusing
         * it — that an assignment made this way is indistinguishable from one a
         * dispatcher made, because it went through the same code.
         *
         * So this returns what the route needs to make that call, and the route
         * makes it. If the assignment is refused — the responder has no unit,
         * or lacks `dispatch.assign` — the ACCEPTANCE STILL STANDS. They said
         * they are coming; whether the board also records an assignment is a
         * separate question with a separate answer.
         */
        attachedToIncidentId: request.incident_id,
        x: request.pos_x,
        y: request.pos_y,
      },
      events: [
        {
          kind: 'field_request.updated' as const,
          organizationId: membership.organization_id,
          payload: { fieldRequestId: requestId, kind: request.kind, status: 'accepted' },
        },
        ...notificationEmissions(deliveries),
      ],
    };
  });
}

/** Withdrawing your own request. Nobody else may. */
export async function cancelFieldRequest(
  db: Database,
  scope: DispatchScope,
  requestId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string }>> {
  return db.transaction(async (tx) => {
    const membership = await lockOwnMembership(tx, scope);
    if (membership === null) {
      throw new ForbiddenError('You are not a member of this organization.');
    }

    const rows = await tx.execute<{ member_id: string; status: string; kind: FieldRequestKind }>(sql`
      SELECT member_id, status, kind FROM field_request WHERE id = ${requestId} FOR UPDATE
    `);
    const request = rows[0];
    if (!request) throw new NotFoundError('That request no longer exists.');

    // Only the asker. Not a supervisor, not a dispatcher: cancelling somebody
    // else's call for help is not a thing this product lets anybody do.
    if (request.member_id !== membership.id) {
      throw new ForbiddenError('Only the person who raised a request may cancel it.');
    }
    if (request.status !== 'pending') {
      throw new ConflictError('REQUEST_NOT_LIVE', 'That request is no longer open.');
    }

    await tx.execute(sql`
      UPDATE field_request
         SET status = 'cancelled', resolved_at = now()
       WHERE id = ${requestId}
    `);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.FIELD_REQUEST_CANCELLED,
      actorUserId: scope.actorUserId,
      organizationId: membership.organization_id,
      entityType: 'field_request',
      entityId: requestId,
      metadata: { kind: request.kind },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return {
      result: { id: requestId },
      events: [{
        kind: 'field_request.updated' as const,
        organizationId: membership.organization_id,
        payload: { fieldRequestId: requestId, kind: request.kind, status: 'cancelled' },
      }],
    };
  });
}

/**
 * Attaches an accepting unit to the asker's call, when there is one.
 *
 * Separate from `respondToFieldRequest` and called after it, so the assignment
 * goes through the ORDINARY path with its own transaction, authorization, audit
 * row and timeline entry. An assignment made by accepting a backup request is
 * then indistinguishable from one a dispatcher made — which is the point.
 *
 * Returns null when there was nothing to attach to, which is the common case
 * and is not a failure: see the doc on why no incident is manufactured.
 */
export async function attachAcceptorToIncident(
  db: Database,
  scope: DispatchScope,
  incidentId: string | null,
  meta: RequestMeta,
): Promise<DispatchOutcome | null> {
  if (incidentId === null) return null;

  const crewing = await db.execute<{ unit_id: string }>(sql`
    SELECT um.unit_id
      FROM organization_member om
      JOIN unit_member um ON um.member_id = om.id AND um.left_at IS NULL
     WHERE om.user_id = ${scope.actorUserId} AND om.status = 'active'
       AND om.organization_id = ${scope.organizationId}
  `);
  const unitId = crewing[0]?.unit_id;
  // Not crewed into a unit: there is nothing to assign. They are still coming.
  if (!unitId) return null;

  try {
    return await assignUnit(db, scope, incidentId, unitId, null, meta);
  } catch {
    /**
     * A REFUSED ASSIGNMENT DOES NOT UNDO THE ACCEPTANCE.
     *
     * The responder may lack `dispatch.assign`, or the call may have closed in
     * the meantime. They still said they are coming, the asker has still been
     * told, and the waypoint is still set. Rolling that back because the board
     * could not also record an assignment would be the tail wagging the dog.
     *
     * Already audited by `assignUnit`'s own denial path, so nothing is lost.
     */
    return null;
  }
}
