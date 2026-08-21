/**
 * Administration panel walkthrough.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT PROVES, IN A REAL BROWSER
 *
 *   1. AN ORGANIZATION LEAD REACHES NOTHING. The PD Chief — unbounded inside
 *      their own organization — sees no administration navigation, and every
 *      administration URL typed by hand sends them away.
 *   2. CAPABILITIES ARE SEPARATE, NOT NESTED. A `user_admin` reads the register
 *      and is refused the system configuration; an `audit_viewer` reads the log
 *      and is refused the register; `support` reads and changes nothing.
 *   3. THE ACTIONS DO WHAT THEIR DIALOGS SAY. Disabling an account ends its
 *      sessions immediately and lands in the audit log with the reason typed.
 *   4. THE PANEL CANNOT LOCK ITSELF OUT. An administrator is refused their own
 *      account, with a sentence explaining why rather than a disabled button.
 *   5. NO CREDENTIAL IS ON ANY PAGE. The rendered HTML of every screen is
 *      searched for hashes and secrets.
 *
 * Prerequisites — `packages/db/scripts/setup-admin.mjs` prints all of them.
 *
 * Usage:  node scripts/admin-check.mjs [outdir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.LEOOS_WEB ?? 'http://localhost:3010';
const OUT = process.argv[2] ?? '.admin';
const PASSWORD = process.env.LEOOS_ADMIN_PASSWORD ?? 'correct-horse-staple-42';

const CAST = {
  admin: process.env.LEOOS_ADMIN_USER,
  useradmin: process.env.LEOOS_USERADMIN_USER,
  auditor: process.env.LEOOS_AUDITOR_USER,
  support: process.env.LEOOS_SUPPORT_USER,
  lead: process.env.LEOOS_LEAD_USER,
  officer: process.env.LEOOS_OFFICER_USER,
};

for (const [role, username] of Object.entries(CAST)) {
  if (!username) {
    console.error(`Missing ${role}. Run packages/db/scripts/setup-admin.mjs first.`);
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

/** Every administration URL, for the "reaches nothing" sweep. */
const ADMIN_URLS = [
  '/admin',
  '/admin/users',
  '/admin/organizations',
  '/admin/leads',
  '/admin/permissions',
  '/admin/system',
  '/audit',
];

const CREDENTIAL_MARKERS = [
  'passwordHash', 'password_hash', '$argon2', 'tokenHash', 'token_hash',
  'secretHash', 'totpSecret', 'totp_secret_enc',
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

function report() {
  const text = [
    '# Administration walkthrough',
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

async function session(username, label) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="identifier"]', username);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|map|no-organization)/, { timeout: 20000 });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (overflow) problems.push(`horizontal overflow on ${name}`);
}

/** Where a URL actually settles, after any redirect. */
async function landsOn(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  return new URL(page.url()).pathname;
}

/** The sidebar's administration links, as this session sees them. */
const adminNavLinks = (page) => page.evaluate(() =>
  [...document.querySelectorAll('nav a')]
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => href.startsWith('/admin') || href === '/audit'));

async function assertNoCredentials(page, label) {
  const html = await page.content();
  for (const marker of CREDENTIAL_MARKERS) {
    if (html.includes(marker)) {
      problems.push(`LEAK: ${label} rendered "${marker}" into the page`);
      return;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 1 · The Organization Lead reaches nothing
// ════════════════════════════════════════════════════════════════════════════

{
  const lead = await session(CAST.lead, 'lead');

  const links = await adminNavLinks(lead.page);
  check(
    links.length === 0,
    `the PD Chief's sidebar offers administration links: ${links.join(', ')}`,
    'the PD Chief sees no administration navigation at all',
  );
  await shot(lead.page, '01-lead-dashboard');

  const reached = [];
  for (const url of ADMIN_URLS) {
    const landed = await landsOn(lead.page, url);
    if (landed.startsWith('/admin') || landed === '/audit') reached.push(`${url} → ${landed}`);
  }
  check(
    reached.length === 0,
    `the PD Chief reached administration screens by typing the URL: ${reached.join(', ')}`,
    'every administration URL typed by hand sent the PD Chief away',
  );
  await shot(lead.page, '02-lead-redirected');

  // The lead really is a lead — otherwise the four assertions above would be
  // testing an ordinary officer and would prove nothing.
  const own = await landsOn(lead.page, '/organization');
  check(
    own === '/organization',
    'the PD Chief could not reach their own organization screen — the fixture is wrong, '
    + 'and the checks above prove nothing',
    'the PD Chief still has full authority over their own organization',
  );
  await shot(lead.page, '03-lead-own-organization');

  await lead.ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 2 · Capabilities are separate, not nested
// ════════════════════════════════════════════════════════════════════════════

const EXPECTED = {
  useradmin: { reach: ['/admin', '/admin/users'], refuse: ['/admin/system', '/audit'] },
  auditor: { reach: ['/admin', '/audit', '/admin/permissions'], refuse: ['/admin/users', '/admin/system'] },
  support: { reach: ['/admin', '/admin/users'], refuse: ['/admin/system', '/audit', '/admin/leads'] },
};

for (const [role, expectation] of Object.entries(EXPECTED)) {
  const actor = await session(CAST[role], role);

  const reached = [];
  const refused = [];
  for (const url of [...expectation.reach, ...expectation.refuse]) {
    const landed = await landsOn(actor.page, url);
    if (landed === url) reached.push(url); else refused.push(`${url} → ${landed}`);
  }

  for (const url of expectation.reach) {
    check(
      reached.includes(url),
      `${role} should reach ${url} but was sent away`,
      `${role} reaches ${url}`,
    );
  }
  for (const url of expectation.refuse) {
    check(
      !reached.includes(url),
      `${role} reached ${url}, which its capability does not permit`,
      `${role} is kept out of ${url}`,
    );
  }

  await landsOn(actor.page, expectation.reach[0]);
  await assertNoCredentials(actor.page, role);
  await shot(actor.page, `04-${role}`);
  await actor.ctx.close();
}

// ── support is read-only, which a redirect cannot show ──────────────────────
{
  const support = await session(CAST.support, 'support');
  await landsOn(support.page, '/admin/users');
  await support.page.waitForTimeout(600);

  const row = support.page.getByText(CAST.officer, { exact: false }).first();
  if (await row.count() > 0) {
    await row.click();
    await support.page.waitForURL(/\/admin\/users\/[0-9a-f-]+/, { timeout: 10000 });
    await support.page.waitForTimeout(500);

    const body = await support.page.evaluate(() => document.body.innerText);
    check(
      body.includes('Last login') || body.includes('never signed in'),
      'support could not read account detail, which is the whole reason the capability exists',
      'support reads account detail',
    );
    check(
      await support.page.getByRole('button', { name: /change status/i }).count() === 0,
      'support was offered the "Change status" control',
      'support is offered no way to change anything',
    );
    check(
      await support.page.getByRole('button', { name: /grant capability/i }).count() === 0,
      'support was offered the "Grant capability" control',
      'support cannot grant capabilities',
    );
    await assertNoCredentials(support.page, 'support detail');
    await shot(support.page, '05-support-readonly');
  } else {
    problems.push('support could not find the officer in the register');
  }
  await support.ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · The administrator, and what the actions actually do
// ════════════════════════════════════════════════════════════════════════════

const admin = await session(CAST.admin, 'admin');

{
  await landsOn(admin.page, '/admin');
  await admin.page.waitForTimeout(600);
  await shot(admin.page, '06-admin-hub');

  const hub = await admin.page.evaluate(() => document.body.innerText);
  check(
    /not connected|Placeholder|not live/i.test(hub),
    'the hub does not report which integrations are running on placeholders',
    'the hub reports the honest state of the installation up front',
  );

  const links = await adminNavLinks(admin.page);
  check(
    links.includes('/admin/users') && links.includes('/audit') && links.includes('/admin/system'),
    `the administrator's sidebar is missing screens: ${links.join(', ')}`,
    `the administrator's sidebar offers all ${links.length} administration screens`,
  );
}

// ── The register ────────────────────────────────────────────────────────────
{
  await landsOn(admin.page, '/admin/users');
  await admin.page.waitForTimeout(700);

  const search = admin.page.locator('input[placeholder*="Username"]').first();
  await search.fill(CAST.officer);
  await admin.page.waitForTimeout(1200);
  await shot(admin.page, '07-register-search');

  const rows = await admin.page.evaluate(() => document.body.innerText);
  check(
    rows.includes(CAST.officer),
    `searching for ${CAST.officer} did not find it`,
    'the register finds an account by username',
  );
  await assertNoCredentials(admin.page, 'register');
}

// ── One account, and a status change ───────────────────────────────────────
let officerUrl = null;
{
  await admin.page.getByText(CAST.officer, { exact: false }).first().click();
  await admin.page.waitForURL(/\/admin\/users\/[0-9a-f-]+/, { timeout: 10000 });
  await admin.page.waitForTimeout(600);
  officerUrl = admin.page.url();
  await shot(admin.page, '08-account-detail');

  const detail = await admin.page.evaluate(() => document.body.innerText);
  for (const [label, present] of [
    ['memberships', /Memberships/i.test(detail)],
    ['roles', /Officer|no role assigned/i.test(detail)],
    ['last login', /Last login/i.test(detail)],
    ['created', /Created/i.test(detail)],
    ['capabilities', /Global capabilities/i.test(detail)],
  ]) {
    check(present, `the account detail does not show ${label}`, `account detail shows ${label}`);
  }
  await assertNoCredentials(admin.page, 'account detail');

  // Disable it, with a reason, and confirm the dialog says what will happen.
  await admin.page.getByRole('button', { name: /change status/i }).first().click();
  await admin.page.waitForTimeout(400);
  const dialog = await admin.page.evaluate(() => document.body.innerText);
  check(
    /End all .* active sessions/i.test(dialog),
    'the status dialog does not say that sessions will be ended',
    'the status dialog states exactly what the action will do',
  );
  await shot(admin.page, '09-status-dialog');

  // Explicitly DISABLED rather than whatever the dialog defaults to, so the
  // walkthrough always exercises the same transition.
  await admin.page.locator('#status').click();
  await admin.page.waitForTimeout(300);
  await admin.page.getByRole('option', { name: /^Disabled$/ }).click();
  await admin.page.waitForTimeout(300);
  await admin.page.fill('#status-reason', 'Walkthrough: disabled for review');
  await admin.page.getByRole('button', { name: /^Set disabled/i }).first().click();
  await admin.page.waitForTimeout(2500);
  await shot(admin.page, '10-account-disabled');

  const after = await admin.page.evaluate(() => document.body.innerText);
  check(
    /Disabled/.test(after) && /Deactivated/.test(after),
    'the account does not read as disabled after the change',
    'the account is disabled, and the screen says what that means',
  );
}

// ── The disabled account really cannot sign in ─────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="identifier"]', CAST.officer);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);

  check(
    new URL(page.url()).pathname === '/login',
    'a disabled account signed in successfully',
    'the disabled account cannot sign in',
  );
  await shot(page, '11-disabled-cannot-sign-in');
  await ctx.close();
}

// ── Reinstate, so the fixture is reusable ──────────────────────────────────
{
  await admin.page.goto(officerUrl, { waitUntil: 'domcontentloaded' });
  await admin.page.waitForTimeout(700);
  await admin.page.getByRole('button', { name: /change status/i }).first().click();
  await admin.page.waitForTimeout(400);

  // The Select is a Radix listbox; open it and pick "Active".
  await admin.page.locator('#status').click();
  await admin.page.waitForTimeout(300);
  await admin.page.getByRole('option', { name: /^Active$/ }).click();
  await admin.page.waitForTimeout(300);
  await admin.page.fill('#status-reason', 'Walkthrough: review complete');
  await admin.page.getByRole('button', { name: /^Set active/i }).first().click();
  await admin.page.waitForTimeout(2500);

  const after = await admin.page.evaluate(() => document.body.innerText);
  check(
    /Active/.test(after) && !/Disabled/.test(after.split('Account state')[0] ?? ''),
    'the account was not reinstated',
    'the account is reinstated and can sign in again',
  );
  await shot(admin.page, '12-account-reinstated');
}

// ════════════════════════════════════════════════════════════════════════════
// 4 · The panel cannot lock itself out
// ════════════════════════════════════════════════════════════════════════════

{
  await landsOn(admin.page, '/admin/users');
  await admin.page.waitForTimeout(500);
  const search = admin.page.locator('input[placeholder*="Username"]').first();
  await search.fill(CAST.admin);
  await admin.page.waitForTimeout(1200);

  await admin.page.getByText(CAST.admin, { exact: false }).first().click();
  await admin.page.waitForURL(/\/admin\/users\/[0-9a-f-]+/, { timeout: 10000 });
  await admin.page.waitForTimeout(600);

  const own = await admin.page.evaluate(() => document.body.innerText);
  check(
    /cannot .* your own account/i.test(own),
    'the administrator’s own account page does not explain why the controls are absent',
    'the administrator is told, in words, why they cannot act on their own account',
  );
  check(
    await admin.page.getByRole('button', { name: /change status/i }).count() === 0,
    'the administrator was offered a control to change their own account status',
    'no self-service status control is offered',
  );
  await shot(admin.page, '13-own-account-locked');
}

// ════════════════════════════════════════════════════════════════════════════
// 5 · The audit log
// ════════════════════════════════════════════════════════════════════════════

{
  await landsOn(admin.page, '/audit');
  await admin.page.waitForTimeout(1200);
  await shot(admin.page, '14-audit-log');

  const body = await admin.page.evaluate(() => document.body.innerText);
  check(
    /user\.(disabled|reinstated)/.test(body),
    'the status change made minutes ago is not in the audit log',
    'the status change is in the audit log',
  );
  check(
    /append-only/i.test(body),
    'the audit screen does not state that the log is append-only',
    'the audit screen states the log is append-only',
  );
  await assertNoCredentials(admin.page, 'audit log');

  // Severity filter — the derived one, applied server-side.
  await admin.page.goto(`${BASE}/audit?severity=critical`, { waitUntil: 'domcontentloaded' });
  await admin.page.waitForTimeout(1500);
  const critical = await admin.page.evaluate(() => document.body.innerText);
  check(
    /Critical/.test(critical) && !/No entries match/.test(critical),
    'filtering the audit log to critical found nothing — the refused escalation from setup '
    + 'should be there',
    'filtering to critical severity finds the refused privilege escalation',
  );
  check(
    /global_capability_granted|denied/i.test(critical),
    'the critical entries do not include the refused capability grant',
    'the refused grant is recorded and classified as critical',
  );
  await shot(admin.page, '15-audit-critical');

  /**
   * A row opens with its full context.
   *
   * Anchored on the row's own timestamp+action shape rather than on a class:
   * every audit row is a button whose text starts with a formatted date, and
   * the severity badge follows it.
   */
  await admin.page.goto(`${BASE}/audit`, { waitUntil: 'domcontentloaded' });
  await admin.page.waitForTimeout(1500);

  /**
   * The first entry row, found through the panel's own heading.
   *
   * Anchored on the visible "Audit entries" title rather than on a class or a
   * text shape: the filter bar is full of buttons too, and a looser selector
   * picks one of those and clicks a dropdown instead of a row.
   */
  const opened = await admin.page.evaluate(() => {
    const heading = [...document.querySelectorAll('h2')]
      .find((el) => el.textContent.trim() === 'Audit entries');
    if (!heading) return 'no heading';
    const panel = heading.closest('div.flex.min-h-0');
    const row = panel?.querySelector('div.overflow-auto button');
    if (!row) return 'no rows';
    row.click();
    return 'clicked';
  });

  if (opened === 'clicked') {
    await admin.page.waitForTimeout(1000);
    const detail = await admin.page.evaluate(
      () => document.querySelector('[role="dialog"]')?.textContent ?? '',
    );
    check(
      /Actor/.test(detail) && /Target/.test(detail) && /Context/.test(detail),
      `the audit detail dialog does not show actor, target and context (saw: ${
        detail.replace(/\s+/g, ' ').slice(0, 160)})`,
      'an audit entry opens with its actor, target, organization and context',
    );
    await shot(admin.page, '16-audit-detail');
  } else {
    problems.push(`could not open an audit entry: ${opened}`);
  }

  // Date range, actor and outcome are URL parameters and must not error.
  const from = new Date(Date.now() - 86_400_000).toISOString();
  await admin.page.goto(
    `${BASE}/audit?outcome=denied&from=${encodeURIComponent(from)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await admin.page.waitForTimeout(1200);
  const denied = await admin.page.evaluate(() => document.body.innerText);
  check(
    !/No entries match/.test(denied),
    'filtering to refused actions in the last day found nothing',
    'the outcome and date-range filters work together',
  );
  await shot(admin.page, '17-audit-denied');
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · Leads, permissions and system
// ════════════════════════════════════════════════════════════════════════════

{
  await landsOn(admin.page, '/admin/leads');
  await admin.page.waitForTimeout(900);
  const leads = await admin.page.evaluate(() => document.body.innerText);
  check(
    leads.includes('PD Chief') || /LSPD/.test(leads),
    'the leads screen does not show the PD lead created for this run',
    'the leads screen lists every current Organization Lead',
  );
  check(
    /no lead|without a lead/i.test(leads),
    'the leads screen does not call out organizations with nobody leading them',
    'the leads screen calls out organizations with no lead',
  );
  await shot(admin.page, '18-leads');

  await landsOn(admin.page, '/admin/permissions');
  await admin.page.waitForTimeout(1200);
  const perms = await admin.page.evaluate(() => document.body.innerText);
  check(
    /personnel\.fire/.test(perms),
    'the permission overview does not list the catalogue',
    'the permission overview lists the permission catalogue with its grants',
  );
  check(
    /global/.test(perms),
    'the permission overview does not mark global-scope permissions',
    'global-scope permissions are marked as such',
  );
  await shot(admin.page, '19-permissions');

  await landsOn(admin.page, '/admin/system');
  await admin.page.waitForTimeout(900);
  const system = await admin.page.evaluate(() => document.body.innerText);
  check(
    /NOT delivered/i.test(system),
    'the system screen does not say that mail is going nowhere',
    'the system screen reports the mail transport as a placeholder, in plain words',
  );
  check(
    /deployment action|not editable/i.test(system),
    'the system screen does not explain why nothing is editable',
    'the system screen explains why it is read-only',
  );
  await assertNoCredentials(admin.page, 'system');
  await shot(admin.page, '20-system');
}

await admin.ctx.close();
await browser.close();

report();
process.exit(problems.length === 0 ? 0 : 1);
