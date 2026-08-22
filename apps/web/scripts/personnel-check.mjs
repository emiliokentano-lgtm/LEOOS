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

  /**
   * Find the fixture rows by SEARCHING for them, not by assuming page one.
   *
   * The roster is paged at 50 by design and the shared test database keeps its
   * memberships on purpose, so PD has accumulated more than a thousand. This
   * walkthrough used to reach straight for `Tomas Brandt` in `tbody` and started
   * failing once the roster outgrew a page — which was the walkthrough being
   * wrong about the product, not the product being wrong.
   *
   * Searching is also what an operator does with a roster that size, so this
   * exercises the debounced filter at the same time.
   */
  const findRow = async (name) => {
    const box = page.locator('input[placeholder*="callsign" i], input[placeholder*="Search" i]').first();
    await box.fill(name);
    await page.waitForTimeout(700);
    const row = page.locator('tbody tr', { hasText: name });
    await row.first().waitFor({ state: 'visible', timeout: 10000 });
    return row.first();
  };

  // The Chief outranks the Commander, so that row must be locked.
  const chiefRow = await findRow('Marcus Vale');
  const chiefLocked = await chiefRow.locator('text=Locked').count();
  if (chiefLocked === 0) problems.push('Chief row is NOT locked for the Commander');

  // And so must their own row.
  const selfRow = await findRow('Renata Ochoa');
  if (await selfRow.locator('text=Locked').count() === 0) {
    problems.push('Commander\'s own row is NOT locked');
  }

  // An Officer is below them and must offer a menu.
  const offRow = await findRow('Tomas Brandt');
  const manageBtn = offRow.locator('button', { hasText: 'Manage' });
  if (await manageBtn.count() === 0) problems.push('no Manage menu on an Officer row');
  else {
    await manageBtn.click();
    await page.waitForTimeout(250);
    await shot(page, '02-manage-menu');
    await page.locator('[role="menuitem"]', { hasText: 'Change rank' }).click();
    await page.waitForTimeout(400);
    await shot(page, '03-change-rank');

    /**
     * The rank picker must disable everything at or above the actor's own level.
     *
     * This step used to count `select#rank-role option:disabled` with a
     * `.catch(() => 0)` around it. The picker is a Radix listbox, not a native
     * `<select>`, and its options do not exist in the DOM until it is OPENED —
     * so the count was always 0, the `.catch` swallowed the failure, and the
     * step could not fail. A check that cannot fail is worse than no check,
     * because it reads as coverage.
     *
     * Opened for real, and asserted: a Commander at L80 must see the Chief rank
     * offered-but-disabled rather than either missing or selectable. Missing
     * would hide the ceiling; selectable would invite a request the server will
     * refuse. (The server refusing it regardless is covered by the authz suite —
     * this is about the screen telling the truth.)
     */
    await page.locator('#rank-role').click();
    await page.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 5000 });
    const total = await page.locator('[role="option"]').count();
    const disabled = await page.locator('[role="option"][data-disabled]').count();
    console.log(`rank options: ${total}, disabled: ${disabled}`);
    if (total === 0) problems.push('rank picker offered no options at all');
    if (disabled === 0) problems.push('rank picker disabled nothing — no ceiling shown at L80');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await closeDialog(page);
  }

  // Profile drawer.
  await offRow.locator('td').first().click();
  await page.waitForTimeout(700);
  await shot(page, '04-profile-drawer');
  const drawerText = await page.locator('[role="dialog"]').innerText().catch(() => '');
  if (!drawerText.includes('Tomas Brandt')) problems.push('drawer did not load the profile');
  if (!/Activity/i.test(drawerText)) problems.push('drawer has no activity section');

  /**
   * Permission exceptions — the round trip, on screen.
   *
   * An override is the one place authority is handed to a PERSON rather than to
   * a rank, so the screen has two jobs: let somebody entitled write one, and
   * make the ones that exist impossible to miss. Both are checked here, and the
   * exception is removed again so the walkthrough leaves the fixture as it
   * found it.
   */
  const drawer = page.locator('[role="dialog"]');
  if (!/Permission exceptions/i.test(drawerText)) {
    problems.push('drawer has no permission-exceptions section');
  } else {
    await drawer.locator('button', { hasText: 'Add' }).first().click();
    await page.waitForTimeout(300);

    // The picker must offer only what the Commander may actually hand out.
    await drawer.locator('#override-permission').click();
    await page.locator('[role="option"]').first().waitFor({ state: 'visible', timeout: 5000 });
    const offered = await page.locator('[role="option"]').allTextContents();
    console.log(`override permissions offered: ${offered.length}`);
    if (offered.length === 0) problems.push('override picker offered nothing at all');
    if (offered.some((label) => /manage user accounts|view audit logs|impersonate/i.test(label))) {
      problems.push('override picker offered a GLOBAL-scope permission');
    }
    /**
     * Remember WHICH permission was chosen.
     *
     * The step used to save one exception and then remove `.first()`, which is
     * the same row only while the list has exactly one entry. A previous failing
     * run left a row behind, the picker then offered a different permission
     * (it excludes what is already held), and `.first()` removed the leftover
     * while the new one stayed — reported as "the exception survived being
     * removed", which was the walkthrough's own bookkeeping rather than a
     * product fault. Addressed by name from here on.
     */
    const chosenLabel = (offered[0] ?? '').trim();
    await page.locator('[role="option"]').first().click();
    await page.waitForTimeout(200);

    await drawer.locator('#override-reason').fill('walkthrough check, removed immediately');
    await shot(page, '04b-override-form');
    await drawer.locator('button', { hasText: 'Save exception' }).click();
    await page.waitForTimeout(1200);

    /**
     * Scoped to the exceptions SECTION, not to the whole drawer.
     *
     * The reason also lands in the activity timeline below — correctly, because
     * the audit trail records why the exception was written. Searching the whole
     * drawer therefore finds the reason after the exception has been removed,
     * and the first version of this check failed for exactly that reason: it was
     * reading the audit trail and calling it the exception list.
     */
    const section = drawer.locator('[data-section="overrides"]');
    const afterSave = await section.innerText().catch(() => '');
    if (!/walkthrough check, removed immediately/.test(afterSave)) {
      problems.push('the saved exception did not appear on the profile');
    }
    if (!/Granted|Denied/.test(afterSave)) {
      problems.push('the exception does not say whether it grants or denies');
    }
    await shot(page, '04c-override-listed');

    const row = section.locator('li', { hasText: chosenLabel });
    await row.locator('button', { hasText: 'Remove' }).first().click();
    await page.waitForTimeout(1500);
    const afterRemove = await section.innerText().catch(() => '');
    if (/walkthrough check, removed immediately/.test(afterRemove)) {
      problems.push(`the exception for "${chosenLabel}" survived being removed`);
    }

    // And the audit trail keeps BOTH events — the record outlives the exception.
    const trail = await drawer.innerText().catch(() => '');
    if (!/Permission exception set/.test(trail)) {
      problems.push('the audit trail does not show the exception being set');
    }
    if (!/Permission exception removed/.test(trail)) {
      problems.push('the audit trail does not show the exception being removed');
    }
  }
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
