import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, setPermissionOverride,
  signIn, userIdByUsername, type TestHarness,
} from './harness.js';
import {
  bumpPermissionVersion, clearIdentityCache, loadActorContextLocked, resolveIdentityCached,
} from '../src/modules/auth/context.service.js';

/**
 * The authorization cache.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS PROTECTING
 *
 * `resolveIdentity` runs before every authenticated request and cost 5.36 ms at
 * the median against an RP-scale fixture. It is now cached, which is a change
 * to how AUTHORIZATION DATA reaches a decision — so the safety of the caching
 * strategy is a release gate, not a review note.
 *
 * The engineering rule is "do not cache data that must be real-time unless the
 * caching strategy is explicitly safe". The strategy is: key on
 * `user_account.permission_version`, which every mutating path bumps inside its
 * own transaction, with a short TTL for the one change no transaction can
 * announce (an override reaching `expires_at`).
 *
 * Each test below pins one claim in that sentence. If somebody removes the
 * version read to save a query, the first test fails. If somebody points
 * `loadActorContextLocked` at the cache, the last one does.
 * ────────────────────────────────────────────────────────────────────────────
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  await resetAccounts(h.db);
});

beforeEach(() => {
  h.app.limiter.resetAll();
  clearIdentityCache();
});

afterAll(async () => {
  await h.close();
});

async function operator(prefix: string, roleKey = 'sergeant') {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  const membership = await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey });
  const session = await signIn(h, creds);
  const userId = await userIdByUsername(h.db, creds.username);
  return { creds, userId, ...membership, ...session };
}

/**
 * The dispatch board, which is gated on `dispatch.view`.
 *
 * A refusal here is 404, not 403: the board does not confirm that a dispatch
 * surface exists to somebody not entitled to see it. What these tests care about
 * is only the difference between 200 and refused.
 */
const REFUSED = 404;

const board = (headers: Record<string, string>) =>
  h.app.inject({ method: 'GET', url: '/api/v1/dispatch/board', headers });

// ═══════════════════════════════════════════════════════════════════════════
// The version key
// ═══════════════════════════════════════════════════════════════════════════

describe('a permission change takes effect on the very next request', () => {
  /**
   * The demotion test that matters.
   *
   * Deliberately NO wait between the change and the request. The realtime hub's
   * equivalent test waits 1.2 s past its own actor cache, because that cache is
   * a plain timer. This one must not need to: a version bump invalidates by
   * moving the key, so the next request re-resolves regardless of how quickly it
   * arrives. A sleep added here to "make it pass" would be the bug.
   */
  it('refuses immediately after the permission is denied, with no wait', async () => {
    const sergeant = await operator('idcdeny');

    expect((await board(sergeant.headers)).statusCode).toBe(200);
    // Warm the cache the way a real burst of page requests would.
    expect((await board(sergeant.headers)).statusCode).toBe(200);

    await setPermissionOverride(h.db, sergeant.memberId, 'dispatch.view', 'deny');

    const after = await board(sergeant.headers);
    expect(after.statusCode).toBe(REFUSED);
  });

  it('restores access immediately when the permission comes back', async () => {
    const sergeant = await operator('idcrestore');
    await setPermissionOverride(h.db, sergeant.memberId, 'dispatch.view', 'deny');
    expect((await board(sergeant.headers)).statusCode).toBe(REFUSED);

    await setPermissionOverride(h.db, sergeant.memberId, 'dispatch.view', 'grant');

    expect((await board(sergeant.headers)).statusCode).toBe(200);
  });

  it('reuses the resolved identity while the version holds, and drops it when it moves', async () => {
    const sergeant = await operator('idcreuse');

    const first = await resolveIdentityCached(h.db, sergeant.userId);
    const second = await resolveIdentityCached(h.db, sergeant.userId);
    // Identity, not equality: a re-resolution would produce an equal object, so
    // only object identity distinguishes a cache hit from a repeated query.
    expect(second).toBe(first);

    await bumpPermissionVersion(h.db, sergeant.userId);

    const third = await resolveIdentityCached(h.db, sergeant.userId);
    expect(third).not.toBe(first);
    expect(third?.account.permissionVersion).toBe(first!.account.permissionVersion + 1);
  });

  it('does not serve one user’s identity to another', async () => {
    const a = await operator('idcusera');
    const b = await operator('idcuserb');

    const first = await resolveIdentityCached(h.db, a.userId);
    const second = await resolveIdentityCached(h.db, b.userId);

    expect(first?.account.userId).toBe(a.userId);
    expect(second?.account.userId).toBe(b.userId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The TTL bound
// ═══════════════════════════════════════════════════════════════════════════

describe('the TTL bounds the one change no transaction can announce', () => {
  /**
   * An override reaching `expires_at` changes nothing in the database, so no
   * version can be bumped for it. The TTL is the whole answer, and this test
   * states its size rather than leaving it as a claim in a comment.
   *
   * It asserts the STALE window as well as the recovery. That is uncomfortable
   * to write down, which is exactly why it is written down: the bound is five
   * seconds, it is not zero, and a reader deciding whether that is acceptable
   * for their installation should be able to see it here.
   */
  it('re-resolves within the TTL when the change did not bump a version', async () => {
    const sergeant = await operator('idcttl');
    expect((await board(sergeant.headers)).statusCode).toBe(200);

    // Raw SQL, deliberately without the bump every real writer performs — this
    // is standing in for the clock passing an override's expiry.
    await h.db.execute(sql`
      INSERT INTO member_permission_override (member_id, permission_key, effect, reason)
      VALUES (${sergeant.memberId}, 'dispatch.view', 'deny'::permission_override_effect, 'ttl test')
      ON CONFLICT (member_id, permission_key)
      DO UPDATE SET effect = 'deny'::permission_override_effect
    `);

    // Still served from the cached identity: the version has not moved.
    expect((await board(sergeant.headers)).statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 5_300));

    expect((await board(sergeant.headers)).statusCode).toBe(REFUSED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The mutation path
// ═══════════════════════════════════════════════════════════════════════════

describe('a mutation never decides from the cache', () => {
  /**
   * `loadActorContextLocked` takes a row lock and must then see the rows it
   * locked. A cached identity resolved before the lock is exactly the stale read
   * the lock exists to prevent — so this test changes authority WITHOUT a
   * version bump, which the cache would honour, and proves the locked loader
   * does not.
   */
  it('reads through to the database even when a stale entry is cached', async () => {
    const sergeant = await operator('idclocked');

    const cached = await resolveIdentityCached(h.db, sergeant.userId);
    expect(cached?.memberships[0]?.permissions).toContain('dispatch.view');

    await h.db.execute(sql`
      INSERT INTO member_permission_override (member_id, permission_key, effect, reason)
      VALUES (${sergeant.memberId}, 'dispatch.view', 'deny'::permission_override_effect, 'lock test')
      ON CONFLICT (member_id, permission_key)
      DO UPDATE SET effect = 'deny'::permission_override_effect
    `);

    // The cache still holds the pre-change identity …
    const stillCached = await resolveIdentityCached(h.db, sergeant.userId);
    expect(stillCached).toBe(cached);

    // … and the locked loader ignores it.
    const actor = await h.db.transaction((tx) =>
      loadActorContextLocked(tx, sergeant.userId, sergeant.organizationId));
    expect(actor.permissions.has('dispatch.view')).toBe(false);
  });
});
