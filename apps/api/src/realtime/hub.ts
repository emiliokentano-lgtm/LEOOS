import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@leoos/authz-core';
import {
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, parseTopic, topicsForEvent,
  type RealtimeEvent, type ServerMessage, type UnitLocationPayload,
} from '@leoos/contracts';
import { authorizeTopic } from './topics.js';

/**
 * The connection hub.
 *
 * Holds every open socket, what each has subscribed to, and the per-topic
 * sequence numbers. About 250 lines, which is the trade ADR-0003 accepted in
 * exchange for owning the subscribe path.
 *
 * THE LOAD-BEARING DECISION: authorization is re-evaluated on EVERY DELIVERY,
 * not cached at subscribe time. `deliver` calls `authorizeTopic` with a freshly
 * resolved actor context for each recipient. That is more work per event than
 * checking a cached boolean, and it is what makes a permission change take
 * effect on the next event rather than on the next reconnect — with no
 * revocation machinery, because nothing is cached to revoke.
 *
 * The cost is bounded: dispatch events are infrequent, and the one high-rate
 * path (positions) is coalesced into one batch per subscriber per tick, so the
 * authorization work there is per-subscriber-per-second rather than
 * per-unit-per-second.
 */

/** What the hub needs from a socket. Narrow, so tests can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Re-resolves a subscriber's authorization context.
 *
 * Injected rather than imported so the hub does not depend on the auth module,
 * and so tests can drive permission changes directly.
 */
export type ActorResolver = (
  userId: string,
  organizationId: string | null,
) => Promise<ActorContext | null>;

export interface Connection {
  id: string;
  userId: string;
  sessionId: string;
  organizationId: string | null;
  socket: SocketLike;
  topics: Set<string>;
  /** Last time anything was heard from the client. */
  lastSeen: number;
  /**
   * Positions pending delivery to this subscriber, keyed by unit.
   *
   * A Map keyed by unit id, not a list: within a tick only the LATEST position
   * per unit matters, so a unit reporting ten times between flushes costs one
   * entry rather than ten. This is the "latest-state" half of the location
   * strategy.
   */
  pendingPositions: Map<string, UnitLocationPayload>;
  /** Units that left this subscriber's visibility since the last flush. */
  pendingRemovals: Set<string>;
  /** Units this subscriber currently has. Used to compute removals. */
  visibleUnits: Set<string>;
}

export interface HubOptions {
  resolveActor: ActorResolver;
  /**
   * Decides which units a subscriber may see positions for.
   *
   * Injected because the rule lives in the map module and depends on the
   * database; the hub only needs the answer.
   */
  visibleUnitsFor: (userId: string, organizationId: string | null) => Promise<Set<string>>;
  log?: (message: string) => void;
  heartbeatMs?: number;
  /**
   * Called when a connection is dropped, for whatever reason.
   *
   * The location broadcaster caches a visible-unit set per connection, and a
   * cache keyed by an id that will never be seen again is a slow leak on a
   * process that stays up for weeks.
   */
  onRemove?: (connectionId: string) => void;
}

export class RealtimeHub {
  private readonly connections = new Map<string, Connection>();
  /** Per-topic monotonic counters. A client detecting a gap resyncs. */
  private readonly sequences = new Map<string, number>();
  private readonly options: Required<Pick<HubOptions, 'heartbeatMs'>> & HubOptions;

  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: HubOptions) {
    this.options = {
      ...options,
      heartbeatMs: options.heartbeatMs ?? HEARTBEAT_TIMEOUT_MS,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => this.reapSilent(), HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
    }
    /**
     * THERE IS DELIBERATELY NO POSITION TIMER HERE.
     *
     * `flushPositions` is driven by the `LocationBroadcaster`, which is the one
     * clock for the location path. Two timers at the same interval would flush a
     * batch the broadcaster was still filling, so a subscriber would receive
     * half a tick's units and then the other half — the exact stutter the
     * coalescing exists to prevent.
     */
  }

  stop(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const connection of this.connections.values()) {
      connection.socket.close(1001, 'server shutting down');
      this.options.onRemove?.(connection.id);
    }
    this.connections.clear();
  }

  add(input: {
    userId: string;
    sessionId: string;
    organizationId: string | null;
    socket: SocketLike;
  }): Connection {
    const connection: Connection = {
      id: randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      socket: input.socket,
      topics: new Set(),
      lastSeen: Date.now(),
      pendingPositions: new Map(),
      pendingRemovals: new Set(),
      visibleUnits: new Set(),
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  remove(connectionId: string): void {
    if (this.connections.delete(connectionId)) this.options.onRemove?.(connectionId);
  }

  touch(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) connection.lastSeen = Date.now();
  }

  get size(): number {
    return this.connections.size;
  }

  // ── Subscription ─────────────────────────────────────────────────────────

  /**
   * Subscribes, authorizing each topic independently.
   *
   * A partially-denied request succeeds for what was allowed and reports the
   * rest. Failing the whole batch would make one stale topic in a client's list
   * silently break every other feed on the screen.
   */
  async subscribe(
    connectionId: string,
    raw: string[],
  ): Promise<{ ok: { topic: string; seq: number }[]; denied: { topic: string; reason: string }[] }> {
    const connection = this.connections.get(connectionId);
    if (!connection) return { ok: [], denied: [] };

    const actor = await this.options.resolveActor(connection.userId, connection.organizationId);
    const ok: { topic: string; seq: number }[] = [];
    const denied: { topic: string; reason: string }[] = [];

    // Bounded so a client cannot ask for ten thousand topics in one message.
    for (const topicString of raw.slice(0, 32)) {
      const parsed = parseTopic(topicString);
      if (parsed === null) {
        denied.push({ topic: topicString, reason: 'malformed-topic' });
        continue;
      }
      if (actor === null) {
        denied.push({ topic: topicString, reason: 'not-authenticated' });
        continue;
      }

      const decision = authorizeTopic(actor, connection.userId, parsed);
      if (!decision.allowed) {
        denied.push({ topic: topicString, reason: decision.reason ?? 'not-permitted' });
        continue;
      }

      connection.topics.add(topicString);
      ok.push({ topic: topicString, seq: this.sequences.get(topicString) ?? 0 });
    }

    return { ok, denied };
  }

  unsubscribe(connectionId: string, topics: string[]): string[] {
    const connection = this.connections.get(connectionId);
    if (!connection) return [];
    const removed: string[] = [];
    for (const topic of topics) {
      if (connection.topics.delete(topic)) removed.push(topic);
    }
    return removed;
  }

  sequencesFor(topics: string[]): { topic: string; seq: number }[] {
    return topics.map((topic) => ({ topic, seq: this.sequences.get(topic) ?? 0 }));
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  /**
   * Publishes an event to every authorized subscriber.
   *
   * The sequence is incremented ONCE per topic, not per recipient: `seq` is a
   * property of the topic's history, so two subscribers must see the same number
   * for the same event or neither can detect a gap reliably.
   */
  async publish(event: RealtimeEvent, explicitTopics?: string[]): Promise<number> {
    const topics = explicitTopics ?? topicsForEvent(event);
    if (topics.length === 0) return 0;

    let delivered = 0;

    for (const topic of topics) {
      const seq = (this.sequences.get(topic) ?? 0) + 1;
      this.sequences.set(topic, seq);

      const parsed = parseTopic(topic);
      if (parsed === null) continue;

      const message: ServerMessage = { t: 'event', topic, seq, event };
      const encoded = JSON.stringify(message);

      for (const connection of this.connections.values()) {
        if (!connection.topics.has(topic)) continue;

        /**
         * RE-AUTHORIZED HERE, on every delivery.
         *
         * This is the check that makes a mid-connection permission change take
         * effect immediately. A subscriber who has lost the permission simply
         * stops receiving; the subscription is also dropped so the work is not
         * repeated for every subsequent event.
         */
        const actor = await this.options.resolveActor(
          connection.userId, connection.organizationId,
        );
        if (actor === null || !authorizeTopic(actor, connection.userId, parsed).allowed) {
          connection.topics.delete(topic);
          this.send(connection, {
            t: 'resync-required',
            topics: [topic],
            reason: 'authorization changed',
          });
          continue;
        }

        this.sendRaw(connection, encoded);
        delivered += 1;
      }
    }

    return delivered;
  }

  /**
   * Queues a position for the subscribers who may see that unit.
   *
   * NOT sent immediately — queued, coalesced by unit, and flushed on the
   * broadcast tick. This is where the "do not broadcast every raw position"
   * requirement is actually met: a hundred units reporting at 5 Hz produce one
   * message per subscriber per second, carrying at most one entry per unit.
   */
  queuePosition(position: UnitLocationPayload, visibleTo: (connection: Connection) => boolean): void {
    for (const connection of this.connections.values()) {
      if (!connection.topics.has('map:units')) continue;
      if (!visibleTo(connection)) continue;
      connection.pendingPositions.set(position.unitId, position);
      connection.pendingRemovals.delete(position.unitId);
      connection.visibleUnits.add(position.unitId);
    }
  }

  /** Marks a unit as no longer visible to a subscriber, so the client drops it. */
  queueRemoval(unitId: string, from: Connection): void {
    if (!from.visibleUnits.delete(unitId)) return;
    from.pendingPositions.delete(unitId);
    from.pendingRemovals.add(unitId);
  }

  /**
   * Sends each subscriber their coalesced batch.
   *
   * One message per subscriber per tick, and nothing at all for a subscriber
   * with no pending changes — a parked fleet costs zero bytes rather than a
   * heartbeat of empty arrays.
   */
  flushPositions(): number {
    let sent = 0;
    const seq = (this.sequences.get('map:units') ?? 0) + 1;
    let bumped = false;

    for (const connection of this.connections.values()) {
      if (connection.pendingPositions.size === 0 && connection.pendingRemovals.size === 0) {
        continue;
      }

      const event: RealtimeEvent = {
        id: randomUUID(),
        type: 'unit.location.updated',
        at: new Date().toISOString(),
        organizationId: null,
        actor: { kind: 'system', userId: null, label: null },
        payload: {
          positions: [...connection.pendingPositions.values()],
          removed: [...connection.pendingRemovals],
        },
      };

      connection.pendingPositions.clear();
      connection.pendingRemovals.clear();

      if (!bumped) {
        this.sequences.set('map:units', seq);
        bumped = true;
      }

      this.send(connection, { t: 'event', topic: 'map:units', seq, event });
      sent += 1;
    }

    return sent;
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  /**
   * Closes sockets that have gone silent.
   *
   * A client that stops sending heartbeats is gone whether or not TCP has
   * noticed — a half-open connection otherwise holds a slot and receives events
   * nobody reads.
   */
  reapSilent(now = Date.now()): number {
    let closed = 0;
    for (const connection of this.connections.values()) {
      if (now - connection.lastSeen <= this.options.heartbeatMs) continue;
      connection.socket.close(1001, 'heartbeat timeout');
      this.remove(connection.id);
      closed += 1;
    }
    return closed;
  }

  /** Closes every connection belonging to a session. Used when a session ends. */
  closeSession(sessionId: string, reason = 'session ended'): number {
    let closed = 0;
    for (const connection of this.connections.values()) {
      if (connection.sessionId !== sessionId) continue;
      connection.socket.close(4001, reason);
      this.remove(connection.id);
      closed += 1;
    }
    return closed;
  }

  connectionsFor(userId: string): Connection[] {
    return [...this.connections.values()].filter((c) => c.userId === userId);
  }

  /** Subscribers of one topic. Used by the location broadcaster. */
  connectionsWithTopic(topic: string): Connection[] {
    return [...this.connections.values()].filter((c) => c.topics.has(topic));
  }

  send(connection: Connection, message: ServerMessage): void {
    this.sendRaw(connection, JSON.stringify(message));
  }

  private sendRaw(connection: Connection, encoded: string): void {
    try {
      connection.socket.send(encoded);
    } catch (error) {
      // A socket that throws on send is already gone. Dropping it here keeps a
      // dead connection from failing every subsequent broadcast.
      this.options.log?.(`realtime: dropping connection ${connection.id}: ${String(error)}`);
      this.remove(connection.id);
    }
  }
}
