import type { IncidentPriority, IncidentStatusKey } from './statuses';

/**
 * Real-time protocol.
 *
 * ONE definition, shared by both sides, so the client cannot handle an event
 * shape the server cannot produce and vice versa (ADR-0003). Everything below is
 * transport-agnostic: the same envelopes would survive a move to SSE or to a
 * message broker, because none of it mentions WebSocket.
 *
 * THE THREE PROPERTIES THAT MATTER, and where each is enforced:
 *
 *   AUTHORIZATION is per topic, re-evaluated on every delivery rather than
 *   cached at subscribe time — see `apps/api/src/realtime/topics.ts`. A PD
 *   dispatcher does not receive FIB events because those events are never
 *   written to their socket, not because the client filters them.
 *
 *   RECOVERY is per topic sequence numbers. A client that notices a gap asks for
 *   a fresh snapshot rather than trying to reconstruct; replay is deliberately
 *   not implemented, because a snapshot is simpler and always correct.
 *
 *   ECONOMY is the location path. Positions are coalesced, batched and sent as
 *   the latest state only — never one message per unit per tick.
 */

// ── Events ─────────────────────────────────────────────────────────────────

/**
 * Every event the system emits.
 *
 * Named `noun.verb` in past tense: these describe things that HAVE happened, not
 * commands. A consumer that cannot act on a past-tense fact is a consumer that
 * has misunderstood the feed.
 */
export type RealtimeEventType =
  // units
  | 'unit.location.updated'
  | 'unit.status.updated'
  | 'unit.created'
  | 'unit.updated'
  | 'unit.member.joined'
  | 'unit.member.left'
  // incidents
  | 'incident.created'
  | 'incident.updated'
  | 'incident.assigned'
  | 'incident.closed'
  // panic
  | 'panic.triggered'
  | 'panic.resolved'
  // asking for help, and saying where you are
  | 'field_request.updated'
  // people
  | 'personnel.updated'
  // the operator
  | 'notification.created';

/**
 * Who or what caused an event.
 *
 * Deliberately NOT the full actor: a display name and an id, never an email, a
 * rank, a permission set or anything from the account record. An event is
 * broadcast to many sockets and is the easiest place in the system to leak an
 * identity detail nobody asked for.
 */
export interface RealtimeActor {
  kind: 'user' | 'system' | 'game_server';
  /** Null for system-originated events. */
  userId: string | null;
  /** Display name only. Never an email or an identifier that grants anything. */
  label: string | null;
}

/**
 * The envelope every event travels in.
 *
 * `organizationId` is the SCOPE, not a hint: it is what the server matches
 * against a subscriber's topic authorization. Null means the event genuinely
 * belongs to everyone who can see the topic (a multi-agency incident).
 */
export interface RealtimeEnvelope<T extends RealtimeEventType, P> {
  /** Unique per event. The client uses it to discard duplicates after a resync. */
  id: string;
  type: T;
  /** Server clock, ISO-8601. Client clocks are not trusted for ordering. */
  at: string;
  organizationId: string | null;
  actor: RealtimeActor;
  payload: P;
}

// ── Payloads ───────────────────────────────────────────────────────────────
//
// Kept SMALL and free of anything sensitive. A payload carries identifiers and
// the handful of fields a screen needs to update in place; anything richer is
// fetched through the normal authorized read path, which already knows what this
// particular caller may see.

export interface UnitLocationPayload {
  unitId: string;
  x: number;
  y: number;
  heading: number | null;
  speed: number | null;
  /** Sample time, not send time — staleness is a property of the data. */
  sampledAt: string;
}

/**
 * A batch of positions.
 *
 * The wire form for `unit.location.updated` is ALWAYS a batch, even for one
 * unit. One message per unit per tick is the shape that makes a map feed
 * expensive, and having two shapes for the same event would mean two code paths
 * on both sides.
 */
export interface UnitLocationBatchPayload {
  positions: UnitLocationPayload[];
  /** Units that left this subscriber's visibility since the last batch. */
  removed: string[];
}

export interface UnitStatusPayload {
  unitId: string;
  callsign: string;
  statusKey: string;
  previousStatusKey: string | null;
}

export interface UnitPayload {
  unitId: string;
  callsign: string;
  unitType: string;
}

export interface UnitMemberPayload {
  unitId: string;
  callsign: string;
  memberId: string;
  /** Display name only. */
  memberName: string;
  isLeader: boolean;
}

export interface IncidentPayload {
  incidentId: string;
  number: string;
  priority: IncidentPriority;
  status: IncidentStatusKey;
  /** Present on create and update; omitted where it would add nothing. */
  title?: string;
}

export interface IncidentAssignedPayload extends IncidentPayload {
  unitId: string;
  callsign: string;
  /** True when the unit was released rather than assigned. */
  released: boolean;
}

export interface IncidentClosedPayload extends IncidentPayload {
  cancelled: boolean;
  unitsReleased: number;
}

export interface PanicPayload {
  panicId: string;
  memberId: string;
  memberName: string;
  callsign: string | null;
  unitId: string | null;
  unitCallsign: string | null;
  /** Null when no position is known. Never guessed. */
  position: { x: number; y: number } | null;
}

export interface PanicResolvedPayload {
  panicId: string;
  memberId: string;
  memberName: string;
  /** Whether the officer stood their own alert down. */
  selfResolved: boolean;
}

export interface PersonnelPayload {
  memberId: string;
  memberName: string;
  statusKey: string | null;
  unitId: string | null;
}

export type NotificationTone = 'info' | 'success' | 'warning' | 'danger';

/**
 * A notification arriving live.
 *
 * Carries the notification's IDENTIFIERS and the handful of fields a client
 * needs to decide what to do with it — no more. `id` is what a toast marks read;
 * `type` is what picks the icon and answers `shouldPlaySound`, which tone cannot
 * (tone says how alarming it looks, not whether the operator asked to hear it);
 * `severity` is what decides whether the toast stays.
 *
 * `href` is deliberately ABSENT. Routing belongs to the web app, and the client
 * refetches the head of its list on arrival anyway — which is also the only way
 * the unread badge can be right, since a count computed here would be stale the
 * moment the same person reads something in another tab.
 */
export interface NotificationPayload {
  id: string;
  /** A key from the notification catalogue. Unknown keys render generically. */
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  tone: NotificationTone;
  /** A screen name, never a URL — routing belongs to the web app. */
  target: 'dispatch' | 'map' | 'dashboard' | null;
}

// ── The event union ────────────────────────────────────────────────────────

/**
 * A field request changed state.
 *
 * IDENTIFIERS AND A STATUS, nothing more. No note body, no asker name, no
 * position — the rule that event payloads carry what a screen needs to know
 * something moved, and never the content. A client that needs the detail asks
 * for it over REST, where the per-viewer authorization already lives.
 */
export interface FieldRequestPayload {
  fieldRequestId: string;
  kind: string;
  status: string;
}

export type RealtimeEvent =
  | RealtimeEnvelope<'unit.location.updated', UnitLocationBatchPayload>
  | RealtimeEnvelope<'unit.status.updated', UnitStatusPayload>
  | RealtimeEnvelope<'unit.created', UnitPayload>
  | RealtimeEnvelope<'unit.updated', UnitPayload>
  | RealtimeEnvelope<'unit.member.joined', UnitMemberPayload>
  | RealtimeEnvelope<'unit.member.left', UnitMemberPayload>
  | RealtimeEnvelope<'incident.created', IncidentPayload>
  | RealtimeEnvelope<'incident.updated', IncidentPayload>
  | RealtimeEnvelope<'incident.assigned', IncidentAssignedPayload>
  | RealtimeEnvelope<'incident.closed', IncidentClosedPayload>
  | RealtimeEnvelope<'panic.triggered', PanicPayload>
  | RealtimeEnvelope<'panic.resolved', PanicResolvedPayload>
  | RealtimeEnvelope<'field_request.updated', FieldRequestPayload>
  | RealtimeEnvelope<'personnel.updated', PersonnelPayload>
  | RealtimeEnvelope<'notification.created', NotificationPayload>;

/** Narrowing helper, so consumers switch on `type` with the payload inferred. */
export type EventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;

// ── Topics ─────────────────────────────────────────────────────────────────

/**
 * What a client can subscribe to.
 *
 * Topics are STRUCTURED STRINGS rather than free text so the server can parse
 * one and decide authorization from its parts alone — a topic it cannot parse is
 * a topic it refuses, which is the safe default for anything a client can type.
 */
export type TopicKind =
  | 'org.units'
  | 'org.incidents'
  | 'org.panic'
  | 'org.personnel'
  | 'map.units'
  | 'user';

export interface Topic {
  kind: TopicKind;
  /** Present for `org.*` topics. */
  organizationId: string | null;
  /** Present for `user`. */
  userId: string | null;
}

export function formatTopic(topic: Topic): string {
  switch (topic.kind) {
    case 'user':
      return `user:${topic.userId ?? ''}`;
    case 'map.units':
      return 'map:units';
    default:
      return `org:${topic.organizationId ?? ''}:${topic.kind.slice('org.'.length)}`;
  }
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Parses a topic string, refusing anything malformed.
 *
 * Returns null rather than throwing: a client can send arbitrary text, and an
 * unparseable topic is a denial, not a server error.
 */
export function parseTopic(raw: string): Topic | null {
  if (raw.length > 120) return null;

  if (raw === 'map:units') {
    return { kind: 'map.units', organizationId: null, userId: null };
  }

  if (raw.startsWith('user:')) {
    const userId = raw.slice('user:'.length);
    return UUID.test(userId) ? { kind: 'user', organizationId: null, userId } : null;
  }

  if (raw.startsWith('org:')) {
    const rest = raw.slice('org:'.length);
    const separator = rest.lastIndexOf(':');
    if (separator <= 0) return null;

    const organizationId = rest.slice(0, separator);
    const suffix = rest.slice(separator + 1);
    if (!UUID.test(organizationId)) return null;

    const kind = (['units', 'incidents', 'panic', 'personnel'] as const)
      .find((k) => k === suffix);
    if (kind === undefined) return null;

    return { kind: `org.${kind}` as TopicKind, organizationId, userId: null };
  }

  return null;
}

/** Which topics an event should be delivered on. */
export function topicsForEvent(event: RealtimeEvent): string[] {
  const org = event.organizationId;

  switch (event.type) {
    case 'unit.location.updated':
      return ['map:units'];

    case 'unit.status.updated':
    case 'unit.created':
    case 'unit.updated':
    case 'unit.member.joined':
    case 'unit.member.left':
      return org === null ? [] : [`org:${org}:units`];

    case 'incident.created':
    case 'incident.updated':
    case 'incident.assigned':
    case 'incident.closed':
      // A multi-agency call has no owning organization. It is delivered on every
      // organization topic the publisher names explicitly rather than being
      // silently dropped — see the publisher.
      return org === null ? [] : [`org:${org}:incidents`];

    case 'panic.triggered':
    case 'panic.resolved':
      return org === null ? [] : [`org:${org}:panic`];

    /**
     * Delivered on the INCIDENTS topic, not a topic of its own.
     *
     * A field request is dispatch board content and its audience is exactly the
     * audience of that board — everyone with `dispatch.view` in the
     * organization. A new topic would mean a new authorization rule that had to
     * be kept in step with an existing one, which is how two rules drift apart.
     */
    case 'field_request.updated':
      return org === null ? [] : [`org:${org}:incidents`];

    case 'personnel.updated':
      return org === null ? [] : [`org:${org}:personnel`];

    case 'notification.created':
      return event.actor.userId === null ? [] : [`user:${event.actor.userId}`];
  }
}

// ── Wire protocol ──────────────────────────────────────────────────────────

/**
 * Client → server.
 *
 * The socket is READ-MOSTLY. Clients never perform dispatch actions over it;
 * they call REST and observe the resulting event. That keeps one authorization
 * path, one validation path and one audit path for every mutation, which is
 * worth far more than the round trip it costs.
 */
export type ClientMessage =
  /** Always first. Carries the single-use ticket — see ADR-0013. */
  | { t: 'auth'; ticket: string }
  | { t: 'subscribe'; topics: string[] }
  | { t: 'unsubscribe'; topics: string[] }
  | { t: 'ping' }
  /** Asks for the current sequence numbers, to detect a gap after a reconnect. */
  | { t: 'resync'; topics: string[] };

export type DenyReason =
  | 'not-authenticated'
  | 'malformed-topic'
  | 'not-permitted'
  | 'unknown-organization';

/** Server → client. */
export type ServerMessage =
  | { t: 'ready'; connectionId: string; userId: string; heartbeatMs: number }
  | { t: 'auth-failed'; reason: string }
  | {
    t: 'subscribed';
    ok: { topic: string; seq: number }[];
    denied: { topic: string; reason: DenyReason }[];
  }
  | { t: 'unsubscribed'; topics: string[] }
  /**
   * An event, with its per-topic sequence number.
   *
   * A client that receives `seq` more than one ahead of what it holds knows it
   * missed something and refetches rather than guessing.
   */
  | { t: 'event'; topic: string; seq: number; event: RealtimeEvent }
  /** The server is telling the client its view is unreliable; refetch. */
  | { t: 'resync-required'; topics: string[]; reason: string }
  | { t: 'seq'; topics: { topic: string; seq: number }[] }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string };

// ── Timing ─────────────────────────────────────────────────────────────────

/** Client pings on this interval. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** The server closes a socket that has been silent this long. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** A ticket is short-lived and single-use; see ADR-0013. */
export const TICKET_TTL_MS = 30_000;

/**
 * Position broadcast interval.
 *
 * Positions are coalesced into one batch per subscriber per tick. Raising this
 * costs responsiveness; lowering it costs bandwidth on every connected console
 * simultaneously, which is the expensive direction.
 */
export const LOCATION_BROADCAST_MS = 1_000;

/** Reconnect backoff, capped. Jitter is applied by the client. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * How often a screen polls WHILE THE SOCKET IS LIVE.
 *
 * Polling is not switched off when the feed connects, it is slowed down. The
 * socket can be silently wrong in ways it cannot detect — a topic denied at
 * subscribe time, a proxy holding a connection open with nothing flowing through
 * it — and a screen that has stopped asking would never find out. Half a minute
 * costs almost nothing and bounds how long a console can display a stale board
 * while believing it is live.
 */
export const BACKSTOP_POLL_MS = 30_000;

/**
 * How many recent event ids a client remembers for duplicate suppression.
 *
 * A reconnect can redeliver events the client already applied. Most are
 * idempotent, but `notification.created` is not — showing a panic toast twice is
 * exactly the kind of thing that erodes trust in the feed.
 */
export const DUPLICATE_WINDOW = 256;
