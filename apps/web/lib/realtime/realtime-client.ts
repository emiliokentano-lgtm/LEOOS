import {
  DUPLICATE_WINDOW, HEARTBEAT_INTERVAL_MS, RECONNECT_BASE_MS, RECONNECT_MAX_MS,
  type ClientMessage, type RealtimeEvent, type ServerMessage,
} from '@leoos/contracts';

/**
 * The browser's real-time connection.
 *
 * ONE PER TAB, shared by every screen. Dispatch, the dashboard and the map do
 * not each open a socket: they subscribe to topics on this one. Three sockets
 * per operator would triple the server's connection count, triple the
 * re-authorization work on every event, and give three different answers about
 * whether the feed is up — which the top bar would then have to reconcile.
 *
 * WHAT THIS CLASS IS RESPONSIBLE FOR, and what it deliberately is not.
 *
 *   It owns the socket, the ticket handshake, reconnection, the heartbeat,
 *   duplicate suppression, and gap detection. It does NOT own application state:
 *   it hands events to subscribers and tells them when their view is unreliable.
 *   Screens decide what to do about that — usually refetch, which is always
 *   correct and needs no replay machinery.
 *
 * RECOVERY, in the four failure modes the brief names:
 *
 *   CONNECTION LOSS   the socket closes; `onState('reconnecting')` fires so the
 *                     UI can say so rather than silently freezing.
 *   RECONNECT         a fresh ticket is minted (the old one is single-use and
 *                     probably expired), the socket reopens, and every topic is
 *                     re-subscribed. Backoff is exponential with jitter, capped.
 *   MISSED EVENTS     each topic carries a sequence number. A jump means
 *                     something was missed, and the subscriber is told to resync
 *                     — a snapshot, not a replay. Replay would need a durable
 *                     log and would still be wrong after a long disconnect.
 *   DUPLICATES        a bounded ring of recent event ids. Most events are
 *                     idempotent, but a panic toast shown twice is exactly the
 *                     kind of thing that teaches people to distrust the feed.
 */

export type RealtimeState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface RealtimeListener {
  /** An event on a topic this listener subscribed to. */
  onEvent?(event: RealtimeEvent, topic: string): void;
  /**
   * This listener's view of one or more topics is unreliable — refetch.
   *
   * Fired on a sequence gap, on a server `resync-required`, and after every
   * reconnect. A listener that treats this as "reload my data" is always
   * correct; there is nothing subtler to do.
   */
  onResync?(topics: string[], reason: string): void;
  /** Connection state, for the UI to report honestly. */
  onState?(state: RealtimeState, detail: string | null): void;
}

interface Subscription {
  id: number;
  topics: string[];
  listener: RealtimeListener;
}

export interface RealtimeClientOptions {
  /** Where to mint a ticket. The BFF hop, never the API directly. */
  ticketUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected by tests. */
  socketFactory?: (url: string) => WebSocketLike;
  heartbeatMs?: number;
}

/** The slice of `WebSocket` this client uses, so tests can supply a fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private state: RealtimeState = 'idle';
  private detail: string | null = null;

  private readonly subscriptions = new Map<number, Subscription>();
  private nextSubscriptionId = 1;

  /** Last sequence number seen per topic. The gap detector's whole memory. */
  private readonly sequences = new Map<string, number>();

  /**
   * Recently applied event ids, newest last.
   *
   * A bounded array rather than an unbounded Set: a console left open for a
   * twelve-hour shift would otherwise accumulate every event id of the day for
   * a check that only ever matters across a reconnect.
   */
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();

  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  /** Guards against two connect attempts racing after a fast close/open. */
  private connecting = false;

  private readonly ticketUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocketLike;
  private readonly heartbeatMs: number;

  constructor(options: RealtimeClientOptions = {}) {
    this.ticketUrl = options.ticketUrl ?? '/api/realtime/ticket';
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.socketFactory = options.socketFactory
      ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    void this.connect();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, 'client stopped');
    this.socket = null;
    this.setState('idle', null);

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
  }

  get connectionState(): RealtimeState {
    return this.state;
  }

  get connectionDetail(): string | null {
    return this.detail;
  }

  // ── Subscription ─────────────────────────────────────────────────────────

  /**
   * Registers interest in a set of topics.
   *
   * Returns an unsubscribe function. Topics are reference-counted across
   * listeners, so two screens both watching `org:x:incidents` share one server
   * subscription and neither can cancel the other's.
   */
  subscribe(topics: string[], listener: RealtimeListener): () => void {
    const id = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    this.subscriptions.set(id, { id, topics: [...topics], listener });

    listener.onState?.(this.state, this.detail);
    if (this.socket !== null && this.state === 'live') {
      this.send({ t: 'subscribe', topics: this.topicsNeededBy(id) });
    }

    return () => {
      const gone = this.subscriptions.get(id);
      this.subscriptions.delete(id);
      if (gone === undefined) return;

      // Only release what nobody else still wants.
      const orphaned = gone.topics.filter((topic) => !this.isWanted(topic));
      if (orphaned.length > 0 && this.state === 'live') {
        this.send({ t: 'unsubscribe', topics: orphaned });
        for (const topic of orphaned) this.sequences.delete(topic);
      }
    };
  }

  private isWanted(topic: string): boolean {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.topics.includes(topic)) return true;
    }
    return false;
  }

  private topicsNeededBy(id: number): string[] {
    return this.subscriptions.get(id)?.topics ?? [];
  }

  private allTopics(): string[] {
    const topics = new Set<string>();
    for (const subscription of this.subscriptions.values()) {
      for (const topic of subscription.topics) topics.add(topic);
    }
    return [...topics];
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting', this.detail);

    let ticket: { ticket: string; url: string };
    try {
      const response = await this.fetchImpl(this.ticketUrl, {
        method: 'POST',
        cache: 'no-store',
      });

      if (response.status === 401 || response.status === 403) {
        /**
         * The session is gone. Reconnecting cannot fix that, and a client that
         * keeps trying turns one expired session into a request every few
         * seconds forever.
         */
        this.connecting = false;
        this.setState('failed', 'Your session has ended. Sign in again to resume live updates.');
        return;
      }
      if (!response.ok) throw new Error(`ticket ${response.status}`);

      ticket = (await response.json()) as { ticket: string; url: string };
    } catch {
      this.connecting = false;
      this.scheduleReconnect('Could not reach the live feed.');
      return;
    }

    if (this.stopped) {
      this.connecting = false;
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(ticket.url);
    } catch {
      this.connecting = false;
      this.scheduleReconnect('Could not open the live feed.');
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.connecting = false;
      // The ticket is the FIRST message, never a query parameter — see
      // apps/api/src/realtime/tickets.ts for why.
      this.sendOn(socket, { t: 'auth', ticket: ticket.ticket });
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };

    socket.onclose = () => {
      this.connecting = false;
      if (this.socket === socket) this.socket = null;
      this.clearHeartbeat();
      if (this.stopped) return;
      if (this.state === 'failed') return;
      this.scheduleReconnect('Reconnecting to the live feed…');
    };

    socket.onerror = () => {
      // `onclose` always follows, and it is where reconnection is decided. Doing
      // it in both places produced two overlapping reconnect timers.
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'ready': {
        this.attempts = 0;
        this.setState('live', null);
        this.startHeartbeat();

        const topics = this.allTopics();
        if (topics.length > 0) this.send({ t: 'subscribe', topics });
        return;
      }

      case 'auth-failed':
        this.setState('failed', 'The live feed refused the connection. Reload to try again.');
        return;

      case 'subscribed': {
        /**
         * A resync is fired only where the server's sequence DIFFERS from what
         * this client last held.
         *
         * That covers exactly the case that needs it — a reconnect across which
         * events were published — and skips the two that do not. On a first
         * connection there is no previous number, so nothing is refetched on top
         * of the data the page already loaded. On a reconnect during a quiet
         * minute the numbers match, so forty consoles coming back from a blip do
         * not all refetch a board that has not changed.
         */
        const missed: string[] = [];
        for (const { topic, seq } of message.ok) {
          const previous = this.sequences.get(topic);
          this.sequences.set(topic, seq);
          if (previous !== undefined && seq !== previous) missed.push(topic);
        }

        // Not an error to the user: a screen may legitimately ask for a topic
        // this account cannot have, and the answer is simply no data.
        for (const denied of message.denied) this.sequences.delete(denied.topic);

        if (missed.length > 0) this.fanOutResync(missed, 'reconnected');
        return;
      }

      case 'event': {
        const { topic, seq, event } = message;

        // Duplicate: already applied, on this connection or the last one.
        if (this.seenSet.has(event.id)) return;
        this.remember(event.id);

        const previous = this.sequences.get(topic);
        this.sequences.set(topic, seq);

        /**
         * A GAP, not merely an out-of-order message.
         *
         * `seq` is per topic and incremented once per event, so anything other
         * than +1 means something never arrived. The event in hand is still
         * delivered — it is real and current — and the resync follows so the
         * screen also picks up whatever was missed before it.
         */
        if (previous !== undefined && seq > previous + 1) {
          this.fanOutEvent(event, topic);
          this.fanOutResync([topic], `missed ${seq - previous - 1} event(s)`);
          return;
        }

        this.fanOutEvent(event, topic);
        return;
      }

      case 'resync-required':
        this.fanOutResync(message.topics, message.reason);
        return;

      case 'seq': {
        /**
         * The answer to a `resync` probe — sent when a tab comes back into view.
         *
         * A number ahead of ours means events arrived while nobody was looking.
         * They are gone: the server keeps no log to replay from. So the screen
         * is told to refetch, which is both simpler and always right.
         */
        const missed: string[] = [];
        for (const { topic, seq } of message.topics) {
          const previous = this.sequences.get(topic);
          this.sequences.set(topic, seq);
          if (previous !== undefined && seq !== previous) missed.push(topic);
        }
        if (missed.length > 0) this.fanOutResync(missed, 'missed events while hidden');
        return;
      }

      case 'pong':
      case 'unsubscribed':
      case 'error':
        return;
    }
  }

  private fanOutEvent(event: RealtimeEvent, topic: string): void {
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.topics.includes(topic)) continue;
      subscription.listener.onEvent?.(event, topic);
    }
  }

  private fanOutResync(topics: string[], reason: string): void {
    for (const subscription of this.subscriptions.values()) {
      const mine = topics.filter((topic) => subscription.topics.includes(topic));
      if (mine.length === 0) continue;
      subscription.listener.onResync?.(mine, reason);
    }
  }

  private remember(eventId: string): void {
    this.seen.push(eventId);
    this.seenSet.add(eventId);
    while (this.seen.length > DUPLICATE_WINDOW) {
      const evicted = this.seen.shift();
      if (evicted !== undefined) this.seenSet.delete(evicted);
    }
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private setState(state: RealtimeState, detail: string | null): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    for (const subscription of this.subscriptions.values()) {
      subscription.listener.onState?.(state, detail);
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket === null) return;
    this.sendOn(this.socket, message);
  }

  private sendOn(socket: WebSocketLike, message: ClientMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket is already gone; `onclose` will handle reconnection.
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    // The server closes a socket that has been silent for a minute. This is what
    // keeps an idle console — a map left open on a wall display — connected.
    this.heartbeatTimer = setInterval(() => this.send({ t: 'ping' }), this.heartbeatMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    this.attempts += 1;
    this.setState('reconnecting', detail);

    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { void this.connect(); }, reconnectDelay(this.attempts));
  }

  /**
   * A hidden tab keeps its socket.
   *
   * Unlike the pollers, which stop entirely: a socket costs nothing while idle,
   * and dropping it would mean a full resync every time an operator glanced at
   * another window. What a returning tab does need is to check it did not miss
   * anything, hence the `resync` probe.
   */
  private readonly handleVisibility = (): void => {
    if (this.stopped) return;
    if (document.visibilityState !== 'visible') return;
    if (this.state === 'live') {
      this.send({ t: 'resync', topics: this.allTopics() });
      return;
    }
    if (this.state === 'reconnecting') {
      // Coming back to a struggling feed, try immediately rather than waiting
      // out a backoff that may have grown to half a minute.
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      void this.connect();
    }
  };
}

/** Exponential backoff with jitter, capped (03-realtime.md §2). */
export function reconnectDelay(attempts: number): number {
  const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempts, 5));
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}
