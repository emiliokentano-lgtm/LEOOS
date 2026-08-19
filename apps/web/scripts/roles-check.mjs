/**
 * Role and permission editor walkthrough.
 *
 * Drives the screen as three different ranks and asserts both what is offered
 * and what actually happens. Fails on console errors, page errors and
 * horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.rcheck';
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
  await page.waitForURL(/\/(dashboard|roles|personnel)/, { timeout: 15000 });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

// ── Commander (L80): may create and edit, may not delete ──────────────────
{
  const { ctx, page } = await session('ui.commander');
  await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '01-roles-commander');

  const rows = await page.locator('tbody tr').count();
  console.log(`commander sees ${rows} roles`);
  if (rows < 5) problems.push(`only ${rows} roles listed`);

  // The Chief role (L100) outranks the Commander — it must be locked.
  const chiefRow = page.locator('tbody tr', { hasText: 'Chief of Police' });
  if (await chiefRow.locator('text=Locked').count() === 0) {
    problems.push('Chief role is NOT locked for an L80 Commander');
  }

  // Selecting the Chief role must open a READ ONLY editor.
  await chiefRow.locator('td').nth(1).click();
  await page.waitForTimeout(600);
  await shot(page, '02-editor-readonly');
  const readOnly = await page.locator('text=Read only').count();
  if (readOnly === 0) problems.push('editor is not read-only for a role above the actor');
  const saveButtons = await page.locator('button', { hasText: /^Save/ }).count();
  if (saveButtons > 0) problems.push('save controls offered for a role above the actor');

  // An Officer role (L30) must be editable.
  await page.locator('tbody tr', { hasText: 'Officer' }).first().locator('td').nth(1).click();
  await page.waitForTimeout(600);
  await shot(page, '03-editor-editable');
  if (await page.locator('button', { hasText: 'Save permissions' }).count() === 0) {
    problems.push('no permission save control on an editable role');
  }

  // Permissions must be grouped by category, with high-risk marked.
  const groups = await page.locator('fieldset').count();
  if (groups < 5) problems.push(`permission grid has only ${groups} categories`);
  const adminNote = await page.getByText('Global permissions belong to system administrators').count();
  if (adminNote === 0) problems.push('global-scope category is not explained');

  // A permission the Commander does not hold must be visible but disabled.
  const orgEdit = page.locator('label', { hasText: 'Edit organization' }).first();
  if (await orgEdit.count() > 0) {
    const box = orgEdit.locator('button[role="checkbox"]');
    if (await box.count() > 0 && !(await box.first().isDisabled())) {
      problems.push('a permission the actor does not hold is selectable');
    }
  } else {
    problems.push('permission the actor lacks is hidden rather than shown disabled');
  }

  // Creating a role above yourself must be flagged before submitting.
  await page.locator('button', { hasText: 'New role' }).click();
  await page.waitForTimeout(500);
  await page.fill('#new-role-name', 'Shadow Chief');
  await page.fill('#new-role-level', '95');
  await page.waitForTimeout(250);
  await shot(page, '04-create-above-self');
  if (await page.getByText('you cannot create a role at or above your own rank').count() === 0) {
    problems.push('creating above your own rank is not flagged in the UI');
  }

  // And it must actually be refused if submitted anyway.
  await page.locator('[role="dialog"] button', { hasText: 'Create role' }).click();
  await page.waitForTimeout(1800);
  const dialogText = await page.locator('[role="dialog"]').innerText().catch(() => '');
  if (!/refused|permission|rank|ROLE_LEVEL/i.test(dialogText)) {
    problems.push(`server refusal not surfaced: ${dialogText.slice(0, 160)}`);
  }
  await shot(page, '05-create-refused');
  await page.locator('[role="dialog"] button', { hasText: /^Cancel$/ }).click();
  await page.waitForTimeout(400);

  // Reorder must flag out-of-reach roles.
  await page.locator('button', { hasText: 'Reorder' }).click();
  await page.waitForTimeout(600);
  await shot(page, '06-reorder');
  const outOfReach = await page.getByText('Out of reach').count();
  if (outOfReach === 0) problems.push('reorder does not mark roles above the actor');
  await page.locator('[role="dialog"] button', { hasText: /^Cancel$/ }).click();
  await page.waitForTimeout(300);

  await ctx.close();
}

// ── Cadet (L10): view only ────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.cadet1');
  await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '07-roles-cadet');

  const newRole = page.locator('button', { hasText: 'New role' });
  if (await newRole.count() > 0 && !(await newRole.first().isDisabled())) {
    problems.push('New role is enabled for a cadet');
  }
  if (await page.locator('button', { hasText: 'Save permissions' }).count() > 0) {
    problems.push('a cadet is offered permission saving');
  }
  await ctx.close();
}

// ── Chief (L100): the top of this organization ────────────────────────────
{
  const { ctx, page } = await session('ui.chief');
  await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '08-roles-chief');

  // The Chief's own role is at their own level, so it stays out of reach.
  const own = page.locator('tbody tr', { hasText: 'Chief of Police' });
  if (await own.locator('text=Locked').count() === 0) {
    problems.push('the Chief role is not locked for the Chief themselves');
  }
  // But a Lieutenant role below them is manageable.
  const lt = page.locator('tbody tr', { hasText: 'Lieutenant' }).first();
  if (await lt.locator('button', { hasText: 'Manage' }).count() === 0) {
    problems.push('no Manage menu on a role below the Chief');
  }
  await ctx.close();
}

// ── Narrow viewport ───────────────────────────────────────────────────────
{
  const { ctx, page } = await session('ui.chief', { width: 900, height: 900 });
  await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '09-roles-narrow');
  await ctx.close();
}

await browser.close();

if (problems.length > 0) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nno problems found');
