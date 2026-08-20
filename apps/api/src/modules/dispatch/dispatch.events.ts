import { sql } from 'drizzle-orm';
import type { Database } from '@leoos/db';
import type {
  IncidentAssignedPayload, IncidentClosedPayload, IncidentPayload, PanicPayload,
  PanicResolvedPayload, PersonnelPayload, RealtimeActor, UnitMemberPayload, UnitPayload,
  UnitStatusPayload,
} from '@leoos/contracts';
import type { RealtimePublisher } from '../../realtime/publisher.js';

/**
 * What a dispatch mutation says happened.
 *
 * WHY THIS EXISTS RATHER THAN A PUBLISHER PASSED INTO EACH SERVICE.
 *
 * The one invariant of the publish path is that an event is emitted AFTER the
 * transaction commits, never inside it — a rolled-back change that has already
 * been broadcast leaves every board showing something that does not exist, and
 * there is no second event to correct it.
 *
 * A publisher handed to the service would make that a rule people have to
 * remember: `db.transaction(async (tx) => { …; events.unitCreated(…) })` compiles
 * perfectly and is wrong. So the services do not have a publisher at all. They
 * RETURN a description of what happened, and the route publishes it — which it
 * can only do once the service's promise has resolved, which is once the
 * transaction has committed. The invariant becomes a property of the shape
 * rather than of the reviewer's attention.
 *
 * The second benefit is testability: a test can assert on the emissions a
 * mutation produces without a socket, a hub, or a clock.
 */

export type DispatchEmission =
  | { kind: 'unit.created'; organizationId: string; payload: UnitPayload }
  | { kind: 'unit.updated'; organizationId: string; payload: UnitPayload }
  | { kind: 'unit.status.updated'; organizationId: string; payload: UnitStatusPayload }
  | { kind: 'unit.member.joined'; organizationId: string; payload: UnitMemberPayload }
  | { kind: 'unit.member.left'; organizationId: string; payload: UnitMemberPayload }
  | {
    kind: 'incident.created' | 'incident.updated';
    organizationId: string | null;
    topics: string[];
    payload: IncidentPayload;
  }
  | {
    kind: 'incident.assigned';
    organizationId: string | null;
    topics: string[];
    payload: IncidentAssignedPayload;
  }
  | {
    kind: 'incident.closed';
    organizationId: string | null;
    topics: string[];
    payload: IncidentClosedPayload;
  }
  | { kind: 'panic.triggered'; organizationId: string; payload: PanicPayload }
  | { kind: 'panic.resolved'; organizationId: string; payload: PanicResolvedPayload }
  | { kind: 'personnel.updated'; organizationId: string; payload: PersonnelPayload };

/**
 * The uniform return shape of every mutating dispatch service.
 *
 * `result` is what the route sends back; `events` is what it publishes. Keeping
 * both in one envelope means no route can forget the second half — a service
 * that emits nothing still returns an empty array, and the difference is
 * visible.
 */
export interface DispatchOutcome<T = null> {
  result: T;
  events: DispatchEmission[];
}

/**
 * Which organization boards an incident should reach.
 *
 * A single-agency call reaches its owner. A MULTI-AGENCY call has no owner, so
 * `topicsForEvent` would produce nothing for it and the event would be silently
 * dropped — the failure mode where a joint incident appears on neither board
 * instead of both. Here the involved organizations are read from the live
 * assignments, inside the same transaction as the change, and named explicitly.
 *
 * Must be called INSIDE the transaction: computed afterwards, it would miss a
 * unit assigned by a concurrent request, or include one released by it.
 */
export async function incidentTopics(
  tx: Database,
  incidentId: string,
  owningOrganizationId: string | null,
): Promise<string[]> {
  const organizationIds = new Set<string>();
  if (owningOrganizationId !== null) organizationIds.add(owningOrganizationId);

  const rows = await tx.execute<{ organization_id: string }>(sql`
    SELECT DISTINCT u.organization_id
      FROM incident_assignment a
      JOIN unit u ON u.id = a.unit_id
     WHERE a.incident_id = ${incidentId} AND a.released_at IS NULL
  `);
  for (const row of rows) organizationIds.add(row.organization_id);

  return [...organizationIds].map((id) => `org:${id}:incidents`);
}

/**
 * Publishes a batch of emissions.
 *
 * Call sites are all in the route layer, after the service has returned. There
 * is no await: publishing is fire-and-forget by design (see publisher.ts), and a
 * failure to broadcast must never turn a committed, audited action into a 500.
 */
export function publishDispatchEvents(
  publisher: RealtimePublisher,
  actor: RealtimeActor,
  events: readonly DispatchEmission[],
): void {
  for (const event of events) {
    switch (event.kind) {
      case 'unit.created':
        publisher.unitCreated({ organizationId: event.organizationId, actor }, event.payload);
        break;
      case 'unit.updated':
        publisher.unitUpdated({ organizationId: event.organizationId, actor }, event.payload);
        break;
      case 'unit.status.updated':
        publisher.unitStatusUpdated(
          { organizationId: event.organizationId, actor }, event.payload,
        );
        break;
      case 'unit.member.joined':
        publisher.unitMemberJoined({ organizationId: event.organizationId, actor }, event.payload);
        break;
      case 'unit.member.left':
        publisher.unitMemberLeft({ organizationId: event.organizationId, actor }, event.payload);
        break;
      case 'incident.created':
        publisher.incidentCreated(
          { organizationId: event.organizationId, actor }, event.payload, event.topics,
        );
        break;
      case 'incident.updated':
        publisher.incidentUpdated(
          { organizationId: event.organizationId, actor }, event.payload, event.topics,
        );
        break;
      case 'incident.assigned':
        publisher.incidentAssigned(
          { organizationId: event.organizationId, actor }, event.payload, event.topics,
        );
        break;
      case 'incident.closed':
        publisher.incidentClosed(
          { organizationId: event.organizationId, actor }, event.payload, event.topics,
        );
        break;
      case 'panic.triggered':
        publisher.panicTriggered({ organizationId: event.organizationId, actor }, event.payload);
        break;
      case 'panic.resolved':
        publisher.panicResolved({ organizationId: event.organizationId, actor }, event.payload);
        break;
      case 'personnel.updated':
        publisher.personnelUpdated({ organizationId: event.organizationId, actor }, event.payload);
        break;
    }
  }
}
