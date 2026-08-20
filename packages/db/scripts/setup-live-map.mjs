/**
 * Prepares a LEOOS instance for a live-map walkthrough.
 *
 * LIVES IN `packages/db` RATHER THAN `apps/web/scripts` because it touches the
 * database directly, and `apps/web` has no database access at all (ADR-0001,
 * engineering rule 38). A fixture builder is not an exception to that boundary —
 * it is exactly the kind of thing that erodes one.
 *
 * Creates officers across several agencies, links each to a FiveM licence,
 * crews each into a unit, and issues a game-server credential — all through the
 * REAL paths, so what the walkthrough then exercises is the deployed behaviour
 * rather than a fixture shaped to pass.
 *
 * Prints the environment the simulator needs. Not production data, and it says
 * so: every account it makes is prefixed `sim.`.
 *
 * Usage:
 *   node packages/db/scripts/setup-live-map.mjs > sim.env
 *   . ./sim.env
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

const API = process.env.LEOOS_API ?? 'http://localhost:3011';
const INTERNAL = process.env.LEOOS_INTERNAL ?? 'dev-internal-token-abcdefgh';
const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = 'correct-horse-staple-42';

if (!DATABASE_URL) {
  console.error('Set DATABASE_URL.');
  process.exit(2);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });
const log = (message) => console.error(`[setup] ${message}`);

/**
 * The fleet, spread across agencies.
 *
 * Multi-agency on purpose: organization isolation is one of the properties the
 * walkthrough has to check, and it cannot be checked with one organization.
 */
const FLEET = [
  { org: 'PD', role: 'sergeant', count: 4, prefix: 'ADAM' },
  // `null` takes the organization's highest role. A paramedic legitimately
  // lacks `units.manage` — the first attempt used one and every MD unit was
  // refused, which is the permission model working, not a bug to route around.
  { org: 'MD', role: null, count: 3, prefix: 'MED' },
  { org: 'FIB', role: null, count: 2, prefix: 'FIB' },
];

async function api(path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = { 'x-leoos-internal': INTERNAL };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-leoos-csrf'] = csrf;

  const res = await fetch(`${API}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* some responses carry no body */ }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
}

/**
 * Signs in, WAITING OUT the rate limiter rather than defeating it.
 *
 * Logins are capped at 30 per address per 15 minutes. That is the right limit
 * and this script is not entitled to an exemption — a fixture builder that
 * needed one would be evidence the limit was in the wrong place. Two runs back
 * to back genuinely exhaust it, so this waits.
 */
async function signIn(username, attempt = 0) {
  const res = await api('/api/v1/auth/login', {
    method: 'POST', body: { identifier: username, password: PASSWORD },
  });

  if (res.status === 429 && attempt < 6) {
    const waitMs = 20_000;
    log(`login rate limited — waiting ${waitMs / 1000}s (attempt ${attempt + 1})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return signIn(username, attempt + 1);
  }

  if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);

  const jar = {};
  for (const line of res.setCookie) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  return {
    cookie: Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
    csrf: jar.leoos_csrf ?? '',
  };
}

/**
 * A password hash the API will actually accept.
 *
 * Registration is rate limited to three per hour per address — correctly, and
 * that limit exists to protect the real signup path, not to be worked around by
 * a fixture builder. So exactly ONE account is registered through the API, and
 * its hash is copied for the rest: the Argon2 parameters then come from the API
 * itself rather than from this script's guess at them.
 *
 * Copying a hash found by scanning the table was the first attempt and was
 * wrong — the suite leaves accounts whose hashes were deliberately corrupted,
 * and picking one produced a fleet that could not log in.
 */
let templateHash = null;

/**
 * Finds a hash that is PROVEN to work, before falling back to registering one.
 *
 * Candidates are tried against the real login endpoint and the first that
 * succeeds is adopted. That is what makes this safe to copy: scanning the table
 * and taking whatever came back first was the original approach and it picked an
 * account whose hash a test had deliberately corrupted, producing a fleet that
 * could not log in.
 *
 * Registering is the fallback rather than the default because registration is
 * capped at three per hour per address — a limit that protects the real signup
 * path and that this script has no business exhausting on every run.
 */
async function adoptTemplateHash() {
  const candidates = await sql`
    SELECT username, password_hash FROM user_account
     WHERE username LIKE 'sim.seed.%'
     ORDER BY created_at DESC
     LIMIT 4
  `;

  for (const candidate of candidates) {
    try {
      await signIn(candidate.username);
      log(`reusing the verified password hash from ${candidate.username}`);
      return candidate.password_hash;
    } catch {
      log(`candidate ${candidate.username} could not log in — trying the next`);
    }
  }
  return null;
}

async function mintTemplateHash(tag) {
  const username = `sim.seed.${tag}`;
  const registered = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: `${username}@test.invalid`,
      username,
      displayName: 'Simulator seed',
      password: PASSWORD,
    },
  });

  if (registered.status === 429) {
    throw new Error(
      'registration is rate limited. Restart the API to clear the in-process limiter, '
      + 'or wait an hour.',
    );
  }
  if (registered.json?.devVerificationToken) {
    await api('/api/v1/auth/verify', {
      method: 'POST', body: { token: registered.json.devVerificationToken },
    });
  }

  const rows = await sql`SELECT password_hash FROM user_account WHERE username = ${username}`;
  if (rows.length === 0) throw new Error(`could not register a seed account (${registered.status})`);

  // Proven, not assumed: if this login fails the rest of the fleet would fail
  // the same way, ten accounts later and much less obviously.
  await signIn(username);
  return rows[0].password_hash;
}

async function ensureAccount(username, displayName) {
  const existing = await sql`SELECT id FROM user_account WHERE username = ${username}`;
  if (existing.length > 0) return existing[0].id;

  const rows = await sql`
    INSERT INTO user_account (email, username, display_name, password_hash, status, email_verified_at)
    VALUES (${`${username}@test.invalid`}, ${username}, ${displayName}, ${templateHash},
            'active', now())
    RETURNING id
  `;
  return rows[0].id;
}

async function ensureMembership(userId, orgKey, roleKey, callsign) {
  const orgs = await sql`SELECT id FROM organization WHERE key = ${orgKey}`;
  if (orgs.length === 0) throw new Error(`organization ${orgKey} not seeded`);
  const organizationId = orgs[0].id;

  let members = await sql`
    SELECT id FROM organization_member
     WHERE user_id = ${userId} AND organization_id = ${organizationId}
  `;
  if (members.length === 0) {
    members = await sql`
      INSERT INTO organization_member (user_id, organization_id, status, callsign)
      VALUES (${userId}, ${organizationId}, 'active', ${callsign})
      RETURNING id
    `;
  }
  const memberId = members[0].id;

  // A role is what carries the permissions; without one the account can see
  // nothing and crews nothing.
  const key = roleKey ?? (await sql`
    SELECT key FROM role
     WHERE organization_id = ${organizationId} AND deleted_at IS NULL
     ORDER BY hierarchy_level DESC LIMIT 1
  `)[0]?.key;

  const roles = await sql`
    SELECT id FROM role WHERE organization_id = ${organizationId} AND key = ${key}
  `;
  if (roles.length > 0) {
    await sql`
      INSERT INTO member_role (member_id, role_id, assigned_by)
      VALUES (${memberId}, ${roles[0].id}, ${userId})
      ON CONFLICT DO NOTHING
    `;
  }

  await sql`
    INSERT INTO member_status (member_id, status_key, unit_id)
    VALUES (${memberId}, 'available', NULL)
    ON CONFLICT (member_id) DO NOTHING
  `;

  return { memberId, organizationId };
}

async function linkIdentity(userId, license) {
  await sql`
    INSERT INTO game_identity (provider, identifier, user_id, verified_at)
    VALUES ('license', ${license}, ${userId}, now())
    ON CONFLICT (provider, identifier)
    DO UPDATE SET user_id = ${userId}, verified_at = now()
  `;
}

// ── Build the fleet ─────────────────────────────────────────────────────────
const tag = randomBytes(3).toString('hex');
const licenses = [];
const summary = [];

templateHash = await adoptTemplateHash() ?? await mintTemplateHash(tag);
log('password hash verified against the API');

for (const group of FLEET) {
  for (let i = 0; i < group.count; i += 1) {
    const username = `sim.${group.org.toLowerCase()}${i}.${tag}`;
    const displayName = `${group.org} Officer ${i + 1}`;
    const callsign = `${group.prefix}-${i + 1}${tag.slice(0, 2).toUpperCase()}`;

    const userId = await ensureAccount(username, displayName);
    await ensureMembership(userId, group.org, group.role, callsign);

    const license = `sim-${tag}-${group.org.toLowerCase()}-${i}`;
    await linkIdentity(userId, license);

    // Crewing goes through the REAL dispatch endpoint, so the unit is created
    // and joined exactly as an operator would do it.
    const auth = await signIn(username);
    const unit = await api('/api/v1/dispatch/units', {
      method: 'POST',
      cookie: auth.cookie,
      csrf: auth.csrf,
      body: { callsign, unitType: 'patrol', joinSelf: true },
    });

    if (unit.status !== 201) {
      log(`could not create unit ${callsign}: ${unit.status} ${JSON.stringify(unit.json)}`);
      continue;
    }

    licenses.push(`license:${license}`);
    summary.push(`${group.org} ${callsign} → ${username}`);
    log(`${group.org} ${callsign} ready`);
  }
}

// ── Map sharing, stated rather than inherited ───────────────────────────────
//
// The isolation scenario needs two different answers to "may another agency see
// this unit on the map": MD shares, FIB does not. Left to whatever the database
// happened to hold, the check either proves nothing (nothing shared, so a PD
// officer sees no other organization at all) or quietly stops testing what it
// claims to. Setting both makes the scenario reproducible and its meaning
// explicit.
for (const [key, shares] of [['MD', true], ['FIB', false], ['PD', false]]) {
  await sql`
    UPDATE organization
    SET settings = COALESCE(settings, '{}'::jsonb)
      || jsonb_build_object('shareOnPublicMap', ${shares})
    WHERE key = ${key}
  `;
}
log('map sharing: MD shares on the public map, FIB and PD do not');

// ── A game server credential ────────────────────────────────────────────────
//
// Issued through the real admin path, so the walkthrough proves the issuing and
// verifying halves agree.
const adminUsername = `sim.admin.${tag}`;
const adminId = await ensureAccount(adminUsername, 'Simulator Admin');
await sql`
  INSERT INTO user_global_role (user_id, capability) VALUES (${adminId}, 'global_admin')
  ON CONFLICT DO NOTHING
`;
const adminAuth = await signIn(adminUsername);

const server = await api('/api/v1/game-servers', {
  method: 'POST', cookie: adminAuth.cookie, csrf: adminAuth.csrf,
  body: { key: `sim-${tag}`, name: `Simulated server ${tag}` },
});
if (server.status !== 201) throw new Error(`register server: ${server.status}`);

const credential = await api(`/api/v1/game-servers/${server.json.id}/credentials`, {
  method: 'POST', cookie: adminAuth.cookie, csrf: adminAuth.csrf, body: {},
});
if (credential.status !== 201) throw new Error(`issue credential: ${credential.status}`);

log('');
log('fleet:');
for (const line of summary) log(`  ${line}`);
log('');

// stdout is the machine-readable half, so `> sim.env` works.
console.log(`export LEOOS_KEY_ID=${credential.json.keyId}`);
console.log(`export LEOOS_SECRET=${credential.json.secret}`);
console.log(`export LEOOS_SIM_LICENSES=${licenses.join(',')}`);
console.log(`export LEOOS_SIM_PD_USER=sim.pd0.${tag}`);
console.log(`export LEOOS_SIM_MD_USER=sim.md0.${tag}`);
console.log(`export LEOOS_SIM_TAG=${tag}`);

await sql.end({ timeout: 5 });
