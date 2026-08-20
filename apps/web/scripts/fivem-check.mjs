/**
 * FiveM bridge walkthrough.
 *
 * Signs requests EXACTLY as the Lua resource does — same canonical string, same
 * headers, same order — and drives a full session against a running API:
 * handshake, telemetry, panic, heartbeat. Then it attacks its own requests:
 * replay, tamper, skew, forged organization.
 *
 * The point of doing this out-of-process rather than in vitest is that it proves
 * the wire format, not the internals. A test that calls the verifier directly
 * cannot catch a header the server never reads.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

const API = process.env.LEOOS_API ?? 'http://localhost:3011';
const KEY_ID = process.env.LEOOS_KEY_ID;
const SECRET = process.env.LEOOS_SECRET;

if (!KEY_ID || !SECRET) {
  console.error('Set LEOOS_KEY_ID and LEOOS_SECRET (issue a credential first).');
  process.exit(2);
}

const problems = [];
const notes = [];
let seq = Number(process.env.LEOOS_START_SEQ ?? Date.now() % 1_000_000);

/** The canonical string, byte for byte as `transport.lua` builds it. */
function sign(path, body, overrides = {}) {
  const timestamp = String(overrides.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? randomBytes(16).toString('base64url');
  seq += 1;
  const seqStr = String(overrides.seq ?? seq);

  const canonical = [
    'POST', path, timestamp, nonce, seqStr,
    createHash('sha256').update(overrides.bodyToSign ?? body, 'utf8').digest('hex'),
  ].join('\n');

  return {
    'content-type': 'application/json',
    'x-leoos-key-id': KEY_ID,
    'x-leoos-timestamp': timestamp,
    'x-leoos-nonce': nonce,
    'x-leoos-seq': seqStr,
    'x-leoos-protocol': '1',
    'x-leoos-signature': createHmac('sha256', overrides.secret ?? SECRET)
      .update(canonical, 'utf8').digest('hex'),
  };
}

async function post(path, payload, overrides = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${API}${path}`, {
    method: 'POST', body, headers: sign(path, body, overrides),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function expect(label, actual, wanted) {
  if (actual === wanted) notes.push(`${label}: ${actual}`);
  else problems.push(`${label}: expected ${wanted}, got ${actual}`);
}

// ── 1. Handshake ────────────────────────────────────────────────────────────
const shook = await post('/api/v1/fivem/handshake', {
  resourceVersion: '1.0.0', serverName: 'walkthrough', adapter: 'standalone',
});
expect('handshake', shook.status, 200);
if (shook.status !== 200) {
  console.error(JSON.stringify(shook.json));
  process.exit(1);
}
const sessionId = shook.json.sessionId;
notes.push(`session ${sessionId.slice(0, 8)}…, telemetry ${shook.json.telemetryIntervalMs}ms`);

// ── 2. Telemetry for the linked officer ─────────────────────────────────────
const LICENSE = process.env.LEOOS_TEST_LICENSE;
if (LICENSE) {
  const sent = await post('/api/v1/fivem/telemetry', {
    sessionId, sentAt: Date.now(),
    players: [{
      src: 1, identifiers: { license: LICENSE },
      x: 421.7, y: -981.2, z: 30.7, heading: 187.4, speed: 12.5,
      vehicle: { model: 'police3', plate: 'LS12345' },
    }],
  });
  expect('telemetry', sent.status, 200);
  expect('telemetry accepted', sent.json?.accepted, 1);
}

// ── 3. An unlinked player is tracked and attributed to nobody ───────────────
const anon = await post('/api/v1/fivem/telemetry', {
  sessionId, sentAt: Date.now(),
  players: [{
    src: 9, identifiers: { license: `license:${randomBytes(8).toString('hex')}` },
    x: 100, y: 100, z: 30, heading: 0,
  }],
});
expect('unlinked accepted-as-request', anon.status, 200);
expect('unlinked attributed to nobody', anon.json?.accepted, 0);

// ── 4. A forged organization is REFUSED ─────────────────────────────────────
const forged = await post('/api/v1/fivem/telemetry', {
  sessionId, sentAt: Date.now(),
  players: [{
    src: 2, identifiers: { license: LICENSE ?? 'license:whoever' },
    x: 100, y: 100, z: 30, heading: 0,
    organization: 'FIB', rank: 'Director', callsign: 'FIB-1',
  }],
});
expect('forged organization refused', forged.status, 400);

// ── 5. Replay ───────────────────────────────────────────────────────────────
const body = JSON.stringify({ sessionId, playerCount: 3, uptimeSeconds: 60, resourceVersion: '1.0.0' });
const headers = sign('/api/v1/fivem/heartbeat', body);
const first = await fetch(`${API}/api/v1/fivem/heartbeat`, { method: 'POST', body, headers });
const replay = await fetch(`${API}/api/v1/fivem/heartbeat`, { method: 'POST', body, headers });
expect('heartbeat', first.status, 200);
expect('replay refused', replay.status, 409);

// ── 6. Tampered body ────────────────────────────────────────────────────────
const honest = JSON.stringify({ sessionId, playerCount: 3, uptimeSeconds: 60, resourceVersion: '1.0.0' });
const tampered = JSON.stringify({ sessionId, playerCount: 999, uptimeSeconds: 60, resourceVersion: '1.0.0' });
const tamperRes = await fetch(`${API}/api/v1/fivem/heartbeat`, {
  method: 'POST', body: tampered,
  headers: sign('/api/v1/fivem/heartbeat', tampered, { bodyToSign: honest }),
});
expect('tampered body refused', tamperRes.status, 401);

// ── 7. Clock skew ───────────────────────────────────────────────────────────
const skewed = await post('/api/v1/fivem/heartbeat', {
  sessionId, playerCount: 3, uptimeSeconds: 60, resourceVersion: '1.0.0',
}, { timestamp: Math.floor(Date.now() / 1000) - 600 });
expect('clock skew refused', skewed.status, 401);

// ── 8. Wrong secret ─────────────────────────────────────────────────────────
const wrong = await post('/api/v1/fivem/heartbeat', {
  sessionId, playerCount: 3, uptimeSeconds: 60, resourceVersion: '1.0.0',
}, { secret: randomBytes(32).toString('base64url') });
expect('wrong secret refused', wrong.status, 401);

// ── 9. In-game panic ────────────────────────────────────────────────────────
if (LICENSE) {
  const panic = await post('/api/v1/fivem/events', {
    sessionId,
    events: [{
      kind: 'player.panic', at: Date.now(),
      identifiers: { license: LICENSE }, x: 420, y: -980,
    }],
  });
  expect('in-game panic', panic.status, 200);
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log('\n# FiveM bridge walkthrough\n\n## Notes');
for (const note of notes) console.log(`- ${note}`);
console.log('\n## Problems');
if (problems.length === 0) console.log('- none');
else for (const problem of problems) console.log(`- ${problem}`);

process.exit(problems.length === 0 ? 0 : 1);
