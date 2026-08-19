/**
 * Personnel walkthrough in a real browser.
 *
 * Signs in as several ranks and exercises the roster, the profile drawer and the
 * dialogs. Fails on console errors, page errors and horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.personnel-check';
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

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', 'correct-horse-staple-42');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|personnel|no-organization)/, { timeout: 15000 });
  return { ctx, page };
}

async function closeDialog(page) {
  const cancel = page.locator('[role="dialog"] button', { hasText: /^Cancel$/ }).first();
  if (await cancel.count() > 0) await cancel.click();
  else await page.keyboard.press('Escape');
  await page.locator('[aria-hidden="true"].fixed.inset-0')
    .waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

// ── Commander: a real ceiling at L80 ──────────────────────────────────────
{
  const { ctx, page } = await session('ui.commander');
  await page.goto(`${BASE}/personnel`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, '01-roster-commander');

  const rows = await page.locator('tbody tr').count();
  console.log(`commander sees ${rows} rows`);
  if (rows < 5) problems.push(`commander roster only ${rows} rows`);
  if (rows > 50) problems.push(`roster not paged: ${rows} rows in one page`);

  // The Chief outranks the Commander, so that row must be locked.
  const chiefRow = page.locator('tbody tr', { hasText: 'Marcus Vale' });
  const chiefLocked = await chiefRow.locator('text=Locked').count();
  if (chiefLocked === 0) problems.push('Chief row is NOT locked for the Commander');

  // And so must their own row.
  const selfRow = page.locator('tbody tr', { hasText: 'Renata Ochoa' });
  if (await selfRow.locator('text=Locked').count() === 0) {
    problems.push('Commander\'s own row is NOT locked');
  }

  // An Officer is below them and must offer a menu.
  const offRow = page.locator('tbody tr', { hasText: 'Tomas Brandt' });
  const manageBtn = offRow.locator('button', { hasText: 'Manage' });
  if (await manageBtn.count() === 0) problems.push('no Manage menu on an Officer row');
  else {
    await manageBtn.click();
    await page.waitForTimeout(250);
    await shot(page, '02-manage-menu');
    await page.locator('[role="menuitem"]', { hasText: 'Change rank' }).click();
    await page.waitForTimeout(400);
    await shot(page, '03-change-rank');

    // The rank picker must disable everything at or above L80.
    const disabled = await page.locator('select#rank-role option:disabled, [role="option"][data-disabled]').count()
      .catch(() => 0);
    console.log(`rank options disabled: ${disabled}`);
    await closeDialog(page);
  }

  // Profile drawer.
  await offRow.locator('td').first().click();
  await page.waitForTimeout(700);
  await shot(page, '04-profile-drawer');
  const drawerText = await page.locator('[role="dialog"]').innerText().catch(() => '');
  if (!drawerText.includes('Tomas Brandt')) problems.push('drawer did not load the profile');
  if (!/Activity/i.test(drawerText)) problems.push('drawer has no activity section');
  await closeDialog(page);

  // Hire dialog.
  const hire = page.locator('button', { hasText: 'Hire' }).first();
  if (await hire.isDisabled()) problems.push('Hire disabled for a Commander');
  else {
    await hire.click();
    await page.waitForTimeout(500);
    await shot(page, '05-hire');
    await closeDialog(page);
  }

  // Terminated filter.
  await page.goto(`${BASE}/personnel?status=all`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, '06-status-all');

  await ctx.close();
}

// ── Cadet: view only ───────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.cadet1');
  await page.goto(`${BASE}/personnel`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, '07-roster-cadet');

  const manage = await page.locator('button', { hasText: 'Manage' }).count();
  if (manage > 0) problems.push(`cadet sees ${manage} Manage menus`);
  const hireDisabled = await page.locator('button', { hasText: 'Hire' }).first().isDisabled();
  if (!hireDisabled) problems.push('Hire is enabled for a cadet');

  await ctx.close();
}

// ── Global admin: no ceiling ───────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.admin');
  await page.goto(`${BASE}/personnel`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, '08-roster-admin');
  await ctx.close();
}

// ── Narrow viewport ────────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.commander', { width: 900, height: 800 });
  await page.goto(`${BASE}/personnel`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, '09-roster-narrow');
  await ctx.close();
}

await browser.close();

if (problems.length > 0) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nno problems found');
