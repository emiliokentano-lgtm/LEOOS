/**
 * A simulated FiveM server.
 *
 * Speaks the real signed protocol — same canonical string, same headers, same
 * endpoints — so what it exercises is the actual ingest path rather than a
 * shortcut into the position store. It is a MOCK GAME SERVER, not a mock of the
 * integration: everything between this process and the map is production code.
 *
 * Drives the scenarios the live map has to survive:
 *
 *   many units      several agencies patrolling at once
 *   high frequency  a configurable tick, up to and past the API's own rate
 *   panic           a unit raising an alert mid-patrol
 *   going quiet     a unit that stops reporting, so stale → offline can be seen
 *   disconnect      the whole server dropping and re-handshaking
 *
 * Usage:
 *   node fivem-simulator.mjs --units 20 --tick 1000 --duration 60
 *   node fivem-simulator.mjs --scenario panic
 *   node fivem-simulator.mjs --scenario go-quiet --units 6
 *   node fivem-simulator.mjs --scenario reconnect
 *   node fivem-simulator.mjs --scenario burst --tick 100
 *
 * It also takes COMMANDS ON STDIN, one per line, so a single run can be driven
 * through several situations the way one real server would be:
 *
 *   panic            player 0 raises an alert
 *   quiet <n>        n players stop transmitting
 *   resume           everyone transmits again
 *   tick <ms>        change the transmit interval
 *   drop             the server goes away entirely — no telemetry, no heartbeat
 *   up               it comes back and re-handshakes
 *   stop             exit
 *
 * That matters beyond convenience: a handshake is rate limited per credential
 * because a real game server handshakes once when it starts. Spawning a new
 * process per situation burns that budget for no reason and stops looking like
 * a game server at all.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

const API = process.env.LEOOS_API ?? 'http://localhost:3011';
const KEY_ID = process.env.LEOOS_KEY_ID;
const SECRET = process.env.LEOOS_SECRET;

if (!KEY_ID || !SECRET) {
  console.error('Set LEOOS_KEY_ID and LEOOS_SECRET. Issue a credential in LEOOS first.');
  process.exit(2);
}

// ── Arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const SCENARIO = arg('scenario', 'patrol');
const TICK_MS = Number(arg('tick', 1000));
const DURATION_S = Number(arg('duration', 60));
const MAX_UNITS = Number(arg('units', 12));

// ── Signing, exactly as `transport.lua` does it ─────────────────────────────
//
// Seeded from unix seconds, as the resource is. `Date.now() % 1e6` looks like a
// reasonable seed and is not: it wraps every seventeen minutes, so a second run
// can start BEHIND the sequence the first one left on the server and be refused
// as stale. The clock only goes one way.
let seq = Math.floor(Date.now() / 1000);

function sign(path, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  seq += 1;
  const seqStr = String(seq);

  const canonical = [
    'POST', path, timestamp, nonce, seqStr,
    createHash('sha256').update(body, 'utf8').digest('hex'),
  ].join('\n');

  return {
    'content-type': 'application/json',
    'x-leoos-key-id': KEY_ID,
    'x-leoos-timestamp': timestamp,
    'x-leoos-nonce': nonce,
    'x-leoos-seq': seqStr,
    'x-leoos-protocol': '1',
    'x-leoos-signature': createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex'),
  };
}

async function post(path, payload) {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(`${API}${path}`, { method: 'POST', body, headers: sign(path, body) });
    let json = null;
    try { json = await res.json(); } catch { /* empty body is fine */ }
    return { status: res.status, json };
  } catch (error) {
    return { status: 0, json: null, error: String(error) };
  }
}

// ── The simulated world ─────────────────────────────────────────────────────
//
// Approximate Los Santos landmarks. Eyeballed, and nothing operational depends
// on them — they exist so simulated patrols travel between recognisable places
// instead of drifting through the ocean.
const ANCHORS = [
  { name: 'Legion Square', x: 195, y: -935 },
  { name: 'Mission Row', x: 441, y: -982 },
  { name: 'Pillbox Hill', x: 298, y: -584 },
  { name: 'La Mesa', x: 830, y: -1290 },
  { name: 'Davis', x: 100, y: -1900 },
  { name: 'LS Airport', x: -1037, y: -2737 },
  { name: 'Vespucci', x: -1200, y: -1500 },
  { name: 'Del Perro', x: -1850, y: -1240 },
  { name: 'Vinewood', x: 300, y: 180 },
  { name: 'Sandy Shores', x: 1960, y: 3740 },
  { name: 'Paleto Bay', x: -100, y: 6430 },
];

/**
 * One simulated player.
 *
 * Keyed by the FiveM licence, because that is what the API resolves on. The
 * simulator knows nothing about which unit or organization it maps to — that is
 * the point of the trust model, and it means this file cannot accidentally
 * assert an organization it has no business asserting.
 */
class Player {
  constructor(license, index) {
    this.license = license;
    this.x = ANCHORS[index % ANCHORS.length].x + (Math.random() - 0.5) * 60;
    this.y = ANCHORS[index % ANCHORS.length].y + (Math.random() - 0.5) * 60;
    this.z = 30;
    this.heading = Math.random() * 360;
    this.target = ANCHORS[(index + 3) % ANCHORS.length];
    this.speed = 12 + Math.random() * 14;
    this.quiet = false;
    this.plate = `SIM${String(index).padStart(3, '0')}`;
  }

  step(seconds) {
    if (this.quiet) return;

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const distance = Math.hypot(dx, dy);

    if (distance < 60) {
      this.target = ANCHORS[Math.floor(Math.random() * ANCHORS.length)];
      return;
    }

    const move = Math.min(distance, this.speed * seconds);
    this.x += (dx / distance) * move;
    this.y += (dy / distance) * move;
    // Heading in GTA's convention: 0 is north, increasing clockwise.
    this.heading = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (this.heading < 0) this.heading += 360;
  }

  sample(src) {
    return {
      src,
      identifiers: { license: this.license },
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      z: this.z,
      heading: Math.round(this.heading * 10) / 10,
      speed: Math.round(this.speed * 10) / 10,
      vehicle: { model: 'police3', plate: this.plate },
    };
  }
}

// ── Session ─────────────────────────────────────────────────────────────────
let sessionId = null;

async function handshake() {
  const res = await post('/api/v1/fivem/handshake', {
    resourceVersion: 'sim-1.0.0',
    serverName: 'Simulated FiveM server',
    maxPlayers: 128,
    adapter: 'standalone',
  });
  if (res.status !== 200) {
    console.error(`handshake failed (${res.status}):`, JSON.stringify(res.json));
    return false;
  }
  sessionId = res.json.sessionId;
  console.log(`handshake ok — session ${sessionId.slice(0, 8)}…`);
  return true;
}

async function heartbeat(playerCount) {
  const res = await post('/api/v1/fivem/heartbeat', {
    sessionId,
    playerCount,
    uptimeSeconds: Math.floor(process.uptime()),
    resourceVersion: 'sim-1.0.0',
  });
  // A lost session re-handshakes, exactly as the resource does.
  if (res.status === 400 || res.status === 409) {
    console.log('session lost — re-handshaking');
    await handshake();
  }
  return res;
}

// ── Which licences to drive ─────────────────────────────────────────────────
//
// Read from the environment: the simulator does not create identities, because
// linking one is a two-sided flow the whole trust model rests on. `setup-live-map`
// prepares them and passes them here.
const licenses = (process.env.LEOOS_SIM_LICENSES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, MAX_UNITS);

if (licenses.length === 0) {
  console.error('Set LEOOS_SIM_LICENSES to a comma-separated list of linked licences.');
  process.exit(2);
}

const players = licenses.map((license, i) => new Player(license, i));
console.log(`simulating ${players.length} unit(s), scenario "${SCENARIO}", tick ${TICK_MS}ms`);

// ── Run ─────────────────────────────────────────────────────────────────────
if (!(await handshake())) process.exit(1);

let ticks = 0;
let sent = 0;
let accepted = 0;
let rejected = 0;
let failures = 0;
const startedAt = Date.now();
let paused = false;

let tickMs = TICK_MS;

async function sendTelemetry() {
  if (paused) return;

  ticks += 1;
  const seconds = tickMs / 1000;
  for (const player of players) player.step(seconds);

  const active = players.filter((p) => !p.quiet);
  const res = await post('/api/v1/fivem/telemetry', {
    sessionId,
    sentAt: Date.now(),
    players: active.map((p, i) => p.sample(i + 1)),
  });

  sent += 1;
  if (res.status === 200) {
    accepted += res.json?.accepted ?? 0;
    rejected += res.json?.rejected ?? 0;
  } else {
    failures += 1;
    if (failures <= 3) console.error(`telemetry ${res.status}`, JSON.stringify(res.json));
    if (res.status === 400 || res.status === 409) await handshake();
  }

  if (ticks % 10 === 0) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `t+${elapsed}s  ticks=${ticks} accepted=${accepted} rejected=${rejected} failed=${failures} quiet=${players.length - active.length}`,
    );
  }
}

let timer = setInterval(sendTelemetry, tickMs);

const heartbeatTimer = setInterval(() => { void heartbeat(players.length); }, 5000);
void heartbeat(players.length);

// ── Scenarios ───────────────────────────────────────────────────────────────

if (SCENARIO === 'panic') {
  // One unit raises a panic ten seconds in, so a watcher can see the board and
  // the map react while everything else keeps moving normally.
  setTimeout(async () => {
    const victim = players[0];
    console.log(`>>> ${victim.license} is raising a PANIC`);
    const res = await post('/api/v1/fivem/events', {
      sessionId,
      events: [{
        kind: 'player.panic',
        at: Date.now(),
        identifiers: { license: victim.license },
        x: Math.round(victim.x * 10) / 10,
        y: Math.round(victim.y * 10) / 10,
      }],
    });
    console.log(`>>> panic ${res.status}`);
  }, 10_000);
}

if (SCENARIO === 'go-quiet') {
  // Half the fleet stops reporting. Everything else keeps going, so the
  // difference between "the feed died" and "this unit died" is visible.
  setTimeout(() => {
    const half = Math.ceil(players.length / 2);
    for (let i = 0; i < half; i += 1) players[i].quiet = true;
    console.log(`>>> ${half} unit(s) stopped transmitting — watch them go stale, then offline`);
  }, 8_000);
}

if (SCENARIO === 'reconnect') {
  // The whole server drops: no telemetry and no heartbeat, then it comes back
  // and re-handshakes from a fresh sequence.
  setTimeout(() => {
    paused = true;
    sessionId = null;
    console.log('>>> game server DROPPED — no telemetry, no heartbeat');
  }, 10_000);

  setTimeout(async () => {
    console.log('>>> game server coming back');
    if (await handshake()) {
      paused = false;
      console.log('>>> reconnected');
    }
  }, 45_000);
}

// ── Commands on stdin ───────────────────────────────────────────────────────

process.stdin.setEncoding('utf8');
let stdinBuffer = '';

process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf('\n');
  while (newline >= 0) {
    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (line !== '') void command(line);
    newline = stdinBuffer.indexOf('\n');
  }
});

async function command(line) {
  const [verb, argument] = line.split(/\s+/);

  switch (verb) {
    case 'panic': {
      const victim = players[Number(argument ?? 0)] ?? players[0];
      const res = await post('/api/v1/fivem/events', {
        sessionId,
        events: [{
          kind: 'player.panic',
          at: Date.now(),
          identifiers: { license: victim.license },
          x: Math.round(victim.x * 10) / 10,
          y: Math.round(victim.y * 10) / 10,
        }],
      });
      console.log(`>>> panic by ${victim.license} — ${res.status}`);
      break;
    }
    case 'quiet': {
      const count = Number(argument ?? Math.ceil(players.length / 2));
      players.forEach((p, i) => { p.quiet = i < count; });
      console.log(`>>> ${count} unit(s) stopped transmitting`);
      break;
    }
    case 'resume':
      for (const p of players) p.quiet = false;
      console.log('>>> all units transmitting again');
      break;
    case 'tick': {
      const ms = Number(argument);
      if (Number.isFinite(ms) && ms >= 50) {
        clearInterval(timer);
        timer = setInterval(sendTelemetry, ms);
        tickMs = ms;
        console.log(`>>> tick is now ${ms}ms`);
      }
      break;
    }
    case 'drop':
      paused = true;
      sessionId = null;
      console.log('>>> game server DROPPED — no telemetry, no heartbeat');
      break;
    case 'up':
      if (await handshake()) {
        paused = false;
        console.log('>>> reconnected');
      }
      break;
    case 'stop':
      finish();
      break;
    default:
      console.log(`>>> unknown command: ${line}`);
  }
}

setTimeout(finish, DURATION_S * 1000);

function finish() {
  clearInterval(timer);
  clearInterval(heartbeatTimer);
  console.log(
    `\ndone — ${ticks} tick(s), ${accepted} position(s) accepted, `
    + `${rejected} rejected, ${failures} request(s) failed`,
  );
  process.exit(failures > sent / 2 ? 1 : 0);
}
