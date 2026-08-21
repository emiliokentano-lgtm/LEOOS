import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { formatTopic, parseTopic, topicsForEvent, type RealtimeEvent } from '@leoos/contracts';
import type { ActorContext } from '@leoos/authz-core';
import {
  createActiveUser, createHarness, grantMembership, organizationIdByKey,
  resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';
import { RealtimeHub, type SocketLike } from '../src/realtime/hub.js';
import { TicketStore } from '../src/realtime/tickets.js';
import { authorizeTopic } from '../src/realtime/topics.js';

/**
 * Real-time authorization and recovery.
 *
 * THE CLAIM THIS FILE EXISTS TO DEFEND, in the brief's own words: "a PD user
 * should not automatically receive sensitive FIB-only events". That is a
 * security property, so it is tested rather than asserted in a comment — and it
 * is tested at the two places it can fail:
 *
 *   1. AT SUBSCRIBE. A crafted topic naming somebody else's organization is
 *      refused. So is a topic naming another user's private stream, including
 *      to a global administrator.
 *
 *   2. AT DELIVERY. This is the one people forget. A subscription authorized
 *      five minutes ago is not authorization now: a demoted, transferred or
 *      terminated operator must stop receiving on the NEXT event, not on their
 *      next reconnect. The hub re-checks every recipient on every publish, and
 *      the tests below drive a permission change through a live connection to
 *      prove it.
 *
 * The remaining tests cover the two mechanisms recovery depends on — single-use
 * tickets and per-topic sequence numbers — because a feed that cannot be trusted
 * to notice its own gaps is a feed that shows a stale board confidently.
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
  await h.db.execute(sql`UPDATE panic_event SET resolved_at = now() WHERE resolved_at IS NULL`);
});

interface Person {
  username: string;
  userId: string;
  memberId: string;
  organizationId: string;
  headers: Record<string, string>;
  /**
   * The REAL session behind this person's sign-in.
   *
   * A connection now has to name a live session — the hub re-checks it on every
   * subscribe and every delivery, and sweeps for dead ones on the heartbeat, so
   * a logout or a revocation closes the socket. A synthetic id would simply
   * resolve to "not a live session" and the connection would be dropped, which
   * is the correct behaviour and would make these tests wrong rather than
   * failing for a reason worth reading.
   */
  sessionId: string;
}

async function member(prefix: string, orgKey: string, roleKey: string): Promise<Person> {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  const m = await grantMembership(h.db, creds.username, { orgKey, roleKey });
  const auth = await signIn(h, creds);
  const userId = await userIdByUsername(h.db, creds.username);
  const [live] = await h.db.execute<{ id: string }>(sql`
    SELECT id FROM "session"
     WHERE user_id = ${userId} AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1
  `);
  return {
    username: creds.username,
    userId,
    memberId: m.memberId,
    organizationId: m.organizationId,
    headers: auth.headers,
    sessionId: live!.id,
  };
}

/** A socket that records what was written to it. */
function fakeSocket(): SocketLike & { sent: string[]; closed: { code?: number }[] } {
  const sent: string[] = [];
  const closed: { code?: number }[] = [];
  return {
    sent,
    closed,
    send: (data: string) => { sent.push(data); },
    close: (code?: number) => { closed.push({ code }); },
  };
}

function messages(socket: { sent: string[] }): { t: string; [k: string]: unknown }[] {
  return socket.sent.map((raw) => JSON.parse(raw) as { t: string });
}

/** A minimal actor, so topic rules can be tested without a database round trip. */
function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    isGlobalAdmin: false,
    isOrgLead: false,
    level: 10,
    permissions: new Set(),
    globalCapabilities: new Set(),
    membershipActive: true,
    ...overrides,
  };
}

function event(type: RealtimeEvent['type'], organizationId: string | null): RealtimeEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    at: new Date().toISOString(),
    organizationId,
    actor: { kind: 'system', userId: null, label: null },
    // Each event type has its own payload; the hub never reads it, so a cast is
    // honest here — what is under test is routing, not shape.
    payload: {},
  } as unknown as RealtimeEvent;
}

// ── Topic parsing ───────────────────────────────────────────────────────────

describe('topic parsing', () => {
  it('refuses anything it cannot parse rather than throwing', () => {
    for (const bad of [
      '', 'units', 'org:', 'org::units', 'org:not-a-uuid:units',
      'org:00000000-0000-4000-8000-000000000001:secrets',
      'user:not-a-uuid', 'map:everything', 'x'.repeat(200),
    ]) {
      expect(parseTopic(bad), bad).toBeNull();
    }
  });

  it('round-trips every topic kind', () => {
    const org = '00000000-0000-4000-8000-000000000001';
    const user = '00000000-0000-4000-8000-000000000002';
    for (const raw of [
      `org:${org}:units`, `org:${org}:incidents`, `org:${org}:panic`, `org:${org}:personnel`,
      'map:units', `user:${user}`,
    ]) {
      const parsed = parseTopic(raw);
      expect(parsed, raw).not.toBeNull();
      expect(formatTopic(parsed!)).toBe(raw);
    }
  });

  it('routes each event type to exactly one kind of topic', () => {
    const org = '00000000-0000-4000-8000-000000000001';
    expect(topicsForEvent(event('unit.status.updated', org))).toEqual([`org:${org}:units`]);
    expect(topicsForEvent(event('incident.created', org))).toEqual([`org:${org}:incidents`]);
    expect(topicsForEvent(event('panic.triggered', org))).toEqual([`org:${org}:panic`]);
    expect(topicsForEvent(event('personnel.updated', org))).toEqual([`org:${org}:personnel`]);
    expect(topicsForEvent(event('unit.location.updated', null))).toEqual(['map:units']);
  });

  it('produces no topic for an ownerless dispatch event', () => {
    // A multi-agency call has no owning organization. The publisher names its
    // topics explicitly; silently broadcasting to everyone would be the wrong
    // failure, so the default is to broadcast to nobody.
    expect(topicsForEvent(event('incident.created', null))).toEqual([]);
    expect(topicsForEvent(event('unit.status.updated', null))).toEqual([]);
  });
});

// ── Topic authorization ─────────────────────────────────────────────────────

describe('topic authorization', () => {
  const OTHER_ORG = '00000000-0000-4000-8000-0000000000ff';

  it('refuses another organization’s dispatch topics', () => {
    const pd = actor({ permissions: new Set(['dispatch.view']) });
    const own = parseTopic(`org:org-1:units`);
    // `org-1` is not a UUID, so build the topic directly — the parse rule is
    // tested above; this is about the decision.
    expect(own).toBeNull();

    const foreign = { kind: 'org.incidents' as const, organizationId: OTHER_ORG, userId: null };
    expect(authorizeTopic(pd, 'user-1', foreign).allowed).toBe(false);

    const mine = { kind: 'org.incidents' as const, organizationId: 'org-1', userId: null };
    expect(authorizeTopic(pd, 'user-1', mine).allowed).toBe(true);
  });

  it('requires dispatch.view even inside the caller’s own organization', () => {
    const bystander = actor();
    const mine = { kind: 'org.units' as const, organizationId: 'org-1', userId: null };
    expect(authorizeTopic(bystander, 'user-1', mine).allowed).toBe(false);
  });

  it('gates the personnel feed on personnel.view, not dispatch.view', () => {
    const dispatcher = actor({ permissions: new Set(['dispatch.view']) });
    const roster = { kind: 'org.personnel' as const, organizationId: 'org-1', userId: null };
    expect(authorizeTopic(dispatcher, 'user-1', roster).allowed).toBe(false);

    const supervisor = actor({ permissions: new Set(['dispatch.view', 'personnel.view']) });
    expect(authorizeTopic(supervisor, 'user-1', roster).allowed).toBe(true);
  });

  it('refuses another user’s notification stream — even to a global administrator', () => {
    const admin = actor({ isGlobalAdmin: true, globalCapabilities: new Set(['global_admin']) });
    const someoneElse = { kind: 'user' as const, organizationId: null, userId: 'user-2' };
    expect(authorizeTopic(admin, 'user-1', someoneElse).allowed).toBe(false);

    const own = { kind: 'user' as const, organizationId: null, userId: 'user-1' };
    expect(authorizeTopic(admin, 'user-1', own).allowed).toBe(true);
  });

  it('gates positions on map.track_units', () => {
    const topic = { kind: 'map.units' as const, organizationId: null, userId: null };
    expect(authorizeTopic(actor(), 'user-1', topic).allowed).toBe(false);
    expect(
      authorizeTopic(actor({ permissions: new Set(['map.track_units']) }), 'user-1', topic).allowed,
    ).toBe(true);
  });
});

// ── Tickets ─────────────────────────────────────────────────────────────────

describe('connection tickets', () => {
  it('is single use', () => {
    const store = new TicketStore();
    const { ticket } = store.mint({ userId: 'u', sessionId: 's', organizationId: 'o' });

    expect(store.redeem(ticket)).not.toBeNull();
    // The replay a captured ticket would be used for.
    expect(store.redeem(ticket)).toBeNull();
  });

  it('expires, and a used ticket stays used even before it expires', () => {
    const store = new TicketStore();
    const { ticket } = store.mint({ userId: 'u', sessionId: 's', organizationId: null });
    store.redeem(ticket);
    expect(store.size).toBe(0);

    const other = store.mint({ userId: 'u', sessionId: 's', organizationId: null });
    expect(store.sweep(Date.now() + 60_000)).toBe(1);
    expect(store.redeem(other.ticket)).toBeNull();
  });

  it('refuses a value it never issued, without leaking why', () => {
    const store = new TicketStore();
    store.mint({ userId: 'u', sessionId: 's', organizationId: null });
    expect(store.redeem('not-a-ticket-but-long-enough-to-pass-the-length-check')).toBeNull();
    expect(store.redeem('')).toBeNull();
  });

  it('revoking a session invalidates every ticket it minted', () => {
    const store = new TicketStore();
    const a = store.mint({ userId: 'u', sessionId: 'session-1', organizationId: null });
    const b = store.mint({ userId: 'u', sessionId: 'session-1', organizationId: null });
    const c = store.mint({ userId: 'u', sessionId: 'session-2', organizationId: null });

    expect(store.revokeSession('session-1')).toBe(2);
    expect(store.redeem(a.ticket)).toBeNull();
    expect(store.redeem(b.ticket)).toBeNull();
    expect(store.redeem(c.ticket)).not.toBeNull();
  });

  it('is minted only for an authenticated caller, and never cached', async () => {
    const anon = await h.app.inject({ method: 'POST', url: '/api/v1/realtime/ticket' });
    expect(anon.statusCode).toBe(401);

    const person = await member('rtticket', 'PD', 'sergeant');
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/realtime/ticket', headers: person.headers,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toContain('no-store');

    const body = res.json() as { ticket: string; expiresAt: string };
    expect(body.ticket.length).toBeGreaterThan(30);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

// ── The hub ─────────────────────────────────────────────────────────────────

describe('hub delivery', () => {
  const ORG_A = '00000000-0000-4000-8000-00000000000a';
  const ORG_B = '00000000-0000-4000-8000-00000000000b';

  function hubWith(actors: Record<string, ActorContext | null>): RealtimeHub {
    return new RealtimeHub({
      resolveActor: async (userId) => actors[userId] ?? null,
      // These units exercise topic authorization, not session lifetime; the
      // session-liveness path has its own tests.
      isSessionLive: async () => true,
      visibleUnitsFor: async () => new Set(),
    });
  }

  it('delivers only to subscribers of the topic', async () => {
    const hub = hubWith({
      a: actor({ organizationId: ORG_A, permissions: new Set(['dispatch.view']) }),
      b: actor({ organizationId: ORG_B, permissions: new Set(['dispatch.view']) }),
    });

    const socketA = fakeSocket();
    const socketB = fakeSocket();
    const a = hub.add({ userId: 'a', sessionId: 's', organizationId: ORG_A, socket: socketA });
    const b = hub.add({ userId: 'b', sessionId: 's', organizationId: ORG_B, socket: socketB });

    await hub.subscribe(a.id, [`org:${ORG_A}:incidents`]);
    await hub.subscribe(b.id, [`org:${ORG_B}:incidents`]);

    const delivered = await hub.publish(event('incident.created', ORG_A));
    expect(delivered).toBe(1);
    expect(messages(socketA).filter((m) => m.t === 'event')).toHaveLength(1);
    expect(messages(socketB).filter((m) => m.t === 'event')).toHaveLength(0);
  });

  it('refuses a subscription to another organization’s topic', async () => {
    const hub = hubWith({
      a: actor({ organizationId: ORG_A, permissions: new Set(['dispatch.view']) }),
    });
    const socket = fakeSocket();
    const a = hub.add({ userId: 'a', sessionId: 's', organizationId: ORG_A, socket });

    const result = await hub.subscribe(a.id, [
      `org:${ORG_B}:incidents`, `org:${ORG_A}:incidents`, 'garbage',
    ]);

    expect(result.ok.map((o) => o.topic)).toEqual([`org:${ORG_A}:incidents`]);
    expect(result.denied.map((d) => d.topic).sort())
      .toEqual([`org:${ORG_B}:incidents`, 'garbage'].sort());

    // And it is not merely reported — nothing arrives on the refused topic.
    await hub.publish(event('incident.created', ORG_B));
    expect(messages(socket).filter((m) => m.t === 'event')).toHaveLength(0);
  });

  it('RE-AUTHORIZES on every delivery, so losing a permission stops the feed at once',
    async () => {
      const live: Record<string, ActorContext | null> = {
        a: actor({ organizationId: ORG_A, permissions: new Set(['dispatch.view']) }),
      };
      const hub = new RealtimeHub({
        isSessionLive: async () => true,
        resolveActor: async (userId) => live[userId] ?? null,
        visibleUnitsFor: async () => new Set(),
      });

      const socket = fakeSocket();
      const a = hub.add({ userId: 'a', sessionId: 's', organizationId: ORG_A, socket });
      await hub.subscribe(a.id, [`org:${ORG_A}:incidents`]);

      expect(await hub.publish(event('incident.created', ORG_A))).toBe(1);

      // The demotion. No revocation call, no cache to invalidate — the next
      // delivery simply re-reads and finds the permission gone.
      live.a = actor({ organizationId: ORG_A, permissions: new Set() });

      expect(await hub.publish(event('incident.updated', ORG_A))).toBe(0);

      const sent = messages(socket);
      expect(sent.filter((m) => m.t === 'event')).toHaveLength(1);
      // Told, rather than silently starved: the client refetches through the
      // authorized read, which will show it what it may now see.
      expect(sent.filter((m) => m.t === 'resync-required')).toHaveLength(1);

      // The subscription is dropped, so the work is not repeated per event.
      expect(await hub.publish(event('incident.updated', ORG_A))).toBe(0);
      expect(messages(socket).filter((m) => m.t === 'resync-required')).toHaveLength(1);
    });

  it('stops delivering entirely when the account no longer resolves', async () => {
    const live: Record<string, ActorContext | null> = {
      a: actor({ organizationId: ORG_A, permissions: new Set(['dispatch.view']) }),
    };
    const hub = new RealtimeHub({
      isSessionLive: async () => true,
      resolveActor: async (userId) => live[userId] ?? null,
      visibleUnitsFor: async () => new Set(),
    });
    const socket = fakeSocket();
    const a = hub.add({ userId: 'a', sessionId: 's', organizationId: ORG_A, socket });
    await hub.subscribe(a.id, [`org:${ORG_A}:incidents`]);

    live.a = null; // deleted, disabled, or a database that stopped answering
    expect(await hub.publish(event('incident.created', ORG_A))).toBe(0);
  });

  it('numbers each topic independently, and identically for every recipient', async () => {
    const both = actor({ organizationId: ORG_A, permissions: new Set(['dispatch.view']) });
    const hub = hubWith({ a: both, b: both });

    const socketA = fakeSocket();
    const socketB = fakeSocket();
    const a = hub.add({ userId: 'a', sessionId: 's', organizationId: ORG_A, socket: socketA });
    const b = hub.add({ userId: 'b', sessionId: 's', organizationId: ORG_A, socket: socketB });
    await hub.subscribe(a.id, [`org:${ORG_A}:incidents`, `org:${ORG_A}:units`]);
    await hub.subscribe(b.id, [`org:${ORG_A}:incidents`]);

    await hub.publish(event('incident.created', ORG_A));
    await hub.publish(event('unit.status.updated', ORG_A));
    await hub.publish(event('incident.updated', ORG_A));

    const seqOn = (socket: { sent: string[] }, topic: string) =>
      messages(socket)
        .filter((m) => m.t === 'event' && m.topic === topic)
        .map((m) => m.seq);

    // Two events on the incident topic, numbered 1 and 2 — the unit event in
    // between must NOT advance it, or a client would see a phantom gap.
    expect(seqOn(socketA, `org:${ORG_A}:incidents`)).toEqual([1, 2]);
    expect(seqOn(socketA, `org:${ORG_A}:units`)).toEqual([1]);
    // Both subscribers see the same numbers, which is what makes a gap
    // detectable at all.
    expect(seqOn(socketB, `org:${ORG_A}:incidents`)).toEqual([1, 2]);
  });

  it('coalesces positions to the latest per unit, in one batch per subscriber', () => {
    const hub = hubWith({ a: actor({ permissions: new Set(['map.track_units']) }) });
    const socket = fakeSocket();
    const connection = hub.add({
      userId: 'a', sessionId: 's', organizationId: null, socket,
    });
    connection.topics.add('map:units');

    // The same unit reporting five times between flushes, plus a second unit.
    for (let i = 0; i < 5; i += 1) {
      hub.queuePosition({
        unitId: 'unit-1', x: i, y: i, heading: null, speed: null,
        sampledAt: new Date().toISOString(),
      }, () => true);
    }
    hub.queuePosition({
      unitId: 'unit-2', x: 9, y: 9, heading: null, speed: null,
      sampledAt: new Date().toISOString(),
    }, () => true);

    expect(hub.flushPositions()).toBe(1);

    const events = messages(socket).filter((m) => m.t === 'event');
    expect(events).toHaveLength(1);

    const payload = (events[0] as unknown as {
      event: { payload: { positions: { unitId: string; x: number }[] } };
    }).event.payload;

    // Two entries for two units — not six for six samples.
    expect(payload.positions).toHaveLength(2);
    expect(payload.positions.find((p) => p.unitId === 'unit-1')?.x).toBe(4);
  });

  it('sends nothing at all to a subscriber with no pending positions', () => {
    const hub = hubWith({ a: actor({ permissions: new Set(['map.track_units']) }) });
    const socket = fakeSocket();
    const connection = hub.add({ userId: 'a', sessionId: 's', organizationId: null, socket });
    connection.topics.add('map:units');

    // A parked fleet costs zero bytes, rather than a heartbeat of empty arrays.
    expect(hub.flushPositions()).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });

  it('reports a removal so a marker cannot be left frozen on the map', () => {
    const hub = hubWith({ a: actor({ permissions: new Set(['map.track_units']) }) });
    const socket = fakeSocket();
    const connection = hub.add({ userId: 'a', sessionId: 's', organizationId: null, socket });
    connection.topics.add('map:units');

    hub.queuePosition({
      unitId: 'unit-1', x: 1, y: 1, heading: null, speed: null,
      sampledAt: new Date().toISOString(),
    }, () => true);
    hub.flushPositions();

    hub.queueRemoval('unit-1', connection);
    hub.flushPositions();

    const last = messages(socket).at(-1) as unknown as {
      event: { payload: { removed: string[] } };
    };
    expect(last.event.payload.removed).toEqual(['unit-1']);
  });

  it('closes every connection belonging to a revoked session', () => {
    const hub = hubWith({ a: actor() });
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    hub.add({ userId: 'a', sessionId: 'session-1', organizationId: null, socket: socketA });
    hub.add({ userId: 'a', sessionId: 'session-2', organizationId: null, socket: socketB });

    expect(hub.closeSession('session-1')).toBe(1);
    expect(socketA.closed).toHaveLength(1);
    expect(socketB.closed).toHaveLength(0);
    expect(hub.size).toBe(1);
  });

  it('reaps a connection that has gone silent', () => {
    const hub = new RealtimeHub({
      isSessionLive: async () => true,
      resolveActor: async () => actor(),
      visibleUnitsFor: async () => new Set(),
      heartbeatMs: 1_000,
    });
    const socket = fakeSocket();
    hub.add({ userId: 'a', sessionId: 's', organizationId: null, socket });

    expect(hub.reapSilent(Date.now())).toBe(0);
    expect(hub.reapSilent(Date.now() + 5_000)).toBe(1);
    expect(socket.closed).toHaveLength(1);
    expect(hub.size).toBe(0);
  });
});

// ── The publish path, end to end ────────────────────────────────────────────

describe('dispatch mutations publish', () => {
  /**
   * These go through the REAL routes with a REAL connection attached to the
   * application's own hub — the point being that the events reach a socket, not
   * merely that a service returned an array. A test of the return value alone
   * would pass with the publish call deleted from the route.
   */
  async function connect(person: Person): Promise<ReturnType<typeof fakeSocket>> {
    const socket = fakeSocket();
    const connection = h.app.realtime.add({
      userId: person.userId,
      sessionId: person.sessionId,
      organizationId: person.organizationId,
      socket,
    });
    await h.app.realtime.subscribe(connection.id, [
      `org:${person.organizationId}:incidents`,
      `org:${person.organizationId}:units`,
      `org:${person.organizationId}:panic`,
      `org:${person.organizationId}:personnel`,
    ]);
    return socket;
  }

  /** The publish path is fire-and-forget, so give it a tick to land. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  function typesOn(socket: { sent: string[] }): string[] {
    return messages(socket)
      .filter((m) => m.t === 'event')
      .map((m) => (m as unknown as { event: { type: string } }).event.type);
  }

  it('announces a new incident on the owning organization’s topic', async () => {
    const dispatcher = await member('rtpub', 'PD', 'sergeant');
    const socket = await connect(dispatcher);

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents', headers: dispatcher.headers,
      payload: { title: 'Realtime publish check', priority: 2 },
    });
    expect(res.statusCode).toBe(201);
    await settle();

    expect(typesOn(socket)).toContain('incident.created');
  });

  it('announces a panic, and does not announce a repeat press', async () => {
    const officer = await member('rtpanic', 'PD', 'officer');
    const socket = await connect(officer);

    const first = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic', headers: officer.headers, payload: {},
    });
    expect(first.statusCode).toBe(201);
    await settle();
    expect(typesOn(socket).filter((t) => t === 'panic.triggered')).toHaveLength(1);

    // Someone in trouble presses again. The alert is already live; a second
    // event would be a second toast for one emergency.
    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/panic', headers: officer.headers, payload: {},
    });
    await settle();
    expect(typesOn(socket).filter((t) => t === 'panic.triggered')).toHaveLength(1);
  });

  it('announces a duty status change as both a personnel and a unit event', async () => {
    const officer = await member('rtstatus', 'PD', 'officer');
    const socket = await connect(officer);

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/units', headers: officer.headers,
      payload: { callsign: `RT${Date.now().toString(36).slice(-5)}`.toUpperCase(), joinSelf: true },
    });
    // An officer may not create units; use a supervisor for that part.
    if (created.statusCode !== 201) {
      const sergeant = await member('rtstatussgt', 'PD', 'sergeant');
      const unit = await h.app.inject({
        method: 'POST', url: '/api/v1/dispatch/units', headers: sergeant.headers,
        payload: {
          callsign: `RT${Date.now().toString(36).slice(-5)}`.toUpperCase(), joinSelf: false,
        },
      });
      expect(unit.statusCode).toBe(201);
      const { id } = unit.json() as { id: string };
      await h.app.inject({
        method: 'POST', url: `/api/v1/dispatch/self/unit/${id}`, headers: officer.headers,
        payload: {},
      });
    }
    await settle();

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/self/status', headers: officer.headers,
      payload: { statusKey: 'busy' },
    });
    expect(res.statusCode).toBe(200);
    await settle();

    const types = typesOn(socket);
    expect(types).toContain('personnel.updated');
    expect(types).toContain('unit.status.updated');
    expect(types).toContain('unit.member.joined');
  });

  it('does not put one organization’s incident on another’s socket', async () => {
    const pd = await member('rtiso', 'PD', 'sergeant');
    const md = await member('rtisomd', 'MD', 'doctor');
    expect(pd.organizationId).not.toBe(md.organizationId);

    const mdSocket = await connect(md);

    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents', headers: pd.headers,
      payload: { title: 'PD only', priority: 1 },
    });
    await settle();

    expect(typesOn(mdSocket)).not.toContain('incident.created');
  });

  it('carries no sensitive detail in an incident payload', async () => {
    const dispatcher = await member('rtleak', 'PD', 'sergeant');
    const socket = await connect(dispatcher);

    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents', headers: dispatcher.headers,
      payload: {
        title: 'Caller reports a prowler',
        description: 'CONFIDENTIAL-NARRATIVE',
        callerPhone: '555-0199',
        priority: 2,
      },
    });
    await settle();

    /**
     * The whole serialised frame is searched, not just the fields anyone
     * remembered to check. A payload that grew a `description` field later would
     * fail this test rather than quietly broadcast a narrative.
     */
    const frames = socket.sent.join('\n');
    expect(frames).toContain('incident.created');
    expect(frames).not.toContain('CONFIDENTIAL-NARRATIVE');
    expect(frames).not.toContain('555-0199');
  });

  it('a note reaches the board without the note’s text', async () => {
    const dispatcher = await member('rtnote', 'PD', 'sergeant');
    const socket = await connect(dispatcher);

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents', headers: dispatcher.headers,
      payload: { title: 'Note carrier', priority: 3 },
    });
    const { id } = created.json() as { id: string };

    await h.app.inject({
      method: 'POST', url: `/api/v1/dispatch/incidents/${id}/notes`, headers: dispatcher.headers,
      payload: { body: 'SUSPECT-WENT-OVER-THE-FENCE' },
    });
    await settle();

    expect(typesOn(socket).filter((t) => t === 'incident.updated').length).toBeGreaterThan(0);
    expect(socket.sent.join('\n')).not.toContain('SUSPECT-WENT-OVER-THE-FENCE');
  });

  it('a subscriber who loses dispatch.view stops receiving on the next event', async () => {
    const dispatcher = await member('rtdemote', 'PD', 'sergeant');
    const socket = await connect(dispatcher);

    const first = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents', headers: dispatcher.headers,
      payload: { title: 'Before the demotion', priority: 3 },
    });
    expect(first.statusCode).toBe(201);
    await settle();
    const beforeCount = typesOn(socket).length;
    expect(beforeCount).toBeGreaterThan(0);

    // A deny override is the fastest way to take the permission away for real —
    // it goes through the same resolution path a demotion would.
    await setPermissionOverride(h.db, dispatcher.memberId, 'dispatch.view', 'deny');

    /**
     * The hub caches a resolved actor for one second. Waiting past it is what
     * makes this a test of re-authorization rather than of the cache.
     */
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const other = await member('rtdemoteb', 'PD', 'sergeant');
    await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/incidents', headers: other.headers,
      payload: { title: 'After the demotion', priority: 3 },
    });
    await settle();

    expect(typesOn(socket).length).toBe(beforeCount);
    expect(messages(socket).some((m) => m.t === 'resync-required')).toBe(true);
  });
});

// ── Scope helper ────────────────────────────────────────────────────────────

describe('organization scoping of the feed', () => {
  it('a PD dispatcher cannot subscribe to FIB’s board', async () => {
    const pd = await member('rtfib', 'PD', 'sergeant');
    const fibOrgId = await organizationIdByKey(h.db, 'FIB');

    const socket = fakeSocket();
    const connection = h.app.realtime.add({
      userId: pd.userId, sessionId: pd.sessionId, organizationId: pd.organizationId, socket,
    });

    const result = await h.app.realtime.subscribe(connection.id, [
      `org:${fibOrgId}:incidents`,
      `org:${fibOrgId}:panic`,
      `org:${fibOrgId}:personnel`,
    ]);

    expect(result.ok).toEqual([]);
    expect(result.denied).toHaveLength(3);
    for (const denial of result.denied) expect(denial.reason).toBe('not-permitted');
  });
});
