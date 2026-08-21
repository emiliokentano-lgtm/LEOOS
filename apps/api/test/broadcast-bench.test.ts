import { describe, expect, it } from 'vitest';
import { InMemoryPositionStore } from '../src/modules/map/sources/live-positions.js';
import { LocationBroadcaster } from '../src/realtime/location-broadcaster.js';
import { RealtimeHub } from '../src/realtime/hub.js';
import type { ActorContext } from '@leoos/authz-core';

/**
 * What one broadcast tick actually costs, in position objects on the wire.
 *
 * Measured rather than asserted: the numbers are printed so a change in the
 * broadcast strategy shows up as a number moving, and the assertions are the
 * PROPERTY that number has to keep — not the number itself, which will drift
 * with the fixture.
 */

const UNITS = 500;
const SUBSCRIBERS = 20;
const MOVING = 60; // roughly what a busy shift looks like: most of the fleet parked

function actor(userId: string): ActorContext {
  return {
    userId,
    organizationId: 'org',
    isGlobalAdmin: true,
    isOrgLead: false,
    level: 100,
    permissions: new Set(),
    globalCapabilities: new Set(['global_admin']),
    membershipActive: true,
  };
}

function socket() {
  const sent: string[] = [];
  return {
    sent,
    send: (data: string) => { sent.push(data); },
    close: () => {},
  };
}

function sample(unitId: string, tick: number, moving: boolean) {
  return {
    unitId,
    organizationId: 'org',
    x: moving ? (tick * 7) % 3000 : 100,
    y: moving ? (tick * 11) % 3000 : 200,
    z: null,
    heading: moving ? (tick * 3) % 360 : 90,
    speed: moving ? 40 : 0,
    sampledAt: new Date(1_700_000_000_000 + tick * 1000),
  };
}

describe('one broadcast tick, at 500 units and 20 subscribers', () => {
  it('sends only what moved', async () => {
    const store = new InMemoryPositionStore();
    const unitIds = Array.from({ length: UNITS }, (_, i) => `unit-${i}`);
    const visible = new Set(unitIds);

    const hub = new RealtimeHub({
      resolveActor: async (userId) => actor(userId),
      isSessionLive: async () => true,
      visibleUnitsFor: async () => visible,
    });

    const broadcaster = new LocationBroadcaster({
      hub,
      store,
      visibleUnitsFor: async () => visible,
      tickMs: 1_000,
    });

    const sockets = [];
    for (let i = 0; i < SUBSCRIBERS; i += 1) {
      const s = socket();
      sockets.push(s);
      const connection = hub.add({
        userId: `user-${i}`, sessionId: `session-${i}`, organizationId: 'org', socket: s,
      });
      await hub.subscribe(connection.id, ['map:units']);
    }

    const positionsIn = (s: { sent: string[] }, from: number) =>
      s.sent.slice(from)
        .map((raw) => JSON.parse(raw) as { event?: { payload?: { positions?: unknown[] } } })
        .reduce((n, m) => n + (m.event?.payload?.positions?.length ?? 0), 0);

    // ── Tick 1: everything is new, so everybody gets the full set ───────────
    //
    // The moving/parked split is the SAME from the first tick on. Changing it
    // at tick 2 would move 440 units once and measure that transition rather
    // than the steady state.
    store.setMany(unitIds.map((id, i) => sample(id, 1, i < MOVING)));
    await broadcaster.tickForTest();
    const firstTick = positionsIn(sockets[0]!, 0);

    // ── Ticks 2–6: the fleet reports, but only MOVING units changed ─────────
    const marks = sockets.map((s) => s.sent.length);
    for (let tick = 2; tick <= 6; tick += 1) {
      store.setMany(unitIds.map((id, i) => sample(id, tick, i < MOVING)));
      await broadcaster.tickForTest();
    }

    const steady = sockets.reduce((n, s, i) => n + positionsIn(s, marks[i]!), 0);
    const perSubscriberPerTick = steady / SUBSCRIBERS / 5;

    // eslint-disable-next-line no-console
    console.log(
      `BROADCAST first tick: ${firstTick} positions/subscriber; `
      + `steady state: ${perSubscriberPerTick.toFixed(0)} positions/subscriber/tick `
      + `(${UNITS} units, ${MOVING} moving); total ${steady} across ${SUBSCRIBERS} subscribers over 5 ticks`,
    );

    // A new subscriber must still get the whole fleet, or the map starts empty.
    expect(firstTick).toBe(UNITS);

    // THE PROPERTY: the steady-state cost tracks how much of the fleet is
    // MOVING, not how big the fleet is. Before this change it was 500.
    expect(perSubscriberPerTick).toBeLessThanOrEqual(MOVING);
    expect(perSubscriberPerTick).toBeGreaterThan(0);
  });

  it('costs nothing at all when the whole fleet is parked', async () => {
    const store = new InMemoryPositionStore();
    const unitIds = Array.from({ length: UNITS }, (_, i) => `unit-${i}`);
    const visible = new Set(unitIds);

    const hub = new RealtimeHub({
      resolveActor: async (userId) => actor(userId),
      isSessionLive: async () => true,
      visibleUnitsFor: async () => visible,
    });
    const broadcaster = new LocationBroadcaster({
      hub, store, visibleUnitsFor: async () => visible, tickMs: 1_000,
    });

    const s = socket();
    const connection = hub.add({
      userId: 'u', sessionId: 'sess', organizationId: 'org', socket: s,
    });
    await hub.subscribe(connection.id, ['map:units']);

    store.setMany(unitIds.map((id) => sample(id, 1, false)));
    await broadcaster.tickForTest();
    const afterFirst = s.sent.length;

    // The bridge keeps reporting — a keep-alive is how the server tells parked
    // from crashed — and every report is the same coordinates.
    for (let tick = 2; tick <= 10; tick += 1) {
      store.setMany(unitIds.map((id) => sample(id, tick, false)));
      await broadcaster.tickForTest();
    }

    // eslint-disable-next-line no-console
    console.log(`BROADCAST parked fleet: ${s.sent.length - afterFirst} messages over 9 ticks`);
    expect(s.sent.length).toBe(afterFirst);
  });
});
