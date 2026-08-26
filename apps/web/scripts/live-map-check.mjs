/**
 * Live map walkthrough — the FiveM feed, end to end, in a real browser.
 *
 * Everything between this script and the pixels is production code. Positions
 * are pushed by `fivem-simulator.mjs`, which speaks the real signed ingest
 * protocol, so what is being exercised is the whole chain:
 *
 *   simulator → HMAC ingest → identity resolution → live position store
 *             → WebSocket fan-out → MapUnitStore → canvas + side list
 *
 * The seven properties it checks are the ones the live map has to hold:
 *
 *   1. MULTIPLE UNITS      several agencies patrolling at once, each row
 *                          carrying callsign, organization, status, crew,
 *                          vehicle, position, heading and current incident.
 *   2. HIGH FREQUENCY      positions at 10 Hz must not churn the DOM. The unit
 *                          list is observed for mutations while the feed runs
 *                          flat out; a roster that re-rendered per tick would
 *                          show up here as hundreds of them.
 *   3. RECONNECT           the browser loses the network and gets it back. The
 *                          status banner must tell the truth in both directions
 *                          and positions must resume without a reload.
 *   4. STALE → OFFLINE     a unit that stops transmitting is marked stale, then
 *                          offline, and STAYS ON THE BOARD with its last known
 *                          position readable.
 *   5. FILTERING           organization and tracking-level filters agree with a
 *                          recomputation from the payload the browser holds.
 *   6. PANIC               the standing alert bar, the off-screen bearing arrow
 *                          and the Locate action — none of which is an
 *                          animation.
 *   7. ORG ISOLATION       FIB units transmit throughout. No PD or MD session
 *                          may receive one byte about them.
 *
 * Prerequisites — `packages/db/scripts/setup-live-map.mjs` prints all of them:
 *
 *   LEOOS_KEY_ID, LEOOS_SECRET      a game-server credential
 *   LEOOS_SIM_LICENSES              linked FiveM licences to drive
 *   LEOOS_SIM_PD_USER, LEOOS_SIM_MD_USER
 *
 * Usage:  node scripts/live-map-check.mjs [outdir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.LEOOS_WEB ?? 'http://localhost:3010';
const OUT = process.argv[2] ?? '.live-map';
const PASSWORD = process.env.LEOOS_SIM_PASSWORD ?? 'correct-horse-staple-42';

const PD_USER = process.env.LEOOS_SIM_PD_USER;
const MD_USER = process.env.LEOOS_SIM_MD_USER;

for (const name of ['LEOOS_KEY_ID', 'LEOOS_SECRET', 'LEOOS_SIM_LICENSES']) {
  if (!process.env[name]) {
    console.error(`Set ${name}. Run packages/db/scripts/setup-live-map.mjs first.`);
    process.exit(2);
  }
}
if (!PD_USER || !MD_USER) {
  console.error('Set LEOOS_SIM_PD_USER and LEOOS_SIM_MD_USER.');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const problems = [];
const notes = [];
const check = (ok, failure, pass) => {
  if (ok) notes.push(`✓ ${pass}`);
  else problems.push(failure);
  return ok;
};

// ── The simulated game server ───────────────────────────────────────────────

/**
 * Runs the simulator as a child process and resolves when it exits.
 *
 * Deliberately a separate process rather than an imported function: it is
 * standing in for a FiveM server, and a FiveM server is not in the browser's
 * address space. Killing it is how "the game server went away" is expressed.
 */
function simulator(args) {
  const child = spawn('node', ['scripts/fivem-simulator.mjs', ...args], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  child.stdout.on('data', (b) => lines.push(String(b).trimEnd()));
  child.stderr.on('data', (b) => lines.push(`ERR ${String(b).trimEnd()}`));

  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, output: lines.join('\n') }));
  });

  /**
   * Resolves once the game server is actually talking to the API.
   *
   * Without this the walkthrough races the handshake and reports "the feed is
   * not reaching the map" for every phase, which is true but says nothing about
   * why. A simulator that cannot connect is a problem in its own right and is
   * reported as one.
   */
  const ready = new Promise((resolve) => {
    const deadline = setTimeout(() => {
      problems.push(`the simulated game server never connected: ${lines.join(' | ')}`);
      resolve(false);
    }, 20000);
    const watch = setInterval(() => {
      if (lines.some((l) => l.includes('handshake ok'))) {
        clearInterval(watch);
        clearTimeout(deadline);
        resolve(true);
      } else if (lines.some((l) => l.includes('handshake failed'))) {
        clearInterval(watch);
        clearTimeout(deadline);
        problems.push(`the simulated game server was refused: ${lines.join(' | ')}`);
        resolve(false);
      }
    }, 250);
  });

  /** Sends one command down the simulator's stdin — see its header. */
  const tell = (line) => { child.stdin.write(`${line}\n`); };

  return { child, done, ready, lines, tell };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Clicks, or records a problem — never throws.
 *
 * A walkthrough that dies on its third assertion tells you about one failure and
 * hides the other twelve. Every interaction here is best-effort so the run
 * always reaches the report.
 */
async function safeClick(locator, what, timeout = 8000) {
  try {
    await locator.click({ timeout });
    return true;
  } catch (error) {
    // Why it could not be clicked matters: an element that is missing is a
    // different defect from one that never stops moving under the cursor.
    let diagnosis = '';
    try {
      const boxes = [];
      for (let i = 0; i < 3; i += 1) {
        boxes.push(await locator.boundingBox());
        await sleep(120);
      }
      const moved = boxes.some(
        (b) => b === null || b.x !== boxes[0]?.x || b.y !== boxes[0]?.y || b.width !== boxes[0]?.width,
      );
      diagnosis = ` (visible=${await locator.isVisible()} enabled=${await locator.isEnabled()}`
        + `${moved ? ' MOVING: ' + JSON.stringify(boxes) : ' box stable'})`;
    } catch { /* the element vanished entirely */ }
    problems.push(`could not click ${what}: ${String(error).split('\n')[0]}${diagnosis}`);
    return false;
  }
}

/** A filter chip, by its exact label. Chips are the only aria-pressed buttons. */
const chipNamed = (page, label) => page
  .locator('button[aria-pressed]')
  .filter({ hasText: new RegExp(`^\\s*${label}`) })
  .first();

// ── Browser plumbing ────────────────────────────────────────────────────────

/**
 * Writes what was learned, whatever happened.
 *
 * Registered against both failure channels below, so a crash three phases in
 * still reports the two phases that passed and names the crash as the problem
 * rather than throwing the run away.
 */
function report() {
  const text = [
    '# Live map walkthrough',
    '',
    ...notes.map((n) => `- ${n}`),
    '',
    problems.length === 0 ? '## No problems found' : `## ${problems.length} problem(s)`,
    ...problems.map((p) => `- ${p}`),
    '',
  ].join('\n');
  writeFileSync(`${OUT}/report.md`, text);
  console.log(text);
}

for (const channel of ['uncaughtException', 'unhandledRejection']) {
  process.on(channel, (error) => {
    problems.push(`the walkthrough crashed: ${String(error).split('\n')[0]}`);
    report();
    process.exit(1);
  });
}

/** Raised around the deliberate disconnection, so its noise is not a finding. */
let expectingNetworkErrors = false;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

async function session(username, label) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    // Network errors during the deliberate offline window are the point of that
    // phase, not a defect. Everything else is still a problem.
    if (m.type() === 'error' && !expectingNetworkErrors) {
      problems.push(`[${label}] console: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => {
    if (!expectingNetworkErrors) problems.push(`[${label}] pageerror: ${e.message}`);
  });

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|map)/, { timeout: 20000 });
  return { ctx, page };
}

async function openMap(page) {
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 20000 });
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

/** The snapshot the BROWSER received — not the server's opinion of it. */
const snapshotFor = (page) => page.evaluate(async () => {
  const res = await fetch('/api/map/snapshot', { cache: 'no-store' });
  return res.ok ? res.json() : { error: res.status };
});

/**
 * The unit list container, found through its heading.
 *
 * Anchored on the visible "Units on map" title rather than on a class, because
 * the sidebar's account menu also renders a callsign in a monospaced span and a
 * looser selector picks that up as a phantom row.
 */
const UNIT_LIST = `(() => {
  const h = [...document.querySelectorAll('h2')]
    .find((el) => el.textContent.trim() === 'Units on map');
  if (!h) return null;
  const panel = h.closest('div.flex.min-h-0.flex-1') ?? h.parentElement?.parentElement?.parentElement;
  return panel?.querySelector('div.overflow-auto') ?? null;
})()`;

/** Every unit row currently in the side list, read out of the DOM. */
const listedUnits = (page) => page.evaluate(`(() => {
  const list = ${UNIT_LIST};
  if (!list) return [];
  return [...list.querySelectorAll('button')].map((row) => {
    const spans = [...row.querySelectorAll('span')].map((s) => s.textContent.trim());
    return {
      // The row's first monospaced span is the callsign; the last is the
      // tracking level. Callsigns are not all alphabetic — "1-ADAM-12" is a
      // perfectly ordinary one — so this reads position, not shape.
      callsign: row.querySelector('span.font-mono')?.textContent.trim() ?? '',
      text: row.textContent,
      tracking: spans[spans.length - 1] ?? '',
    };
  });
})()`);

// ════════════════════════════════════════════════════════════════════════════
// 1 · MULTIPLE UNITS
// ════════════════════════════════════════════════════════════════════════════

/**
 * ONE game server, for the whole walkthrough.
 *
 * A handshake is rate limited per credential because a real server handshakes
 * once when it starts; spawning a process per situation burns that budget and
 * stops resembling a game server at all. Every situation below is commanded
 * down this one process's stdin instead.
 */
const game = simulator(['--units', '9', '--tick', '1000', '--duration', '400']);
await game.ready;
await sleep(3000);

const pd = await session(PD_USER, 'PD');
await openMap(pd.page);
await pd.page.waitForTimeout(3000);
await shot(pd.page, '01-live-fleet');

const pdSnap = await snapshotFor(pd.page);
if (pdSnap.error) {
  problems.push(`PD could not load the map snapshot: ${pdSnap.error}`);
} else {
  const orgs = [...new Set(pdSnap.units.map((u) => u.organization.key))].sort();
  notes.push(`PD sees ${pdSnap.units.length} unit(s) across ${orgs.join(', ') || '—'}`);
  notes.push(`position source: ${pdSnap.source.kind} — ${pdSnap.source.detail}`);

  /**
   * Only the units the simulator is actually driving.
   *
   * A development database accumulates units from every earlier phase, most of
   * them carrying a position from a fixture that ran weeks ago. Selecting on
   * RECENCY rather than on "has a position" is what makes this a test of the
   * live feed instead of a test of the seed data.
   */
  const tracked = pdSnap.units.filter(
    (u) => u.location !== null && Date.now() - Date.parse(u.location.updatedAt) < 20000,
  );
  check(
    tracked.length >= 4,
    `only ${tracked.length} unit(s) reported in the last 20s — the feed is not reaching the map`,
    `${tracked.length} unit(s) reporting live through the signed ingest path `
    + `(of ${pdSnap.units.length} on the board)`,
  );

  // Every field the brief asks a live unit to display, present on the payload
  // the browser holds rather than on the server's row.
  const sample = tracked.find((u) => u.crew.length > 0) ?? tracked[0];
  if (sample) {
    const missing = [];
    if (!sample.callsign) missing.push('callsign');
    if (!sample.organization?.shortName) missing.push('organization');
    if (!sample.status?.key) missing.push('status');
    if (sample.location.x === undefined) missing.push('position');
    if (sample.location.heading === null || sample.location.heading === undefined) {
      missing.push('heading');
    }
    if (sample.vehicle === undefined) missing.push('vehicle');
    if (sample.crew === undefined) missing.push('members');
    if (sample.incident === undefined) missing.push('incident');
    check(
      missing.length === 0,
      `live unit ${sample.callsign} is missing: ${missing.join(', ')}`,
      `${sample.callsign} carries callsign, organization, status, position, heading, `
      + `vehicle (${sample.vehicle?.model ?? 'none'}), ${sample.crew.length} crew and its incident field`,
    );
  }

  const rows = await listedUnits(pd.page);
  check(
    rows.length > 0,
    'the side list rendered no unit rows',
    `${rows.length} unit row(s) rendered, e.g. "${rows[0]?.callsign}" — ${rows[0]?.tracking}`,
  );
}

// ── The unit detail panel, and its route into dispatch ──────────────────────
{
  const rows = await listedUnits(pd.page);

  /**
   * The units that are BOTH driven by the simulator and on this operator's own
   * dispatch board.
   *
   * Both halves matter. Driven, so the panel has a live position to report. On
   * the board, because "View unit" is offered only for units dispatch can
   * actually show — the map is cross-agency and the board is not — and following
   * a link to a board without the unit on it is the thing the action must not
   * do.
   */
  const driven = new Set(
    (pdSnap.units ?? [])
      .filter((u) => u.location !== null && Date.now() - Date.parse(u.location.updatedAt) < 20000)
      .map((u) => u.callsign),
  );
  const onBoard = new Set(await pd.page.evaluate(async () => {
    const res = await fetch('/api/dispatch/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return [];
    const board = await res.json();
    return (board.units ?? []).map((u) => u.callsign);
  }));

  const target = rows.find((r) => driven.has(r.callsign) && onBoard.has(r.callsign))
    ?? rows.find((r) => driven.has(r.callsign))
    ?? rows[0];
  const targetIsMine = target !== undefined && onBoard.has(target.callsign);
  if (target) {
    notes.push(
      `opening the detail panel for ${target.callsign} `
      + `(${targetIsMine ? 'on this operator’s board' : 'another agency’s unit'})`,
    );
    await safeClick(
      pd.page.getByRole('button').filter({ hasText: new RegExp(`^${target.callsign}`) }).first(),
      `the ${target.callsign} row`,
    );
    await pd.page.waitForTimeout(600);
    await shot(pd.page, '02-unit-detail');

    const panel = await pd.page.evaluate(() => document.body.innerText);
    check(
      /Tracking/.test(panel) && /(Live|Stale|Offline|No fix)/.test(panel),
      'the unit detail panel does not report a tracking state',
      'the detail panel reports the unit’s tracking state in words',
    );

    const viewUnit = pd.page.getByRole('link', { name: /view unit/i });

    if (!targetIsMine) {
      // The map is cross-agency; the dispatch board is not. Offering the action
      // here would be a link to a board the unit is not on.
      check(
        await viewUnit.count() === 0,
        `"View unit" was offered for ${target.callsign}, which is not on this `
        + 'operator’s dispatch board',
        `"View unit" is withheld for ${target.callsign}, which belongs to another agency`,
      );
      const panelText = await pd.page.evaluate(() => document.body.innerText);
      check(
        /dispatch board shows your own organization/i.test(panelText),
        'the panel withholds "View unit" without saying why',
        'the panel says why the action is not offered',
      );
    } else if (check(
      await viewUnit.count() > 0,
      'no "View unit" action on the unit detail panel',
      'the detail panel offers "View unit"',
    )) {
      const href = await viewUnit.first().getAttribute('href');
      check(
        (href ?? '').startsWith('/dispatch?unit='),
        `"View unit" points at ${href}, not at the dispatch board`,
        `"View unit" → ${href}`,
      );

      await safeClick(viewUnit.first(), 'the "View unit" action');
      await pd.page.waitForURL(/\/dispatch\?unit=/, { timeout: 15000 });
      await pd.page.waitForTimeout(1500);
      await shot(pd.page, '03-dispatch-focused');

      const focused = await pd.page.evaluate(() => {
        const el = document.querySelector('.ring-inset');
        return el ? el.textContent : null;
      });
      check(
        focused !== null && focused.includes(target.callsign),
        `dispatch did not highlight ${target.callsign} after following "View unit"`,
        `dispatch scrolled to and highlighted ${target.callsign}`,
      );
      await openMap(pd.page);
      await pd.page.waitForTimeout(2000);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · HIGH-FREQUENCY UPDATES
// ════════════════════════════════════════════════════════════════════════════
//
// The property under test is NOT "it survives 10 Hz" — it is "10 Hz does not
// reach React". With positions in roster state, every sample would re-render
// the list; that is exactly what a mutation count measures.

game.tell('tick 120');
await sleep(2000);

const churn = await pd.page.evaluate(`new Promise((resolve) => {
  const list = ${UNIT_LIST};
  if (!list || list.children.length === 0) {
    resolve({ error: 'no unit rows to observe' });
    return;
  }

  let mutations = 0;
  const observer = new MutationObserver((records) => { mutations += records.length; });
  observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });

  setTimeout(() => {
    observer.disconnect();
    resolve({ mutations, rows: list.children.length });
  }, 8000);
})`);

if (churn.error) {
  problems.push(`high-frequency check: ${churn.error}`);
} else {
  const seconds = 8;
  notes.push(
    `high-frequency: ${churn.mutations} DOM mutation(s) across ${churn.rows} row(s) `
    + `in ${seconds}s at ~8 position batches/second`,
  );
  // A per-tick roster render would put this in the hundreds. The budget allows
  // for genuine changes — a status moving, a unit crossing a freshness
  // threshold — without allowing a render loop.
  check(
    churn.mutations <= churn.rows * 2,
    `the unit list mutated ${churn.mutations} time(s) under a 10 Hz feed — positions are `
    + 'reaching React state instead of going straight to the canvas',
    `the unit list stayed still under a 10 Hz feed (${churn.mutations} mutation(s))`,
  );
}
await shot(pd.page, '04-high-frequency');
game.tell('tick 1000');
await sleep(1500);

// ════════════════════════════════════════════════════════════════════════════
// 3 · RECONNECT
// ════════════════════════════════════════════════════════════════════════════
//
// The browser's own connection, cut and restored. The banner must report what
// it actually has in both directions (engineering rule 45).

const beforeDrop = await pd.page.evaluate(() => document.body.innerText);
expectingNetworkErrors = true;
await pd.ctx.setOffline(true);
await pd.page.waitForTimeout(9000);
await shot(pd.page, '05-feed-lost');

const whileOffline = await pd.page.evaluate(() => document.body.innerText);
check(
  /reconnect|offline|polling|not reporting|lost|degraded|stale/i.test(whileOffline),
  'the map claimed a healthy feed while the browser was offline',
  'the map reported a degraded feed while the browser was offline',
);

await pd.ctx.setOffline(false);
await pd.page.waitForTimeout(12000);
expectingNetworkErrors = false;
await shot(pd.page, '06-feed-recovered');

const afterRecovery = await snapshotFor(pd.page);
check(
  !afterRecovery.error && afterRecovery.units.some((u) => u.location !== null),
  'positions did not resume after the connection came back',
  'positions resumed after the connection came back, without a reload',
);
notes.push(`banner before drop: ${(beforeDrop.match(/Feed[^\n]*/) ?? ['—'])[0]}`);

// ════════════════════════════════════════════════════════════════════════════
// 7 · ORGANIZATION ISOLATION
// ════════════════════════════════════════════════════════════════════════════
//
// FIB units are being driven by the simulator throughout. FIB does not share on
// the public map, so a caller WITHOUT `map.track_all_orgs` must not receive one
// — not hidden behind a filter, absent from the payload.
//
// The second session is the control. The MD account the setup script builds
// holds the organization's highest role, and that role HAS the clearance — so it
// legitimately sees everything. Checking both is what makes the first result
// mean something: the difference between the two payloads is the permission,
// not the account.

{
  const pdPayload = await snapshotFor(pd.page);
  const pdBlob = JSON.stringify(pdPayload);
  check(
    pdPayload.capabilities?.canTrackAllOrganizations === false,
    'the PD session unexpectedly holds map.track_all_orgs — the isolation check below '
    + 'would prove nothing',
    'the PD session does not hold map.track_all_orgs',
  );
  check(
    !/FIB/.test(pdBlob),
    'LEAK: the PD payload mentions FIB while FIB units are transmitting',
    'the PD payload contains no FIB unit, though FIB units are transmitting',
  );

  const md = await session(MD_USER, 'MD');
  await openMap(md.page);
  await md.page.waitForTimeout(3000);
  await shot(md.page, '07-md-map');

  const mdSnap = await snapshotFor(md.page);
  if (mdSnap.error) {
    problems.push(`MD could not load the map snapshot: ${mdSnap.error}`);
  } else {
    const orgs = [...new Set(mdSnap.units.map((u) => u.organization.key))].sort();
    const cleared = mdSnap.capabilities?.canTrackAllOrganizations === true;
    notes.push(
      `MD sees ${mdSnap.units.length} unit(s) across ${orgs.join(', ') || '—'} `
      + `(map.track_all_orgs: ${cleared})`,
    );

    if (cleared) {
      check(
        orgs.length > 1,
        'the MD session holds map.track_all_orgs but sees only its own organization — '
        + 'the permission is not being honoured',
        `the cleared MD session sees ${orgs.length} organizations, PD's sergeant sees `
        + `${[...new Set(pdPayload.units.map((u) => u.organization.key))].length}`,
      );
    } else {
      check(
        !/FIB/.test(JSON.stringify(mdSnap)),
        'LEAK: the MD payload mentions FIB',
        'the MD payload contains no FIB unit',
      );
    }
  }
  await md.ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · PANIC
// ════════════════════════════════════════════════════════════════════════════

const panicsBefore = await pd.page.locator('[role="alert"]')
  .filter({ hasText: /panic/i }).count();
game.tell('panic 0');
await sleep(6000);
await pd.page.waitForTimeout(3000);
notes.push(
  panicsBefore > 0
    ? 'note: the database already held an unresolved panic before this run'
    : 'the panic bar was absent before the alert was raised',
);

const alert = pd.page.locator('[role="alert"]').filter({ hasText: /panic/i });
if (check(
  await alert.count() > 0,
  'no standing panic bar appeared while a unit was in panic',
  'a standing panic bar appeared, announced as an alert',
)) {
  const text = await alert.first().innerText();
  notes.push(`panic bar: ${text.replace(/\s+/g, ' ').trim()}`);
  check(
    /\d+,\s*-?\d+/.test(text),
    'the panic bar names a unit but shows no position for it',
    'the panic bar carries the panicking unit’s live position',
  );
  await shot(pd.page, '08-panic-bar');

  // The bar must survive a filter that excludes the unit's organization: a
  // panic an operator has filtered away is a panic they will not answer.
  const panicSnap = await snapshotFor(pd.page);
  const otherOrg = (panicSnap.units ?? [])
    .map((u) => u.organization.shortName)
    .find((name) => name !== undefined);
  if (otherOrg) {
    const chip = chipNamed(pd.page, otherOrg);
    if (await safeClick(chip, `the ${otherOrg} filter chip`)) {
      await pd.page.waitForTimeout(800);
      check(
        await pd.page.locator('[role="alert"]').filter({ hasText: /panic/i }).count() > 0,
        'the panic bar disappeared when an organization filter was applied',
        'the panic bar survived an organization filter',
      );
      await safeClick(chip, `the ${otherOrg} filter chip (clearing)`);
      await pd.page.waitForTimeout(500);
    }
  }

  /**
   * The off-screen arrow.
   *
   * Locate first, then zoom in hard, then pan. Panning at whatever zoom the map
   * happened to be at is not a test — at a wide zoom a drag of a few hundred
   * pixels may not move the unit out of view at all, and the arrow would be
   * absent for the right reason. Zooming in first makes "off screen" certain.
   */
  const locate = pd.page.getByRole('button', { name: /^locate$/i });
  if (check(
    await locate.count() > 0,
    'no Locate action on the panic bar',
    'the panic bar offers Locate',
  )) {
    await safeClick(locate.first(), 'the panic bar’s Locate action');
    await pd.page.waitForTimeout(1000);
    check(
      await pd.page.getByRole('button', { name: /Panic: .* off screen/i }).count() === 0,
      'an off-screen arrow was shown for a panic that Locate had just centred',
      'Locate centred the map on the panic, and no off-screen arrow was shown',
    );
    await shot(pd.page, '10-panic-located');

    const zoomIn = pd.page.getByRole('button', { name: /zoom in/i }).first();
    for (let i = 0; i < 4; i += 1) {
      await safeClick(zoomIn, 'zoom in');
      await pd.page.waitForTimeout(200);
    }

    const canvas = pd.page.locator('canvas').first();
    await canvas.hover({ position: { x: 900, y: 600 } });
    await pd.page.mouse.down();
    await pd.page.mouse.move(150, 120, { steps: 15 });
    await pd.page.mouse.up();
    await pd.page.waitForTimeout(1200);

    const arrow = pd.page.getByRole('button', { name: /Panic: .* off screen/i });
    check(
      await arrow.count() > 0,
      'no off-screen bearing arrow appeared after panning the panic out of view',
      'an off-screen bearing arrow pointed at the panic once it left the viewport',
    );
    await shot(pd.page, '09-panic-offscreen');

    /**
     * And Locate brings it back, which is the point of having the arrow at all.
     *
     * Asserted as "one fewer panic is off screen", not "no panic is off
     * screen". More than one alert can be live at once — that is normal on a
     * busy shift — and centring one of them quite correctly leaves the others
     * off screen. The assertion used to be `count() === 0`, which held only
     * while the database happened to contain exactly one panic, and failed for
     * the wrong reason the moment it contained two.
     */
    const offScreenLabels = async () => pd.page
      .getByRole('button', { name: /Panic: .* off screen/i })
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
      .catch(() => []);

    const beforeLocate = await offScreenLabels();
    await safeClick(locate.first(), 'the panic bar’s Locate action (returning)');
    await pd.page.waitForTimeout(1200);
    const afterLocate = await offScreenLabels();
    check(
      afterLocate.length < beforeLocate.length,
      'Locate did not bring a panic back into view '
        + `(off screen before: ${beforeLocate.length}, after: ${afterLocate.length})`,
      'Locate brought the panic back into view',
    );
    await shot(pd.page, '10b-panic-relocated');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 4 · STALE → OFFLINE
// ════════════════════════════════════════════════════════════════════════════
//
// Five of the nine stop transmitting while the rest keep reporting, so what is
// observed is a unit dying rather than the whole feed dying.

await pd.page.reload({ waitUntil: 'domcontentloaded' });
await pd.page.waitForSelector('canvas', { timeout: 20000 });
await pd.page.waitForTimeout(4000);

const beforeQuiet = await listedUnits(pd.page);
game.tell('quiet 5');
/**
 * The units that were LIVE at the moment half the fleet went quiet.
 *
 * Tracked by name so the transition is measured on the units this run actually
 * drove, rather than on whatever the database was already carrying.
 */
const liveBefore = beforeQuiet.filter((r) => /live/i.test(r.tracking)).map((r) => r.callsign);
notes.push(
  `before going quiet: ${beforeQuiet.length} unit(s) listed, ${liveBefore.length} of them live`,
);
const levelOf = (rows, callsign) => rows.find((r) => r.callsign === callsign)?.tracking ?? '(gone)';

// Past the 15 s stale threshold, well before the 45 s offline one.
await sleep(24000);
const atStale = await listedUnits(pd.page);
await shot(pd.page, '11-stale');
const wentStale = liveBefore.filter((c) => /stale|offline/i.test(levelOf(atStale, c)));
check(
  wentStale.length > 0,
  `none of the ${liveBefore.length} live unit(s) was marked stale 24s after half the fleet `
  + `stopped transmitting (levels: ${liveBefore.map((c) => `${c}=${levelOf(atStale, c)}`).join(', ')})`,
  `${wentStale.length} of ${liveBefore.length} live unit(s) left "Live" once they went quiet: `
  + `${wentStale.map((c) => `${c}=${levelOf(atStale, c)}`).join(', ')}`,
);

// Past the 45 s offline threshold — which is the ingest layer's own position
// TTL, so by now the server has stopped broadcasting them too.
await sleep(32000);
const atOffline = await listedUnits(pd.page);
await shot(pd.page, '12-offline');
const offline = atOffline.filter(
  (r) => /offline/i.test(r.tracking) && liveBefore.includes(r.callsign),
);
check(
  offline.length > 0,
  `none of the units that went quiet was marked offline after 56s `
  + `(levels: ${liveBefore.map((c) => `${c}=${levelOf(atOffline, c)}`).join(', ')})`,
  `${offline.length} unit(s) that went quiet are now offline: `
  + `${offline.map((r) => r.callsign).join(', ')}`,
);
check(
  liveBefore.every((c) => levelOf(atOffline, c) !== '(gone)'),
  `going offline removed ${liveBefore.filter((c) => levelOf(atOffline, c) === '(gone)').join(', ')} `
  + 'from the board — historical unit data must not be deleted',
  'every unit that went quiet is still on the board, with its history intact',
);
check(
  atOffline.length === beforeQuiet.length,
  `the list dropped from ${beforeQuiet.length} to ${atOffline.length} unit(s) — going `
  + 'offline deleted units instead of marking them',
  `all ${atOffline.length} unit(s) stayed on the board after going offline`,
);

// An offline unit's last known position must still be readable. "We do not know
// where this unit is" and "this unit never existed" are different facts.
if (offline[0]) {
  await safeClick(
    pd.page.getByRole('button').filter({ hasText: new RegExp(`^${offline[0].callsign}`) }).first(),
    `the ${offline[0].callsign} row`,
  );
  await pd.page.waitForTimeout(600);
  const detail = await pd.page.evaluate(() => document.body.innerText);
  check(
    /Offline/.test(detail) && /Position/.test(detail) && /Last update/.test(detail),
    `the detail panel for offline unit ${offline[0].callsign} shows no last known position`,
    `offline unit ${offline[0].callsign} still shows its last known position and when it was seen`,
  );
  await shot(pd.page, '13-offline-detail');
}

// ════════════════════════════════════════════════════════════════════════════
// 5 · FILTERING
// ════════════════════════════════════════════════════════════════════════════

{
  // Tracking · Offline — the filter the brief names that no status can express.
  const offlineChip = chipNamed(pd.page, 'Offline');
  if (check(
    await offlineChip.count() > 0,
    'no Offline tracking filter on the map',
    'the map offers a tracking filter for offline units',
  ) && await safeClick(offlineChip, 'the Offline tracking chip')) {
    await pd.page.waitForTimeout(800);
    const filtered = await listedUnits(pd.page);
    await shot(pd.page, '14-filter-offline');
    check(
      filtered.length > 0 && filtered.every((r) => /offline/i.test(r.tracking)),
      `filtering to Offline left ${filtered.length} row(s), `
      + `including: ${filtered.filter((r) => !/offline/i.test(r.tracking)).map((r) => r.callsign).join(', ')}`,
      `filtering to Offline left exactly the ${filtered.length} offline unit(s)`,
    );
    await safeClick(offlineChip, 'the Offline tracking chip (clearing)');
    await pd.page.waitForTimeout(500);
  }

  // Organization.
  const snap = await snapshotFor(pd.page);
  const orgs = [...new Set(snap.units?.map((u) => u.organization.shortName) ?? [])];
  const chip = orgs[0] ? chipNamed(pd.page, orgs[0]) : null;
  if (chip && await safeClick(chip, `the ${orgs[0]} filter chip`)) {
    await pd.page.waitForTimeout(800);
    const filtered = await listedUnits(pd.page);
    const expected = snap.units.filter(
      (u) => u.organization.shortName === orgs[0] && u.status.isOnDuty,
    ).length;
    await shot(pd.page, '15-filter-org');
    check(
      filtered.length === expected,
      `filtering to ${orgs[0]} left ${filtered.length} row(s); the payload holds ${expected}`,
      `filtering to ${orgs[0]} left exactly its ${filtered.length} on-duty unit(s)`,
    );
    await safeClick(chip, `the ${orgs[0]} filter chip (clearing)`);
    await pd.page.waitForTimeout(400);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · AREAS AND ROUTES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Drawing a cordon, end to end, through the real tool.
 *
 * The two questions worth a browser rather than a unit test: does the modal
 * drawing tool actually place points where they are clicked, and does the shape
 * stay inside the organization that drew it once it is in a live payload.
 */
{
  const areaButton = pd.page.getByRole('button', { name: 'Draw an area' });
  if (check(
    await areaButton.count() > 0,
    'the map offers no way to draw an area to a caller who can manage markers',
    'the map offers a drawing tool to a caller who can manage markers',
  ) && await safeClick(areaButton, 'the draw-an-area control')) {
    const canvas = pd.page.locator('canvas').first();
    const box = await canvas.boundingBox();

    // Four clicks, in the canvas's own coordinates. Deliberately a real cordon
    // shape rather than four points in a line, so a wrongly paired geometry
    // would produce a visibly different figure.
    const corners = [
      { dx: 0.35, dy: 0.35 }, { dx: 0.55, dy: 0.35 },
      { dx: 0.55, dy: 0.55 }, { dx: 0.35, dy: 0.55 },
    ];
    for (const corner of corners) {
      await pd.page.mouse.click(
        box.x + box.width * corner.dx,
        box.y + box.height * corner.dy,
      );
      await pd.page.waitForTimeout(120);
    }

    const toolbar = await pd.page.evaluate(() => document.body.innerText);
    check(
      /4 points/.test(toolbar),
      `after four clicks the drawing toolbar reads: ${
        (toolbar.match(/\d+ points?/) ?? ['nothing'])[0]}`,
      'four clicks on the canvas placed exactly four points',
    );
    await shot(pd.page, '16-drawing');

    const label = `Walkthrough cordon ${Date.now().toString(36).slice(-4)}`;
    if (await safeClick(pd.page.getByRole('button', { name: 'Finish' }), 'Finish')) {
      await pd.page.fill('#shape-label', label);
      await shot(pd.page, '17-shape-dialog');
      await safeClick(pd.page.getByRole('button', { name: /Save area/ }), 'Save area');
      await pd.page.waitForTimeout(1200);

      const afterDraw = await snapshotFor(pd.page);
      const drawn = (afterDraw.shapes ?? []).find((sh) => sh.label === label);
      check(
        drawn !== undefined && drawn.points.length === 4 && drawn.kind === 'area',
        `the drawn cordon did not come back as a four-point area: ${JSON.stringify(drawn)}`,
        'the drawn cordon came back from the server as a four-point area',
      );
      await shot(pd.page, '18-shape-drawn');

      /**
       * THE ONE THAT MATTERS: another organization does not receive it.
       *
       * Checked against the RAW payload the MD browser got, not against what
       * its screen shows — the client-side filter is a view filter, and a shape
       * that reached the browser at all has already leaked.
       */
      const md2 = await session(MD_USER, 'MD-shapes');
      await openMap(md2.page);
      await md2.page.waitForTimeout(800);
      const mdPayload = await md2.page.evaluate(async () => {
        const res = await fetch('/api/map/snapshot', { cache: 'no-store' });
        return res.ok ? res.text() : `error ${res.status}`;
      });
      check(
        !mdPayload.includes(label) && (drawn === undefined || !mdPayload.includes(drawn.id)),
        `a PD cordon reached an MD browser's map payload`,
        'a PD cordon is absent from an MD browser\'s map payload, not merely hidden in it',
      );
      await shot(md2.page, '19-shape-other-org');
      await md2.ctx.close();

      // And the filter chip counts it, so the operator can turn the layer off.
      const shapeChip = chipNamed(pd.page, 'Areas & routes');
      check(
        await shapeChip.count() > 0,
        'the map offers no way to hide the areas-and-routes layer',
        'the map offers an areas-and-routes filter chip',
      );
    }
  }
}

game.tell('stop');
await game.done;
await pd.ctx.close();
await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────

report();
process.exit(problems.length === 0 ? 0 : 1);
