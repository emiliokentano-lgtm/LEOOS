/**
 * Map walkthrough.
 *
 * Drives the live map as a PD officer, an MD medic and a global admin, and
 * checks the property that matters most: a covert unit belonging to another
 * organization must not be in the payload the browser receives. Not hidden by a
 * filter — absent, so that reading the page source reveals nothing.
 *
 * Fails on console errors, page errors and horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.map';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problems = [];
const notes = [];

async function session(username) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${username}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', 'correct-horse-staple-42');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|map)/, { timeout: 15000 });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

/** Reads the snapshot the browser itself receives — not the server's view of it. */
async function snapshotFor(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/map/snapshot', { cache: 'no-store' });
    if (!res.ok) return { error: res.status };
    return res.json();
  });
}

// ── PD officer ─────────────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.officer1');
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForTimeout(2500); // let a few ticks land
  await shot(page, '01-pd-map');

  const snap = await snapshotFor(page);
  if (snap.error) {
    problems.push(`PD officer could not load the map snapshot: ${snap.error}`);
  } else {
    const orgs = [...new Set(snap.units.map((u) => u.organization.key))].sort();
    notes.push(`PD officer sees ${snap.units.length} unit(s) across: ${orgs.join(', ')}`);

    const covertForeign = snap.units.filter(
      (u) => u.isCovert && u.organization.key !== 'PD',
    );
    if (covertForeign.length > 0) {
      problems.push(
        `LEAK: PD officer received ${covertForeign.length} covert unit(s) from other ` +
        `organizations: ${covertForeign.map((u) => `${u.organization.key}/${u.callsign}`).join(', ')}`,
      );
    }

    // Belt and braces: the callsigns must not appear anywhere in the payload.
    const blob = JSON.stringify(snap);
    for (const callsign of ['SIERRA-2', 'ECHO-2']) {
      if (blob.includes(callsign)) {
        problems.push(`LEAK: covert callsign ${callsign} present in the PD payload`);
      }
    }
    notes.push(`PD officer incidents: ${snap.incidents.length}, markers: ${snap.markers.length}`);
    notes.push(`PD capabilities: ${JSON.stringify(snap.capabilities)}`);
    notes.push(`source: ${snap.source.kind} — ${snap.source.detail}`);
  }

  // Click a unit in the side list and confirm the detail panel opens.
  //
  // Matched by callsign rather than by container: the account menu in the
  // sidebar also renders the signed-in officer's callsign in a monospaced span,
  // so a structural selector picks that instead and opens the account menu.
  const firstUnit = page
    .getByRole('button')
    .filter({ hasText: /^(1-ADAM|1-KILO|1-LINCOLN|AIR-|MEDIC-|TOW-)/ })
    .first();
  if (await firstUnit.count()) {
    await firstUnit.click();
    await page.waitForTimeout(400);
    await shot(page, '02-pd-unit-selected');
    const crew = await page.getByText(/no crew/i).count();
    if (crew > 0) notes.push(`WARN: ${crew} unit row(s) show "No crew"`);

    const follow = page.getByRole('button', { name: /^follow/i });
    if (await follow.count()) {
      await follow.first().click();
      await page.waitForTimeout(1200);
      await shot(page, '03-pd-following');
    } else {
      problems.push('no Follow control on the unit detail panel');
    }
  } else {
    problems.push('no units listed in the PD side panel');
  }

  // Filters.
  const mdChip = page.getByRole('button', { name: /^MD/ });
  if (await mdChip.count()) {
    await mdChip.first().click();
    await page.waitForTimeout(400);
    await shot(page, '04-pd-filtered');
  }

  await ctx.close();
}

// ── MD medic ───────────────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.medic');
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot(page, '05-md-map');

  const snap = await snapshotFor(page);
  if (snap.error) {
    problems.push(`MD medic could not load the map snapshot: ${snap.error}`);
  } else {
    const orgs = [...new Set(snap.units.map((u) => u.organization.key))].sort();
    notes.push(`MD medic sees ${snap.units.length} unit(s) across: ${orgs.join(', ')}`);
    const blob = JSON.stringify(snap);
    for (const callsign of ['SIERRA-2', 'ECHO-2']) {
      if (blob.includes(callsign)) {
        problems.push(`LEAK: covert callsign ${callsign} present in the MD payload`);
      }
    }
  }
  await ctx.close();
}

// ── PD Chief — holds map.track_all_orgs ────────────────────────────────────
//
// Not the global admin: `ui.admin` has no organization membership, so the app
// redirects them away from every organization-scoped screen. The Chief is the
// representative case anyway — an operational role that has been GRANTED the
// clearance, rather than one that bypasses the check entirely.
{
  const { ctx, page } = await session('ui.chief');
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot(page, '06-chief-map');

  const snap = await snapshotFor(page);
  if (snap.error) {
    problems.push(`chief could not load the map snapshot: ${snap.error}`);
  } else {
    const orgs = [...new Set(snap.units.map((u) => u.organization.key))].sort();
    const covert = snap.units.filter((u) => u.isCovert).map((u) => u.callsign);
    notes.push(`chief sees ${snap.units.length} unit(s) across: ${orgs.join(', ')}`);
    notes.push(`chief covert units: ${covert.join(', ') || 'none'}`);
    if (covert.length === 0) {
      problems.push(
        'a holder of map.track_all_orgs sees no covert units — either the fixture is ' +
        'missing or the permission is not being honoured',
      );
    }
    if (!snap.capabilities.canTrackAllOrganizations) {
      problems.push('the chief holds map.track_all_orgs but the API did not report it');
    }
  }

  // Zoom out to the whole world, then verify clustering appears.
  const whole = page.getByRole('button', { name: /whole map/i });
  if (await whole.count()) {
    await whole.first().click();
    await page.waitForTimeout(600);
    await shot(page, '07-chief-world');
  }

  // Right-click to place a marker.
  const canvas = page.locator('canvas').first();
  await canvas.click({ button: 'right', position: { x: 700, y: 450 } });
  await page.waitForTimeout(500);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    await shot(page, '08-chief-marker-dialog');
    await page.fill('#marker-label', 'Walkthrough marker');
    await page.getByRole('button', { name: /place marker/i }).click();
    await page.waitForTimeout(1500);
    await shot(page, '09-chief-marker-placed');
  } else {
    problems.push('right-click did not open the marker dialog for a marker manager');
  }

  await ctx.close();
}

await browser.close();

writeFileSync(`${OUT}/notes.txt`, notes.join('\n'));
console.log('── notes ──');
console.log(notes.join('\n'));
if (problems.length > 0) {
  console.log('\n── PROBLEMS ──');
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('\nMap walkthrough clean.');
