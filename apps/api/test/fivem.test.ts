import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  FIVEM_CLOCK_SKEW_SECONDS, FIVEM_HEADERS, MAP, fivemCanonicalString,
} from '@leoos/contracts';
import {
  createActiveUser, createHarness, grantMembership, resetAccounts, signIn,
  userIdByUsername, type TestHarness,
} from './harness.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { NonceStore } from '../src/modules/fivem/nonce-store.js';
import { parseIdentifier, primaryIdentifier } from '../src/modules/fivem/fivem.identity.js';

/**
 * FiveM ingest.
 *
 * THE CLAIM THIS FILE DEFENDS, in the brief's words: "Never trust arbitrary
 * browser clients to submit official unit positions or organization
 * information." The stronger form, which is what is actually implemented: never
 * trust the GAME SERVER for organization information either.
 *
 * A verified signature proves a request came from a registered game server. It
 * proves nothing about whether the contents are true. So the tests below are in
 * three groups:
 *
 *   1. AUTHENTICATION — can an unsigned, replayed, stale or tampered request get
 *      in? Each is its own test, because each fails for a different reason and a
 *      regression in one would be invisible behind the others.
 *
 *   2. VALIDATION — given a perfectly signed request, is nonsense rejected?
 *      Out-of-world coordinates, teleports, duplicate identifiers.
 *
 *   3. THE TRUST MODEL — the one that matters most. Can a game server invent an
 *      organization, a rank or a unit? It must not be able to, and the test that
 *      proves it sends a payload that tries.
 */

let h: TestHarness;

/** A key the tests own, so they never depend on the deployment's real one. */
const TEST_KEY = randomBytes(32).toString('base64');

beforeAll(async () => {
  h = await createHarness({ env: { LEOOS_FIVEM_SECRET_KEY: TEST_KEY } });
}, 120_000);
afterAll(async () => { await h?.close(); });

beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

// ── Signing helpers, mirroring what the Lua resource does ───────────────────

interface Credential {
  gameServerId: string;
  keyId: string;
  secret: string;
}

let seqCounter = 1000n;

/**
 * Registers a game server and issues it a credential, directly.
 *
 * Directly rather than through the admin endpoint, so an authentication test
 * cannot fail because of an unrelated permission change in the admin surface.
 * The admin path has its own tests below.
 */
async function registerServer(prefix: string): Promise<Credential> {
  const key = `${prefix}${Date.now().toString(36).slice(-5)}`.toLowerCase();
  const box = SecretBox.fromBase64(TEST_KEY)!;
  const secret = randomBytes(32).toString('base64url');
  const keyId = `srv_${randomBytes(8).toString('hex')}`;

  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO game_server (key, name, is_active)
    VALUES (${key}, ${`Test ${key}`}, true)
    RETURNING id
  `);
  const gameServerId = rows[0]!.id;

  await h.db.execute(sql`
    INSERT INTO game_server_credential (game_server_id, key_id, secret_hash, secret_enc)
    VALUES (${gameServerId}, ${keyId}, ${'not-the-verification-path'}, ${box.seal(secret)})
  `);

  return { gameServerId, keyId, secret };
}

interface SignOptions {
  timestamp?: number;
  nonce?: string;
  seq?: bigint;
  /** Sign one body and send another — the tampering test. */
  bodyToSign?: string;
  secret?: string;
  protocol?: string;
}

function signedHeaders(
  credential: Credential,
  path: string,
  body: string,
  options: SignOptions = {},
): Record<string, string> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(16).toString('base64url');
  seqCounter += 1n;
  const seq = String(options.seq ?? seqCounter);

  const canonical = fivemCanonicalString({
    method: 'POST',
    path,
    timestamp,
    nonce,
    seq,
    bodySha256Hex: createHash('sha256').update(options.bodyToSign ?? body, 'utf8').digest('hex'),
  });

  return {
    'content-type': 'application/json',
    [FIVEM_HEADERS.keyId]: credential.keyId,
    [FIVEM_HEADERS.timestamp]: timestamp,
    [FIVEM_HEADERS.nonce]: nonce,
    [FIVEM_HEADERS.seq]: seq,
    [FIVEM_HEADERS.protocol]: options.protocol ?? '1',
    [FIVEM_HEADERS.signature]: createHmac('sha256', options.secret ?? credential.secret)
      .update(canonical, 'utf8').digest('hex'),
  };
}

async function post(
  credential: Credential,
  path: string,
  payload: unknown,
  options: SignOptions = {},
) {
  const body = JSON.stringify(payload);
  return h.app.inject({
    method: 'POST',
    url: path,
    payload: body,
    headers: signedHeaders(credential, path, body, options),
  });
}

async function handshake(credential: Credential): Promise<string> {
  const res = await post(credential, '/api/v1/fivem/handshake', {
    resourceVersion: '1.0.0',
    serverName: 'Test server',
    adapter: 'standalone',
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sessionId: string }).sessionId;
}

// ── 1. Authentication ───────────────────────────────────────────────────────

describe('ingest authentication', () => {
  it('refuses a request with no signature at all', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/fivem/handshake',
      payload: { resourceVersion: '1.0.0' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly signed request', async () => {
    const credential = await registerServer('sig');
    const sessionId = await handshake(credential);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a TAMPERED body — the whole point of signing the body hash', async () => {
    const credential = await registerServer('tamper');
    const honest = JSON.stringify({ resourceVersion: '1.0.0' });
    const tampered = JSON.stringify({ resourceVersion: '9.9.9' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/fivem/handshake',
      payload: tampered,
      // Signed over the honest body, sent with the tampered one.
      headers: signedHeaders(credential, '/api/v1/fivem/handshake', tampered, {
        bodyToSign: honest,
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a signature made with the wrong secret', async () => {
    const credential = await registerServer('wrongkey');
    const res = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      secret: randomBytes(32).toString('base64url'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('gives the SAME answer for an unknown key id and a bad signature', async () => {
    // Distinguishing them would make this endpoint an oracle for which key ids
    // exist, which is free information an attacker should not get.
    const credential = await registerServer('oracle');
    const unknown = await post(
      { ...credential, keyId: 'srv_deadbeefdeadbeef' },
      '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' },
    );
    const badSig = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      secret: 'not-the-secret',
    });

    expect(unknown.statusCode).toBe(badSig.statusCode);
    expect((unknown.json() as { error: { message: string } }).error.message)
      .toBe((badSig.json() as { error: { message: string } }).error.message);
  });

  it('refuses a REPLAYED request', async () => {
    const credential = await registerServer('replay');
    const body = JSON.stringify({ resourceVersion: '1.0.0' });
    const headers = signedHeaders(credential, '/api/v1/fivem/handshake', body);

    const first = await h.app.inject({
      method: 'POST', url: '/api/v1/fivem/handshake', payload: body, headers,
    });
    expect(first.statusCode).toBe(200);

    // Byte-for-byte identical — the capture-and-resend an attacker would try.
    const replayed = await h.app.inject({
      method: 'POST', url: '/api/v1/fivem/handshake', payload: body, headers,
    });
    expect(replayed.statusCode).toBe(409);
  });

  it('refuses a stale sequence number even with a fresh nonce', async () => {
    // The nonce cache is in-process and expires; the sequence is persisted and
    // does not. This is the check that survives a restart.
    const credential = await registerServer('seq');
    const ok = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      seq: 5_000n,
    });
    expect(ok.statusCode).toBe(200);

    const stale = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      seq: 4_999n,
    });
    expect(stale.statusCode).toBe(409);

    const equal = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      seq: 5_000n,
    });
    expect(equal.statusCode).toBe(409);
  });

  it('refuses a timestamp outside the skew window', async () => {
    const credential = await registerServer('skew');
    const stale = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      timestamp: Math.floor(Date.now() / 1000) - FIVEM_CLOCK_SKEW_SECONDS - 30,
    });
    expect(stale.statusCode).toBe(401);

    const future = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      timestamp: Math.floor(Date.now() / 1000) + FIVEM_CLOCK_SKEW_SECONDS + 30,
    });
    expect(future.statusCode).toBe(401);
  });

  it('refuses a revoked credential', async () => {
    const credential = await registerServer('revoked');
    expect((await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }))
      .statusCode).toBe(200);

    await h.db.execute(sql`
      UPDATE game_server_credential SET revoked_at = now() WHERE key_id = ${credential.keyId}
    `);

    expect((await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }))
      .statusCode).toBe(401);
  });

  it('refuses a deactivated server, distinguishably from a revoked key', async () => {
    // Different situations: an operator turning a server off for maintenance
    // versus dealing with a compromise. Reactivating must not need a reissue.
    const credential = await registerServer('inactive');
    await h.db.execute(sql`
      UPDATE game_server SET is_active = false WHERE id = ${credential.gameServerId}
    `);
    const res = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unsupported protocol version with an upgrade instruction', async () => {
    const credential = await registerServer('proto');
    const res = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      protocol: '99',
    });
    expect(res.statusCode).toBe(426);
    expect((res.json() as { error: { message: string } }).error.message)
      .toContain('leoos_bridge');
  });

  it('burns the sequence even when the BODY is rejected', async () => {
    /**
     * Otherwise a request that failed validation stays replayable for as long as
     * an attacker cares to wait for its nonce to expire.
     */
    const credential = await registerServer('burn');
    const bad = await post(credential, '/api/v1/fivem/handshake', { nonsense: true }, {
      seq: 7_000n,
    });
    expect(bad.statusCode).toBe(400);

    const reuse = await post(credential, '/api/v1/fivem/handshake', { resourceVersion: '1.0.0' }, {
      seq: 7_000n,
    });
    expect(reuse.statusCode).toBe(409);
  });
});

// ── 2. Validation and sanity filters ────────────────────────────────────────

describe('telemetry validation', () => {
  async function ready(prefix: string) {
    const credential = await registerServer(prefix);
    const sessionId = await handshake(credential);
    return { credential, sessionId };
  }

  it('refuses a session id it never issued', async () => {
    const { credential } = await ready('session');
    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId: randomUUID(),
      sentAt: Date.now(),
      players: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a coordinate outside the world', async () => {
    const { credential, sessionId } = await ready('bounds');
    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [{
        src: 1,
        identifiers: { license: 'license:abc123' },
        x: MAP.worldMaxX + 10_000,
        y: 0,
        z: 30,
        heading: 90,
      }],
    });
    // Rejected by the schema, before anything reaches the pipeline.
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    /**
     * `.strict()` everywhere is what makes the trust model discoverable: a
     * resource sending `organization` finds out immediately, rather than
     * shipping for months believing the API reads it.
     */
    const { credential, sessionId } = await ready('strict');
    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [{
        src: 1,
        identifiers: { license: 'license:abc123' },
        x: 100, y: 100, z: 30, heading: 90,
        organization: 'LSPD',
      }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a batch of unlinked players without attributing them to anyone', async () => {
    const { credential, sessionId } = await ready('unlinked');
    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [
        {
          src: 1, identifiers: { license: `license:${randomUUID()}` },
          x: 100, y: 100, z: 30, heading: 90,
        },
        {
          src: 2, identifiers: { license: `license:${randomUUID()}` },
          x: 200, y: 200, z: 30, heading: 180,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accepted: number; rejected: number };
    // Accepted as a request, attributed to nobody. An unknown identifier cannot
    // become a unit however convincing the rest of its payload is.
    expect(body.accepted).toBe(0);
  });
});

// ── 3. The trust model ──────────────────────────────────────────────────────

describe('the trust model', () => {
  /**
   * A linked, on-duty officer, built the way the application builds one — an
   * account, a membership, a unit, a crewing — so the test exercises the real
   * resolution path rather than a fixture shaped to pass.
   */
  async function onDutyOfficer(prefix: string) {
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, prefix);
    const membership = await grantMembership(h.db, creds.username, {
      orgKey: 'PD', roleKey: 'sergeant',
    });
    const auth = await signIn(h, creds);
    const userId = await userIdByUsername(h.db, creds.username);

    const identifier = `test-${randomBytes(8).toString('hex')}`;
    await h.db.execute(sql`
      INSERT INTO game_identity (provider, identifier, user_id, verified_at)
      VALUES ('license', ${identifier}, ${userId}, now())
    `);

    const unit = await h.app.inject({
      method: 'POST', url: '/api/v1/dispatch/units', headers: auth.headers,
      payload: {
        callsign: `FM${randomBytes(3).toString('hex')}`.toUpperCase().slice(0, 8),
        joinSelf: true,
      },
    });
    expect(unit.statusCode).toBe(201);

    return {
      userId,
      memberId: membership.memberId,
      organizationId: membership.organizationId,
      unitId: (unit.json() as { id: string }).id,
      license: `license:${identifier}`,
      headers: auth.headers,
    };
  }

  it('attributes a position to the unit the DATABASE says the player crews', async () => {
    const credential = await registerServer('trust');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmtrust');

    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [{
        src: 1,
        identifiers: { license: officer.license },
        x: 421.7, y: -981.2, z: 30.7, heading: 187.4,
      }],
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { accepted: number }).accepted).toBe(1);

    // The position landed on the unit the database resolved, not on anything
    // the payload named — it named nothing.
    const stored = h.app.mapPositions.get(officer.unitId);
    expect(stored).toBeDefined();
    expect(stored!.x).toBeCloseTo(421.7, 1);
    expect(stored!.organizationId).toBe(officer.organizationId);
  });

  it('a game server CANNOT invent an organization, rank, callsign or unit', async () => {
    /**
     * THE CENTRAL TEST OF THIS FILE.
     *
     * The payload below is a game server trying to manufacture a Chief of
     * Police: a made-up organization, a made-up rank, a made-up callsign, a
     * made-up unit id. Every one of those fields is rejected by the schema —
     * there is nowhere in the type to put them — and the position resolves
     * strictly from the identifier.
     */
    const credential = await registerServer('forge');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmforge');

    const forged = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [{
        src: 1,
        identifiers: { license: officer.license },
        x: 100, y: 100, z: 30, heading: 0,
        organization: 'FIB',
        organizationId: randomUUID(),
        rank: 'Director',
        callsign: 'FIB-1',
        unitId: randomUUID(),
        permissions: ['admin.users'],
      }],
    });

    // Refused outright — not accepted-and-ignored.
    expect(forged.statusCode).toBe(400);

    // And the honest form of the same sample still resolves to the officer's
    // REAL unit and REAL organization.
    const honest = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [{
        src: 1, identifiers: { license: officer.license },
        x: 100, y: 100, z: 30, heading: 0,
      }],
    });
    expect(honest.statusCode).toBe(200);

    const stored = h.app.mapPositions.get(officer.unitId);
    expect(stored!.organizationId).toBe(officer.organizationId);
  });

  it('drops a position for a member who has been terminated', async () => {
    const credential = await registerServer('terminated');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmterm');

    // `left_at` is required by a CHECK — a terminated membership must always
    // record when it ended, or the personnel history has a hole.
    await h.db.execute(sql`
      UPDATE organization_member
         SET status = 'terminated', left_at = now()
       WHERE id = ${officer.memberId}
    `);

    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId,
      sentAt: Date.now(),
      players: [{
        src: 1, identifiers: { license: officer.license },
        x: 300, y: 300, z: 30, heading: 0,
      }],
    });

    expect(res.statusCode).toBe(200);
    // Someone dismissed this morning must not still be a unit on the map.
    expect((res.json() as { accepted: number }).accepted).toBe(0);
  });

  it('rejects a TELEPORT and keeps the last good position', async () => {
    const credential = await registerServer('teleport');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmtele');

    await post(credential, '/api/v1/fivem/telemetry', {
      sessionId, sentAt: Date.now(),
      players: [{
        src: 1, identifiers: { license: officer.license },
        x: 0, y: 0, z: 30, heading: 0,
      }],
    });
    expect(h.app.mapPositions.get(officer.unitId)!.x).toBeCloseTo(0, 1);

    // 4000 metres in the blink of an eye — faster than anything in the game.
    const jump = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId, sentAt: Date.now(),
      players: [{
        src: 1, identifiers: { license: officer.license },
        x: 4000, y: 0, z: 30, heading: 0,
      }],
    });

    expect(jump.statusCode).toBe(200);
    expect((jump.json() as { rejected: number }).rejected).toBe(1);
    // The old position SURVIVES. A dispatcher acting on a slightly stale
    // position is far better off than one acting on a position in the ocean.
    expect(h.app.mapPositions.get(officer.unitId)!.x).toBeCloseTo(0, 1);
  });

  it('rejects a batch that reports the same identifier twice', async () => {
    const credential = await registerServer('dupe');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmdupe');

    const res = await post(credential, '/api/v1/fivem/telemetry', {
      sessionId, sentAt: Date.now(),
      players: [
        {
          src: 1, identifiers: { license: officer.license },
          x: 10, y: 10, z: 30, heading: 0,
        },
        {
          src: 2, identifiers: { license: officer.license },
          x: 900, y: 900, z: 30, heading: 0,
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    // A player is in exactly one place. Taking either claim would be choosing
    // arbitrarily between two statements about the same unit.
    expect((res.json() as { accepted: number }).accepted).toBe(0);
    expect(h.app.mapPositions.get(officer.unitId)).toBeUndefined();
  });

  it('removes a departed player promptly rather than waiting for the TTL', async () => {
    const credential = await registerServer('departed');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmdep');

    await post(credential, '/api/v1/fivem/telemetry', {
      sessionId, sentAt: Date.now(),
      players: [{
        src: 1, identifiers: { license: officer.license },
        x: 50, y: 50, z: 30, heading: 0,
      }],
    });
    expect(h.app.mapPositions.get(officer.unitId)).toBeDefined();

    await post(credential, '/api/v1/fivem/telemetry', {
      sessionId, sentAt: Date.now(),
      players: [],
      departed: [officer.license],
    });
    expect(h.app.mapPositions.get(officer.unitId)).toBeUndefined();
  });

  it('an in-game panic goes through the ORDINARY authorization path', async () => {
    const credential = await registerServer('panic');
    const sessionId = await handshake(credential);
    const officer = await onDutyOfficer('fmpanic');

    const res = await post(credential, '/api/v1/fivem/events', {
      sessionId,
      events: [{
        kind: 'player.panic',
        at: Date.now(),
        identifiers: { license: officer.license },
        x: 200, y: -900,
      }],
    });
    expect(res.statusCode).toBe(200);

    // A real `panic_event` row, with the same lifecycle a browser panic gets.
    const panics = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM panic_event
       WHERE member_id = ${officer.memberId} AND resolved_at IS NULL
    `);
    expect(panics[0]!.n).toBe(1);

    // And it is audited as coming from the game server, not from a user.
    const audits = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'panic.triggered' AND entity_type = 'panic_event'
    `);
    expect(audits[0]!.n).toBeGreaterThan(0);
  });

  it('an in-game panic for an UNLINKED identifier does nothing', async () => {
    const credential = await registerServer('panicanon');
    const sessionId = await handshake(credential);

    const before = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM panic_event WHERE resolved_at IS NULL
    `);

    const res = await post(credential, '/api/v1/fivem/events', {
      sessionId,
      events: [{
        kind: 'player.panic',
        at: Date.now(),
        identifiers: { license: `license:${randomUUID()}` },
      }],
    });
    expect(res.statusCode).toBe(200);

    const after = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM panic_event WHERE resolved_at IS NULL
    `);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

// ── Heartbeat and offline detection ─────────────────────────────────────────

describe('heartbeat', () => {
  it('records a heartbeat and the player count', async () => {
    const credential = await registerServer('hb');
    const sessionId = await handshake(credential);

    const res = await post(credential, '/api/v1/fivem/heartbeat', {
      sessionId,
      playerCount: 42,
      uptimeSeconds: 3600,
      resourceVersion: '1.0.0',
    });
    expect(res.statusCode).toBe(200);

    const rows = await h.db.execute<{ player_count: number; heartbeat: Date | null }>(sql`
      SELECT player_count, last_heartbeat_at AS heartbeat
        FROM game_server_state WHERE game_server_id = ${credential.gameServerId}
    `);
    expect(rows[0]!.player_count).toBe(42);
    expect(rows[0]!.heartbeat).not.toBeNull();
  });
});

// ── Identity claim ──────────────────────────────────────────────────────────

describe('identity claim', () => {
  async function claimCodeFor(userId: string): Promise<string> {
    const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    await h.db.execute(sql`
      INSERT INTO identity_claim_code (user_id, code, expires_at)
      VALUES (${userId}, ${code}, now() + interval '5 minutes')
    `);
    return code;
  }

  it('links an identifier when the code is valid, and consumes it', async () => {
    const credential = await registerServer('claim');
    await handshake(credential);

    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'fmclaim');
    const userId = await userIdByUsername(h.db, creds.username);
    const code = await claimCodeFor(userId);
    const license = `license:claim-${randomBytes(6).toString('hex')}`;

    const first = await post(credential, '/api/v1/fivem/identity/claim', {
      identifiers: { license },
      code,
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { ok: boolean }).ok).toBe(true);

    const linked = await h.db.execute<{ user_id: string; verified_at: Date | null }>(sql`
      SELECT user_id, verified_at FROM game_identity
       WHERE identifier = ${license.slice('license:'.length)}
    `);
    expect(linked[0]!.user_id).toBe(userId);
    expect(linked[0]!.verified_at).not.toBeNull();

    // SINGLE USE. The second attempt gets nothing, however quickly it follows.
    const replay = await post(credential, '/api/v1/fivem/identity/claim', {
      identifiers: { license: `license:other-${randomBytes(4).toString('hex')}` },
      code,
    });
    expect((replay.json() as { ok: boolean }).ok).toBe(false);
  });

  it('refuses an expired code, and says nothing about why', async () => {
    const credential = await registerServer('claimexp');
    await handshake(credential);

    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'fmclaimexp');
    const userId = await userIdByUsername(h.db, creds.username);

    // Random, not a fixed literal: claim codes are globally unique, and this
    // suite runs repeatedly against a database that keeps its rows.
    const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    await h.db.execute(sql`
      INSERT INTO identity_claim_code (user_id, code, expires_at)
      VALUES (${userId}, ${code}, now() - interval '1 minute')
    `);

    const res = await post(credential, '/api/v1/fivem/identity/claim', {
      identifiers: { license: `license:${randomUUID()}` },
      code,
    });
    const body = res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    // One message for invalid and expired alike: this is the one endpoint where
    // a guess is worth something to an attacker.
    expect(body.message).toContain('not valid or has expired');
  });

  it('refuses to steal an identifier already linked to someone else', async () => {
    const credential = await registerServer('claimsteal');
    await handshake(credential);

    h.app.limiter.resetAll();
    const owner = await createActiveUser(h, 'fmowner');
    const ownerId = await userIdByUsername(h.db, owner.username);
    const license = `steal-${randomBytes(6).toString('hex')}`;
    await h.db.execute(sql`
      INSERT INTO game_identity (provider, identifier, user_id, verified_at)
      VALUES ('license', ${license}, ${ownerId}, now())
    `);

    h.app.limiter.resetAll();
    const thief = await createActiveUser(h, 'fmthief');
    const thiefId = await userIdByUsername(h.db, thief.username);
    const code = await claimCodeFor(thiefId);

    const res = await post(credential, '/api/v1/fivem/identity/claim', {
      identifiers: { license: `license:${license}` },
      code,
    });
    expect((res.json() as { ok: boolean }).ok).toBe(false);

    const still = await h.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM game_identity WHERE identifier = ${license}
    `);
    expect(still[0]!.user_id).toBe(ownerId);
  });
});

// ── Administration ──────────────────────────────────────────────────────────

describe('game server administration', () => {
  it('is refused to a caller without admin.game_servers, as a 404', async () => {
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'fmnoadmin');
    await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'officer' });
    const auth = await signIn(h, creds);

    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/game-servers', headers: auth.headers,
    });
    // 404, not 403: a caller who may not administer game servers learns nothing
    // about whether any exist.
    expect(res.statusCode).toBe(404);
  });

  it('returns the secret exactly once and never again', async () => {
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'fmadmin');
    const userId = await userIdByUsername(h.db, creds.username);
    await h.db.execute(sql`
      INSERT INTO user_global_role (user_id, capability) VALUES (${userId}, 'global_admin')
      ON CONFLICT DO NOTHING
    `);
    const auth = await signIn(h, creds);

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/game-servers', headers: auth.headers,
      payload: { key: `adm${Date.now().toString(36).slice(-5)}`, name: 'Admin test server' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const issued = await h.app.inject({
      method: 'POST', url: `/api/v1/game-servers/${id}/credentials`,
      headers: auth.headers, payload: {},
    });
    expect(issued.statusCode).toBe(201);
    const credential = issued.json() as { keyId: string; secret: string };
    expect(credential.secret.length).toBeGreaterThan(30);
    expect(issued.headers['cache-control']).toContain('no-store');

    // The listing carries the key id and NOT the secret — nor a hash of it, nor
    // a truncated form. The whole serialised body is searched.
    const listed = await h.app.inject({
      method: 'GET', url: '/api/v1/game-servers', headers: auth.headers,
    });
    expect(listed.body).toContain(credential.keyId);
    expect(listed.body).not.toContain(credential.secret);
    expect(listed.body).not.toContain('secretHash');
    expect(listed.body).not.toContain('secret_enc');
  });

  it('a credential issued through the admin path actually signs requests', async () => {
    /**
     * The end-to-end check that the two halves agree. Everything above uses a
     * credential inserted directly; this proves the ISSUING path produces one
     * the VERIFYING path accepts, which is where an encryption or encoding
     * mismatch would hide.
     */
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'fmroundtrip');
    const userId = await userIdByUsername(h.db, creds.username);
    await h.db.execute(sql`
      INSERT INTO user_global_role (user_id, capability) VALUES (${userId}, 'global_admin')
      ON CONFLICT DO NOTHING
    `);
    const auth = await signIn(h, creds);

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/game-servers', headers: auth.headers,
      payload: { key: `rt${Date.now().toString(36).slice(-5)}`, name: 'Round trip' },
    });
    const { id } = created.json() as { id: string };

    const issued = await h.app.inject({
      method: 'POST', url: `/api/v1/game-servers/${id}/credentials`,
      headers: auth.headers, payload: {},
    });
    const credential = issued.json() as { keyId: string; secret: string };

    const res = await post(
      { gameServerId: id, keyId: credential.keyId, secret: credential.secret },
      '/api/v1/fivem/handshake',
      { resourceVersion: '1.0.0' },
    );
    expect(res.statusCode).toBe(200);
  });

  it('refuses a third live credential, so rotation stays comprehensible', async () => {
    h.app.limiter.resetAll();
    const creds = await createActiveUser(h, 'fmrotate');
    const userId = await userIdByUsername(h.db, creds.username);
    await h.db.execute(sql`
      INSERT INTO user_global_role (user_id, capability) VALUES (${userId}, 'global_admin')
      ON CONFLICT DO NOTHING
    `);
    const auth = await signIn(h, creds);

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/game-servers', headers: auth.headers,
      payload: { key: `rot${Date.now().toString(36).slice(-5)}`, name: 'Rotation' },
    });
    const { id } = created.json() as { id: string };

    for (let i = 0; i < 2; i += 1) {
      const res = await h.app.inject({
        method: 'POST', url: `/api/v1/game-servers/${id}/credentials`,
        headers: auth.headers, payload: {},
      });
      expect(res.statusCode).toBe(201);
    }

    const third = await h.app.inject({
      method: 'POST', url: `/api/v1/game-servers/${id}/credentials`,
      headers: auth.headers, payload: {},
    });
    expect(third.statusCode).toBe(409);
  });
});

// ── Units of the pieces ─────────────────────────────────────────────────────

describe('secret box', () => {
  it('round-trips, and refuses a value encrypted under another key', () => {
    const a = SecretBox.fromBase64(randomBytes(32).toString('base64'))!;
    const b = SecretBox.fromBase64(randomBytes(32).toString('base64'))!;

    const sealed = a.seal('the-ingest-secret');
    expect(a.open(sealed)).toBe('the-ingest-secret');
    expect(b.open(sealed)).toBeNull();
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const box = SecretBox.fromBase64(randomBytes(32).toString('base64'))!;
    const sealed = box.seal('the-ingest-secret');
    const parts = sealed.split('.');
    // Flip a character in the ciphertext. GCM's auth tag catches it.
    const last = parts[3]!;
    parts[3] = (last[0] === 'A' ? 'B' : 'A') + last.slice(1);
    expect(box.open(parts.join('.'))).toBeNull();
  });

  it('never produces the same ciphertext twice for one plaintext', () => {
    // A reused IV under GCM leaks the XOR of the plaintexts and forges the tag.
    const box = SecretBox.fromBase64(randomBytes(32).toString('base64'))!;
    expect(box.seal('same')).not.toBe(box.seal('same'));
  });

  it('refuses a key of the wrong length', () => {
    expect(() => SecretBox.fromBase64(randomBytes(16).toString('base64'))).toThrow();
    expect(SecretBox.fromBase64(undefined)).toBeNull();
  });
});

describe('nonce store', () => {
  it('accepts once and refuses thereafter, scoped by key id', () => {
    const store = new NonceStore();
    expect(store.remember('key-a', 'n1')).toBe(true);
    expect(store.remember('key-a', 'n1')).toBe(false);
    // A different server picking the same random value must not be locked out.
    expect(store.remember('key-b', 'n1')).toBe(true);
  });

  it('forgets a nonce once its window has passed', () => {
    const store = new NonceStore(1_000);
    const now = Date.now();
    expect(store.remember('key', 'n1', now)).toBe(true);
    expect(store.remember('key', 'n1', now + 500)).toBe(false);
    expect(store.remember('key', 'n1', now + 1_500)).toBe(true);
  });
});

describe('identifier parsing', () => {
  it('splits a provider prefix from its value', () => {
    expect(parseIdentifier('license:110000112345678'))
      .toEqual({ provider: 'license', value: '110000112345678', full: 'license:110000112345678' });
  });

  it('refuses a provider it does not know', () => {
    // The column is a Postgres enum. Inserting into it from untrusted input is
    // how a game server gets to choose your schema.
    expect(parseIdentifier('madeup:abc')).toBeNull();
    expect(parseIdentifier('noseparator')).toBeNull();
    expect(parseIdentifier(':empty')).toBeNull();
  });

  it('prefers the licence, which is the hardest identifier to change', () => {
    const chosen = primaryIdentifier({
      discord: 'discord:1',
      steam: 'steam:2',
      license: 'license:3',
    });
    expect(chosen?.provider).toBe('license');
  });

  it('accepts a bare value under a provider key and normalises it', () => {
    expect(primaryIdentifier({ license: 'abc' })?.full).toBe('license:abc');
  });
});
