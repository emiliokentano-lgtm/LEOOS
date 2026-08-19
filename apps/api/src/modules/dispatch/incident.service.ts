import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  canTransitionIncident, isTerminalIncidentStatus,
  type IncidentPriority, type IncidentStatusKey,
} from '@leoos/contracts';
import {
  AUDIT_ACTIONS, incident, incidentAssignment, incidentLog, unit, type Database,
} from '@leoos/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { DispatchScope } from './dispatch.scope.js';

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
): Promise<{ id: string; number: string }> {
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

    return created;
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
): Promise<void> {
  await db.transaction(async (tx) => {
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
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canManageIncident) throw new ForbiddenError('You cannot change incident priority.');
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'A closed incident cannot be re-prioritised.');
    }
    if (current.priority === priority) return;

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
  });
}

// ── Status ─────────────────────────────────────────────────────────────────

export async function changeIncidentStatus(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  status: IncidentStatusKey,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
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
  });
}

// ── Close and reopen ───────────────────────────────────────────────────────

export async function closeIncident(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  input: { cancelled: boolean; notes: string | null },
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canCloseIncident) throw new ForbiddenError('You cannot close incidents.');
    if (isTerminalIncidentStatus(current.status)) {
      throw new ConflictError('INCIDENT_CLOSED', 'That incident is already closed.');
    }

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
  });
}

export async function reopenIncident(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  reason: string,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
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
): Promise<void> {
  await db.transaction(async (tx) => {
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
    if (current.status === 'pending') {
      await tx.update(incident).set({ status: 'dispatched' }).where(eq(incident.id, incidentId));
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
  });
}

export async function releaseUnit(
  db: Database,
  scope: DispatchScope,
  incidentId: string,
  unitId: string,
  meta: RequestMeta,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, scope, incidentId);
    if (!current) throw new NotFoundError('incident');
    if (!scope.canAssignUnits) throw new ForbiddenError('You cannot release units.');

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
): Promise<void> {
  await db.transaction(async (tx) => {
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
  });
}
