/**
 * The stale-cookie regression check.
 *
 * A session cookie and a session have separate lifetimes: the cookie is in the
 * browser, the session is a row that can end without it — idle timeout,
 * absolute timeout, an administrator ending sessions, a revoked account. When
 * that happened, the two halves of the guard used to disagree and redirect at
 * each other forever:
 *
 *   middleware      sees a cookie → "signed in"     → /login   ⇒ /dashboard
 *   the app layout  asks the API  → "no session"    → /dashboard ⇒ /login
 *
 * The operator could not reach the application OR the sign-in page without
 * clearing site data. This asserts the loop cannot come back.
 *
 * Usage:  node scripts/session-check.mjs
 */
const BASE = process.env.LEOOS_WEB ?? 'http://localhost:3010';

const problems = [];
const notes = [];

/** Follows redirects by hand, so the hop count itself can be asserted. */
async function walk(path, cookie, maxHops = 6) {
  const hops = [];
  let url = new URL(path, BASE).toString();
  let jar = cookie;

  for (let i = 0; i < maxHops; i += 1) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jar ? { cookie: jar } : {},
    });
    hops.push({ url, status: res.status, location: res.headers.get('location') });

    // A cleared cookie must actually leave the jar, or the next hop presents a
    // credential the server has already rejected — which is the bug.
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const [name, value] = pair.split('=');
      if (name === 'leoos_session' && (value === '' || /Expires=Thu, 01 Jan 1970/i.test(line))) {
        jar = '';
      }
    }

    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || location === null) break;
    url = new URL(location, BASE).toString();
  }

  return { hops, jar };
}

// ── A cookie the server does not recognise ──────────────────────────────────
{
  const { hops } = await walk('/map', 'leoos_session=not-a-real-session-token');
  const trail = hops.map((h) => `${h.status} ${new URL(h.url).pathname}`).join(' → ');
  notes.push(`stale cookie on /map: ${trail}`);

  const last = hops[hops.length - 1];
  if (last?.status !== 200 || !last.url.includes('/login')) {
    problems.push(
      `a stale session cookie did not settle on the sign-in page — ended at `
      + `${last?.status} ${last?.url}. This is the redirect loop returning.`,
    );
  }
  if (!last?.url.includes('reason=expired')) {
    problems.push('the sign-in page was not told the session had expired');
  }
  if (hops.some((h) => h.location?.includes('/api/session/expired')
    && hops.filter((x) => x.url.includes('/api/session/expired')).length > 1)) {
    problems.push('the expiry route was visited more than once — it is looping');
  }
}

// ── No cookie at all: the ordinary case, which must still work ──────────────
{
  const { hops } = await walk('/map', '');
  const last = hops[hops.length - 1];
  notes.push(`no cookie on /map: ${hops.map((h) => `${h.status} ${new URL(h.url).pathname}`).join(' → ')}`);
  if (!last?.url.includes('/login')) {
    problems.push(`an anonymous request to /map ended at ${last?.url}, not the sign-in page`);
  }
  if (!hops[0]?.location?.includes('next=')) {
    problems.push('the destination was not preserved for after sign-in');
  }
}

// ── The sign-in page itself, reached directly with a stale cookie ───────────
{
  const { hops } = await walk('/login', 'leoos_session=not-a-real-session-token');
  const last = hops[hops.length - 1];
  notes.push(`stale cookie on /login: ${hops.map((h) => `${h.status} ${new URL(h.url).pathname}`).join(' → ')}`);
  if (last?.status !== 200) {
    problems.push(
      `/login was not reachable with a stale cookie — ended at ${last?.status} ${last?.url}`,
    );
  }
}

for (const note of notes) console.log(`  ${note}`);
if (problems.length === 0) {
  console.log('\nno problems found');
  process.exit(0);
}
console.error(`\n${problems.length} problem(s):`);
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
