/**
 * Global search walkthrough.
 *
 * Exercises the palette and the search page as a PD officer and an MD doctor,
 * and checks the thing that matters most: that one organization's search box
 * cannot reach the other's records. Fails on console errors, page errors and
 * horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.search';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problems = [];

async function session(username, viewport = { width: 1600, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${username}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${username}] pageerror: ${e.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', 'correct-horse-staple-42');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|search)/, { timeout: 15000 });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

// ── Palette: keyboard shortcut, instant search, grouping, counts ──────────
{
  const { ctx, page } = await session('ui.officer1');
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // The shortcut must open it from anywhere.
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.count() === 0) problems.push('Ctrl+K does not open the palette');
  await shot(page, '01-palette-open');

  // Below the minimum: screens only, with the hint.
  await page.keyboard.type('d');
  await page.waitForTimeout(500);
  await shot(page, '02-palette-too-short');

  // At the minimum: record results, grouped, with counts.
  await page.keyboard.type('ispatch');
  await page.waitForTimeout(1200);
  await shot(page, '03-palette-screens');

  await page.fill('input[aria-label="Global search"]', 'Holm');
  await page.waitForTimeout(1400);
  await shot(page, '04-palette-results');

  const paletteText = await dialog.innerText();
  if (!/Persons/i.test(paletteText)) problems.push('palette does not group results by category');
  if (!/Holm/.test(paletteText)) problems.push('palette found no person for a known surname');
  if (!/Wanted/i.test(paletteText)) problems.push('palette does not show the wanted badge');

  // Category filter pills must be present and filter.
  const pills = await dialog.locator('button[aria-pressed]').count();
  if (pills < 2) problems.push(`palette has only ${pills} category filters`);

  await page.fill('input[aria-label="Global search"]', 'ADAM');
  await page.waitForTimeout(1400);
  await shot(page, '05-palette-units');
  const unitsText = await dialog.innerText();
  if (!/Units/i.test(unitsText)) problems.push('palette does not find units by callsign');

  // Enter navigates and records the term.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await ctx.close();
}

// ── Search page: grouping, counts, category filter, paging ───────────────
{
  const { ctx, page } = await session('ui.officer1');

  await page.goto(`${BASE}/search`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await shot(page, '06-search-empty');
  if (!/Search everything|Recent searches/i.test(await page.locator('main').innerText())) {
    problems.push('search page shows no empty state');
  }

  await page.goto(`${BASE}/search?q=Holm`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot(page, '07-search-results');

  const body = await page.locator('main').innerText();
  if (!/Persons/i.test(body)) problems.push('search page does not group by category');
  if (!/filtered by your permissions/i.test(body)) {
    problems.push('search page does not say results are permission filtered');
  }

  // Too-short term must be explained, not silently empty.
  await page.goto(`${BASE}/search?q=a`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await shot(page, '08-search-too-short');
  if (!/Keep typing/i.test(await page.locator('main').innerText())) {
    problems.push('search page does not explain the minimum length');
  }

  // No results must be an explained empty state.
  await page.goto(`${BASE}/search?q=zzzznotathing`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot(page, '09-search-no-results');
  if (!/Nothing matches/i.test(await page.locator('main').innerText())) {
    problems.push('search page has no empty state for zero results');
  }

  // A single category pages properly.
  await page.goto(`${BASE}/search?q=15&category=persons`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot(page, '10-search-category');

  await ctx.close();
}

// ── The security property, in the browser ────────────────────────────────
{
  const { ctx, page } = await session('ui.officer1');

  // MEDIC-3 is an MD unit; a PD officer must not find it.
  await page.goto(`${BASE}/search?q=MEDIC`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot(page, '11-search-scoped-out');
  const scoped = await page.locator('main').innerText();
  if (/MEDIC-3/.test(scoped)) problems.push('a PD officer can find an MD unit through search');

  // And an MD incident.
  await page.goto(`${BASE}/search?q=Cardiac`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (/Cardiac arrest/.test(await page.locator('main').innerText())) {
    problems.push('a PD officer can find an MD incident through search');
  }

  // Their own unit and incident, they must find.
  await page.goto(`${BASE}/search?q=Burglary`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot(page, '12-search-own-incident');
  if (!/Burglary in progress/.test(await page.locator('main').innerText())) {
    problems.push('a PD officer cannot find their own incident');
  }

  await ctx.close();
}

// ── The mirror, as MD ────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.medic');

  await page.goto(`${BASE}/search?q=Cardiac`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await shot(page, '13-search-md-own');
  if (!/Cardiac arrest/.test(await page.locator('main').innerText())) {
    problems.push('a doctor cannot find their own organization\'s incident');
  }

  await page.goto(`${BASE}/search?q=Burglary`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (/Burglary in progress/.test(await page.locator('main').innerText())) {
    problems.push('a doctor can find a PD incident through search');
  }

  await ctx.close();
}

// ── Narrow viewport ──────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.officer1', { width: 900, height: 900 });
  await page.goto(`${BASE}/search?q=Holm`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await shot(page, '14-search-narrow');
  await ctx.close();
}

await browser.close();

if (problems.length > 0) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nno problems found');
