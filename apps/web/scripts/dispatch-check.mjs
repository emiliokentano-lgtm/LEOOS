/**
 * Dispatch walkthrough.
 *
 * Drives a full shift as two operators: a sergeant who runs the board, and an
 * officer who goes on duty, crews a unit and raises a panic. The point is the
 * property that makes dispatch dispatch — that one operator's action shows up on
 * the other operator's screen, because it is server state rather than local UI.
 *
 * Fails on console errors, page errors and horizontal body overflow.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3010';
const OUT = process.argv[2] ?? '.dispatch';
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

/** Reads the board the browser itself receives. */
async function boardFor(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/dispatch/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: null }),
      cache: 'no-store',
    });
    if (!res.ok) return { error: res.status };
    return res.json();
  });
}

// ── Dispatcher opens the board ─────────────────────────────────────────────
const sgt = await session('ui.sergeant');
await sgt.page.goto(`${BASE}/dispatch`, { waitUntil: 'domcontentloaded' });
await sgt.page.waitForSelector('text=Call queue', { timeout: 15000 });
await sgt.page.waitForTimeout(1500);
await shot(sgt.page, '01-board');

{
  const b = await boardFor(sgt.page);
  if (b.error) problems.push(`sergeant could not load the board: ${b.error}`);
  else {
    notes.push(`sergeant: ${b.incidents.length} incidents, ${b.units.length} units`);
    notes.push(`counts: ${JSON.stringify(b.counts)}`);
    notes.push(`self: status=${b.self.statusKey} unit=${b.self.unitCallsign ?? 'none'}`);
    notes.push(`statuses: ${b.statuses.map((s) => s.key).join(', ')}`);
  }
}

// ── Create a call ──────────────────────────────────────────────────────────
const newCall = sgt.page.getByRole('button', { name: /new call/i });
if (await newCall.count()) {
  await newCall.first().click();
  await sgt.page.waitForTimeout(400);
  await sgt.page.fill('#incident-title', 'Walkthrough — structure fire');
  await shot(sgt.page, '02-new-call');
  await sgt.page.getByRole('button', { name: /^create call$/i }).click();
  await sgt.page.waitForTimeout(1800);
  await shot(sgt.page, '03-created');
} else {
  problems.push('no "New call" control for a sergeant');
}

// ── Select it and work it ──────────────────────────────────────────────────
const row = sgt.page.getByRole('button').filter({ hasText: 'Walkthrough — structure fire' }).first();
if (await row.count()) {
  await row.click();
  await sgt.page.waitForTimeout(1200);
  await shot(sgt.page, '04-selected');

  // Timeline must exist from creation.
  const timelineText = await sgt.page.locator('text=Timeline').count();
  if (timelineText === 0) problems.push('no timeline section on the incident detail');

  // Assign a unit.
  const dispatchBtn = sgt.page.getByRole('button', { name: /^dispatch$/i });
  if (await dispatchBtn.count()) {
    const select = sgt.page.locator('button[role="combobox"]').last();
    await select.click();
    await sgt.page.waitForTimeout(300);
    const option = sgt.page.locator('[role="option"]').first();
    if (await option.count()) {
      await option.click();
      await sgt.page.waitForTimeout(300);
      await dispatchBtn.first().click();
      await sgt.page.waitForTimeout(1800);
      await shot(sgt.page, '05-assigned');
    } else {
      notes.push('WARN: no assignable unit in the picker');
      await sgt.page.keyboard.press('Escape');
    }
  } else {
    problems.push('no Dispatch control on the incident detail');
  }

  // Add a note.
  const noteInput = sgt.page.getByPlaceholder(/add a note/i);
  if (await noteInput.count()) {
    await noteInput.fill('Walkthrough note: crews on scene.');
    await noteInput.press('Enter');
    await sgt.page.waitForTimeout(1500);
    await shot(sgt.page, '06-note');
  } else {
    problems.push('no note input on the incident detail');
  }
} else {
  problems.push('the created call did not appear in the queue');
}

// ── An officer goes on duty and raises a panic ─────────────────────────────
const off = await session('ui.officer1');
await off.page.goto(`${BASE}/dispatch`, { waitUntil: 'domcontentloaded' });
await off.page.waitForSelector('text=Your status', { timeout: 15000 });
await off.page.waitForTimeout(1200);
await shot(off.page, '07-officer');

// Set a status.
const busy = off.page.getByRole('button', { name: /^busy$/i });
if (await busy.count()) {
  await busy.first().click();
  await off.page.waitForTimeout(1500);
  const b = await boardFor(off.page);
  if (!b.error && b.self.statusKey !== 'busy') {
    problems.push(`status did not persist: expected busy, got ${b.self.statusKey}`);
  } else if (!b.error) {
    notes.push('officer status change persisted server-side');
  }
} else {
  problems.push('no Busy status control');
}

let raisedPanicId = null;

// Panic — two-step, from the top bar (present on every screen).
const panicBtn = off.page.getByRole('button', { name: /^panic$/i });
const panicCount = await panicBtn.count();
notes.push(`panic controls on screen: ${panicCount} (top bar + status panel)`);
if (panicCount > 0) {
  await panicBtn.first().click();
  await off.page.waitForTimeout(400);
  await shot(off.page, '08-panic-confirm');
  const confirm = off.page.getByRole('button', { name: /raise panic|confirm panic/i });
  if (await confirm.count()) {
    await confirm.first().click();
    await off.page.waitForTimeout(2000);
    await shot(off.page, '09-panic-raised');

    const b = await boardFor(off.page);
    if (!b.error) {
      // Track the id, not the count: this database is shared with the API suite,
      // so other alerts may legitimately be live. The count would be a flake.
      raisedPanicId = b.self.ownPanicId;
      if (raisedPanicId === null) problems.push('panic did not create a server-side alert');
      else notes.push(`panic is server state: own alert ${raisedPanicId.slice(0, 8)}, self=${b.self.statusKey}`);
    }
  } else {
    problems.push('panic did not ask for confirmation');
  }
} else {
  problems.push('no Panic control');
}

// ── The dispatcher must see it without reloading ───────────────────────────
await sgt.page.waitForTimeout(6000);
await shot(sgt.page, '10-dispatcher-sees-panic');
{
  const banner = await sgt.page.locator('[role="alert"]').filter({ hasText: /panic/i }).count();
  void raisedPanicId;
  if (banner === 0) {
    problems.push('the panic did not reach the dispatcher board through the feed');
  } else {
    notes.push('panic propagated to the dispatcher without a reload');
  }

  const ack = sgt.page.getByRole('button', { name: /acknowledge/i });
  if (await ack.count()) {
    await ack.first().click();
    await sgt.page.waitForTimeout(1500);
    await shot(sgt.page, '11-acknowledged');
    const b = await boardFor(sgt.page);
    if (!b.error) {
      const stillLive = b.panics.some((p) => p.id === raisedPanicId);
      if (!stillLive) {
        problems.push('acknowledging cleared the alert — it should stay until stood down');
      } else {
        notes.push('acknowledged alert correctly stays live');
      }
    }
  } else {
    problems.push('no Acknowledge control for a dispatcher');
  }

  const standDown = sgt.page.getByRole('button', { name: /stand down/i });
  if (await standDown.count()) {
    await standDown.first().click();
    await sgt.page.waitForTimeout(1800);
    await shot(sgt.page, '12-stood-down');
    const b = await boardFor(sgt.page);
    if (!b.error && b.panics.some((p) => p.id === raisedPanicId)) {
      problems.push('stand down did not resolve the alert');
    } else {
      notes.push('stand down resolved the alert');
    }
  }
}

// ── Close the call ─────────────────────────────────────────────────────────
const closeBtn = sgt.page.getByRole('button', { name: /close this call/i });
if (await closeBtn.count()) {
  await closeBtn.first().click();
  await sgt.page.waitForTimeout(400);
  await sgt.page.getByRole('button', { name: /^close call$/i }).click();
  await sgt.page.waitForTimeout(2000);
  await shot(sgt.page, '13-closed');
  notes.push('call closed');
} else {
  notes.push('WARN: no close control (call may not have been selected)');
}

await off.ctx.close();
await sgt.ctx.close();
await browser.close();

writeFileSync(`${OUT}/notes.txt`, notes.join('\n'));
console.log('── notes ──');
console.log(notes.join('\n'));
if (problems.length > 0) {
  console.log('\n── PROBLEMS ──');
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('\nDispatch walkthrough clean.');
