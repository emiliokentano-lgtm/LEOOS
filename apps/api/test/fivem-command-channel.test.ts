import { describe, expect, it } from 'vitest';
import { FiveMCommandQueue, COMMAND_TTL_MS } from '../src/modules/fivem/command-queue.js';
import { LivenessStore, LIVENESS_TTL_MS } from '../src/modules/fivem/liveness-store.js';

/**
 * The two in-process stores behind the in-game keybinds.
 *
 * Pure unit tests: neither store touches the database, and both encode a
 * decision that is easy to reverse by accident later. The queue's drop-OLDEST
 * rule and the liveness store's fail-OPEN rule are the two lines somebody
 * tidying this code would most plausibly flip, so each has a test that says
 * which direction is correct and why.
 */

describe('the command queue', () => {
  it('hands a command out exactly once', () => {
    const queue = new FiveMCommandQueue();
    queue.push('srv', { type: 'notify', target: 'license:a', payload: { body: 'hello' } });

    const first = queue.drain('srv');
    expect(first.commands).toHaveLength(1);
    expect(first.commands[0]!.type).toBe('notify');

    /**
     * AT-MOST-ONCE IS THE DESIGN, not an oversight.
     *
     * If the response carrying that batch never arrives, those commands are
     * gone. An acknowledgement protocol would buy at-least-once, and a
     * duplicated in-game popup is worse than a missed one — anything that must
     * not be lost belongs in the web UI where a person can acknowledge it.
     */
    expect(queue.drain('srv').commands).toHaveLength(0);
  });

  it('keeps one game server\'s commands away from another\'s', () => {
    const queue = new FiveMCommandQueue();
    queue.push('srv-a', { type: 'notify', target: 'license:a' });
    queue.push('srv-b', { type: 'notify', target: 'license:b' });

    expect(queue.drain('srv-a').commands).toHaveLength(1);
    expect(queue.depth('srv-b')).toBe(1);
  });

  it('drops the OLDEST past the cap, not the newest', () => {
    /**
     * A game server unreachable for an hour must not make the API hold a
     * backlog for it. When something has to go, the stale prompt is the one
     * worth losing: the newest command is the one still describing a situation
     * that exists.
     */
    const queue = new FiveMCommandQueue(3, 10);
    for (const n of [1, 2, 3, 4]) {
      queue.push('srv', { type: 'notify', target: `license:${n}` });
    }

    const { commands } = queue.drain('srv');
    expect(commands.map((c) => c.target)).toEqual(['license:2', 'license:3', 'license:4']);
  });

  it('reports more waiting rather than trickling a burst out one batch per tick', () => {
    const queue = new FiveMCommandQueue(100, 2);
    for (const n of [1, 2, 3]) {
      queue.push('srv', { type: 'notify', target: `license:${n}` });
    }

    const first = queue.drain('srv');
    expect(first.commands).toHaveLength(2);
    expect(first.pending).toBe(true);

    const second = queue.drain('srv');
    expect(second.commands).toHaveLength(1);
    expect(second.pending).toBe(false);
  });

  it('expires a command nobody drained', () => {
    /**
     * A backup prompt surfacing four minutes late is not help, it is confusion:
     * the situation has resolved one way or the other. Expiry is checked on
     * drain rather than on a timer, so a queue nobody reads costs nothing.
     */
    const queue = new FiveMCommandQueue();
    const at = Date.now();
    queue.push('srv', { type: 'notify', target: 'license:a' }, at);

    expect(queue.depth('srv', at + COMMAND_TTL_MS - 1)).toBe(1);
    expect(queue.drain('srv', at + COMMAND_TTL_MS + 1).commands).toHaveLength(0);
  });

  it('forgets a server outright, for a revoked credential', () => {
    const queue = new FiveMCommandQueue();
    queue.push('srv', { type: 'notify', target: 'license:a' });
    queue.forget('srv');
    expect(queue.depth('srv')).toBe(0);
  });
});

describe('the liveness store', () => {
  it('records what the game server asserted', () => {
    const store = new LivenessStore();
    store.set('license:a', true);
    expect(store.isDown('license:a')).toBe(true);

    store.set('license:a', false);
    expect(store.isDown('license:a')).toBe(false);
  });

  it('treats an unknown player as NOT down', () => {
    /**
     * FAIL OPEN ON SILENCE.
     *
     * This gates a panic button. Refusing on absent information would let a
     * telemetry gap suppress somebody's alarm, which is a far worse failure
     * than a dead player managing to raise one.
     */
    expect(new LivenessStore().isDown('license:nobody')).toBe(false);
  });

  it('treats a STALE report as not down', () => {
    const store = new LivenessStore();
    const at = Date.now();
    store.set('license:a', true, at);

    expect(store.isDown('license:a', at + LIVENESS_TTL_MS - 1)).toBe(true);
    // Past the TTL the rest of the system has already stopped believing this
    // player exists on the map. One stale sample must not suppress a panic
    // minutes later.
    expect(store.isDown('license:a', at + LIVENESS_TTL_MS + 1)).toBe(false);
  });

  it('records nothing when the sample omits the field', () => {
    /**
     * An older bridge sends no liveness at all. Absent must stay absent rather
     * than being coerced to `false` and stored, because a stored `false` is an
     * assertion the game server never made.
     */
    const store = new LivenessStore();
    store.set('license:a', undefined);
    store.set('license:b', null);
    expect(store.size).toBe(0);
  });

  it('forgets a player who disconnected', () => {
    const store = new LivenessStore();
    store.set('license:a', true);
    store.forget('license:a');
    expect(store.isDown('license:a')).toBe(false);
  });

  it('sweeps expired entries so the map cannot grow without bound', () => {
    const store = new LivenessStore();
    const at = Date.now();
    store.set('license:a', true, at);
    store.set('license:b', false, at);

    expect(store.sweep(at + LIVENESS_TTL_MS + 1)).toBe(2);
    expect(store.size).toBe(0);
  });
});
