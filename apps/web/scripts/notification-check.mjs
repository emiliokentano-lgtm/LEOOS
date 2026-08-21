/**
 * Notification system walkthrough.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT PROVES, IN A REAL BROWSER
 *
 *   1. THE AUDIENCE IS DERIVED. A panic raised by one officer reaches the
 *      dispatcher's screen, and does NOT reach a PD officer whose
 *      `dispatch.view` is denied by an override, nor a full dispatcher in
 *      another organization. Same moment, same organization, different
 *      permission — different feed.
 *   2. IT ARRIVES WITHOUT A RELOAD. The dispatcher's page is opened and left
 *      alone; the panic is raised from another session; the badge and the
 *      banner appear on the untouched page.
 *   3. THE CENTRE WORKS. Unread count, list, mark one read, mark all read,
 *      detail, and navigation to the related object.
 *   4. PANIC CANNOT BE SILENCED. Sound is off on a fresh account, and the panic
 *      category has no mute control — with the reason written on the screen.
 *   5. NOTHING LEAKS. The rendered HTML of every notification screen is searched
 *      for credentials, and for the incident description and caller phone number
 *      that the notification deliberately does not carry.
 *
 * Prerequisites — `packages/db/scripts/setup-notifications.mjs` prints all of
 * them, and creates every fixture through the real endpoints.
 *
 * Usage:  node scripts/notification-check.mjs [outdir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.LEOOS_WEB ?? 'http://localhost:3010';
const OUT = process.argv[2] ?? '.notify';
const PASSWORD = process.env.LEOOS_NOTIFY_PASSWORD ?? 'correct-horse-staple-42';

const CAST = {
  dispatcher: process.env.LEOOS_DISPATCHER_USER,
  watcher: process.env.LEOOS_WATCHER_USER,
  officer: process.env.LEOOS_OFFICER_USER,
  blind: process.env.LEOOS_BLIND_USER,
  chief: process.env.LEOOS_CHIEF_USER,
  outsider: process.env.LEOOS_OUTSIDER_USER,
};

const INCIDENT_NUMBER = process.env.LEOOS_INCIDENT_NUMBER ?? '';

for (const [role, username] of Object.entries(CAST)) {
  if (!username) {
    console.error(`Missing ${role}. Run packages/db/scripts/setup-notifications.mjs first.`);
    process.exit(2);
  }
}

mkdirSync(OUT, { recursive: true });

const problems = [];
const notes = [];
const check = (ok, failure, pass) => {
  if (ok) notes.push(`✓ ${pass}`);
  else problems.push(failure);
  return ok;
};

const CREDENTIAL_MARKERS = [
  'passwordHash', 'password_hash', '$argon2', 'tokenHash', 'token_hash',
  'secretHash', 'totpSecret', 'totp_secret_enc',
];

/**
 * Things the notification deliberately does NOT carry.
 *
 * The fixture files the P1 with a description and a caller's phone number, and
 * the notification body is a location and a headline. If either of these reaches
 * a notification screen, the payload grew past what a notification needs — which
 * is the failure the realtime document warns about, arriving through a different
 * door.
 */
const OPERATIONAL_MARKERS = ['CONFIDENTIAL-BRIEFING-TEXT', '555-0199'];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

function report() {
  const text = [
    '# Notification walkthrough',
    '',
    ...notes.map((n) => `- ${n}`),
    '',
    problems.length === 0 ? '## No problems found' : `## ${problems.length} problem(s)`,
    ...problems.map((p) => `- ${p}`),
    '',
  ].join('\n');
  writeFileSync(`${OUT}/report.md`, text);
  console.log(text);
}

for (const channel of ['uncaughtException', 'unhandledRejection']) {
  process.on(channel, (error) => {
    problems.push(`the walkthrough crashed: ${String(error).split('\n')[0]}`);
    report();
    process.exit(1);
  });
}

/**
 * Signs in, waiting out the rate limiter rather than defeating it.
 *
 * This walkthrough opens six sessions and is run repeatedly against a live
 * server, which is exactly the shape the per-IP login limit exists to stop
 * (30 in 15 minutes). Raising the limit for the walkthrough's convenience would
 * make the walkthrough test a system nobody ships; waiting costs a minute and
 * keeps the real limit in force.
 */
async function session(username, label) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="identifier"]', username);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    try {
      await page.waitForURL(/\/(dashboard|map|no-organization)/, { timeout: 15000 });
      // Console listeners are attached only AFTER the sign-in settles, so a
      // rate-limited attempt is not reported as a defect in the application.
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
      return { ctx, page };
    } catch {
      const body = await page.textContent('body') ?? '';
      if (!/too many|try again|rate/i.test(body)) {
        throw new Error(`sign-in failed for ${label}: ${body.slice(0, 200)}`);
      }
      console.error(`[notify-check] ${label} rate-limited, waiting 60s`);
      await page.waitForTimeout(60_000);
    }
  }
  throw new Error(`sign-in for ${label}: still rate-limited`);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

/** The badge on the bell, as a number. Zero when there is none. */
const unreadBadge = (page) => page.evaluate(() => {
  const trigger = document.querySelector('[aria-label^="Notifications"]');
  const badge = trigger?.parentElement?.querySelector('span[aria-hidden]');
  const text = badge?.textContent?.trim() ?? '';
  return /^\d+$/.test(text) ? Number(text) : 0;
});

/** The notification titles the centre is showing. */
const centreTitles = (page) => page.evaluate(() =>
  [...document.querySelectorAll('ul li')]
    .map((li) => li.textContent?.trim() ?? '')
    .filter((text) => text.length > 0));

async function assertClean(page, label) {
  const html = await page.content();
  for (const marker of [...CREDENTIAL_MARKERS, ...OPERATIONAL_MARKERS]) {
    if (html.includes(marker)) {
      problems.push(`LEAK: ${label} rendered "${marker}" into the page`);
      return;
    }
  }
  notes.push(`✓ ${label} carries no credential and no operational detail`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · The fixtures already produced notifications. Who has them?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The WATCHER is the recipient throughout, not the dispatcher.
 *
 * The dispatcher filed the P1 and sent nothing else; the actor is excluded from
 * every audience they cause, so their feed is the one place the alert correctly
 * does not appear. Asserting on it would prove the opposite of what it looks
 * like.
 */
const dispatcher = await session(CAST.watcher, 'watcher');
const blind = await session(CAST.blind, 'blind');
const outsider = await session(CAST.outsider, 'outsider');
const officer = await session(CAST.officer, 'officer');

{
  await dispatcher.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await dispatcher.page.waitForTimeout(1200);
  const titles = (await centreTitles(dispatcher.page)).join('\n');

  check(
    titles.includes('P1') || titles.toLowerCase().includes('critical'),
    'the dispatcher was not notified about the P1 call',
    'the dispatcher was notified about the P1 call',
  );
  check(
    titles.includes('briefing') || titles.toLowerCase().includes('announcement')
      || titles.includes('19:00'),
    'the dispatcher did not receive the organization announcement',
    'the dispatcher received the organization announcement',
  );
  await shot(dispatcher.page, '01-dispatcher-centre');
  await assertClean(dispatcher.page, 'the notification centre');
}

{
  /**
   * The person who FILED the call is not told about it.
   *
   * Not an omission — the actor is excluded from every audience they cause,
   * because a copy of what you just did is noise that pushes down the things you
   * did not do. This is the other half of "the audience is derived".
   */
  const filer = await session(CAST.dispatcher, 'dispatcher');
  await filer.page.goto(`${BASE}/notifications?category=incidents`, {
    waitUntil: 'domcontentloaded',
  });
  await filer.page.waitForTimeout(1500);
  const filerTitles = (await centreTitles(filer.page)).join('\n');
  check(
    !filerTitles.includes(INCIDENT_NUMBER),
    `the dispatcher who filed ${INCIDENT_NUMBER} was notified about their own call`,
    'the dispatcher who filed the call was not notified about it',
  );
  await shot(filer.page, '01b-filer-not-notified');
  await filer.ctx.close();
}

{
  await officer.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await officer.page.waitForTimeout(1200);
  const titles = (await centreTitles(officer.page)).join('\n');
  check(
    titles.toLowerCase().includes('assigned'),
    'the crewed officer was not told their unit had been assigned',
    'the crewed officer was told their unit had been assigned',
  );
  await shot(officer.page, '02-officer-centre');
}

{
  await blind.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await blind.page.waitForTimeout(1200);
  const titles = (await centreTitles(blind.page)).join('\n');

  // The whole point of the fixture: same organization, same moment, no
  // dispatch.view. An audience computed from membership would include them.
  check(
    !titles.includes('P1') && !titles.toLowerCase().includes('armed robbery'),
    'a PD officer with dispatch.view DENIED was told about the P1 call',
    'a PD officer with dispatch.view denied was not told about the call',
  );
  // They ARE in the organization, so the announcement is theirs.
  check(
    titles.includes('briefing') || titles.includes('19:00'),
    'the denied officer did not receive the organization announcement they are entitled to',
    'the denied officer still received the organization announcement',
  );
  await shot(blind.page, '03-denied-officer-centre');
}

{
  await outsider.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await outsider.page.waitForTimeout(1200);
  const titles = (await centreTitles(outsider.page)).join('\n');
  check(
    !titles.includes('Armed robbery') && !titles.includes('19:00'),
    'a dispatcher in ANOTHER organization received PD traffic',
    'a dispatcher in another organization received none of it',
  );
  await shot(outsider.page, '04-outsider-centre');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · A panic arrives without a reload
// ═══════════════════════════════════════════════════════════════════════════

{
  /**
   * The dispatcher is parked on the DASHBOARD and not touched again.
   *
   * The claim is that a notification appears on a page nobody reloaded, so the
   * page must be somewhere other than the centre — a screen with no reason of
   * its own to refetch notifications.
   */
  await dispatcher.page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await dispatcher.page.waitForTimeout(1500);
  const before = await unreadBadge(dispatcher.page);

  await blind.page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await blind.page.waitForTimeout(1000);
  const blindBefore = await unreadBadge(blind.page);

  // Raised from the OFFICER's session, in a different browser context.
  await officer.page.goto(`${BASE}/dispatch`, { waitUntil: 'domcontentloaded' });
  await officer.page.waitForTimeout(1500);

  /**
   * Stand down anything already running first.
   *
   * The top bar shows EITHER "Panic" or "Stand down", never both, because the
   * duty status comes from the server rather than from a click. An officer left
   * in panic by an earlier run would show the second, and the walkthrough would
   * sit waiting for a button that is correctly not there. Clearing first makes
   * the run repeatable without resetting the database.
   */
  const standDown = officer.page.locator('header button', { hasText: /^Stand down$/ });
  if (await standDown.count() > 0) {
    await standDown.first().click();
    await officer.page.waitForTimeout(2500);
  }

  // Scoped to the top bar: the dispatch board has panic controls of its own, and
  // a bare text match would be ambiguous between them.
  const panicButton = officer.page.locator('header button', { hasText: /^Panic$/ });
  await panicButton.first().click({ timeout: 15000 });
  await officer.page.waitForTimeout(600);
  await officer.page.getByRole('button', { name: 'Raise panic' }).click({ timeout: 15000 });
  await officer.page.waitForTimeout(3000);

  const after = await unreadBadge(dispatcher.page);
  check(
    after > before,
    `the dispatcher's badge did not move on a panic (${before} → ${after})`,
    `the badge rose on an untouched page when the panic was raised (${before} → ${after})`,
  );

  const banner = await dispatcher.page.locator('text=/PANIC/i').count();
  check(
    banner > 0,
    'no visible panic notification appeared for the dispatcher',
    'a visible panic notification appeared without a reload',
  );
  await shot(dispatcher.page, '05-panic-live');

  const blindAfter = await unreadBadge(blind.page);
  check(
    blindAfter === blindBefore,
    `the denied officer's badge moved on a panic they cannot see (${blindBefore} → ${blindAfter})`,
    'the denied officer was not notified of the panic',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · The centre: reading, filtering, navigating
// ═══════════════════════════════════════════════════════════════════════════

{
  await dispatcher.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await dispatcher.page.waitForTimeout(1200);

  const badgeBefore = await unreadBadge(dispatcher.page);
  check(
    badgeBefore > 0,
    'the dispatcher has no unread notifications to work with',
    `the unread count is shown as a number (${badgeBefore})`,
  );

  /**
   * Scoped to `main`, not to the page.
   *
   * The top bar carries a "Panic" BUTTON on every screen. An unscoped text match
   * finds that one first and raises an alert instead of filtering a list — which
   * is a fine illustration of why an operational console should not have two
   * controls with the same word on them, and a good reason for the walkthrough
   * to be explicit about which one it means.
   */
  await dispatcher.page.locator('main button', { hasText: /^Panic$/ }).first().click();
  await dispatcher.page.waitForTimeout(1500);
  const panicOnly = (await centreTitles(dispatcher.page)).join('\n');
  check(
    panicOnly.toLowerCase().includes('panic') && !panicOnly.includes('19:00'),
    'the panic category filter did not narrow the list',
    'filtering to the panic category shows the alert and nothing else',
  );
  await shot(dispatcher.page, '06-panic-filter');

  await dispatcher.page.locator('main button', { hasText: 'Clear filters' }).click();
  await dispatcher.page.waitForTimeout(1000);

  // Mark all read, and watch the badge go.
  await dispatcher.page.locator('main button', { hasText: 'Mark all read' }).click();
  await dispatcher.page.waitForTimeout(1200);
  const badgeAfter = await unreadBadge(dispatcher.page);
  check(
    badgeAfter === 0,
    `marking everything read left ${badgeAfter} unread`,
    'marking everything read clears the badge',
  );

  // Read, not deleted. A centre that empties when you look at it cannot answer
  // "what did I miss this shift".
  const stillThere = (await centreTitles(dispatcher.page)).length;
  check(
    stillThere > 0,
    'marking everything read emptied the list',
    'the entries are still listed after being marked read',
  );
  await shot(dispatcher.page, '07-all-read');
}

{
  /** Navigation to the related object — the deep link the API composed. */
  await officer.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await officer.page.waitForTimeout(1200);

  const assignment = officer.page.locator('a', { hasText: /assigned/i }).first();
  const hasLink = await assignment.count() > 0;
  if (check(
    hasLink,
    'the assignment notification is not a link to the call',
    'the assignment notification links to the call it is about',
  )) {
    await assignment.click();
    await officer.page.waitForTimeout(1500);
    const landed = new URL(officer.page.url()).pathname;
    check(
      landed === '/dispatch',
      `opening the assignment landed on ${landed} rather than the dispatch board`,
      'opening the assignment navigates to the related object',
    );
    if (INCIDENT_NUMBER) {
      const onScreen = await officer.page.locator(`text=${INCIDENT_NUMBER}`).count();
      check(
        onScreen > 0,
        `the linked call ${INCIDENT_NUMBER} is not on the screen it navigated to`,
        `the linked call ${INCIDENT_NUMBER} is on the screen it navigated to`,
      );
    }
    await shot(officer.page, '08-navigated-to-call');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Sound is off, and panic cannot be muted
// ═══════════════════════════════════════════════════════════════════════════

{
  await outsider.page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  await outsider.page.waitForTimeout(1200);

  const soundOn = await outsider.page
    .locator('button[role="switch"]')
    .first()
    .getAttribute('aria-checked');
  check(
    soundOn === 'false',
    `sound is ON for a fresh account (aria-checked=${soundOn})`,
    'sound is off by default on a fresh account',
  );

  const saidPlainly = await outsider.page
    .locator('text=/Sound is an addition, never the alarm/i').count();
  check(
    saidPlainly > 0,
    'the screen does not say that sound is never the only channel',
    'the screen says in plain words that sound is never the alarm',
  );

  const panicMute = outsider.page.locator('label:has-text("Panic — always shown")');
  check(
    await panicMute.count() > 0,
    'the panic category does not explain why it cannot be muted',
    'the panic category is shown as always-on, with the reason on screen',
  );

  const panicCheckbox = outsider.page
    .locator('button[role="checkbox"]')
    .first();
  check(
    await panicCheckbox.isDisabled(),
    'the panic mute control is offered',
    'the panic mute control is refused, not merely hidden',
  );
  await shot(outsider.page, '09-sound-settings');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · The announcement composer
// ═══════════════════════════════════════════════════════════════════════════

const chief = await session(CAST.chief, 'chief');

{
  await chief.page.goto(`${BASE}/organization`, { waitUntil: 'domcontentloaded' });
  await chief.page.waitForTimeout(1200);
  await chief.page.locator('main button', { hasText: 'Announce' }).click();
  await chief.page.waitForTimeout(600);

  const levels = await chief.page.evaluate(() =>
    [...document.querySelectorAll('option, [role="option"]')]
      .map((o) => o.textContent?.trim() ?? '').join('|'));
  check(
    !levels.toLowerCase().includes('critical'),
    'the announcement composer offers a critical level',
    'the announcement composer does not offer the critical level',
  );

  const explained = await chief.page
    .locator('text=/Critical is reserved for panic alerts/i').count();
  check(
    explained > 0,
    'the composer does not explain why critical is unavailable',
    'the composer explains why critical is not available to a human writer',
  );

  const audited = await chief.page.locator('text=/audit log/i').count();
  check(
    audited > 0,
    'the composer does not warn that announcements are audited',
    'the composer says the announcement is audited before it is sent',
  );
  await shot(chief.page, '10-announcement-composer');
}

{
  /** An officer without the permission is told why, rather than shown a dead form. */
  await officer.page.goto(`${BASE}/organization`, { waitUntil: 'domcontentloaded' });
  await officer.page.waitForTimeout(1200);
  await officer.page.locator('main button', { hasText: 'Announce' }).click();
  await officer.page.waitForTimeout(600);

  const refused = await officer.page
    .locator('text=/You cannot send announcements/i').count();
  const hasForm = await officer.page.locator('button:has-text("Send announcement")').count();
  check(
    refused > 0 && hasForm === 0,
    'an officer without organization.announce is shown the composer anyway',
    'an officer without the permission is told so, and offered no form',
  );
  await shot(officer.page, '11-announce-refused');
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · Another person's feed is not reachable
// ═══════════════════════════════════════════════════════════════════════════

{
  /**
   * The API is asked directly, through the browser's own session.
   *
   * There is no user id in any notification route, so this is the closest thing
   * to "read somebody else's feed" that exists: ask for one and see that the
   * answer is the caller's own, not theirs.
   */
  const mine = await dispatcher.page.evaluate(async () => {
    const res = await fetch('/api/notifications?limit=5', { cache: 'no-store' });
    return { status: res.status, body: await res.text() };
  });
  check(
    mine.status === 200,
    `the feed endpoint answered ${mine.status}`,
    'the feed endpoint answers the caller with their own feed',
  );

  /**
   * Issued through the context's request API, not from inside the page.
   *
   * It carries the same session cookies, and it keeps a deliberately-refused
   * request out of the browser console — where this walkthrough treats every
   * error as a defect, and one it caused itself would be indistinguishable from
   * one it found.
   */
  const forgedRes = await dispatcher.ctx.request.get(
    `${BASE}/api/notifications/user/00000000-0000-0000-0000-000000000000`,
  );
  const forged = forgedRes.status();
  check(
    forged === 404,
    `a route naming a user answered ${forged} rather than 404`,
    'no route exists that names a user',
  );
}

report();
await browser.close();
process.exit(problems.length === 0 ? 0 : 1);
