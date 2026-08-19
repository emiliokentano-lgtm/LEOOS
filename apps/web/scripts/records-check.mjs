/**
 * Persons and vehicles walkthrough.
 *
 * Drives both registers as a PD officer and an MD doctor — the two seeded
 * permission shapes — and asserts what each is shown. Fails on console errors,
 * page errors and horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.records';
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
  await page.waitForURL(/\/(dashboard|persons|vehicles)/, { timeout: 15000 });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

async function closeDrawer(page) {
  await page.keyboard.press('Escape');
  await page.locator('[aria-hidden="true"].fixed.inset-0')
    .waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
}

// ── PD officer: criminal yes, medical no ─────────────────────────────────
{
  const { ctx, page } = await session('ui.officer1');

  await page.goto(`${BASE}/persons`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '01-persons-officer');

  const rows = await page.locator('tbody tr').count();
  console.log(`officer sees ${rows} person rows`);
  if (rows === 0) problems.push('person register renders no rows');
  if (rows > 25) problems.push(`register not paged: ${rows} rows`);

  // Debounced search must narrow the list.
  await page.fill('input[placeholder*="Name, alias"]', 'Holm');
  await page.waitForTimeout(1200);
  await shot(page, '02-persons-search');
  const searched = await page.locator('tbody tr').count();
  if (searched === 0) problems.push('search for a known surname returns nothing');
  if (searched >= rows) problems.push('search did not narrow the register');

  // Alias search — "The Swede" is recorded against Holm.
  await page.fill('input[placeholder*="Name, alias"]', 'Swede');
  await page.waitForTimeout(1200);
  if (await page.locator('tbody tr', { hasText: 'Holm' }).count() === 0) {
    problems.push('alias search does not find the person');
  }

  // Profile: criminal present, medical withheld.
  await page.fill('input[placeholder*="Name, alias"]', 'Holm');
  await page.waitForTimeout(1200);
  await page.locator('tbody tr', { hasText: 'Holm' }).first().locator('td').first().click();
  await page.waitForTimeout(1000);
  await shot(page, '03-person-profile');

  const drawer = page.locator('[role="dialog"]');
  const drawerText = await drawer.innerText();
  if (!/Holm/.test(drawerText)) problems.push('drawer did not load the person');
  if (!/active warrant/i.test(drawerText)) problems.push('active warrant banner missing');
  if (!/armed and dangerous/i.test(drawerText)) problems.push('critical flag banner missing');

  await drawer.locator('button', { hasText: 'Criminal' }).click();
  await page.waitForTimeout(400);
  await shot(page, '04-person-criminal');
  if (!/Grand theft auto/.test(await drawer.innerText())) {
    problems.push('an officer cannot see criminal history');
  }

  await drawer.locator('button', { hasText: 'Medical' }).click();
  await page.waitForTimeout(400);
  await shot(page, '05-person-medical-withheld');
  const medicalText = await drawer.innerText();
  if (!/not available to you/i.test(medicalText)) {
    problems.push('medical section is not marked as withheld for an officer');
  }
  await closeDrawer(page);

  // Vehicles.
  await page.goto(`${BASE}/vehicles`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '06-vehicles-officer');

  await page.fill('input[placeholder*="Plate"]', 'RUSTB');
  await page.waitForTimeout(1200);
  const found = await page.locator('tbody tr', { hasText: 'RUSTBKT' }).count();
  if (found === 0) problems.push('partial plate search does not find the vehicle');

  await page.locator('tbody tr', { hasText: 'RUSTBKT' }).first().locator('td').first().click();
  await page.waitForTimeout(1000);
  await shot(page, '07-vehicle-profile');
  const vText = await page.locator('[role="dialog"]').innerText();
  if (!/owner is wanted/i.test(vText)) problems.push('wanted-owner banner missing on the vehicle');
  if (!/stolen/i.test(vText)) problems.push('vehicle flag banner missing');
  await closeDrawer(page);

  // Another organization's fleet must read as locked.
  await page.fill('input[placeholder*="Plate"]', 'EMS0302');
  await page.waitForTimeout(1200);
  await page.locator('tbody tr', { hasText: 'EMS0302' }).first().locator('td').first().click();
  await page.waitForTimeout(1000);
  await shot(page, '08-vehicle-other-fleet');
  const fleetText = await page.locator('[role="dialog"]').innerText();
  if (!/Read only/i.test(fleetText)) problems.push('another org fleet is not marked read only');
  if (await page.locator('[role="dialog"] button', { hasText: 'Edit vehicle' }).count() > 0) {
    problems.push('Edit offered on another organization\'s fleet vehicle');
  }
  await closeDrawer(page);

  await ctx.close();
}

// ── MD doctor: medical yes, criminal no ──────────────────────────────────
{
  const { ctx, page } = await session('ui.medic');

  await page.goto(`${BASE}/persons`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '09-persons-doctor');

  await page.fill('input[placeholder*="Name, alias"]', 'Reyes');
  await page.waitForTimeout(1200);
  await page.locator('tbody tr', { hasText: 'Reyes' }).first().locator('td').first().click();
  await page.waitForTimeout(1000);

  const drawer = page.locator('[role="dialog"]');
  await drawer.locator('button', { hasText: 'Medical' }).click();
  await page.waitForTimeout(400);
  await shot(page, '10-person-medical');
  const medText = await drawer.innerText();
  if (!/Penicillin/.test(medText)) problems.push('a doctor cannot see the medical record');
  if (!/this read is recorded/i.test(medText)) {
    problems.push('the medical section does not say the read is audited');
  }

  await drawer.locator('button', { hasText: 'Criminal' }).click();
  await page.waitForTimeout(400);
  await shot(page, '11-person-criminal-withheld');
  if (!/not available to you/i.test(await drawer.innerText())) {
    problems.push('criminal section is not marked as withheld for a doctor');
  }
  await closeDrawer(page);

  await ctx.close();
}

// ── Narrow viewport ──────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.officer1', { width: 900, height: 900 });
  await page.goto(`${BASE}/persons`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await shot(page, '12-persons-narrow');
  await page.goto(`${BASE}/vehicles`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await shot(page, '13-vehicles-narrow');
  await ctx.close();
}

await browser.close();

if (problems.length > 0) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nno problems found');
