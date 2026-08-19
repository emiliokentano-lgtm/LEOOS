/**
 * Drives the role mutations through the real UI and checks the effect.
 *
 * The API tests prove the rules; this proves the screen is wired to them — that
 * the editor submits the set it displays, and that a refusal reaches the
 * operator instead of vanishing.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.rmut';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const problems = [];
const tag = Math.random().toString(36).slice(2, 7);

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
let page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="identifier"]', 'ui.commander');
await page.fill('input[name="password"]', 'correct-horse-staple-42');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|roles/, { timeout: 15000 });

await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// ── 1. Create a role below the actor, with permissions they hold ──────────
const roleName = `Watch Supervisor ${tag}`;
await page.locator('button', { hasText: 'New role' }).click();
await page.waitForTimeout(500);
await page.fill('#new-role-name', roleName);
await page.fill('#new-role-level', '45');
// Tick a permission a Commander holds. Scoped to the dialog: the same labels
// exist in the read-only editor panel behind it.
await page.locator('[role="dialog"] label', { hasText: 'Close incidents' }).first()
  .locator('button[role="checkbox"]').click();
await page.screenshot({ path: `${OUT}/20-create.png` });
await page.locator('[role="dialog"] button', { hasText: 'Create role' }).click();
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/21-created.png` });

const created = page.locator('tbody tr', { hasText: roleName });
if (await created.count() === 0) {
  problems.push('created role does not appear in the rank structure');
} else {
  const text = await created.first().innerText();
  if (!/45/.test(text)) problems.push(`created role is not at L45: ${text.replace(/\n/g, ' | ')}`);
  if (!/\b1\b/.test(text)) problems.push(`created role has no permission: ${text.replace(/\n/g, ' | ')}`);
}

// ── 2. Edit its permissions through the editor ────────────────────────────
await created.first().locator('td').nth(1).click();
await page.waitForTimeout(700);
await page.locator('form label', { hasText: 'Manage units' }).first()
  .locator('button[role="checkbox"]').click();
await page.waitForTimeout(200);
const unsaved = await page.getByText('unsaved').count();
if (unsaved === 0) problems.push('the editor does not mark unsaved changes');
await page.screenshot({ path: `${OUT}/22-permissions-dirty.png` });

await page.locator('button', { hasText: 'Save permissions' }).click();
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/23-permissions-saved.png` });
const saved = await page.getByText(/Permissions saved/).count();
if (saved === 0) problems.push('no confirmation after saving permissions');

// ── 3. A refused level change must surface ────────────────────────────────
await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('tbody tr', { hasText: roleName }).first().locator('td').nth(1).click();
await page.waitForTimeout(700);

const levelInput = page.locator('input[name="hierarchyLevel"]').first();
await levelInput.fill('95');
await page.waitForTimeout(250);
const warned = await page.getByText('you cannot place a role at or above your own rank').count();
if (warned === 0) problems.push('the editor does not warn before an out-of-reach level change');
await page.screenshot({ path: `${OUT}/24-level-warning.png` });

await page.locator('button', { hasText: 'Save details' }).click();
await page.waitForTimeout(2200);
const refusal = await page.getByText(/Could not save/).count();
if (refusal === 0) problems.push('the server refusal is not shown to the operator');
// And the typed value must survive the refusal.
const kept = await levelInput.inputValue();
if (kept !== '95') problems.push(`a refused save discarded the typed level (kept "${kept}")`);
await page.screenshot({ path: `${OUT}/25-level-refused.png` });

// ── 4. A legal level change applies ───────────────────────────────────────
await levelInput.fill('55');
await page.locator('button', { hasText: 'Save details' }).click();
await page.waitForTimeout(2200);
await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const moved = await page.locator('tbody tr', { hasText: roleName }).first().innerText();
if (!/55/.test(moved)) problems.push(`legal level change did not apply: ${moved.replace(/\n/g, ' | ')}`);
await page.screenshot({ path: `${OUT}/26-level-applied.png` });

// ── 5. Archive it — as the Chief ──────────────────────────────────────────
// A Commander holds roles.create/edit/permissions but NOT roles.delete: the
// seeded structure reserves removing a rank to the Chief. That the Archive item
// is absent for the Commander is the rule working, so the archive steps run as
// someone who actually holds the permission.
{
  const commanderMenu = page.locator('tbody tr', { hasText: roleName }).first();
  await commanderMenu.locator('button', { hasText: 'Manage' }).click();
  await page.waitForTimeout(400);
  if (await page.locator('[role="menuitem"]', { hasText: 'Archive role' }).count() > 0) {
    problems.push('Archive offered to a Commander, who does not hold roles.delete');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

// A fresh context rather than clearing cookies: the session cookie is HttpOnly,
// so a page script cannot remove it — which is exactly the point of the flag.
await ctx.close();
const chiefCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
page = await chiefCtx.newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="identifier"]', 'ui.chief');
await page.fill('input[name="password"]', 'correct-horse-staple-42');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|roles/, { timeout: 15000 });
await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const row = page.locator('tbody tr', { hasText: roleName }).first();
await row.locator('button', { hasText: 'Manage' }).click();
await page.waitForTimeout(400);
await page.locator('[role="menuitem"]', { hasText: 'Archive role' }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/27-archive.png` });

const confirmDisabled = await page.locator('[role="dialog"] button', { hasText: 'Archive role' }).isDisabled();
if (!confirmDisabled) problems.push('archive is confirmable without a reason');
await page.fill('#archive-reason', 'Folded into Sergeant.');
await page.locator('[role="dialog"] button', { hasText: 'Archive role' }).click();
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/28-archived.png` });

if (await page.locator('tbody tr', { hasText: roleName }).count() > 0) {
  problems.push('archived role still in the live rank structure');
}

// ── 6. It is retained, not deleted ────────────────────────────────────────
await page.goto(`${BASE}/roles?archived=true`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
if (await page.locator('tbody tr', { hasText: roleName }).count() === 0) {
  problems.push('archived role is NOT retained under the archived view');
}
await page.screenshot({ path: `${OUT}/29-archived-list.png` });

// ── 7. Restore it ─────────────────────────────────────────────────────────
await page.locator('tbody tr', { hasText: roleName }).first()
  .locator('button', { hasText: 'Restore' }).click();
await page.waitForTimeout(2400);
await page.goto(`${BASE}/roles`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
if (await page.locator('tbody tr', { hasText: roleName }).count() === 0) {
  problems.push('restored role did not come back');
}
await page.screenshot({ path: `${OUT}/30-restored.png` });

await page.context().close();
await browser.close();

if (problems.length > 0) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\nall role mutations verified through the UI');
