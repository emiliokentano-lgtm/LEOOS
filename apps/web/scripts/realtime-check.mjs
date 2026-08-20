/**
 * Real-time walkthrough.
 *
 * Proves the property the whole subsystem exists for: one operator acts, and a
 * SECOND operator's screen changes WITHOUT A RELOAD and without waiting for a
 * poll. Everything else here — the ticket handshake, topic authorization, the
 * position batching — is verified in support of that one claim.
 *
 * What it checks, in order:
 *   1. the socket connects at all, and the status bar says so
 *   2. a panic raised by an officer reaches a sergeant's board in seconds
 *   3. position batches arrive on `map:units` as batches, not per unit
 *   4. an unauthorized topic is REFUSED — the security claim, tested rather
 *      than asserted
 *   5. a ticket is single-use
 *
 * Fails on console errors, page errors and horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.realtime';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problems = [];
const notes = [];

async function session(username) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${username}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', 'correct-horse-staple-42');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|dispatch)/, { timeout: 15000 });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

/**
 * Opens a raw socket from inside the page and returns what it receives.
 *
 * Run in the browser rather than from Node so the ticket is minted through the
 * same authenticated BFF hop the real client uses — a check that bypassed that
 * would be testing a path nobody runs.
 */
function probeSocket(page, topics, holdMs) {
  return page.evaluate(async ({ topics, holdMs }) => {
    const res = await fetch('/api/realtime/ticket', { method: 'POST' });
    if (!res.ok) return { error: `ticket ${res.status}` };
    const { ticket, url } = await res.json();

    return await new Promise((resolve) => {
      const received = [];
      let ready = null;
      let subscribed = null;
      const socket = new WebSocket(url);

      const done = () => {
        try { socket.close(); } catch { /* already gone */ }
        resolve({ ready, subscribed, received });
      };

      socket.onopen = () => socket.send(JSON.stringify({ t: 'auth', ticket }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.t === 'ready') {
          ready = message;
          socket.send(JSON.stringify({ t: 'subscribe', topics }));
          return;
        }
        if (message.t === 'subscribed') {
          subscribed = message;
          setTimeout(done, holdMs);
          return;
        }
        if (message.t === 'event') {
          received.push({ topic: message.topic, seq: message.seq, type: message.event.type,
            payload: message.event.payload });
        }
      };
      socket.onerror = () => resolve({ error: 'socket error', ready, subscribed, received });
      setTimeout(done, holdMs + 8000);
    });
  }, { topics, holdMs });
}

async function orgIdFor(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/dispatch/self');
    if (!res.ok) return null;
    const data = await res.json();
    return data.self?.organizationId ?? null;
  });
}

// ── 1. The socket connects ──────────────────────────────────────────────────
const sergeant = await session('ui.sergeant');
await sergeant.page.goto(`${BASE}/dispatch`, { waitUntil: 'domcontentloaded' });
await sergeant.page.waitForTimeout(4000);

const feedText = await sergeant.page.textContent('footer');
notes.push(`status bar feed: ${/Feed: [a-z ]+/.exec(feedText ?? '')?.[0] ?? 'not found'}`);
if (!feedText?.includes('Feed: live')) {
  problems.push(`status bar does not report a live feed: ${feedText?.slice(0, 200)}`);
}
await shot(sergeant.page, '01-dispatch-live');

// ── 2. A panic crosses between two operators, with no reload ────────────────
//
// Raised through the REAL UI, not a fetch: the claim being tested is that an
// operator pressing the button changes another operator's screen, and a script
// calling an endpoint would skip the half of that path the operator uses.
const officer = await session('ui.officer1');
await officer.page.goto(`${BASE}/dispatch`, { waitUntil: 'domcontentloaded' });
await officer.page.waitForTimeout(3000);

const OFFICER_NAME = 'Tomas Brandt';

// The sergeant's board BEFORE. Asserting on the officer's own name rather than
// on the word "panic" — which appears in filter chips and status labels whether
// or not anything is happening.
const before = await sergeant.page.evaluate((name) => {
  const alerts = [...document.querySelectorAll('[role="alert"]')];
  return {
    banners: alerts.length,
    namedAlert: alerts.some((el) => el.textContent?.includes(name)),
  };
}, OFFICER_NAME);
notes.push(`sergeant before: ${before.banners} alert(s), officer named: ${before.namedAlert}`);

const panicBtn = officer.page.getByRole('button', { name: /^panic$/i });
if (await panicBtn.count() === 0) {
  problems.push('no panic control on the officer’s screen');
} else {
  await panicBtn.first().click();
  await officer.page.waitForTimeout(600);
  const confirm = officer.page.getByRole('button', { name: /raise panic|confirm panic/i });
  if (await confirm.count() === 0) {
    problems.push('panic did not ask for confirmation');
  } else {
    const raisedAt = Date.now();
    await confirm.first().click();

    /**
     * Waits for the sergeant's board to name the officer — with a ceiling well
     * BELOW the backstop poll interval.
     *
     * That ceiling is the whole point of the test. If the board only caught up
     * because of a poll, this would time out; passing inside it is evidence
     * about the socket specifically rather than about the screen eventually
     * getting there.
     */
    try {
      await sergeant.page.waitForFunction(
        (name) => [...document.querySelectorAll('[role="alert"]')]
          .some((el) => el.textContent?.includes(name)),
        OFFICER_NAME,
        { timeout: 8000, polling: 250 },
      );
      notes.push(`panic reached the sergeant in ~${Date.now() - raisedAt}ms, no reload`);
    } catch {
      problems.push('panic did not reach the second operator within 8s (no reload)');
    }
  }
}
await shot(officer.page, '02a-panic-raised');
await shot(sergeant.page, '02b-panic-received');

// Stand it down through the UI too, so the run leaves the board as it found it
// and the next run's "before" state is clean.
const clearBtn = officer.page.getByRole('button', { name: /stand down|clear panic/i });
if (await clearBtn.count() > 0) {
  await clearBtn.first().click();
  await officer.page.waitForTimeout(1500);
  notes.push('panic stood down by the officer who raised it');
}

// ── 3. Positions arrive batched on map:units ────────────────────────────────
await sergeant.page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
await sergeant.page.waitForTimeout(4000);
await shot(sergeant.page, '03-map-live');

const positions = await probeSocket(sergeant.page, ['map:units'], 3500);
if (positions.error) {
  problems.push(`map:units probe failed: ${positions.error}`);
} else {
  const batches = positions.received.filter((m) => m.type === 'unit.location.updated');
  const sizes = batches.map((b) => b.payload.positions.length);
  notes.push(`map:units — ${batches.length} batch(es) in 3.5s, sizes ${JSON.stringify(sizes)}`);

  if (batches.length === 0) {
    problems.push('no position batches arrived on map:units');
  }
  // The economy claim: one message per tick carrying many units, never one
  // message per unit.
  if (batches.length > 6) {
    problems.push(`too many messages in 3.5s (${batches.length}) — positions are not batched`);
  }
  const seqs = batches.map((b) => b.seq);
  const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  if (!monotonic) problems.push(`sequence numbers not monotonic: ${JSON.stringify(seqs)}`);
}

// ── 4. Topic authorization is enforced server-side ──────────────────────────
const ownOrg = await orgIdFor(sergeant.page);
const foreignOrg = '00000000-0000-4000-8000-000000000123';

const denial = await probeSocket(sergeant.page, [
  `org:${foreignOrg}:incidents`,
  'user:00000000-0000-4000-8000-000000000456',
  'not-a-topic',
  ...(ownOrg ? [`org:${ownOrg}:incidents`] : []),
], 500);

if (denial.error) {
  problems.push(`authorization probe failed: ${denial.error}`);
} else {
  const denied = denial.subscribed?.denied ?? [];
  const allowed = (denial.subscribed?.ok ?? []).map((o) => o.topic);
  notes.push(`denied: ${JSON.stringify(denied.map((d) => `${d.topic}=${d.reason}`))}`);
  notes.push(`allowed: ${JSON.stringify(allowed)}`);

  if (!denied.some((d) => d.topic === `org:${foreignOrg}:incidents`)) {
    problems.push('another organization’s incident topic was NOT refused');
  }
  if (!denied.some((d) => d.topic.startsWith('user:'))) {
    problems.push('another user’s notification topic was NOT refused');
  }
  if (!denied.some((d) => d.topic === 'not-a-topic')) {
    problems.push('a malformed topic was NOT refused');
  }
  if (ownOrg && !allowed.includes(`org:${ownOrg}:incidents`)) {
    problems.push('the caller’s OWN organization topic was refused');
  }
}

// ── 5. A ticket is single-use ───────────────────────────────────────────────
const replay = await sergeant.page.evaluate(async () => {
  const res = await fetch('/api/realtime/ticket', { method: 'POST' });
  const { ticket, url } = await res.json();

  const attempt = (label) => new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.onopen = () => socket.send(JSON.stringify({ t: 'auth', ticket }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'ready' || message.t === 'auth-failed') {
        socket.close();
        resolve({ label, result: message.t });
      }
    };
    socket.onerror = () => resolve({ label, result: 'error' });
    setTimeout(() => { socket.close(); resolve({ label, result: 'timeout' }); }, 5000);
  });

  const first = await attempt('first');
  const second = await attempt('replay');
  return { first, second };
});

notes.push(`ticket use: first=${replay.first.result}, replay=${replay.second.result}`);
if (replay.first.result !== 'ready') problems.push('a fresh ticket was refused');
if (replay.second.result === 'ready') problems.push('a ticket was accepted TWICE — not single-use');

// ── Report ──────────────────────────────────────────────────────────────────
const report = [
  '# Real-time walkthrough',
  '',
  '## Notes',
  ...notes.map((n) => `- ${n}`),
  '',
  '## Problems',
  ...(problems.length === 0 ? ['- none'] : problems.map((p) => `- ${p}`)),
  '',
].join('\n');

writeFileSync(`${OUT}/report.md`, report);
console.log(report);

await sergeant.ctx.close();
await officer.ctx.close();
await browser.close();

process.exit(problems.length === 0 ? 0 : 1);
