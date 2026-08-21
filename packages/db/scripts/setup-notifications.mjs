/**
 * The cast the notification walkthrough needs.
 *
 * Six accounts, chosen so the walkthrough can prove the one property that
 * actually matters — that the audience is derived, not chosen:
 *
 *   dispatcher  PD lieutenant   — files the call. Excluded from its own alert.
 *   watcher     PD lieutenant   — holds dispatch.view and files nothing. Receives.
 *   officer     PD officer      — crews a unit; the person who calls the panic.
 *   blind       PD officer      — dispatch.view DENIED by override. Must NOT
 *                                 receive, despite being in the right
 *                                 organization at the right moment.
 *   outsider    MD doctor       — a full dispatcher in ANOTHER organization.
 *                                 Must not receive either.
 *   chief       PD chief        — holds organization.announce.
 *
 * `blind` is the important one. An audience computed from "everyone in the
 * organization" would include them, and only a real permission check excludes
 * them — so their empty feed is what distinguishes a derived audience from a
 * lazy one.
 *
 * NOTHING IS INSERTED INTO `notification` HERE. Every notification the
 * walkthrough asserts on is produced by calling the real endpoint that causes
 * it, because a row this script wrote would prove nothing about whether the
 * dispatch service produces one.
 *
 * Usage:
 *   DATABASE_URL=… LEOOS_API=… node scripts/setup-notifications.mjs > notify.env
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
const log = (message) => console.error(`[notify-setup] ${message}`);

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
  return { status: res.status, json };
}

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
    log(`login rate-limited, waiting 20s (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error(`login ${username}: still rate-limited`);
}

/**
 * A password hash the API will accept, proven by signing in with it.
 *
 * Registering each account through the API would hit the three-per-hour
 * registration limit immediately. Copying a hash that has been VERIFIED to work
 * avoids both that and the temptation to weaken the limit.
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
  const username = `notify.seed.${tag}`;
  const res = await api('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: `${username}@test.invalid`,
      username,
      displayName: 'Notify Seed',
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

let counter = 0;

async function ensureMembership(userId, orgKey, roleKey) {
  const [org] = await sql`SELECT id FROM organization WHERE key = ${orgKey}`;
  if (!org) throw new Error(`no organization ${orgKey}`);

  counter += 1;
  const suffix = `${Date.now().toString(36)}${counter}`;
  const existing = await sql`
    SELECT id FROM organization_member WHERE user_id = ${userId} AND organization_id = ${org.id}
  `;
  const memberId = existing.length > 0
    ? existing[0].id
    : (await sql`
        INSERT INTO organization_member
          (user_id, organization_id, callsign, employee_number, status, joined_at)
        VALUES (${userId}, ${org.id}, ${`N-${suffix}`}, ${suffix}, 'active', now())
        RETURNING id
      `)[0].id;

  const [role] = await sql`
    SELECT id FROM role WHERE organization_id = ${org.id} AND key = ${roleKey}
  `;
  if (!role) throw new Error(`no role ${orgKey}/${roleKey}`);
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

  return { memberId, organizationId: org.id };
}

// ── Build the cast ──────────────────────────────────────────────────────────

const tag = randomBytes(3).toString('hex');
templateHash = await adoptTemplateHash() ?? await mintTemplateHash(tag);
log('password hash verified against the API');

const cast = {};
const members = {};

for (const [key, orgKey, roleKey, name] of [
  ['dispatcher', 'PD', 'lieutenant', 'Watch Dispatcher'],
  // A SECOND dispatcher, who creates nothing.
  //
  // The actor is excluded from every audience — telling somebody what they just
  // did is noise — so the dispatcher who files the P1 is precisely the one
  // person who must not be notified about it. Asserting on their feed would
  // prove the opposite of what it looks like.
  ['watcher', 'PD', 'lieutenant', 'Watch Commander'],
  ['officer', 'PD', 'officer', 'Patrol Officer'],
  ['blind', 'PD', 'officer', 'Officer Without Dispatch'],
  ['chief', 'PD', 'chief', 'Chief of Police'],
  ['outsider', 'MD', 'doctor', 'Attending Physician'],
]) {
  const username = `ntf.${key}.${tag}`;
  const userId = await ensureAccount(username, name);
  const membership = await ensureMembership(userId, orgKey, roleKey);
  cast[key] = username;
  members[key] = { userId, ...membership };
  log(`${orgKey}/${roleKey.padEnd(11)} → ${username}`);
}

/**
 * The one account that must NOT receive.
 *
 * A member-level DENY override, which beats every role grant — so this is a PD
 * officer, present and active, who cannot see dispatch. If they appear in a
 * panic's audience, the audience was not derived from permissions.
 */
await sql`
  INSERT INTO member_permission_override (member_id, permission_key, effect, reason)
  VALUES (${members.blind.memberId}, 'dispatch.view', 'deny', 'notification walkthrough')
  ON CONFLICT (member_id, permission_key)
  DO UPDATE SET effect = 'deny'
`;
log(`dispatch.view DENIED for ${cast.blind}`);

/**
 * A unit for the officer, so an assignment has a crew to notify.
 *
 * Created through the API by the dispatcher and joined through the API by the
 * officer — a `unit_member` row this script inserted would not exercise the
 * path that produces the notification.
 */
const dispatcherSession = await signIn(cast.dispatcher);
const officerSession = await signIn(cast.officer);

const callsign = `N-${tag.toUpperCase()}`;
const unit = await api('/api/v1/dispatch/units', {
  method: 'POST',
  cookie: dispatcherSession.cookie,
  csrf: dispatcherSession.csrf,
  body: { callsign, unitType: 'patrol', joinSelf: false },
});
if (unit.status !== 201) throw new Error(`create unit: ${unit.status}`);
log(`unit ${callsign} created`);

const joined = await api(`/api/v1/dispatch/self/unit/${unit.json.id}`, {
  method: 'POST',
  cookie: officerSession.cookie,
  csrf: officerSession.csrf,
  body: {},
});
if (joined.status !== 200) throw new Error(`join unit: ${joined.status}`);
log(`${cast.officer} crewed ${callsign}`);

/**
 * A P1 call, assigned to that unit.
 *
 * Produces two of the notifications the walkthrough looks for — the critical
 * call for the dispatchers, and the assignment for the crew — through the real
 * endpoints, so what appears on screen is what the dispatch service actually
 * emits.
 */
const call = await api('/api/v1/dispatch/incidents', {
  method: 'POST',
  cookie: dispatcherSession.cookie,
  csrf: dispatcherSession.csrf,
  body: {
    title: 'Armed robbery in progress',
    priority: 1,
    locationText: 'Legion Square',
    description: 'CONFIDENTIAL-BRIEFING-TEXT',
    callerPhone: '555-0199',
  },
});
if (call.status !== 201) throw new Error(`create incident: ${call.status}`);
log(`P1 ${call.json.number} created`);

const assigned = await api(`/api/v1/dispatch/incidents/${call.json.id}/units`, {
  method: 'POST',
  cookie: dispatcherSession.cookie,
  csrf: dispatcherSession.csrf,
  body: { unitId: unit.json.id },
});
if (assigned.status !== 201) throw new Error(`assign unit: ${assigned.status}`);
log(`${callsign} assigned to ${call.json.number}`);

/** An announcement, so the organization category has something in it. */
const chiefSession = await signIn(cast.chief);
const announced = await api(
  `/api/v1/notifications/announcements/${members.chief.organizationId}`,
  {
    method: 'POST',
    cookie: chiefSession.cookie,
    csrf: chiefSession.csrf,
    body: {
      title: 'Shift briefing moved to 19:00',
      body: 'Briefing is in the muster room tonight, not the yard.',
      severity: 'warning',
    },
  },
);
if (announced.status !== 201) throw new Error(`announce: ${announced.status}`);
log(`announcement delivered to ${announced.json.recipients} members`);

log('');

const out = {
  ...cast,
  password: PASSWORD,
  unitId: unit.json.id,
  unitCallsign: callsign,
  incidentId: call.json.id,
  incidentNumber: call.json.number,
  organizationId: members.dispatcher.organizationId,
};

console.log(JSON.stringify(out, null, 2));
await sql.end();
