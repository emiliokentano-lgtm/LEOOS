/**
 * Dashboard walkthrough.
 *
 * Checks the two things that make an operational dashboard trustworthy: that its
 * figures come from the server and AGREE with the dispatch board they link to,
 * and that it updates on its own when the situation changes.
 *
 * Also asserts the honesty property explicitly — a metric the system cannot
 * compute must be reported as unmeasured, not rendered as a zero.
 *
 * Fails on console errors, page errors and horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.dashboard';
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

async function pollFor(page, url) {
  return page.evaluate(async (endpoint) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: null }),
      cache: 'no-store',
    });
    if (!res.ok) return { error: res.status };
    return res.json();
  }, url);
}

const { ctx, page } = await session('ui.sergeant');
await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Active incidents', { timeout: 15000 });
await page.waitForTimeout(1500);
await shot(page, '01-dashboard');

// ── Figures come from the server, and agree with dispatch ──────────────────
const dash = await pollFor(page, '/api/dashboard/poll');
const disp = await pollFor(page, '/api/dispatch/poll');

if (dash.error) {
  problems.push(`dashboard poll failed: ${dash.error}`);
} else {
  notes.push(`counts: ${JSON.stringify(dash.counts)}`);
  notes.push(`statistics: ${JSON.stringify(dash.statistics)}`);
  notes.push(`alerts: ${dash.alerts.length} listed, ${dash.alertOverflow} more`);
  notes.push(`self: ${dash.self.displayName} / ${dash.self.rankName} / ${dash.self.unitCallsign ?? 'no unit'} / ${dash.self.statusKey}`);

  if (!disp.error) {
    // The whole point of composing the dashboard from the dispatch reads.
    if (dash.counts.activeIncidents !== disp.counts.openIncidents) {
      problems.push(
        `dashboard and dispatch disagree on open incidents: ${dash.counts.activeIncidents} vs ${disp.counts.openIncidents}`,
      );
    } else {
      notes.push('dashboard agrees with the dispatch board on open incidents');
    }
    if (dash.counts.unitsAvailable !== disp.counts.unitsAvailable) {
      problems.push(
        `disagreement on available units: ${dash.counts.unitsAvailable} vs ${disp.counts.unitsAvailable}`,
      );
    } else {
      notes.push('dashboard agrees with the dispatch board on available units');
    }
  }

  // Nothing may be fabricated.
  const rt = dash.statistics.responseTime;
  if (rt.available) {
    problems.push('response time is reported as available — nothing records arrival on scene');
  } else if (rt.reason !== 'not-measured') {
    problems.push(`response time unavailable for the wrong reason: ${rt.reason}`);
  } else {
    notes.push('response time correctly reported as not measured');
  }

  for (const [key, m] of Object.entries(dash.statistics)) {
    if (m && typeof m === 'object' && 'available' in m && m.available && m.sampleSize < 5) {
      problems.push(`${key} reports a value from only ${m.sampleSize} samples`);
    }
  }
}

// The unavailable metric must be visibly explained, not shown as a zero.
if (await page.getByText('Response time', { exact: false }).count() === 0) {
  problems.push('response time tile is missing');
}
if (await page.locator('text=Not measured by this system').count() === 0
  && await page.locator('text=/Arrival on scene is not recorded/').count() === 0) {
  problems.push('an unmeasured metric is not explained on screen');
} else {
  notes.push('unmeasured metric explained on screen rather than shown as zero');
}

// ── Clicking a unit status filters the units ───────────────────────────────
const availableTile = page.getByRole('button').filter({ hasText: /^Available/ }).first();
if (await availableTile.count()) {
  await availableTile.click();
  await page.waitForTimeout(500);
  await shot(page, '02-units-filtered');
  if (await availableTile.getAttribute('aria-pressed') !== 'true') {
    problems.push('clicking a unit status did not filter');
  } else {
    notes.push('unit status click filters the unit list');
  }
  await availableTile.click();
} else {
  problems.push('no clickable unit status tile');
}

// ── It updates without a refresh ───────────────────────────────────────────
const before = (await pollFor(page, '/api/dashboard/poll')).counts.activeIncidents;

const other = await session('ui.chief');
await other.page.goto(`${BASE}/dispatch`, { waitUntil: 'domcontentloaded' });
await other.page.waitForSelector('text=Call queue', { timeout: 15000 });
await other.page.getByRole('button', { name: /new call/i }).first().click();
await other.page.waitForTimeout(400);
await other.page.fill('#incident-title', 'Dashboard live-update probe');
await other.page.getByRole('button', { name: /^create call$/i }).click();
await other.page.waitForTimeout(2000);

// The dashboard must notice on its own — no reload, no interaction.
await page.waitForTimeout(9000);
await shot(page, '03-after-new-incident');
const visible = await page.locator('text=Dashboard live-update probe').count();
const after = (await pollFor(page, '/api/dashboard/poll')).counts.activeIncidents;

if (visible === 0) {
  problems.push('the dashboard did not show a new incident without a reload');
} else {
  notes.push(`live update without reload: incidents ${before} -> ${after}, new call rendered`);
}

await other.ctx.close();
await ctx.close();
await browser.close();

writeFileSync(`${OUT}/notes.txt`, notes.join('\n'));
console.log('── notes ──');
console.log(notes.join('\n'));
if (problems.length > 0) {
  console.log('\n── PROBLEMS ──');
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('\nDashboard walkthrough clean.');
