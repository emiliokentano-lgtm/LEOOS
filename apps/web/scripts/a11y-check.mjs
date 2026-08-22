/**
 * Accessibility and visual-consistency audit.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MEASURED, NOT REVIEWED
 *
 * "Check the contrast" is not a task a person can do reliably across thirteen
 * screens and four viewports, and a reviewer's eye is exactly the instrument
 * that misses the 4.3:1 text nobody notices until a night shift. So this walks
 * every page in a real browser and computes the things that have numbers:
 *
 *   1. CONTRAST — every visible text node, against the background actually
 *      painted behind it (walked up the tree through transparent ancestors),
 *      at the WCAG 2.1 AA threshold for its size.
 *   2. ACCESSIBLE NAMES — every control a screen reader would announce as
 *      nothing: icon-only buttons and links with no text, no aria-label, no
 *      title.
 *   3. FOCUS VISIBILITY — tab through the page and confirm each stop actually
 *      changes how it is painted. A focus ring that exists in CSS but is
 *      clipped, transparent, or overridden fails here.
 *   4. COLOUR INDEPENDENCE — status badges must carry a text label, not only a
 *      hue. Asserted structurally rather than by eye.
 *   5. STRUCTURE — one h1 per page, no duplicate ids, no positive tabindex, a
 *      main landmark, and no horizontal body scroll.
 *
 * Usage:  node scripts/a11y-check.mjs [outDir]
 * Requires running servers (see the other *-check scripts).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.LEOOS_WEB ?? 'http://localhost:3010';
const OUT = process.argv[2] ?? '.a11y';
const PASSWORD = process.env.LEOOS_A11Y_PASSWORD ?? 'correct-horse-staple-42';

/**
 * TWO ACCOUNTS, because one cannot reach every screen.
 *
 * The global administrator has no organization membership, so `/personnel`,
 * `/roles` and `/organization` redirect them to the holding screen — the first
 * run of this audit reported "[personnel] no h1" for a page it never actually
 * visited. The operator has an organization but no admin panel. Between them
 * every page in the product is inspected as somebody entitled to see it.
 */
const ADMIN_USER = process.env.LEOOS_A11Y_USER ?? 'ui.admin';
const OPERATOR_USER = process.env.LEOOS_A11Y_OPERATOR ?? 'ui.commander';

mkdirSync(OUT, { recursive: true });

/** Signed-out pages first, then everything behind a session. */
const PUBLIC_PAGES = [
  ['login', '/login'],
  ['register', '/register'],
  ['forgot-password', '/forgot-password'],
];

/** Reachable by the global administrator. */
const ADMIN_PAGES = [
  ['dashboard', '/dashboard'],
  ['dispatch', '/dispatch'],
  ['map', '/map'],
  ['persons', '/persons'],
  ['vehicles', '/vehicles'],
  ['search', '/search?q=a'],
  ['audit', '/audit'],
  ['admin', '/admin'],
  ['admin-users', '/admin/users'],
  ['admin-permissions', '/admin/permissions'],
  ['admin-system', '/admin/system'],
  ['notifications', '/notifications'],
];

/** Organization-scoped, so they need an account that belongs to one. */
const OPERATOR_PAGES = [
  ['personnel', '/personnel'],
  ['roles', '/roles'],
  ['organization', '/organization'],
  ['dispatch-operator', '/dispatch'],
  ['dashboard-operator', '/dashboard'],
];

const problems = [];
const notes = [];
const add = (page, message) => problems.push(`[${page}] ${message}`);

/**
 * The audit, evaluated inside the page.
 *
 * One `evaluate` rather than many round trips: a per-node call across a table
 * of 50 rows is thousands of protocol messages and turns a 20-second check into
 * a coffee break.
 */
const AUDIT = () => {
  const results = {
    contrast: [], unnamed: [], duplicateIds: [], positiveTabIndex: [],
    h1Count: 0, hasMain: false, overflow: false, colourOnly: [],
  };

  const parseColour = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value ?? '');
    if (!m) return null;
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const ratio = (a, b) => {
    const la = luminance(a); const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  /** The colour actually painted behind an element. */
  const backgroundOf = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const bg = parseColour(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        acc = acc === null ? bg : over(acc, bg);
        if (acc.a >= 1) return acc;
      }
      node = node.parentElement;
    }
    return acc ?? { r: 11, g: 14, b: 20, a: 1 };
  };

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const describe = (el) => {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).slice(0, 3).join('.');
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  // ── 1. Contrast ──────────────────────────────────────────────────────────
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    // Only elements with their own text, so a wrapper is not blamed for its
    // children and each string is measured exactly once.
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3 && n.textContent.trim().length > 0)
      .map((n) => n.textContent.trim())
      .join(' ');
    if (!own) continue;

    const s = getComputedStyle(el);
    const fg = parseColour(s.color);
    if (!fg) continue;
    const bg = backgroundOf(el);
    const composited = fg.a < 1 ? over(fg, bg) : fg;
    const r = ratio(composited, bg);

    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    // WCAG "large text": 18.66px bold or 24px regular.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;

    if (r + 0.05 < required) {
      const key = `${s.color}|${describe(el)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.contrast.push({
        text: own.slice(0, 60), el: describe(el), colour: s.color,
        ratio: Math.round(r * 100) / 100, required, size,
      });
    }
  }

  // ── 2. Accessible names ──────────────────────────────────────────────────
  for (const el of document.querySelectorAll('button, a[href], [role="button"], input, select, textarea')) {
    if (!visible(el)) continue;
    const text = (el.innerText ?? '').trim();
    const label = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '';
    const labelledBy = el.getAttribute('aria-labelledby');
    const described = labelledBy
      ? [...labelledBy.split(/\s+/)].some((id) => document.getElementById(id))
      : false;
    const hasLabelElement = el.id
      ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) !== null
      : false;
    const placeholder = el.getAttribute('placeholder') ?? '';
    if (!text && !label.trim() && !described && !hasLabelElement && !placeholder.trim()) {
      results.unnamed.push(describe(el));
    }
  }

  // ── 3. Structure ─────────────────────────────────────────────────────────
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  }
  for (const [id, n] of ids) if (n > 1) results.duplicateIds.push(`${id} ×${n}`);

  for (const el of document.querySelectorAll('[tabindex]')) {
    const v = parseInt(el.getAttribute('tabindex'), 10);
    if (v > 0) results.positiveTabIndex.push(describe(el));
  }

  results.h1Count = document.querySelectorAll('h1').length;
  results.hasMain = document.querySelector('main, [role="main"]') !== null;
  results.overflow =
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;

  // ── 4. Colour independence ───────────────────────────────────────────────
  // A status indicator must say something, not merely be a colour. Anything
  // tagged as one that renders no text is a dot a colour-blind operator cannot
  // read.
  for (const el of document.querySelectorAll('[data-status], [data-priority]')) {
    if (!visible(el)) continue;
    const text = (el.innerText ?? '').trim();
    const label = el.getAttribute('aria-label') ?? '';
    if (!text && !label.trim()) results.colourOnly.push(describe(el));
  }

  return results;
};

async function auditPage(page, name) {
  const r = await page.evaluate(AUDIT);

  for (const c of r.contrast) {
    add(name, `contrast ${c.ratio}:1 (needs ${c.required}) on ${c.el} `
      + `${c.colour} ${Math.round(c.size)}px — "${c.text}"`);
  }
  for (const u of [...new Set(r.unnamed)]) add(name, `control with no accessible name: ${u}`);
  for (const d of r.duplicateIds) add(name, `duplicate id: ${d}`);
  for (const t of [...new Set(r.positiveTabIndex)]) add(name, `positive tabindex: ${t}`);
  for (const c of [...new Set(r.colourOnly)]) add(name, `status shown by colour alone: ${c}`);

  if (r.h1Count === 0) add(name, 'no h1 — a screen reader has no page title to announce');
  if (r.h1Count > 1) add(name, `${r.h1Count} h1 elements — exactly one is the page`);
  if (!r.hasMain) add(name, 'no main landmark');
  if (r.overflow) add(name, 'horizontal body overflow');

  // ── Focus visibility ───────────────────────────────────────────────────
  //
  // Driven with a REAL Tab key, not `element.focus()`.
  //
  // `:focus-visible` is the right selector for a focus ring — it keeps the ring
  // off a mouse click — and Chromium does not match it for a programmatic
  // `.focus()` on a button. Measuring that way reported every button in the
  // product as having no indicator, which was the audit's method being wrong
  // rather than the product. Tab is what a keyboard user presses, so Tab is
  // what this presses.
  const focusStyle = () => document.activeElement === null ? null : (() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).slice(0, 2).join('.');
    return {
      key: `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`,
      style: `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}|${s.backgroundColor}`,
      tag: el.tagName.toLowerCase(),
    };
  })();

  const invisible = [];
  const visited = new Set();
  await page.evaluate(() => { document.body.focus(); });
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(focusStyle);
    if (!focused || focused.tag === 'body') break;
    // `nextjs-portal` is the DEV-TOOLS OVERLAY the framework injects into
    // `next dev`. It is focusable, has no ring of ours, and does not exist in a
    // production build — so reporting it told the reader there were nine
    // problems in the product when there were none. An audit that cannot be
    // brought to zero stops being read.
    if (focused.tag === 'nextjs-portal') continue;
    if (visited.has(focused.key)) continue;
    visited.add(focused.key);

    // The same element's resting style, for comparison: blur it, read it, and
    // put the focus back so the next Tab continues from where it was.
    const resting = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      el.blur();
      const s = getComputedStyle(el);
      const out = `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}|${s.backgroundColor}`;
      el.focus();
      return out;
    });

    if (resting === focused.style) invisible.push(focused.key);
  }
  for (const el of invisible) add(name, `no visible focus indicator: ${el}`);

  await page.screenshot({ path: `${OUT}/${name}.png` });
}

// ── Drive ──────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 160)}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 160)}`);
});

for (const [name, path] of PUBLIC_PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await auditPage(page, name);
}

async function signIn(who) {
  // Cookies cleared first: an existing session sends /login straight to the
  // dashboard, and the second account never gets a form to fill in.
  await ctx.clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="identifier"]', who);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|dispatch|map|no-organization)/, { timeout: 20000 });
}

await signIn(ADMIN_USER);
for (const [name, path] of ADMIN_PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  /**
   * Label the finding with where the browser ENDED UP.
   *
   * Three pages redirect for an account with no active organization, and the
   * audit reported "[personnel] no h1" for a screen that was actually
   * `/no-organization`. A finding that names the wrong page sends the next
   * person to the wrong file.
   */
  const landed = new URL(page.url()).pathname;
  const label = landed === path.split('?')[0] ? name : `${name}→${landed}`;
  if (label !== name) notes.push(`${path} redirected to ${landed}`);
  await auditPage(page, label);
}

await signIn(OPERATOR_USER);
for (const [name, path] of OPERATOR_PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const landed = new URL(page.url()).pathname;
  const label = landed === path.split('?')[0] ? name : `${name}→${landed}`;
  if (label !== name) notes.push(`${path} redirected to ${landed} as the operator`);
  await auditPage(page, label);
}

await browser.close();

console.log(`# Accessibility audit\n`);
if (notes.length > 0) {
  console.log('## Notes');
  for (const n of notes) console.log(`- ${n}`);
  console.log('');
}

if (problems.length === 0) {
  console.log('## No problems found');
  process.exit(0);
}

console.log(`## ${problems.length} problem(s)`);
for (const p of problems) console.log(`- ${p}`);
process.exit(1);
