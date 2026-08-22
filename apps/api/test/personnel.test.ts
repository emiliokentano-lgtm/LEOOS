import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@leoos/db';
import { terminateMember } from '../src/modules/personnel/personnel.service.js';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin, makeOrgLead,
  organizationIdByKey, resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';
import { clearIdentityCache } from '../src/modules/auth/context.service.js';

/**
 * Personnel authorization — hierarchy abuse.
 *
 * These tests are adversarial by design. Each one takes an actor who holds the
 * RIGHT PERMISSION and shows that the permission alone does not carry them past
 * the rank rules: a Commander with `personnel.promote` still cannot promote
 * anyone to Deputy Chief, cannot promote themselves, cannot touch a peer, and
 * cannot reach into another organization.
 *
 * Seeded PD ranks used throughout (docs: packages/db/src/seed/organizations.ts):
 *
 *   chief          100  hire fire promote demote roles.assign + org.edit
 *   deputy_chief    90  hire fire promote demote roles.assign
 *   commander       80  hire fire promote demote roles.assign
 *   lieutenant      60  personnel.edit personnel.callsign   (no hire/fire)
 *   sergeant        50  personnel.edit personnel.callsign
 *   officer         30  field only
 *   cadet           10  base only
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

interface Person {
  username: string;
  userId: string;
  memberId: string;
  organizationId: string;
  headers: Record<string, string>;
}

/**
 * An active member of `orgKey` holding exactly `roleKey`, signed in.
 *
 * Clears the rate limiter first: several tests here build a five-rank chain of
 * command, and registration limiting is a separate concern with its own suite.
 * Leaving it armed would make this file fail on fixture setup rather than on
 * anything it is trying to prove.
 */
async function member(prefix: string, orgKey: string, roleKey: string): Promise<Person> {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  const m = await grantMembership(h.db, creds.username, { orgKey, roleKey });
  const auth = await signIn(h, creds);
  return {
    username: creds.username,
    userId: await userIdByUsername(h.db, creds.username),
    memberId: m.memberId,
    organizationId: m.organizationId,
    headers: auth.headers,
  };
}

/** An account with no membership anywhere — the candidate pool for hiring. */
async function outsider(prefix = 'outsider'): Promise<{ userId: string; username: string }> {
  h.app.limiter.resetAll();
  const creds = await createActiveUser(h, prefix);
  return { userId: await userIdByUsername(h.db, creds.username), username: creds.username };
}

async function roleId(orgKey: string, key: string): Promise<string> {
  const orgId = await organizationIdByKey(h.db, orgKey);
  const rows = await h.db.execute<{ id: string }>(
    sql`SELECT id FROM role WHERE organization_id = ${orgId} AND key = ${key}`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no role ${orgKey}/${key}`);
  return id;
}

/**
 * Creates a LOW-LEVEL role that nevertheless carries a high-risk permission.
 *
 * This is what isolates the subset rule (H4) from the level rule (H2): the level
 * check passes because the role sits below the actor, so a refusal can only come
 * from the permissions the role confers.
 */
async function trojanRole(orgKey: string, permission: string, level = 20): Promise<string> {
  const orgId = await organizationIdByKey(h.db, orgKey);
  const key = `trojan_${Math.random().toString(36).slice(2, 9)}`;
  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO role (organization_id, key, name, hierarchy_level)
    VALUES (${orgId}, ${key}, ${'Trojan ' + key}, ${level})
    RETURNING id
  `);
  const id = rows[0]!.id;
  await h.db.execute(sql`
    INSERT INTO role_permission (role_id, permission_key) VALUES (${id}, ${permission})
  `);
  return id;
}

const base = (orgId: string) => `/api/v1/organizations/${orgId}/personnel`;

/**
 * A callsign no earlier run can have used.
 *
 * Callsigns are unique per active member per organization, and the test database
 * keeps its members on purpose (see `resetAccounts` — operational history must
 * survive). A literal like 'L-99' would pass once and then collide forever.
 */
let callsignCounter = 0;
function freshCallsign(): string {
  callsignCounter += 1;
  return `T${Date.now().toString(36).slice(-5)}${callsignCounter}`.toUpperCase().slice(0, 16);
}

async function levelOf(memberId: string): Promise<number> {
  const rows = await h.db.execute<{ level: number }>(sql`
    SELECT COALESCE(MAX(r.hierarchy_level), 0)::int AS level
    FROM member_role mr JOIN role r ON r.id = mr.role_id
    WHERE mr.member_id = ${memberId}
  `);
  return Number(rows[0]?.level ?? 0);
}

async function statusOf(memberId: string): Promise<string> {
  const rows = await h.db.execute<{ status: string }>(
    sql`SELECT status FROM organization_member WHERE id = ${memberId}`,
  );
  return rows[0]!.status;
}

function reasonOf(res: { json: () => unknown }): string | undefined {
  return (res.json() as { error?: { detail?: { reason?: string } } }).error?.detail?.reason;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('promotion — the actor is the ceiling', () => {
  it('REFUSES promoting anyone ABOVE the actor', async () => {
    const commander = await member('cmdr', 'PD', 'commander');   // 80
    const officer = await member('offr', 'PD', 'officer');       // 30

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'deputy_chief') },   // 90 > 80
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
    expect(await levelOf(officer.memberId)).toBe(30);
  });

  it('REFUSES promoting anyone TO THE ACTOR\'S OWN LEVEL', async () => {
    // The boundary case. Peers are mutually immune (H1), so a subordinate raised
    // to the actor's exact level becomes untouchable by them — which is why the
    // bound is strict rather than inclusive.
    const commander = await member('cmdr', 'PD', 'commander');
    const officer = await member('offr', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'commander') },      // 80 == 80
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
    expect(await levelOf(officer.memberId)).toBe(30);
  });

  it('ALLOWS promoting strictly below the actor', async () => {
    const commander = await member('cmdr', 'PD', 'commander');
    const officer = await member('offr', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'lieutenant'), reason: 'Earned it.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'promote', fromLevel: 30, toLevel: 60 });
    expect(await levelOf(officer.memberId)).toBe(60);
  });

  it('REFUSES promoting a PEER', async () => {
    const a = await member('peerA', 'PD', 'commander');
    const b = await member('peerB', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: `${base(a.organizationId)}/${b.memberId}/rank`,
      headers: a.headers,
      payload: { roleId: await roleId('PD', 'lieutenant') },
    });

    // Refused on the TARGET, before the role is even considered — a peer is not
    // manageable regardless of which direction the change goes.
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('TARGET_RANK_NOT_LOWER');
    expect(await levelOf(b.memberId)).toBe(80);
  });

  it('REFUSES promoting SOMEONE ABOVE the actor, even downwards', async () => {
    const commander = await member('cmdr', 'PD', 'commander');   // 80
    const chief = await member('chief', 'PD', 'chief');          // 100

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${chief.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'cadet') },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('TARGET_RANK_NOT_LOWER');
    expect(await levelOf(chief.memberId)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('self-promotion', () => {
  it('REFUSES promoting yourself directly', async () => {
    const commander = await member('selfp', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${commander.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'chief') },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('SELF_ACTION_FORBIDDEN');
    expect(await levelOf(commander.memberId)).toBe(80);
  });

  it('REFUSES adding a role to yourself, even a lower one', async () => {
    // H6 has no "harmless" exception: self-management is refused outright, so a
    // path that looks like a sideways move cannot be used to build one up.
    const commander = await member('selfr', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${commander.memberId}/roles`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'lieutenant') },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('SELF_ACTION_FORBIDDEN');
  });

  it('REFUSES terminating yourself', async () => {
    const commander = await member('selft', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${commander.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Resigning loudly.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('SELF_ACTION_FORBIDDEN');
    expect(await statusOf(commander.memberId)).toBe('active');
  });

  it('REFUSES editing your own record', async () => {
    const commander = await member('selfe', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${commander.memberId}`,
      headers: commander.headers, payload: { callsign: 'ONE-1' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('SELF_ACTION_FORBIDDEN');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('permission escalation through role assignment (H4)', () => {
  it('REFUSES assigning a LOW role that carries a permission the actor lacks', async () => {
    // The subset rule has to follow the PERMISSIONS, not the level. A Commander
    // does not hold `organization.edit`; without H4 they could mint a level-20
    // role that carries it and hand it to a subordinate — or, next promotion
    // cycle, be handed it back.
    const commander = await member('h4a', 'PD', 'commander');
    const officer = await member('h4b', 'PD', 'officer');
    const trojan = await trojanRole('PD', 'organization.edit', 20);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/roles`,
      headers: commander.headers, payload: { roleId: trojan },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');

    const held = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM member_role
      WHERE member_id = ${officer.memberId} AND role_id = ${trojan}
    `);
    expect(Number(held[0]?.n)).toBe(0);
  });

  it('REFUSES a RANK CHANGE into a role carrying a permission the actor lacks', async () => {
    const commander = await member('h4c', 'PD', 'commander');
    const officer = await member('h4d', 'PD', 'officer');
    const trojan = await trojanRole('PD', 'roles.delete', 20);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/rank`,
      headers: commander.headers, payload: { roleId: trojan },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');
    expect(await levelOf(officer.memberId)).toBe(30);
  });

  it('REFUSES a HIRE into a role carrying a permission the actor lacks', async () => {
    const commander = await member('h4e', 'PD', 'commander');
    const newbie = await outsider();
    const trojan = await trojanRole('PD', 'organization.edit', 15);

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId),
      headers: commander.headers, payload: { userId: newbie.userId, roleId: trojan },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');
  });

  it('ALLOWS assigning a role whose permissions the actor does hold', async () => {
    const commander = await member('h4f', 'PD', 'commander');
    const officer = await member('h4g', 'PD', 'officer');
    // `dispatch.close` is in SUPERVISOR, which COMMAND includes.
    const benign = await trojanRole('PD', 'dispatch.close', 20);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/roles`,
      headers: commander.headers, payload: { roleId: benign },
    });

    expect(res.statusCode).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('hiring', () => {
  it('REFUSES hiring someone into a rank ABOVE the actor', async () => {
    const commander = await member('hireA', 'PD', 'commander');
    const newbie = await outsider();

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId),
      headers: commander.headers,
      payload: { userId: newbie.userId, roleId: await roleId('PD', 'chief') },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM organization_member
      WHERE user_id = ${newbie.userId} AND organization_id = ${commander.organizationId}
    `);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('REFUSES hiring into the actor\'s OWN rank', async () => {
    const commander = await member('hireB', 'PD', 'commander');
    const newbie = await outsider();

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId),
      headers: commander.headers,
      payload: { userId: newbie.userId, roleId: await roleId('PD', 'commander') },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
  });

  it('REFUSES hiring without the permission, however low the rank', async () => {
    // A Lieutenant supervises but does not staff. `personnel.hire` is a COMMAND
    // permission, and lacking it is fatal even for a cadet-level hire.
    const lt = await member('hireC', 'PD', 'lieutenant');
    const newbie = await outsider();

    const res = await h.app.inject({
      method: 'POST', url: base(lt.organizationId),
      headers: lt.headers,
      payload: { userId: newbie.userId, roleId: await roleId('PD', 'cadet') },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD');
  });

  it('ALLOWS hiring strictly below the actor', async () => {
    const commander = await member('hireD', 'PD', 'commander');
    const newbie = await outsider();

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId),
      headers: commander.headers,
      payload: {
        userId: newbie.userId, roleId: await roleId('PD', 'officer'), callsign: freshCallsign(),
      },
    });

    expect(res.statusCode).toBe(201);
    const { memberId } = res.json() as { memberId: string };
    expect(await levelOf(memberId)).toBe(30);
    expect(await statusOf(memberId)).toBe('active');
  });

  it('REFUSES hiring into ANOTHER organization', async () => {
    const commander = await member('hireE', 'PD', 'commander');
    const md = await organizationIdByKey(h.db, 'MD');
    const newbie = await outsider();

    const res = await h.app.inject({
      method: 'POST', url: base(md),
      headers: commander.headers,
      payload: { userId: newbie.userId, roleId: await roleId('MD', 'emt') },
    });

    expect([403, 404]).toContain(res.statusCode);
    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM organization_member
      WHERE user_id = ${newbie.userId} AND organization_id = ${md}
    `);
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('termination', () => {
  it('REFUSES terminating someone ABOVE the actor', async () => {
    const commander = await member('termA', 'PD', 'commander');
    const chief = await member('termB', 'PD', 'chief');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${chief.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Power grab.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('TARGET_RANK_NOT_LOWER');
    expect(await statusOf(chief.memberId)).toBe('active');
  });

  it('REFUSES terminating a PEER', async () => {
    const a = await member('termC', 'PD', 'commander');
    const b = await member('termD', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: `${base(a.organizationId)}/${b.memberId}/termination`,
      headers: a.headers, payload: { reason: 'Office politics.' },
    });

    expect(res.statusCode).toBe(403);
    expect(await statusOf(b.memberId)).toBe('active');
  });

  it('PRESERVES history when a termination succeeds', async () => {
    // Engineering rule 24: terminate is a state change, never a delete. The row,
    // its roles, its callsign and its join date all survive.
    const commander = await member('termE', 'PD', 'commander');
    const officer = await member('termF', 'PD', 'officer');

    const before = await h.db.execute<{ callsign: string; joined_at: string }>(sql`
      SELECT callsign, joined_at FROM organization_member WHERE id = ${officer.memberId}
    `);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Failed firearms qualification.' },
    });
    expect(res.statusCode).toBe(200);

    const after = await h.db.execute<{
      status: string; callsign: string | null; joined_at: string; left_at: string | null;
      termination_reason: string | null; terminated_by: string | null;
    }>(sql`
      SELECT status, callsign, joined_at, left_at, termination_reason, terminated_by
      FROM organization_member WHERE id = ${officer.memberId}
    `);
    const row = after[0]!;

    expect(row.status).toBe('terminated');
    expect(row.callsign).toBe(before[0]!.callsign);
    expect(String(row.joined_at)).toBe(String(before[0]!.joined_at));
    expect(row.left_at).not.toBeNull();
    expect(row.termination_reason).toBe('Failed firearms qualification.');
    expect(row.terminated_by).toBe(commander.userId);

    // Roles are kept — the record of what they held is part of the history.
    const roles = await h.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM member_role WHERE member_id = ${officer.memberId}
    `);
    expect(Number(roles[0]?.n)).toBeGreaterThan(0);

    // And the audit entry survives with the reason attached.
    const audit = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE entity_id = ${officer.memberId} AND action = 'personnel.terminated'
    `);
    expect(audit.length).toBe(1);
  });

  it('ends the terminated member\'s sessions immediately', async () => {
    const commander = await member('termG', 'PD', 'commander');
    const creds = await createActiveUser(h, 'termH');
    const m = await grantMembership(h.db, creds.username, { orgKey: 'PD', roleKey: 'officer' });
    const victim = await signIn(h, creds);

    // Their session works before...
    const okBefore = await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: victim.headers,
    });
    expect(okBefore.statusCode).toBe(200);

    await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${m.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Immediate separation.' },
    });

    // ...and not after. Access ends with the decision, not with the cookie.
    const after = await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: victim.headers,
    });
    expect(after.statusCode).toBe(401);
  });

  it('lets a terminated member be re-hired onto the SAME record', async () => {
    const commander = await member('rehireA', 'PD', 'commander');
    const officer = await member('rehireB', 'PD', 'officer');

    await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Left for a while.' },
    });

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId),
      headers: commander.headers,
      payload: { userId: officer.userId, roleId: await roleId('PD', 'cadet') },
    });

    expect(res.statusCode).toBe(201);
    // Same row: one continuous employment history rather than a second record.
    expect((res.json() as { memberId: string }).memberId).toBe(officer.memberId);
    expect(await statusOf(officer.memberId)).toBe('active');
    // A re-hire does not silently restore the old rank.
    expect(await levelOf(officer.memberId)).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a terminated member is inert', () => {
  it('strips the terminated member of rank and of the ability to act', async () => {
    const chief = await member('inertA', 'PD', 'chief');
    const commander = await member('inertB', 'PD', 'commander');
    const officer = await member('inertC', 'PD', 'officer');

    // Sign the commander in again after termination revokes their session, to
    // prove the refusal comes from their standing and not merely a dead cookie.
    await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${commander.memberId}/termination`,
      headers: chief.headers, payload: { reason: 'Separated.' },
    });

    const res = await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${officer.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('PD', 'sergeant') },
    });

    expect(res.statusCode).toBe(401);
    expect(await levelOf(officer.memberId)).toBe(30);
  });

  it('REFUSES a rank change on a terminated member', async () => {
    const chief = await member('inertD', 'PD', 'chief');
    const officer = await member('inertE', 'PD', 'officer');

    await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${officer.memberId}/termination`,
      headers: chief.headers, payload: { reason: 'Separated.' },
    });

    const res = await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${officer.memberId}/rank`,
      headers: chief.headers, payload: { roleId: await roleId('PD', 'sergeant') },
    });

    expect(res.statusCode).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('organization scoping', () => {
  it('REFUSES a PD commander managing an MD member', async () => {
    const commander = await member('scopeA', 'PD', 'commander');
    const medic = await member('scopeB', 'MD', 'emt');

    // Under MD's own path — the honest attempt. 404 rather than 403, because a
    // 403 would confirm that a member with this id exists over in MD.
    const viaMd = await h.app.inject({
      method: 'POST', url: `${base(medic.organizationId)}/${medic.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Not my org.' },
    });
    expect(viaMd.statusCode).toBe(404);

    // And under PD's path with an MD member id — the forged one.
    const viaPd = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${medic.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Path says PD.' },
    });
    expect(viaPd.statusCode).toBe(404);

    expect(await statusOf(medic.memberId)).toBe('active');
  });

  it('REFUSES cross-organization management at the SERVICE layer too', async () => {
    // The route guard above answers 404 before the service is reached. This
    // proves the service refuses independently, so a future route that forgets
    // the guard is still safe (defence in depth, engineering rule 11).
    const commander = await member('scopeSvcA', 'PD', 'commander');
    const medic = await member('scopeSvcB', 'MD', 'emt');

    await expect(
      terminateMember(h.db, commander.userId, { memberId: medic.memberId, reason: 'Direct.' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await statusOf(medic.memberId)).toBe('active');
  });

  it('REFUSES a PD lead managing MD personnel', async () => {
    // The lead capability is per-organization and confers UNBOUNDED level — in
    // its own organization only.
    const granter = await createActiveUser(h, 'granter');
    const lead = await member('leadA', 'PD', 'cadet');
    await makeOrgLead(h.db, lead.username, 'PD', granter.username);
    const relead = await signIn(h, { username: lead.username, password: 'correct-horse-staple-42' });
    const medic = await member('leadB', 'MD', 'doctor');

    const res = await h.app.inject({
      method: 'POST', url: `${base(medic.organizationId)}/${medic.memberId}/termination`,
      headers: relead.headers, payload: { reason: 'Overreach.' },
    });

    expect(res.statusCode).toBe(404);
    expect(await statusOf(medic.memberId)).toBe('active');

    // And the service refuses it on its own, with the scope reason.
    await expect(
      terminateMember(h.db, lead.userId, { memberId: medic.memberId, reason: 'Overreach.' }),
    ).rejects.toMatchObject({ detail: { reason: 'CROSS_ORGANIZATION' } });
    expect(await statusOf(medic.memberId)).toBe('active');
  });

  it('hides another organization\'s roster as NOT FOUND', async () => {
    const commander = await member('scopeC', 'PD', 'commander');
    const md = await organizationIdByKey(h.db, 'MD');

    const res = await h.app.inject({
      method: 'GET', url: base(md), headers: commander.headers,
    });

    // 404, not 403 — a 403 would confirm the organization has personnel.
    expect(res.statusCode).toBe(404);
  });

  it('REFUSES a role from another organization', async () => {
    const commander = await member('scopeD', 'PD', 'commander');
    const officer = await member('scopeE', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/rank`,
      headers: commander.headers,
      payload: { roleId: await roleId('MD', 'emt') },   // level 20, well below 80
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('CROSS_ORGANIZATION');
    expect(await levelOf(officer.memberId)).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('leads and global administrators', () => {
  it('REFUSES a lead managing another lead of the same organization', async () => {
    // Two unbounded actors: neither strictly outranks the other, so the peer
    // rule applies to them exactly as it does to two Commanders.
    const granter = await createActiveUser(h, 'granter');
    const a = await member('leadC', 'PD', 'cadet');
    const b = await member('leadD', 'PD', 'cadet');
    await makeOrgLead(h.db, a.username, 'PD', granter.username);
    await makeOrgLead(h.db, b.username, 'PD', granter.username);
    const authA = await signIn(h, { username: a.username, password: 'correct-horse-staple-42' });

    const res = await h.app.inject({
      method: 'POST', url: `${base(a.organizationId)}/${b.memberId}/termination`,
      headers: authA.headers, payload: { reason: 'Rival.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('TARGET_RANK_NOT_LOWER');
  });

  it('REFUSES a lead terminating a GLOBAL ADMINISTRATOR', async () => {
    const granter = await createActiveUser(h, 'granter');
    const lead = await member('leadE', 'PD', 'cadet');
    await makeOrgLead(h.db, lead.username, 'PD', granter.username);
    const authLead = await signIn(h, { username: lead.username, password: 'correct-horse-staple-42' });

    const admin = await member('gadminA', 'PD', 'officer');
    await makeGlobalAdmin(h.db, admin.username);

    const res = await h.app.inject({
      method: 'POST', url: `${base(lead.organizationId)}/${admin.memberId}/termination`,
      headers: authLead.headers, payload: { reason: 'Cannot happen.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('TARGET_IS_GLOBAL_ADMIN');
    expect(await statusOf(admin.memberId)).toBe('active');
  });

  it('REFUSES a commander managing an ORGANIZATION LEAD', async () => {
    const granter = await createActiveUser(h, 'granter');
    const commander = await member('cmdrX', 'PD', 'commander');
    const lead = await member('leadF', 'PD', 'cadet');
    await makeOrgLead(h.db, lead.username, 'PD', granter.username);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${lead.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Cadet on paper.' },
    });

    // The lead's nominal rank is CADET. Reading rank off the role alone would
    // let a Commander fire the person who runs the organization.
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('TARGET_IS_ORG_LEAD');
    expect(await statusOf(lead.memberId)).toBe('active');
  });

  it('lets a global administrator act across organizations', async () => {
    const admin = await createActiveUser(h, 'gadminB');
    await makeGlobalAdmin(h.db, admin.username);
    const authAdmin = await signIn(h, admin);
    const medic = await member('mdA', 'MD', 'emt');

    const res = await h.app.inject({
      method: 'POST', url: `${base(medic.organizationId)}/${medic.memberId}/rank`,
      headers: authAdmin.headers, payload: { roleId: await roleId('MD', 'doctor') },
    });

    expect(res.statusCode).toBe(200);
    expect(await levelOf(medic.memberId)).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('role removal and callsigns', () => {
  it('REFUSES removing a role the actor could not have granted', async () => {
    // Removal is a rank change too. Without the check, a Lieutenant with
    // `roles.assign` could strip a subordinate of a role they could never
    // restore — or strip a rival down before a promotion round.
    const chief = await member('rmA', 'PD', 'chief');
    const commander = await member('rmB', 'PD', 'commander');
    const officer = await member('rmC', 'PD', 'officer');

    // The chief seats the officer at deputy-chief level as a second role.
    await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${officer.memberId}/roles`,
      headers: chief.headers, payload: { roleId: await roleId('PD', 'deputy_chief') },
    });

    // Now the officer outranks the commander, who may not touch them at all.
    const res = await h.app.inject({
      method: 'DELETE',
      url: `${base(commander.organizationId)}/${officer.memberId}/roles/${await roleId('PD', 'deputy_chief')}`,
      headers: commander.headers,
    });

    expect(res.statusCode).toBe(403);
    expect(await levelOf(officer.memberId)).toBe(90);
  });

  it('REFUSES removing a member\'s LAST role', async () => {
    const commander = await member('rmD', 'PD', 'commander');
    const officer = await member('rmE', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'DELETE',
      url: `${base(commander.organizationId)}/${officer.memberId}/roles/${await roleId('PD', 'officer')}`,
      headers: commander.headers,
    });

    // A member with no role has no rank, which would make them unmanageable by
    // everyone below the org lead. Terminate instead.
    expect(res.statusCode).toBe(409);
    expect(await levelOf(officer.memberId)).toBe(30);
  });

  it('lets a supervisor set a callsign but NOT edit a superior\'s', async () => {
    const sergeant = await member('csA', 'PD', 'sergeant');     // 50, has callsign perm
    const officer = await member('csB', 'PD', 'officer');       // 30
    const lieutenant = await member('csC', 'PD', 'lieutenant'); // 60

    const ok = await h.app.inject({
      method: 'PATCH', url: `${base(sergeant.organizationId)}/${officer.memberId}`,
      headers: sergeant.headers, payload: { callsign: freshCallsign() },
    });
    expect(ok.statusCode).toBe(200);

    const refused = await h.app.inject({
      method: 'PATCH', url: `${base(sergeant.organizationId)}/${lieutenant.memberId}`,
      headers: sergeant.headers, payload: { callsign: freshCallsign() },
    });
    expect(refused.statusCode).toBe(403);
    expect(reasonOf(refused)).toBe('TARGET_RANK_NOT_LOWER');
  });

  it('REFUSES a duplicate callsign within an organization', async () => {
    const commander = await member('csD', 'PD', 'commander');
    const a = await member('csE', 'PD', 'officer');
    const b = await member('csF', 'PD', 'officer');

    const shared = freshCallsign();
    const first = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${a.memberId}`,
      headers: commander.headers, payload: { callsign: shared },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${b.memberId}`,
      headers: commander.headers, payload: { callsign: shared },
    });
    expect(second.statusCode).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('audit trail', () => {
  it('records a REFUSED attempt, not just successful ones', async () => {
    // A member repeatedly reaching above their rank is the signal an operations
    // lead needs. The denial is written outside the rolled-back transaction, so
    // the rollback cannot take it with it.
    const commander = await member('audA', 'PD', 'commander');
    const chief = await member('audB', 'PD', 'chief');

    await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${chief.memberId}/termination`,
      headers: commander.headers, payload: { reason: 'Attempted coup.' },
    });

    const rows = await h.db.execute<{ outcome: string; actor_user_id: string }>(sql`
      SELECT outcome, actor_user_id FROM audit_log
      WHERE entity_id = ${chief.memberId} AND action = 'personnel.terminated'
      ORDER BY occurred_at DESC LIMIT 1
    `);

    expect(rows[0]?.outcome).toBe('denied');
    expect(rows[0]?.actor_user_id).toBe(commander.userId);
  });

  it('audits a demotion as a DEMOTION even when the caller aims at the promote route', async () => {
    // The direction is derived from the levels server-side, so the audit trail
    // describes the effect rather than the caller's chosen wording.
    const commander = await member('audC', 'PD', 'commander');
    const lt = await member('audD', 'PD', 'lieutenant');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${lt.memberId}/rank`,
      headers: commander.headers, payload: { roleId: await roleId('PD', 'officer') },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { kind: string }).kind).toBe('demote');

    const rows = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE entity_id = ${lt.memberId} AND outcome = 'success'
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(rows[0]?.action).toBe('personnel.demoted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reads', () => {
  it('never exposes a password hash or a session token', async () => {
    const commander = await member('readA', 'PD', 'commander');
    await member('readB', 'PD', 'officer');

    const list = await h.app.inject({
      method: 'GET', url: base(commander.organizationId), headers: commander.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/password/i);
    expect(list.body).not.toMatch(/\$argon2/);
    expect(list.body).not.toMatch(/tokenHash|token_hash|totp/i);
  });

  it('marks who the caller may manage without deciding anything', async () => {
    // Scoped by search: the roster is paged, and the test database holds
    // hundreds of members from earlier runs.
    const tag = `mng${Date.now().toString(36)}`;
    const commander = await member(`${tag}c`, 'PD', 'commander');
    const officer = await member(`${tag}o`, 'PD', 'officer');
    const chief = await member(`${tag}k`, 'PD', 'chief');

    const res = await h.app.inject({
      method: 'GET', url: `${base(commander.organizationId)}?search=${tag}`,
      headers: commander.headers,
    });
    const rows = (res.json() as { personnel: { memberId: string; manageable: boolean }[] }).personnel;

    expect(rows.find((r) => r.memberId === officer.memberId)?.manageable).toBe(true);
    expect(rows.find((r) => r.memberId === chief.memberId)?.manageable).toBe(false);
    expect(rows.find((r) => r.memberId === commander.memberId)?.manageable).toBe(false);
  });

  it('filters terminated members out of the default roster but keeps them findable', async () => {
    const tag = `flt${Date.now().toString(36)}`;
    const chief = await member(`${tag}k`, 'PD', 'chief');
    const officer = await member(`${tag}o`, 'PD', 'officer');

    await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${officer.memberId}/termination`,
      headers: chief.headers, payload: { reason: 'Moved away.' },
    });

    const active = await h.app.inject({
      method: 'GET', url: `${base(chief.organizationId)}?search=${tag}`, headers: chief.headers,
    });
    const activeIds = (active.json() as { personnel: { memberId: string }[] })
      .personnel.map((p) => p.memberId);
    expect(activeIds).not.toContain(officer.memberId);

    const all = await h.app.inject({
      method: 'GET', url: `${base(chief.organizationId)}?search=${tag}&status=terminated`,
      headers: chief.headers,
    });
    const allIds = (all.json() as { personnel: { memberId: string }[] })
      .personnel.map((p) => p.memberId);
    expect(allIds).toContain(officer.memberId);
  });

  it('pages the roster and reports the full total', async () => {
    // An unbounded roster is a denial-of-service surface and an unusable screen.
    const tag = `pag${Date.now().toString(36)}`;
    const chief = await member(`${tag}k`, 'PD', 'chief');
    await member(`${tag}a`, 'PD', 'officer');
    await member(`${tag}b`, 'PD', 'officer');
    await member(`${tag}c`, 'PD', 'officer');

    const first = await h.app.inject({
      method: 'GET', url: `${base(chief.organizationId)}?search=${tag}&limit=2`,
      headers: chief.headers,
    });
    const page1 = first.json() as { personnel: { memberId: string }[]; total: number };
    expect(page1.personnel).toHaveLength(2);
    // The total describes the whole match, not the page.
    expect(page1.total).toBe(4);

    const second = await h.app.inject({
      method: 'GET', url: `${base(chief.organizationId)}?search=${tag}&limit=2&offset=2`,
      headers: chief.headers,
    });
    const page2 = second.json() as { personnel: { memberId: string }[]; total: number };
    expect(page2.personnel).toHaveLength(2);
    expect(page2.total).toBe(4);

    // Pages must not overlap — the ordering carries a tie-break for exactly this.
    const ids = new Set([...page1.personnel, ...page2.personnel].map((p) => p.memberId));
    expect(ids.size).toBe(4);
  });

  it('refuses an unbounded page size', async () => {
    const chief = await member('limitA', 'PD', 'chief');
    const res = await h.app.inject({
      method: 'GET', url: `${base(chief.organizationId)}?limit=100000`, headers: chief.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a member id from another organization on the profile route', async () => {
    const commander = await member('readF', 'PD', 'commander');
    const medic = await member('readG', 'MD', 'emt');

    const res = await h.app.inject({
      method: 'GET', url: `${base(commander.organizationId)}/${medic.memberId}`,
      headers: commander.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses candidate enumeration to someone who cannot hire', async () => {
    const officer = await member('readH', 'PD', 'officer');

    const res = await h.app.inject({
      method: 'GET', url: `${base(officer.organizationId)}/candidates`, headers: officer.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TOCTOU — a permission check before the transaction is a statement about the past', () => {
  it('REFUSES a promotion decided on the actor\'s rank as it was when the request arrived', async () => {
    /**
     * The race this closes:
     *
     *   t0  the Chief demotes the Commander to Officer
     *   t0  the Commander concurrently submits "promote X to Lieutenant"
     *
     * Sequenced deterministically here by holding a lock on the Commander's
     * membership row while their request is in flight: the request blocks on
     * `SELECT … FOR UPDATE`, the demotion commits, and the request then re-reads
     * the actor from the row it finally locked. A pre-transaction check would
     * have approved it.
     */
    const commander = await member('toctouB', 'PD', 'commander');
    const officer = await member('toctouC', 'PD', 'officer');
    const lieutenantRole = await roleId('PD', 'lieutenant');
    const officerRole = await roleId('PD', 'officer');

    const side = createDatabase({
      url: h.config.DATABASE_URL, max: 2, statementTimeoutMs: 15_000, ssl: false,
    });

    try {
      let inFlight: Promise<unknown> | null = null;

      await side.db.transaction(async (tx) => {
        // Hold the actor's membership row.
        await tx.execute(sql`
          SELECT id FROM organization_member WHERE id = ${commander.memberId} FOR UPDATE
        `);

        // The promotion request now blocks trying to lock the same row.
        inFlight = h.app.inject({
          method: 'POST', url: `${base(commander.organizationId)}/${officer.memberId}/rank`,
          headers: commander.headers, payload: { roleId: lieutenantRole },
        });

        // Give it time to reach the lock rather than race the assertion.
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Demote the actor while their request waits.
        await tx.execute(sql`DELETE FROM member_role WHERE member_id = ${commander.memberId}`);
        await tx.execute(sql`
          INSERT INTO member_role (member_id, role_id)
          VALUES (${commander.memberId}, ${officerRole})
        `);
      });

      const res = await (inFlight as unknown as Promise<{ statusCode: number; json: () => unknown }>);

      // The actor is now an Officer (30) facing an Officer (30): peers, so the
      // refusal lands on the target check before the role is even considered.
      // Either way the promotion does not happen — which is the point.
      expect(res.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('TARGET_RANK_NOT_LOWER');
      expect(await levelOf(officer.memberId)).toBe(30);
    } finally {
      await side.close().catch(() => {});
      await side.sql.end({ timeout: 5 }).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H8 · Per-member permission overrides
// ═══════════════════════════════════════════════════════════════════════════

describe('permission overrides — the exception to the rank model', () => {
  /**
   * The key used throughout: PD's Chief holds `map.history`, and neither the
   * Sergeant nor the Officer does. That separation is what lets these tests
   * isolate the subset rule from the rank rule — a refusal cannot be blamed on
   * the wrong one.
   */
  const EXCEPTION_KEY = 'map.history';
  const REASON = 'Vinewood case, approved by the chief';

  const url = (m: Person, key = EXCEPTION_KEY) =>
    `/api/v1/organizations/${m.organizationId}/personnel/${m.memberId}/overrides/${key}`;

  const set = (actor: Person, targetMember: Person, body: Record<string, unknown>, key = EXCEPTION_KEY) =>
    h.app.inject({
      method: 'PUT', url: url(targetMember, key), headers: actor.headers, payload: body,
    });

  const clear = (actor: Person, targetMember: Person, key = EXCEPTION_KEY) =>
    h.app.inject({ method: 'DELETE', url: url(targetMember, key), headers: actor.headers });

  /** The member's effective permissions, as the API itself reports them. */
  async function effective(who: Person): Promise<string[]> {
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me', headers: who.headers,
    });
    const body = res.json() as {
      session: { memberships: { organization: { id: string }; permissions: string[] }[] };
    };
    return body.session.memberships
      .find((m) => m.organization.id === who.organizationId)?.permissions ?? [];
  }

  it('grants a permission to one person, and it takes effect immediately', async () => {
    const chief = await member('ovchief', 'PD', 'chief');
    const officer = await member('ovofficer', 'PD', 'officer');

    expect(await effective(officer)).not.toContain(EXCEPTION_KEY);

    const res = await set(chief, officer, { effect: 'grant', reason: REASON });
    expect(res.statusCode, res.body).toBe(200);

    // No wait: the override bumped the permission version the identity cache is
    // keyed on, so it is visible on the very next request.
    expect(await effective(officer)).toContain(EXCEPTION_KEY);
  });

  it('denies a permission the member’s own role carries', async () => {
    const chief = await member('ovdenychief', 'PD', 'chief');
    const sergeant = await member('ovdenysgt', 'PD', 'sergeant');

    const held = await effective(sergeant);
    const key = held.find((k) => k !== 'dispatch.view') ?? held[0]!;
    expect(key, 'sergeant holds nothing to deny').toBeTruthy();
    // The chief may deny it whether or not they hold it themselves — a deny
    // only ever reduces authority. See `canSetPermissionOverride`.

    expect((await set(chief, sergeant, { effect: 'deny', reason: REASON }, key)).statusCode)
      .toBe(200);
    expect(await effective(sergeant)).not.toContain(key);
  });

  it('clears an override, returning the member to what their roles say', async () => {
    const chief = await member('ovclearchief', 'PD', 'chief');
    const officer = await member('ovclearofficer', 'PD', 'officer');

    await set(chief, officer, { effect: 'grant', reason: REASON });
    expect(await effective(officer)).toContain(EXCEPTION_KEY);

    expect((await clear(chief, officer)).statusCode).toBe(200);
    expect(await effective(officer)).not.toContain(EXCEPTION_KEY);
  });

  it('is idempotent — writing it twice is the same exception, not two', async () => {
    const chief = await member('ovtwice', 'PD', 'chief');
    const officer = await member('ovtwiceoff', 'PD', 'officer');

    expect((await set(chief, officer, { effect: 'grant', reason: REASON })).statusCode).toBe(200);
    expect((await set(chief, officer, { effect: 'grant', reason: 'a second look' })).statusCode)
      .toBe(200);

    const rows = await h.db.execute<{ n: number; reason: string }>(sql`
      SELECT count(*)::int AS n, max(reason) AS reason FROM member_permission_override
       WHERE member_id = ${officer.memberId} AND permission_key = ${EXCEPTION_KEY}
    `);
    expect(rows[0]!.n).toBe(1);
    expect(rows[0]!.reason).toBe('a second look');
  });

  // ── Escalation ───────────────────────────────────────────────────────────

  it('REFUSES writing an override for YOURSELF', async () => {
    const chief = await member('ovself', 'PD', 'chief');
    const res = await set(chief, chief, { effect: 'grant', reason: REASON });
    expect(res.statusCode).toBe(403);

    // Asserted on the TABLE, not on the effective set: a chief already holds
    // this key through their role, so "still has it" would be true either way
    // and the test would pass without the refusal.
    const [row] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM member_permission_override
       WHERE member_id = ${chief.memberId}
    `);
    expect(row!.n).toBe(0);
  });

  it('REFUSES granting a permission the actor does not hold', async () => {
    const sergeant = await member('ovsubset', 'PD', 'sergeant');
    const officer = await member('ovsubsetoff', 'PD', 'officer');

    /**
     * The sergeant is given `roles.permissions` DELIBERATELY.
     *
     * Without it the refusal would come from the route's coarse permission
     * guard, and the test would pass while proving nothing about H4. Given it,
     * the sergeant outranks the officer and holds the right to write overrides —
     * the only thing they lack is the key itself, so a refusal can only be the
     * subset rule.
     */
    await setPermissionOverride(h.db, sergeant.memberId, 'roles.permissions', 'grant');
    expect(await effective(sergeant)).toContain('roles.permissions');
    expect(await effective(sergeant)).not.toContain(EXCEPTION_KEY);

    const res = await set(sergeant, officer, { effect: 'grant', reason: REASON });
    expect(res.statusCode).toBe(403);
    expect(await effective(officer)).not.toContain(EXCEPTION_KEY);
  });

  it('REFUSES an override on somebody of equal or higher rank', async () => {
    const one = await member('ovpeera', 'PD', 'sergeant');
    const two = await member('ovpeerb', 'PD', 'sergeant');
    const senior = await member('ovsenior', 'PD', 'chief');

    expect((await set(one, two, { effect: 'deny', reason: REASON })).statusCode).toBe(403);
    expect((await set(one, senior, { effect: 'deny', reason: REASON })).statusCode).toBe(403);
  });

  it('REFUSES an override on a member of another organization, as a 404', async () => {
    const chief = await member('ovcrossorg', 'PD', 'chief');
    const foreign = await member('ovcrossmd', 'MD', 'doctor');

    // The path names MD's organization, so it is out of the caller's scope and
    // must not confirm the member exists.
    const res = await h.app.inject({
      method: 'PUT', url: url(foreign), headers: chief.headers,
      payload: { effect: 'grant', reason: REASON },
    });
    expect(res.statusCode).toBe(404);
  });

  it('REFUSES a GLOBAL-scope permission, which no organization role can carry', async () => {
    const chief = await member('ovglobal', 'PD', 'chief');
    const officer = await member('ovglobaloff', 'PD', 'officer');

    for (const key of ['admin.users', 'admin.audit_logs']) {
      const res = await set(chief, officer, { effect: 'grant', reason: REASON }, key);
      expect([400, 403], `${key} → ${res.statusCode}`).toContain(res.statusCode);
    }
    expect(await effective(officer)).not.toContain('admin.users');
  });

  it('REFUSES without roles.permissions, however senior the caller', async () => {
    const chief = await member('ovnoperm', 'PD', 'chief');
    const officer = await member('ovnopermoff', 'PD', 'officer');
    await setPermissionOverride(h.db, chief.memberId, 'roles.permissions', 'deny');

    const res = await set(chief, officer, { effect: 'grant', reason: REASON });
    expect(res.statusCode).toBe(403);
  });

  // ── Validation ───────────────────────────────────────────────────────────

  it('REFUSES an unknown permission key by name, not as a constraint violation', async () => {
    const chief = await member('ovunknown', 'PD', 'chief');
    const officer = await member('ovunknownoff', 'PD', 'officer');

    const res = await set(chief, officer, { effect: 'grant', reason: REASON }, 'not.a.permission');
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('permissionKey');
  });

  it('REQUIRES a reason, and will not take a token one', async () => {
    const chief = await member('ovreason', 'PD', 'chief');
    const officer = await member('ovreasonoff', 'PD', 'officer');

    for (const reason of [undefined, '', 'x', '   ']) {
      const res = await set(chief, officer,
        reason === undefined ? { effect: 'grant' } : { effect: 'grant', reason });
      expect(res.statusCode, JSON.stringify(reason)).toBe(400);
    }
  });

  it('REFUSES an expiry in the past, which would be an override that never applied', async () => {
    const chief = await member('ovpast', 'PD', 'chief');
    const officer = await member('ovpastoff', 'PD', 'officer');

    const res = await set(chief, officer, {
      effect: 'grant', reason: REASON,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('REFUSES an override on a membership that is not active', async () => {
    // It would sit in the table looking like a grant, do nothing, and come alive
    // silently if the person were ever reinstated.
    const chief = await member('ovinactive', 'PD', 'chief');
    const officer = await member('ovinactiveoff', 'PD', 'officer');
    await h.db.execute(sql`
      UPDATE organization_member SET status = 'suspended' WHERE id = ${officer.memberId}
    `);

    const res = await set(chief, officer, { effect: 'grant', reason: REASON });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'MEMBER_NOT_ACTIVE' } });
  });

  it('clearing an override that is not there is a 404, not a silent success', async () => {
    const chief = await member('ovmissing', 'PD', 'chief');
    const officer = await member('ovmissingoff', 'PD', 'officer');
    expect((await clear(chief, officer)).statusCode).toBe(404);
  });

  // ── Expiry ───────────────────────────────────────────────────────────────

  it('stops applying once it has expired, without anything running', async () => {
    /**
     * The case the identity cache's TTL exists for.
     *
     * Nothing happens when an override reaches `expires_at`: no transaction
     * commits, no version is bumped, no sweep runs. The permission simply stops
     * being in force, because every read filters on the expiry. This test moves
     * the expiry into the past directly — the alternative is waiting for real
     * time to pass, which tests the clock rather than the predicate.
     */
    const chief = await member('ovexpiry', 'PD', 'chief');
    const officer = await member('ovexpiryoff', 'PD', 'officer');

    await set(chief, officer, {
      effect: 'grant', reason: REASON,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await effective(officer)).toContain(EXCEPTION_KEY);

    await h.db.execute(sql`
      UPDATE member_permission_override SET expires_at = now() - interval '1 minute'
       WHERE member_id = ${officer.memberId} AND permission_key = ${EXCEPTION_KEY}
    `);
    // The row is still there — an expired exception is a record of something
    // that was once approved.
    const [row] = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM member_permission_override
       WHERE member_id = ${officer.memberId} AND permission_key = ${EXCEPTION_KEY}
    `);
    expect(row!.n).toBe(1);

    clearIdentityCache();
    expect(await effective(officer)).not.toContain(EXCEPTION_KEY);
  });

  // ── The record ───────────────────────────────────────────────────────────

  it('audits both the grant and the clearing, with the reason', async () => {
    const chief = await member('ovaudit', 'PD', 'chief');
    const officer = await member('ovauditoff', 'PD', 'officer');

    await set(chief, officer, { effect: 'grant', reason: REASON });
    await clear(chief, officer);

    const rows = await h.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
      SELECT action, metadata FROM audit_log
       WHERE entity_id = ${officer.memberId}
         AND action IN ('permission.override_set', 'permission.override_cleared')
       ORDER BY occurred_at
    `);
    expect(rows.map((r) => r.action))
      .toEqual(['permission.override_set', 'permission.override_cleared']);
    expect(rows[0]!.metadata).toMatchObject({ permissionKey: EXCEPTION_KEY, reason: REASON });
  });

  it('audits a REFUSED override, which is the signal the log exists to surface', async () => {
    const sergeant = await member('ovdenied', 'PD', 'sergeant');
    const officer = await member('ovdeniedoff', 'PD', 'officer');

    await set(sergeant, officer, { effect: 'grant', reason: REASON });

    const rows = await h.db.execute<{ outcome: string }>(sql`
      SELECT outcome FROM audit_log
       WHERE entity_id = ${officer.memberId} AND action = 'permission.override_set'
       ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(rows[0]?.outcome).toBe('denied');
  });

  it('shows the standing exception on the member’s profile', async () => {
    const chief = await member('ovprofile', 'PD', 'chief');
    const officer = await member('ovprofileoff', 'PD', 'officer');
    await set(chief, officer, { effect: 'grant', reason: REASON });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${officer.organizationId}/personnel/${officer.memberId}`,
      headers: chief.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      member: { overrides: { permissionKey: string; effect: string; reason: string }[] };
    };
    expect(body.member.overrides).toContainEqual(
      expect.objectContaining({ permissionKey: EXCEPTION_KEY, effect: 'grant', reason: REASON }),
    );
  });
});
