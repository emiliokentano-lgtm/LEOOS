import { randomUUID } from 'node:crypto';
import type {
  FieldRequestPayload, IncidentAssignedPayload, IncidentClosedPayload, IncidentPayload,
  MessageCreatedPayload, NotificationPayload,
  PanicPayload, PanicResolvedPayload, PersonnelPayload, RealtimeActor, RealtimeEvent,
  RealtimeEventType, UnitMemberPayload, UnitPayload, UnitStatusPayload,
} from '@leoos/contracts';
import type { RealtimeHub } from './hub.js';

/**
 * The publish path.
 *
 * ONE RULE GOVERNS THIS FILE: events are emitted AFTER the transaction commits,
 * never inside it.
 *
 * Publishing inside a transaction means a rolled-back change can still have been
 * broadcast — every dispatcher's board shows an assignment that does not exist,
 * and nothing ever corrects it because there is no second event. The database is
 * the truth; the feed is a notification that the truth changed, so it cannot run
 * ahead of the commit. See ADR-0006, which settled the same question for the
 * outbox.
 *
 * The consequence, stated plainly: a crash between commit and publish loses an
 * event. That is acceptable and is why every screen can resync — a client
 * detecting a sequence gap refetches rather than trusting the stream to be
 * complete. A durable outbox would close the window and is deliberately deferred
 * until there is a second consumer that cannot resync.
 */

export interface PublishContext {
  organizationId: string | null;
  actor: RealtimeActor;
}

export class RealtimePublisher {
  constructor(private readonly hub: RealtimeHub | null) {}

  /**
   * Builds and publishes one event.
   *
   * Fire-and-forget by design: a failure to broadcast must never fail the
   * request that caused it. The mutation already committed and is already
   * audited; the feed catching up is a lesser concern than a 500 on a
   * successful action.
   */
  private emit<T extends RealtimeEventType>(
    type: T,
    context: PublishContext,
    payload: Extract<RealtimeEvent, { type: T }>['payload'],
    explicitTopics?: string[],
  ): void {
    if (this.hub === null) return;

    const event = {
      id: randomUUID(),
      type,
      at: new Date().toISOString(),
      organizationId: context.organizationId,
      actor: context.actor,
      payload,
    } as RealtimeEvent;

    void this.hub.publish(event, explicitTopics).catch(() => {
      // Swallowed deliberately — see the note above. The client resyncs.
    });
  }

  // ── Units ──────────────────────────────────────────────────────────────

  unitCreated(context: PublishContext, payload: UnitPayload): void {
    this.emit('unit.created', context, payload);
  }

  unitUpdated(context: PublishContext, payload: UnitPayload): void {
    this.emit('unit.updated', context, payload);
  }

  unitStatusUpdated(context: PublishContext, payload: UnitStatusPayload): void {
    this.emit('unit.status.updated', context, payload);
  }

  unitMemberJoined(context: PublishContext, payload: UnitMemberPayload): void {
    this.emit('unit.member.joined', context, payload);
  }

  unitMemberLeft(context: PublishContext, payload: UnitMemberPayload): void {
    this.emit('unit.member.left', context, payload);
  }

  // ── Incidents ──────────────────────────────────────────────────────────

  /**
   * Incident events take EXPLICIT topics.
   *
   * A multi-agency call has no owning organization, so `topicsForEvent` would
   * produce nothing for it. The caller knows which organizations are involved —
   * the owner, plus every organization with a unit on the call — and names them,
   * so a joint incident reaches both boards instead of neither.
   */
  incidentCreated(context: PublishContext, payload: IncidentPayload, topics: string[]): void {
    this.emit('incident.created', context, payload, topics);
  }

  incidentUpdated(context: PublishContext, payload: IncidentPayload, topics: string[]): void {
    this.emit('incident.updated', context, payload, topics);
  }

  incidentAssigned(
    context: PublishContext, payload: IncidentAssignedPayload, topics: string[],
  ): void {
    this.emit('incident.assigned', context, payload, topics);
  }

  incidentClosed(context: PublishContext, payload: IncidentClosedPayload, topics: string[]): void {
    this.emit('incident.closed', context, payload, topics);
  }

  // ── Panic ──────────────────────────────────────────────────────────────

  panicTriggered(context: PublishContext, payload: PanicPayload): void {
    this.emit('panic.triggered', context, payload);
  }

  panicResolved(context: PublishContext, payload: PanicResolvedPayload): void {
    this.emit('panic.resolved', context, payload);
  }

  // ── Field requests ─────────────────────────────────────────────────────

  /**
   * Backup asked for, taken, dismissed or withdrawn.
   *
   * Routed onto the organization's INCIDENTS topic by `topicsForEvent` — a
   * field request is board content and shares the board's audience exactly, so
   * it shares its authorization rule rather than getting a second one to keep
   * in step.
   */
  fieldRequestUpdated(context: PublishContext, payload: FieldRequestPayload): void {
    this.emit('field_request.updated', context, payload);
  }

  // ── Chat ───────────────────────────────────────────────────────────────

  /**
   * A message was posted.
   *
   * Delivered to each PARTICIPANT'S OWN topic, named explicitly — never to an
   * organization topic. A conversation's audience is its membership, which is
   * narrower than any organization topic and changes independently of one, and
   * the existence of a conversation is itself information.
   *
   * The payload is three ids. No body, no preview, no author name: the client
   * fetches the message over REST, where per-viewer authorization and per-viewer
   * link resolution already live. See docs/architecture/16-chat.md §1.
   */
  messageCreated(
    context: PublishContext, payload: MessageCreatedPayload, recipientUserIds: string[],
  ): void {
    this.emit(
      'message.created',
      context,
      payload,
      recipientUserIds.map((id) => `user:${id}`),
    );
  }

  // ── People ─────────────────────────────────────────────────────────────

  personnelUpdated(context: PublishContext, payload: PersonnelPayload): void {
    this.emit('personnel.updated', context, payload);
  }

  /**
   * A notification for one person.
   *
   * Routed by the actor's user id onto their own `user:` topic, which no other
   * subscriber can reach.
   */
  notify(userId: string, payload: NotificationPayload): void {
    this.emit(
      'notification.created',
      { organizationId: null, actor: { kind: 'system', userId, label: null } },
      payload,
      [`user:${userId}`],
    );
  }
}

/** A publisher that does nothing. Used in tests and when the hub is disabled. */
export const NULL_PUBLISHER = new RealtimePublisher(null);
