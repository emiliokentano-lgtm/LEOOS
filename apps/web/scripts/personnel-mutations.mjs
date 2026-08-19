/**
 * Drives the personnel mutations through the real UI and checks the effect.
 *
 * The API tests prove the rules; this proves the screen is wired to them — that
 * the forms submit what they claim to and that a refusal reaches the operator
 * instead of vanishing.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.pmut';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problems = [];

async function signIn(username) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', 'correct-horse-staple-42');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|personnel)/, { timeout: 15000 });
  return { ctx, page };
}

async function chooseOption(page, triggerId, labelPattern) {
  await page.click(`#${triggerId}`);
  await page.waitForTimeout(300);
  const option = page.locator('[role="option"]', { hasText: labelPattern }).first();
  await option.click();
  await page.waitForTimeout(300);
}

async function openMenu(page, name, item) {
  const row = page.locator('tbody tr', { hasText: name });
  await row.locator('button', { hasText: 'Manage' }).click();
  await page.waitForTimeout(300);
  await page.locator('[role="menuitem"]', { hasText: item }).click();
  await page.waitForTimeout(600);
}

const { ctx, page } = await signIn('ui.commander');
await page.goto(`${BASE}/personnel`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// ── 1. Promote a Cadet to Officer ─────────────────────────────────────────
await openMenu(page, 'Hiro Tanaka', 'Change rank');
await chooseOption(page, 'rank-role', /^Officer/);
await page.screenshot({ path: `${OUT}/10-rank-chosen.png` });
const promoteBanner = await page.locator('[role="dialog"]').innerText();
if (!/promotion/i.test(promoteBanner)) problems.push('rank dialog did not label the direction');
await page.fill('#rank-reason', 'Completed field training.');
await page.locator('[role="dialog"] button', { hasText: 'Change rank' }).click();
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/11-after-promote.png` });

const tanaka = await page.locator('tbody tr', { hasText: 'Hiro Tanaka' }).innerText();
if (!/Officer/.test(tanaka)) problems.push(`promotion did not take: ${tanaka.replace(/\n/g, ' | ')}`);

// ── 2. A rank at or above the actor's own must be unavailable ─────────────
await openMenu(page, 'Lena Fischer', 'Change rank');
await page.click('#rank-role');
await page.waitForTimeout(400);
const options = page.locator('[role="option"]');
const total = await options.count();
let enabledAtOrAbove = 0;
for (let i = 0; i < total; i += 1) {
  const text = await options.nth(i).innerText();
  const level = Number(/L(\d+)/.exec(text)?.[1] ?? '0');
  const disabled = await options.nth(i).getAttribute('data-disabled');
  if (level >= 80 && disabled === null) enabledAtOrAbove += 1;
}
await page.screenshot({ path: `${OUT}/12-rank-ceiling.png` });
if (enabledAtOrAbove > 0) {
  problems.push(`${enabledAtOrAbove} rank(s) at or above L80 are selectable by an L80 actor`);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.locator('[role="dialog"] button', { hasText: /^Cancel$/ }).click();
await page.waitForTimeout(400);

// ── 3. Set a callsign ─────────────────────────────────────────────────────
const callsign = `Z-${Math.floor(Math.random() * 900 + 100)}`;
await openMenu(page, 'Lena Fischer', 'Edit details');
await page.fill('#edit-callsign', callsign);
await page.locator('[role="dialog"] button', { hasText: 'Save changes' }).click();
await page.waitForTimeout(1800);
const fischer = await page.locator('tbody tr', { hasText: 'Lena Fischer' }).innerText();
if (!fischer.includes(callsign)) problems.push(`callsign not applied: ${fischer.replace(/\n/g, ' | ')}`);
await page.screenshot({ path: `${OUT}/13-after-callsign.png` });

// ── 4. A refused action must surface, not vanish ──────────────────────────
// Reuse the callsign just taken — the API answers 409 and the dialog must say so.
await openMenu(page, 'Yusuf Demir', 'Edit details');
await page.fill('#edit-callsign', callsign);
await page.locator('[role="dialog"] button', { hasText: 'Save changes' }).click();
await page.waitForTimeout(1800);
const dialogText = await page.locator('[role="dialog"]').innerText().catch(() => '');
if (!/in use/i.test(dialogText)) {
  problems.push(`duplicate callsign refusal not shown to the operator: ${dialogText.slice(0, 200)}`);
}
// A refusal must not discard what was typed — otherwise the operator has to
// start the form again to fix a one-character mistake.
const kept = await page.inputValue('#edit-callsign');
if (kept !== callsign) problems.push(`refused save discarded the typed callsign (kept "${kept}")`);
await page.screenshot({ path: `${OUT}/14-refusal.png` });
await page.locator('[role="dialog"] button', { hasText: /^Cancel$/ }).click();
await page.waitForTimeout(400);

// ── 5. Terminate, with the typed confirmation ─────────────────────────────
await openMenu(page, 'Nora Lindqvist', 'Terminate');
const confirmDisabled = await page.locator('[role="dialog"] button', { hasText: 'Terminate membership' }).isDisabled();
if (!confirmDisabled) problems.push('terminate is confirmable without typing the name');
await page.fill('#terminate-reason', 'Resigned, effective today.');
await page.fill('#terminate-confirm', 'Nora Lindqvist');
await page.screenshot({ path: `${OUT}/15-terminate.png` });
await page.locator('[role="dialog"] button', { hasText: 'Terminate membership' }).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/16-after-terminate.png` });

if (await page.locator('tbody tr', { hasText: 'Nora Lindqvist' }).count() > 0) {
  problems.push('terminated member still on the active roster');
}
// Searched by name: the roster is paged, and this database holds many retired
// records from earlier runs.
await page.goto(`${BASE}/personnel?status=terminated&search=Lindqvist`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
if (await page.locator('tbody tr', { hasText: 'Nora Lindqvist' }).count() === 0) {
  problems.push('terminated member is NOT retained under the terminated filter');
}
await page.screenshot({ path: `${OUT}/17-terminated-list.png` });

// ── 6. The audit trail must show the changes ──────────────────────────────
await page.goto(`${BASE}/personnel`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('tbody tr', { hasText: 'Hiro Tanaka' }).locator('td').first().click();
await page.waitForTimeout(1200);
const drawer = await page.locator('[role="dialog"]').innerText().catch(() => '');
if (!/Promoted/i.test(drawer)) problems.push('promotion missing from the activity trail');
await page.screenshot({ path: `${OUT}/18-activity.png` });

await ctx.close();
await browser.close();

if (problems.length > 0) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nall mutations verified through the UI');
