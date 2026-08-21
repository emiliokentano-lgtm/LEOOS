/**
 * Visual consistency check.
 *
 * Screenshots every screen at the two viewports the product targets and fails on
 * console errors, uncaught page errors, or horizontal body overflow — tables and
 * the map must stay usable without the page scrolling sideways.
 *
 * Usage:  node scripts/visual-check.mjs [outDir] [baseUrl]
 * Requires a running server:  NEXT_PUBLIC_LEOOS_DEMO=1 pnpm start
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '.visual';
const BASE = process.argv[3] ?? 'http://localhost:3000';

const SCREENS = [
  ['dashboard', '/dashboard'], ['dispatch', '/dispatch'], ['map', '/map'],
  ['persons', '/persons'], ['vehicles', '/vehicles'], ['personnel', '/personnel'],
  ['roles', '/roles'], ['organization', '/organization'], ['search', '/search'],
  ['audit', '/audit'], ['admin', '/admin'], ['design', '/design'],
  ['login', '/login'], ['register', '/register'],
  ['forgot-password', '/forgot-password'], ['reset-password', '/reset-password'],
  ['verify', '/verify'],
];

/**
 * The product is desktop-first, and these are the widths it has to survive.
 *
 * The first two are what it is designed against. The narrower two were added
 * because the shell already CONTAINS breakpoint logic — `top-bar.tsx` hides the
 * organization label below `lg` so it stops competing with the status area —
 * and nothing was exercising it. A branch that only ever runs on a reviewer's
 * laptop is a branch nobody has tested.
 *
 * 1024 is the floor deliberately: this is an operational console for a seated
 * dispatcher with a dispatch board, a map and a roster on screen, not a phone
 * app, and pretending otherwise would mean asserting a layout the product does
 * not claim. What IS asserted at every width is the thing that would actually
 * break a shift — no console errors, no page errors, and no horizontal body
 * scroll, because a table or a map that pushes the page sideways is unusable
 * long before it is ugly.
 */
const VIEWPORTS = [
  { tag: 'fhd', width: 1920, height: 1080 },
  { tag: 'laptop', width: 1440, height: 900 },
  { tag: 'small-laptop', width: 1280, height: 800 },
  { tag: 'narrow', width: 1024, height: 768 },
];

mkdirSync(OUT, { recursive: true });

const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${vp.tag}] console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`[${vp.tag}] pageerror: ${String(e).slice(0, 200)}`));

  for (const [name, path] of SCREENS) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) problems.push(`[${vp.tag}] ${name}: horizontal overflow ${overflow}px`);

    await page.screenshot({ path: `${OUT}/${vp.tag}-${name}.png` });
  }
  await ctx.close();
}

await browser.close();

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`No issues. ${SCREENS.length * VIEWPORTS.length} screenshots in ${OUT}/`);
