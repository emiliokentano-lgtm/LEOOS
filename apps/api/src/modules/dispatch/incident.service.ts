import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  canTransitionIncident, isCriticalIncident, isTerminalIncidentStatus,
  type IncidentPriority, type IncidentStatusKey,
} from '@leoos/contracts';
import {
  AUDIT_ACTIONS, incident, incidentAssignment, incidentLog, unit, type Database,
} from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from './dispatch.scope.js';
import { incidentTopics, notificationEmissions, type DispatchOutcome } from './dispatch.events.js';
import { createNotifications } from '../notifications/notification.service.js';
import { crewsOnIncident, dispatchersForIncident, unitCrew } from '../notifications/recipients.js';

/**
 * Incident mutations.
 *
 * Every one follows the same shape, which is the shape every mutating service in
 * this codebase follows:
 *
 *   open a transaction → lock the rows the decision depends on → re-read them →
 *   decide → mutate → write the timeline entry → write the audit row → commit
 *
 * The lock matters here for a reason specific to dispatch: two dispatchers
 * working the same board WILL act on the same call within the same second. Without
 * `FOR UPDATE`, "close this call" and "assign a unit to this call" interleave into
 * a closed incident with a live assignment — a unit committed to a call nobody is
 * running any more.
 *
 * THE TIMELINE IS NOT OPTIONAL. `incident_log` is append-only by database trigger
 * and is the legal record of the call. Every state change writes to it inside the
 * same transaction, so a committed change always has a timeline entry and a
 * rolled-back one leaves none.
 *
 * REAL-TIME EVENTS ARE RETURNED, NOT PUBLISHED. Every mutation here answers with
 * a `DispatchOutcome` — the value the route replies with, plus a description of
 * what changed. The route publishes it, which it can only do after this promise
 * resolves, which is after the transaction commits. See dispatch.events.ts for
 * why that is a shape rather than a convention.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHO GETS NOTIFIED, AND WHY IT IS NOT EVERYONE
 *
 * A board that updates live already tells a dispatcher who is watching it. A
 * notification is for the person who is NOT watching — so the audience for each
 * event is chosen to be the smallest set that would otherwise miss something
 * they need. Notifying more widely is not "safer": a dispatcher with two hundred
 * unread entries has a notification centre they no longer read, and the panic
 * lands in it.
 *
 * The policy, in one place:
 *
 *   · a NEW CALL notifies dispatchers only at P1 (`isCriticalIncident`);
 *   · an ESCALATION to P1 notifies dispatchers and the responding crews, because
 *     a call that has just become life-threatening is new information to both;
 *   · a CHANGE to a running call — details, status, close — notifies the CREWS
 *     ON IT and nobody else. They are the people driving to it;
 *   · an ASSIGNMENT notifies the crew of the unit being assigned;
 *   · a NOTE notifies nobody. Notes are the highest-frequency thing on a call by
 *     an order of magnitude, and a notification per note is how the centre stops
 *     being read.
 *
 * The actor is excluded everywhere. Telling somebody what they just did is noise
 * that pushes down the things they did not do.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Locks one incident and returns its current state, or null if out of scope. */
async function lockIncident(
  tx: Database,
  scope: DispatchScope,
  incidentId: string,
) {
  const rows = await tx.execute<{
    id: string;
    organization_id: string | null;
    status: IncidentStatusKey;
    priority: number;
    title: string;
    number: string;
  }>(sql`
    SELECT id, organization_id, status, priority, title, number
      FROM incident
     WHERE id = ${incidentId} AND deleted_at IS NULL
     FOR UPDATE
  `);

  const row = rows[0];
  if (!row) return null;

  // SCOPE BEFORE PERMISSION, so a cross-organization attempt reads as exactly
  // that rather than as a missing permission. A multi-agency call
  // (organization_id NULL) belongs to everyone.
  if (!scope.canViewAllOrganizations && row.organization_id !== null) {
    if (!scope.organizationIds.includes(row.organization_id)) return null;
  }

  return row;
}

interface TimelineInput {
  incidentId: string;
  actorUserId: string;
  kind: 'note' | 'status_change' | 'assignment' | 'arrival' | 'clear' | 'attachment' | 'system';
  body: string | null;
  metadata?: Record<string, unknown>;
}

async function appendTimeline(tx: Database, entry: TimelineInput): Promise<void> {
  await tx.insert(incidentLog).values({
    incidentId: entry.incidentId,
    actorUserId: entry.actorUserId,
    entryType: entry.kind,
    body: entry.body,
    metadata: entry.metadata ?? {},
  });
}

// ── Create ─────────────────────────────────────────────────────────────────

export interface CreateIncidentInput {
  title: string;
  description: string | null;
  typeKey: string | null;
  priority: IncidentPriority;
  locationText: string | null;
  x: number | null;
  y: number | null;
  callerPhone: string | null;
  /** Null creates a multi-agency call, which requires broader clearance. */
  organizationId: string | null;
}

export async function createIncident(
  db: Database,
  scope: DispatchScope,
  input: CreateIncidentInput,
  meta: RequestMeta,
): Promise<DispatchOutcome<{ id: string; number: string }>> {
  if (!scope.canCreateIncident) throw new ForbiddenError('You cannot create incidents.');
  if (!scope.membershipActive) {
    throw new ForbiddenError('An inactive membership cannot create incidents.');
  }

  /**
   * Owning organization is derived from the ACTOR, not taken from the body.
   *
   * Same rule as everywhere else (engineering rule 11): accepting an arbitrary
   * id would let anyone file calls onto another service's board. A genuinely
   * multi-agency call has no owner and needs the clearance that sees every
   * organization, since that is who coordinates one.
   */
  let organizationId: string | null;
  if (input.organizationId === null && scope.canViewAllOrganizations) {
    organizationId = null;
  } else if (input.organizationId !== null && scope.canViewAllOrganizations) {
    organizationId = input.organizationId;
  } else {
    if (scope.organizationId === null) {
      throw new ForbiddenError('Select an organization before creating an incident.');
    }
    if (input.organizationId !== null && input.organizationId !== scope.organizationId) {
      throw new ForbiddenError('You can only create incidents for your own organization.');
    }
    organizationId = scope.organizationId;
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(incident)
      .values({
        organizationId,
        typeKey: input.typeKey,
        priority: input.priority,
        status: 'pending',
        title: input.title,
        description: input.description,
        locationText: input.locationText,
        posX: input.x,
        posY: input.y,
        callerPhone: input.callerPhone,
        source: 'manual',
        createdBy: scope.actorUserId,
      })
      .returning({ id: incident.id, number: incident.number });

    if (!created) throw new ValidationError('The incident could not be created.');

    await appendTimeline(tx, {
      incidentId: created.id,
      actorUserId: scope.actorUserId,
      kind: 'system',
      body: `Incident opened: ${input.title}`,
      metadata: { priority: input.priority, typeKey: input.typeKey },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_CREATED,
      actorUserId: scope.actorUserId,
      organizationId,
      entityType: 'incident', entityId: created.id,
      after: { number: created.number, title: input.title, priority: input.priority },
      metadata: { multiAgency: organizationId === null },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * A P1 reaches the dispatchers who can see it.
     *
     * `dispatchersForIncident` unions the owning organization with every
     * organization that has a unit on the call. For a call this new there are no
     * units yet, so a single-agency P1 reaches its own service — and a
     * MULTI-AGENCY P1 created with no owner reaches nobody until the first unit
     * is attached, exactly as its board event does. That is the same trade the
     * dispatch topics already make, and it is honest: nobody is on it yet.
     */
    const deliveries = isCriticalIncident(input.priority)
      ? await createNotifications(
        tx,
        await dispatchersForIncident(
          tx, created.id, organizationId, { excludeUserId: scope.actorUserId },
        ),
        {
          type: 'incident.critical',
          title: `P1 ${created.number} — ${input.title}`,
          body: input.locationText,
          href: `/dispatch?incident=${created.id}`,
          entityType: 'incident',
          entityId: created.id,
          organizationId,
          target: 'dispatch',
          metadata: { number: created.number, priority: input.priority },
        },
      )
      : [];

    return {
      result: created,
      events: [{
        kind: 'incident.created',
        organizationId,
        // A brand new call has no assignments yet, so this resolves to the
        // owning board — or, for a multi-agency call, to no board at all until
        // the first unit is attached. That is correct: nobody is on it.
        topics: await incidentTopics(tx, created.id, organizationId),
        payload: {
          incidentId: created.id,
          number: created.number,
          priority: input.priority,
          status: 'pending',
          title: input.title,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

// ── Edit ───────────────────────────────────────────────────────────────────

export interface UpdateIncidentInput {
  title?: string;
  description?: string | null;
  typeKey?: string | null;
  locationText?: string | null;
  x?: number | null;
  y?: number | null;
  callerPhone?: string | null;
}

export async function updateIncident(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  changes: UpdateIncidentInput,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canManageIncident) throw new ForbiddenError('You cannot edit incidents.');

    // A closed call is a finished record. Editing one silently rewrites history;
    // correcting it means reopening, which leaves a trace.
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'Reopen the incident before editing it.');
    }

    await tx.update(incident).set({
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.description === undefined ? {} : { description: changes.description }),
      ...(changes.typeKey === undefined ? {} : { typeKey: changes.typeKey }),
      ...(changes.locationText === undefined ? {} : { locationText: changes.locationText }),
      ...(changes.x === undefined ? {} : { posX: changes.x }),
      ...(changes.y === undefined ? {} : { posY: changes.y }),
      ...(changes.callerPhone === undefined ? {} : { callerPhone: changes.callerPhone }),
    }).where(eq(incident.id, incidentId));

    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'system',
      body: `Incident details updated (${Object.keys(changes).join(', ')})`,
      metadata: { changed: Object.keys(changes) },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_UPDATED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      metadata: { changed: Object.keys(changes) },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * The responding crews, not the whole board.
     *
     * The fields that get edited on a running call are the ones a crew is acting
     * on — the address, the caller's description, the type. A unit already
     * driving somewhere needs to know the address changed; a dispatcher watching
     * the board just saw it change.
     */
    const deliveries = await createNotifications(
      tx,
      await crewsOnIncident(tx, incidentId, { excludeUserId: scope.actorUserId }),
      {
        type: 'incident.updated',
        title: `${current.number} updated`,
        body: `Changed: ${Object.keys(changes).join(', ')}`,
        href: `/dispatch?incident=${incidentId}`,
        entityType: 'incident',
        entityId: incidentId,
        organizationId: current.organization_id,
        target: 'dispatch',
        metadata: { number: current.number, changed: Object.keys(changes) },
      },
    );

    return {
      result: null,
      events: [{
        kind: 'incident.updated',
        organizationId: current.organization_id,
        topics: await incidentTopics(tx, incidentId, current.organization_id),
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status: current.status,
          title: changes.title ?? current.title,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

// ── Priority ───────────────────────────────────────────────────────────────

export async function changeIncidentPriority(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  priority: IncidentPriority,
  reason: string | null,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canManageIncident) throw new ForbiddenError('You cannot change incident priority.');
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'A closed incident cannot be re-prioritised.');
    }
    // No change is no event. A board that redraws because someone re-selected
    // the priority it already had is a board people stop trusting.
    if (current.priority === priority) return { result: null, events: [] };

    await tx.update(incident).set({ priority }).where(eq(incident.id, incidentId));

    // Priority changes get their own timeline entry rather than folding into a
    // generic edit: "why was this a P4 for twenty minutes" is a question that
    // gets asked, and the answer has to be reconstructible.
    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'status_change',
      body: reason === null
        ? `Priority changed from P${current.priority} to P${priority}`
        : `Priority changed from P${current.priority} to P${priority}: ${reason}`,
      metadata: { from: current.priority, to: priority },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_UPDATED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      before: { priority: current.priority },
      after: { priority },
      metadata: { field: 'priority', reason },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * An ESCALATION to P1 is treated as a new critical call.
     *
     * A call that has just become life-threatening is new information to the
     * dispatchers who were not going to work it and to the crew already on it.
     * A de-escalation is not: the crew finds out when they arrive, and nobody
     * needs interrupting to be told something got less urgent.
     *
     * The two audiences are unioned and deduplicated by `createNotifications`,
     * so a dispatcher who is also crewing a unit on the call gets one entry.
     */
    const escalated = isCriticalIncident(priority) && !isCriticalIncident(current.priority);
    const audience = escalated
      ? [
        ...await dispatchersForIncident(
          tx, incidentId, current.organization_id, { excludeUserId: scope.actorUserId },
        ),
        ...await crewsOnIncident(tx, incidentId, { excludeUserId: scope.actorUserId }),
      ]
      : await crewsOnIncident(tx, incidentId, { excludeUserId: scope.actorUserId });

    const deliveries = await createNotifications(tx, audience, {
      type: escalated ? 'incident.critical' : 'incident.updated',
      title: escalated
        ? `Escalated to P1 — ${current.number} ${current.title}`
        : `${current.number} is now P${priority}`,
      body: reason,
      href: `/dispatch?incident=${incidentId}`,
      entityType: 'incident',
      entityId: incidentId,
      organizationId: current.organization_id,
      target: 'dispatch',
      metadata: { number: current.number, from: current.priority, to: priority, reason },
    });

    return {
      result: null,
      events: [{
        kind: 'incident.updated',
        organizationId: current.organization_id,
        topics: await incidentTopics(tx, incidentId, current.organization_id),
        payload: {
          incidentId,
          number: current.number,
          priority,
          status: current.status,
          title: current.title,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

// ── Status ─────────────────────────────────────────────────────────────────

export async function changeIncidentStatus(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  status: IncidentStatusKey,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');

    // Closing is a separate permission from managing, so it routes through
    // `closeIncident` where the closing notes are captured.
    if (status === 'closed' || status === 'cancelled') {
      throw new ValidationError('Use the close action to finish an incident.');
    }
    if (!scope.canManageIncident) throw new ForbiddenError('You cannot change incident status.');

    // The transition table is the single source of truth, shared with the client
    // (INCIDENT_TRANSITIONS in @leoos/contracts). The client uses it to grey out
    // buttons; this is where it is enforced.
    if (!canTransitionIncident(current.status, status)) {
      throw new ConflictError(
        'INVALID_TRANSITION',
        `An incident cannot move from ${current.status} to ${status}.`,
      );
    }

    await tx.update(incident).set({ status }).where(eq(incident.id, incidentId));

    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'status_change',
      body: `Status changed from ${current.status} to ${status}`,
      metadata: { from: current.status, to: status },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_UPDATED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      before: { status: current.status },
      after: { status },
      metadata: { field: 'status' },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    const deliveries = await createNotifications(
      tx,
      await crewsOnIncident(tx, incidentId, { excludeUserId: scope.actorUserId }),
      {
        type: 'incident.updated',
        title: `${current.number} — ${status}`,
        body: current.title,
        href: `/dispatch?incident=${incidentId}`,
        entityType: 'incident',
        entityId: incidentId,
        organizationId: current.organization_id,
        target: 'dispatch',
        metadata: { number: current.number, from: current.status, to: status },
      },
    );

    return {
      result: null,
      events: [{
        kind: 'incident.updated',
        organizationId: current.organization_id,
        topics: await incidentTopics(tx, incidentId, current.organization_id),
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status,
          title: current.title,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

// ── Close and reopen ───────────────────────────────────────────────────────

export async function closeIncident(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  input: { cancelled: boolean; notes: string | null },
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canCloseIncident) throw new ForbiddenError('You cannot close incidents.');
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'That incident is already closed.');
    }

    /**
     * Topics are resolved BEFORE the units are released.
     *
     * Closing detaches every unit, so asking afterwards which organizations were
     * involved answers "none" — and the agencies that were actually running the
     * call would be the only ones not told it had ended.
     */
    const topics = await incidentTopics(tx, incidentId, current.organization_id);

    // The crews are read here for the same reason and at the same moment: after
    // the release below there is nobody on the call, and the people who spent an
    // hour on it would be the only ones not told it had ended.
    const crews = await crewsOnIncident(tx, incidentId, { excludeUserId: scope.actorUserId });

    const status: IncidentStatusKey = input.cancelled ? 'cancelled' : 'closed';
    const closedAt = new Date();

    await tx.update(incident).set({
      status,
      closedAt,
      closedBy: scope.actorUserId,
      closingNotes: input.notes,
    }).where(eq(incident.id, incidentId));

    /**
     * Releasing the units is part of closing, not a separate step.
     *
     * Leaving them attached is how a unit ends a shift still "committed" to a
     * call that finished hours ago — and how the board's available count drifts
     * away from reality.
     */
    const released = await tx
      .update(incidentAssignment)
      .set({ releasedAt: closedAt })
      .where(and(
        eq(incidentAssignment.incidentId, incidentId),
        isNull(incidentAssignment.releasedAt),
      ))
      .returning({ unitId: incidentAssignment.unitId });

    if (released.length > 0) {
      await tx.execute(sql`
        UPDATE unit SET current_incident_id = NULL
         WHERE current_incident_id = ${incidentId}
      `);
    }

    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'clear',
      body: input.notes === null
        ? `Incident ${input.cancelled ? 'cancelled' : 'closed'}`
        : `Incident ${input.cancelled ? 'cancelled' : 'closed'}: ${input.notes}`,
      metadata: { unitsReleased: released.length },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_CLOSED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      before: { status: current.status },
      after: { status },
      metadata: { cancelled: input.cancelled, unitsReleased: released.length },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    const deliveries = await createNotifications(tx, crews, {
      type: 'incident.closed',
      title: `${current.number} ${input.cancelled ? 'cancelled' : 'closed'}`,
      body: input.notes ?? current.title,
      href: `/dispatch?incident=${incidentId}`,
      entityType: 'incident',
      entityId: incidentId,
      organizationId: current.organization_id,
      target: 'dispatch',
      metadata: {
        number: current.number, cancelled: input.cancelled, unitsReleased: released.length,
      },
    });

    return {
      result: null,
      events: [{
        kind: 'incident.closed',
        organizationId: current.organization_id,
        topics,
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status,
          title: current.title,
          cancelled: input.cancelled,
          unitsReleased: released.length,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

export async function reopenIncident(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  reason: string,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    // Reopening is gated on the CLOSE permission: whoever may finish a call is
    // who may un-finish it. It is a separate action rather than a status change
    // because it has to carry a reason into the timeline.
    if (!scope.canCloseIncident) throw new ForbiddenError('You cannot reopen incidents.');
    if (!isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_OPEN', 'That incident is not closed.');
    }

    await tx.update(incident).set({
      status: 'pending',
      closedAt: null,
      closedBy: null,
      closingNotes: null,
    }).where(eq(incident.id, incidentId));

    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'status_change',
      body: `Incident reopened: ${reason}`,
      metadata: { from: current.status, to: 'pending', reason },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_REOPENED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      before: { status: current.status },
      after: { status: 'pending' },
      metadata: { reason },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * Reopening notifies nobody, deliberately.
     *
     * Closing released every unit, so there is no crew to tell — and the call
     * lands back at the top of the pending queue, which is a board change the
     * live event already carries. It becomes notifiable again the moment
     * somebody escalates or assigns to it.
     */
    return {
      result: null,
      events: [{
        kind: 'incident.updated',
        organizationId: current.organization_id,
        topics: await incidentTopics(tx, incidentId, current.organization_id),
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status: 'pending',
          title: current.title,
        },
      }],
    };
  });
}

// ── Assignment ─────────────────────────────────────────────────────────────

export async function assignUnit(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  unitId: string,
  role: string | null,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canAssignUnits) throw new ForbiddenError('You cannot assign units.');
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'A closed incident cannot take assignments.');
    }

    const unitRows = await tx.execute<{
      id: string; organization_id: string; callsign: string; status: string;
    }>(sql`
      SELECT id, organization_id, callsign, status FROM unit
       WHERE id = ${unitId}
       FOR UPDATE
    `);
    const target = unitRows[0];
    if (!target) throw new NotFoundError('unit');
    if (target.status !== 'active') throw new ConflictError('UNIT_DISBANDED', 'That unit has been disbanded.');

    /**
     * The unit must be one the dispatcher may command.
     *
     * A PD dispatcher assigning an MD ambulance is the cross-organization write
     * the whole system defends against. A MULTI-AGENCY call is the one place a
     * unit from another service can legitimately appear — and even then the
     * dispatcher needs the clearance that sees every organization, since that is
     * who runs a joint call.
     */
    if (!scope.canViewAllOrganizations
      && !scope.organizationIds.includes(target.organization_id)) {
      throw new ForbiddenError('You can only assign units from your own organization.');
    }

    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM incident_assignment
       WHERE incident_id = ${incidentId} AND unit_id = ${unitId} AND released_at IS NULL
    `);
    if (existing.length > 0) throw new ConflictError('ALREADY_ASSIGNED', 'That unit is already on this call.');

    await tx.insert(incidentAssignment).values({
      incidentId, unitId, role, assignedBy: scope.actorUserId,
    });

    // `unit.current_incident_id` is a denormalisation for the board; the
    // authority is `incident_assignment`. Written in the same transaction so
    // the two cannot disagree.
    await tx.update(unit).set({ currentIncidentId: incidentId }).where(eq(unit.id, unitId));

    // A call with a unit on it is dispatched. Advancing the status here saves a
    // dispatcher a second click during the exact moment they have least time.
    const status: IncidentStatusKey = current.status === 'pending' ? 'dispatched' : current.status;
    if (status !== current.status) {
      await tx.update(incident).set({ status }).where(eq(incident.id, incidentId));
    }

    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'assignment',
      body: `${target.callsign} assigned`,
      metadata: { unitId, callsign: target.callsign, role },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.UNIT_ASSIGNED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id ?? target.organization_id,
      entityType: 'incident', entityId: incidentId,
      metadata: { unitId, callsign: target.callsign, role },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * The crew being sent.
     *
     * Not the whole board and not the other crews on the call: this is the one
     * notification in the module that carries an INSTRUCTION rather than an
     * update, which is why `incident.assigned` is `warning` and audible while
     * everything else here is silent.
     *
     * Crewing the unit is itself the authorization — there is no unit whose own
     * crew may not know where it has been sent — so no permission is consulted.
     * A dispatcher who assigns their own unit is excluded: they know.
     */
    const deliveries = await createNotifications(
      tx,
      await unitCrew(tx, unitId, { excludeUserId: scope.actorUserId }),
      {
        type: 'incident.assigned',
        title: `${target.callsign} assigned — P${current.priority} ${current.number}`,
        body: current.title,
        // Severity follows the CALL, not the type default: being sent to a P1 is
        // interrupting, being sent to a P4 is not.
        severity: isCriticalIncident(current.priority) ? 'critical' : 'warning',
        href: `/dispatch?incident=${incidentId}`,
        entityType: 'incident',
        entityId: incidentId,
        organizationId: current.organization_id ?? target.organization_id,
        target: 'dispatch',
        metadata: {
          number: current.number,
          priority: current.priority,
          unitId,
          callsign: target.callsign,
          role,
        },
      },
    );

    return {
      result: null,
      events: [{
        kind: 'incident.assigned',
        organizationId: current.organization_id,
        // Resolved AFTER the insert, so the newly attached unit's agency is in
        // the set. On a joint call this is what puts the assignment on the
        // responding service's board as well as the owning one.
        topics: await incidentTopics(tx, incidentId, current.organization_id),
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status,
          title: current.title,
          unitId,
          callsign: target.callsign,
          released: false,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

export async function releaseUnit(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  unitId: string,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canAssignUnits) throw new ForbiddenError('You cannot release units.');

    // Before the release, for the same reason as in `closeIncident`: afterwards
    // the departing unit's agency is no longer on the call and would be the one
    // agency not told its unit had been stood down.
    const topics = await incidentTopics(tx, incidentId, current.organization_id);

    const released = await tx
      .update(incidentAssignment)
      .set({ releasedAt: new Date() })
      .where(and(
        eq(incidentAssignment.incidentId, incidentId),
        eq(incidentAssignment.unitId, unitId),
        isNull(incidentAssignment.releasedAt),
      ))
      .returning({ id: incidentAssignment.id });

    if (released.length === 0) throw new NotFoundError('assignment');

    await tx.execute(sql`
      UPDATE unit SET current_incident_id = NULL
       WHERE id = ${unitId} AND current_incident_id = ${incidentId}
    `);

    const callsignRows = await tx.execute<{ callsign: string }>(sql`
      SELECT callsign FROM unit WHERE id = ${unitId}
    `);
    const callsign = callsignRows[0]?.callsign ?? 'unit';

    // Read after the release for a reason: `unitCrew` asks who is CREWING THE
    // UNIT, which the release does not change. Being cleared from a call is
    // information the crew acts on — they are free, and may still be driving.
    const crew = await unitCrew(tx, unitId, { excludeUserId: scope.actorUserId });

    await appendTimeline(tx, {
      incidentId,
      actorUserId: scope.actorUserId,
      kind: 'clear',
      body: `${callsign} released`,
      metadata: { unitId, callsign },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.UNIT_RELEASED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      metadata: { unitId, callsign },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    const deliveries = await createNotifications(tx, crew, {
      type: 'incident.updated',
      title: `${callsign} cleared from ${current.number}`,
      body: current.title,
      href: `/dispatch?incident=${incidentId}`,
      entityType: 'incident',
      entityId: incidentId,
      organizationId: current.organization_id,
      target: 'dispatch',
      metadata: { number: current.number, unitId, callsign, released: true },
    });

    return {
      result: null,
      events: [{
        kind: 'incident.assigned',
        organizationId: current.organization_id,
        topics,
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status: current.status,
          title: current.title,
          unitId,
          callsign,
          released: true,
        },
      }, ...notificationEmissions(deliveries)],
    };
  });
}

// ── Notes ──────────────────────────────────────────────────────────────────

/**
 * Adds an operator note to the timeline.
 *
 * Gated on `dispatch.view` alone — deliberately the lowest bar in the module.
 * The officer on scene is usually the one with something worth recording, and
 * requiring management authority to say "suspect went over the back fence" would
 * mean it gets said on radio and lost.
 */
export async function addIncidentNote(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  body: string,
  meta: RequestMeta,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canView) throw new NotFoundError('incident');
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'A closed incident cannot take new notes.');
    }

    await appendTimeline(tx, {
      incidentId, actorUserId: scope.actorUserId, kind: 'note', body,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.INCIDENT_UPDATED,
      actorUserId: scope.actorUserId,
      organizationId: current.organization_id,
      entityType: 'incident', entityId: incidentId,
      metadata: { field: 'note' },
      ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
    });

    /**
     * A note notifies nobody, and this is the deliberate line.
     *
     * Notes are by far the highest-frequency thing that happens to a call — a
     * busy incident collects dozens — and one notification each is how a centre
     * fills with entries nobody reads, which is how the panic in the same list
     * gets missed. The timeline is live on the incident screen for anyone
     * looking at the call, and that is where a note belongs.
     *
     * There is a second reason: a note can name a suspect, an address or a
     * medical detail, and a notification row is stored where its recipient can
     * read it at leisure. Keeping notes out of the notification table keeps that
     * disclosure behind the authorized read.
     */
    return {
      result: null,
      events: [{
        kind: 'incident.updated',
        organizationId: current.organization_id,
        topics: await incidentTopics(tx, incidentId, current.organization_id),
        payload: {
          incidentId,
          number: current.number,
          priority: current.priority as IncidentPriority,
          status: current.status,
          // The note itself is NOT in the payload. A timeline entry can name a
          // suspect, an address or a medical detail; it belongs behind the
          // authorized read that already knows what this caller may see, not in
          // a broadcast whose only filter is the topic.
        },
      }],
    };
  });
}
