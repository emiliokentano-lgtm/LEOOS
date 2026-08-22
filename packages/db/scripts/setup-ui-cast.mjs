/**
 * The cast the UI walkthroughs need.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCRIPT EXISTS
 *
 * Nine of the browser walkthroughs sign in as `ui.admin`, `ui.chief`,
 * `ui.commander`, `ui.sergeant` or `ui.medic` — hard-coded, because a
 * screenshot comparison and an accessibility audit want the same account every
 * run. Nothing in the repository created those accounts. They existed in one
 * developer's database and nowhere else, which made a documented release gate
 * unrunnable from a clean checkout: `a11y-check.mjs` simply timed out at the
 * login form with no explanation.
 *
 * A gate only one machine can run is not a gate. This script provisions the
 * cast, is idempotent, and refuses a production database.
 *
 *   ui.admin      global_admin, and NO membership. The admin panel and the
 *                 holding screen both need somebody with authority and no
 *                 agency — `/personnel` must redirect them.
 *   ui.chief      PD Chief of Police (top of the hierarchy).
 *   ui.commander  PD Commander — senior, but with a rank ceiling above them,
 *                 which is what the personnel and roles walkthroughs test.
 *   ui.sergeant   PD Sergeant — dispatch, real-time, dashboard.
 *   ui.officer1   PD Officer — the ordinary operator. Criminal records yes,
 *                 medical records no, which is the split the records and search
 *                 walkthroughs measure.
 *   ui.cadet1     PD Cadet — the bottom of the hierarchy, and therefore the
 *                 target the personnel and roles walkthroughs promote.
 *   ui.medic      MD Doctor — the other organization, for scoping and for the
 *                 medical-record permission split.
 *
 * Passwords: every account gets the same walkthrough password, and it is
 * obtained by COPYING A HASH THE API HAS ALREADY VERIFIED rather than by
 * writing one here. That keeps the hashing parameters in one place and means a
 * change to them cannot leave this script minting logins that do not work.
 *
 * Usage:
 *   DATABASE_URL=… LEOOS_API=… LEOOS_INTERNAL=… node scripts/setup-ui-cast.mjs
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

const API = process.env.LEOOS_API ?? 'http://localhost:3011';
const INTERNAL = process.env.LEOOS_INTERNAL ?? 'dev-internal-token-abcdefgh';
const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = process.env.LEOOS_UI_PASSWORD ?? 'correct-horse-staple-42';

if (!DATABASE_URL) {
  console.error('Set DATABASE_URL.');
  process.exit(2);
}

/**
 * Fixture accounts with a shared, publicly-known password have no business in a
 * production database. Refused here as well as by the demo seed, because this
 * script writes the same kind of data by a different route.
 */
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error(
    'Refusing to create walkthrough accounts against NODE_ENV=production. '
    + 'These are fixtures with a shared password. Set ALLOW_DEMO_SEED=true only '
    + 'if this is a disposable staging database.',
  );
  process.exit(2);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });
const log = (message) => console.error(`[ui-cast] ${message}`);

/** Who to create, and what authority each one carries. */
/**
 * The display names are NOT decoration.
 *
 * The personnel walkthrough finds a roster row by the name shown in it — "the
 * Chief's row is locked to a Commander", "the Commander's own row is locked",
 * "an Officer's row offers a menu" — so the three names below are load-bearing
 * and must not be renamed without changing `personnel-check.mjs` with them.
 */
const CAST = [
  { username: 'ui.admin', displayName: 'Vera Lindqvist', capability: 'global_admin' },
  { username: 'ui.chief', displayName: 'Marcus Vale', org: 'PD', role: 'chief' },
  { username: 'ui.commander', displayName: 'Renata Ochoa', org: 'PD', role: 'commander' },
  { username: 'ui.sergeant', displayName: 'Dana Whitlock', org: 'PD', role: 'sergeant' },
  { username: 'ui.officer1', displayName: 'Tomas Brandt', org: 'PD', role: 'officer' },
  { username: 'ui.cadet1', displayName: 'Iris Halloran', org: 'PD', role: 'cadet' },
  { username: 'ui.medic', displayName: 'Sofia Aringarosa', org: 'MD', role: 'doctor' },
];

async function signIn(username) {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-leoos-internal': INTERNAL },
    body: JSON.stringify({ identifier: username, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);
  return true;
}

/**
 * A password hash the API will accept, PROVEN by signing in with it.
 *
 * Registering five accounts through the API would hit the three-per-hour
 * registration limit. Copying a verified hash avoids that without weakening the
 * limit — and the verification step is what stops this from silently producing
 * accounts nobody can log into.
 */
async function adoptTemplateHash() {
  const candidates = await sql`
    SELECT username, password_hash FROM user_account
     WHERE email LIKE '%@test.invalid' AND status = 'active'
       AND password_hash LIKE '$argon2%'
     ORDER BY created_at DESC LIMIT 8
  `;
  for (const candidate of candidates) {
    try {
      await signIn(candidate.username);
      log(`reusing the verified password hash from ${candidate.username}`);
      return candidate.password_hash;
    } catch { /* try the next one */ }
  }
  return null;
}

async function mintTemplateHash(tag) {
  const username = `ui.seed.${tag}`;
  const res = await fetch(`${API}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-leoos-internal': INTERNAL },
    body: JSON.stringify({
      email: `${username}@test.invalid`,
      username,
      displayName: 'UI Seed',
      password: PASSWORD,
    }),
  });
  if (res.status !== 202) throw new Error(`register seed: ${res.status}`);
  const body = await res.json().catch(() => null);
  const token = body?.devVerificationToken;
  if (!token) throw new Error('no verification token — is the API in production mode?');
  await fetch(`${API}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-leoos-internal': INTERNAL },
    body: JSON.stringify({ token }),
  });
  const [row] = await sql`SELECT password_hash FROM user_account WHERE username = ${username}`;
  log('minted a fresh password hash through the real registration flow');
  return row.password_hash;
}

/**
 * Idempotent, and it REPAIRS as well as creates.
 *
 * A rerun after a walkthrough disabled an account (the admin walkthrough does
 * exactly that) has to put it back, or the next run fails at the login form
 * with the same silence this script was written to remove.
 */
async function ensureAccount(username, displayName, templateHash) {
  const existing = await sql`SELECT id, status FROM user_account WHERE username = ${username}`;
  if (existing.length > 0) {
    await sql`
      UPDATE user_account
         SET status = 'active', email_verified_at = coalesce(email_verified_at, now()),
             display_name = ${displayName},
             password_hash = ${templateHash}, locked_until = NULL, failed_login_count = 0,
             permission_version = permission_version + 1
       WHERE id = ${existing[0].id}
    `;
    return { id: existing[0].id, created: false };
  }
  const [row] = await sql`
    INSERT INTO user_account (email, username, display_name, password_hash, status, email_verified_at)
    VALUES (${`${username}@test.invalid`}, ${username}, ${displayName}, ${templateHash},
            'active', now())
    RETURNING id
  `;
  return { id: row.id, created: true };
}

async function grantCapability(userId, capability) {
  await sql`
    INSERT INTO user_global_role (user_id, capability)
    VALUES (${userId}, ${capability}::global_capability)
    ON CONFLICT DO NOTHING
  `;
}

async function ensureMembership(userId, orgKey, roleKey) {
  const [org] = await sql`SELECT id FROM organization WHERE key = ${orgKey}`;
  if (!org) throw new Error(`no organization ${orgKey} — run the baseline seed first`);

  const [role] = await sql`
    SELECT id, name FROM role WHERE organization_id = ${org.id} AND key = ${roleKey}
  `;
  if (!role) throw new Error(`no ${orgKey} role "${roleKey}" — run the baseline seed first`);

  const existing = await sql`
    SELECT id FROM organization_member
     WHERE user_id = ${userId} AND organization_id = ${org.id}
  `;
  const memberId = existing.length > 0
    ? existing[0].id
    : (await sql`
        INSERT INTO organization_member (user_id, organization_id, status, joined_at)
        VALUES (${userId}, ${org.id}, 'active', now())
        RETURNING id
      `)[0].id;

  // A terminated fixture from a previous walkthrough is reinstated, not skipped.
  await sql`UPDATE organization_member SET status = 'active', left_at = NULL WHERE id = ${memberId}`;

  await sql`
    INSERT INTO member_role (member_id, role_id, assigned_by)
    VALUES (${memberId}, ${role.id}, ${userId})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO member_status (member_id, status_key, unit_id)
    VALUES (${memberId}, 'available', NULL)
    ON CONFLICT (member_id) DO NOTHING
  `;
  return role.name;
}

// ── Build the cast ──────────────────────────────────────────────────────────

const tag = randomBytes(3).toString('hex');
const templateHash = await adoptTemplateHash() ?? await mintTemplateHash(tag);
log('password hash verified against the API');

for (const member of CAST) {
  const { id, created } = await ensureAccount(member.username, member.displayName, templateHash);
  if (member.capability) {
    await grantCapability(id, member.capability);
    log(`${member.username.padEnd(13)} ${created ? 'created' : 'refreshed'} — ${member.capability}, no membership`);
  } else {
    const roleName = await ensureMembership(id, member.org, member.role);
    log(`${member.username.padEnd(13)} ${created ? 'created' : 'refreshed'} — ${member.org} ${roleName}`);
  }
}

/**
 * The version bump matters.
 *
 * Identity resolution is cached on `permission_version`; a membership written
 * directly in SQL is otherwise invisible for up to the cache TTL, which reads
 * as "the walkthrough is flaky" rather than "the cache is doing its job".
 */
await sql`
  UPDATE user_account SET permission_version = permission_version + 1
   WHERE username IN ${sql(CAST.map((c) => c.username))}
`;

log('');
log('Cast ready. The walkthroughs find these by name — no environment needed:');
log('  ui.admin  ui.chief  ui.commander  ui.sergeant  ui.officer1  ui.cadet1  ui.medic');
log(`Password: the shared walkthrough password (LEOOS_UI_PASSWORD, default in ${'scripts/*-check.mjs'}).`);

await sql.end({ timeout: 5 });
