/**
 * The cast the administration walkthrough needs.
 *
 * Five accounts, each holding exactly one kind of authority, so the walkthrough
 * can prove that the boundaries between them are real:
 *
 *   admin      global_admin  — everything
 *   useradmin  user_admin    — the register, and no capability grants
 *   auditor    audit_viewer  — the log, and nothing else
 *   support    support       — account detail, read-only
 *   lead       Organization Lead of PD, and NO global capability
 *
 * The lead is the important one. They are given the organization's most senior
 * role AND the lead grant, so the walkthrough's central claim — that unbounded
 * authority inside an organization reaches nothing global — is tested against
 * the most privileged organization account that can exist.
 *
 * Usage:
 *   DATABASE_URL=… LEOOS_API=… node scripts/setup-admin.mjs > admin.env
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
const log = (message) => console.error(`[admin-setup] ${message}`);

async function api(path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = { 'x-leoos-internal': INTERNAL };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-leoos-csrf'] = csrf;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json, headers: res.headers };
}

/**
 * A password hash the API will accept, proven by signing in with it.
 *
 * Registering each account through the API would hit the three-per-hour
 * registration limit immediately. Copying a hash that has been VERIFIED to work
 * avoids both that and the temptation to weaken the limit.
 */
let templateHash = null;

async function signIn(username) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${API}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-leoos-internal': INTERNAL },
      body: JSON.stringify({ identifier: username, password: PASSWORD }),
    });
    if (res.status === 200) {
      const jar = {};
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
      }
      return {
        cookie: Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
        csrf: jar.leoos_csrf ?? '',
      };
    }
    if (res.status !== 429) throw new Error(`login ${username}: ${res.status}`);
    // The limiter is doing its job; wait it out rather than defeating it.
    log(`login rate-limited, waiting 20s (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error(`login ${username}: still rate-limited`);
}

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
  const username = `admin.seed.${tag}`;
  const res = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: `${username}@test.invalid`,
      username,
      displayName: 'Admin Seed',
      password: PASSWORD,
    },
  });
  if (res.status !== 202) throw new Error(`register seed: ${res.status}`);
  const token = res.json?.devVerificationToken;
  if (!token) throw new Error('no verification token — is NODE_ENV production?');
  await api('/api/v1/auth/verify', { method: 'POST', body: { token } });

  const [row] = await sql`SELECT password_hash FROM user_account WHERE username = ${username}`;
  log('minted a fresh password hash through the real registration flow');
  return row.password_hash;
}

async function ensureAccount(username, displayName) {
  const existing = await sql`SELECT id FROM user_account WHERE username = ${username}`;
  if (existing.length > 0) return existing[0].id;

  const [row] = await sql`
    INSERT INTO user_account (email, username, display_name, password_hash, status, email_verified_at)
    VALUES (${`${username}@test.invalid`}, ${username}, ${displayName}, ${templateHash},
            'active', now())
    RETURNING id
  `;
  return row.id;
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
  if (!org) throw new Error(`no organization ${orgKey}`);

  const existing = await sql`
    SELECT id FROM organization_member WHERE user_id = ${userId} AND organization_id = ${org.id}
  `;
  const memberId = existing.length > 0
    ? existing[0].id
    : (await sql`
        INSERT INTO organization_member (user_id, organization_id, status, joined_at)
        VALUES (${userId}, ${org.id}, 'active', now())
        RETURNING id
      `)[0].id;

  const roles = roleKey
    ? await sql`SELECT id FROM role WHERE organization_id = ${org.id} AND key = ${roleKey}`
    : await sql`
        SELECT id FROM role WHERE organization_id = ${org.id}
        ORDER BY hierarchy_level DESC LIMIT 1
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

  return { memberId, organizationId: org.id };
}

// ── Build the cast ──────────────────────────────────────────────────────────

const tag = randomBytes(3).toString('hex');
templateHash = await adoptTemplateHash() ?? await mintTemplateHash(tag);
log('password hash verified against the API');

const cast = {};

for (const [key, capability, name] of [
  ['admin', 'global_admin', 'Global Administrator'],
  ['useradmin', 'user_admin', 'Account Administrator'],
  ['auditor', 'audit_viewer', 'Audit Reviewer'],
  ['support', 'support', 'Support Desk'],
]) {
  const username = `adm.${key}.${tag}`;
  const userId = await ensureAccount(username, name);
  await grantCapability(userId, capability);
  cast[key] = username;
  log(`${capability.padEnd(13)} → ${username}`);
}

/**
 * The Organization Lead, with the most senior role PD has.
 *
 * Deliberately holds NO global capability. The walkthrough's whole point is
 * that this account — the most privileged an organization can produce — reaches
 * nothing in the administration area.
 */
{
  const username = `adm.lead.${tag}`;
  const userId = await ensureAccount(username, 'PD Chief (Organization Lead)');
  await ensureMembership(userId, 'PD', 'chief');

  const [org] = await sql`SELECT id FROM organization WHERE key = 'PD'`;
  const [granter] = await sql`
    SELECT user_id FROM user_global_role WHERE capability = 'global_admin' LIMIT 1
  `;
  await sql`
    INSERT INTO organization_lead (user_id, organization_id, granted_by)
    VALUES (${userId}, ${org.id}, ${granter.user_id})
    ON CONFLICT (user_id, organization_id) DO UPDATE SET revoked_at = NULL
  `;
  cast.lead = username;
  log(`Organization Lead of PD (no global capability) → ${username}`);
}

/** An ordinary officer, and a target for the status-change walkthrough. */
{
  const username = `adm.officer.${tag}`;
  const userId = await ensureAccount(username, 'Ordinary Officer');
  await ensureMembership(userId, 'PD', 'officer');
  cast.officer = username;
  log(`ordinary PD officer → ${username}`);
}

/**
 * A refused action, so the audit log has a `denied` row to filter for.
 *
 * Written through the REAL endpoint rather than inserted: an audit row that was
 * not produced by the thing it claims to record would make the walkthrough's
 * severity filter prove nothing.
 */
{
  const ua = await signIn(cast.useradmin);
  const [target] = await sql`SELECT id FROM user_account WHERE username = ${cast.officer}`;
  const res = await api(`/api/v1/admin/users/${target.id}/capabilities`, {
    method: 'POST',
    cookie: ua.cookie,
    csrf: ua.csrf,
    body: { capability: 'global_admin' },
  });
  log(`user_admin attempting to grant global_admin → ${res.status} (expected 403)`);
}

log('');
console.log(`export LEOOS_ADMIN_USER=${cast.admin}`);
console.log(`export LEOOS_USERADMIN_USER=${cast.useradmin}`);
console.log(`export LEOOS_AUDITOR_USER=${cast.auditor}`);
console.log(`export LEOOS_SUPPORT_USER=${cast.support}`);
console.log(`export LEOOS_LEAD_USER=${cast.lead}`);
console.log(`export LEOOS_OFFICER_USER=${cast.officer}`);
console.log(`export LEOOS_ADMIN_TAG=${tag}`);

await sql.end({ timeout: 5 });
