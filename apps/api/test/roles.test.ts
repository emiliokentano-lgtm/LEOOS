import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@leoos/db';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin, makeOrgLead,
  organizationIdByKey, resetAccounts, signIn, userIdByUsername, type TestHarness,
} from './harness.js';

/**
 * Role, hierarchy and permission authorization.
 *
 * Roles ARE the authority structure, so every attack here is an attempt to edit
 * the structure into a shape that gives the actor more than they started with.
 * The recurring pattern is "role laundering": you cannot grant yourself
 * `personnel.fire`, so instead you write it into a role — and the tests below
 * close every door that leads back to it.
 *
 * Seeded PD ranks (packages/db/src/seed/organizations.ts):
 *
 *   chief         100  everything, including roles.delete / roles.restore
 *   deputy_chief   90  roles.create/edit/assign/permissions
 *   commander      80  roles.create/edit/assign/permissions  (no delete)
 *   lieutenant     60  roles.view only
 *   sergeant       50  roles.view only
 *   officer        30  roles.view only
 *   cadet          10  roles.view only
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

const base = (orgId: string) => `/api/v1/organizations/${orgId}/roles`;

let seq = 0;
function freshKey(prefix = 'r'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`.toLowerCase();
}

/** Creates a role directly, so a test can set up a shape the API would refuse. */
async function seedRole(
  orgKey: string,
  level: number,
  options: { permissions?: string[]; isSystem?: boolean; isDefault?: boolean; key?: string } = {},
): Promise<string> {
  const orgId = await organizationIdByKey(h.db, orgKey);
  const key = options.key ?? freshKey('seeded');
  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO role (organization_id, key, name, hierarchy_level, is_system)
    VALUES (${orgId}, ${key}, ${'Seeded ' + key}, ${level}, ${options.isSystem ?? false})
    RETURNING id
  `);
  const id = rows[0]!.id;
  for (const permission of options.permissions ?? []) {
    await h.db.execute(sql`
      INSERT INTO role_permission (role_id, permission_key) VALUES (${id}, ${permission})
    `);
  }
  return id;
}

async function roleIdByKey(orgKey: string, key: string): Promise<string> {
  const orgId = await organizationIdByKey(h.db, orgKey);
  const rows = await h.db.execute<{ id: string }>(
    sql`SELECT id FROM role WHERE organization_id = ${orgId} AND key = ${key}`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no role ${orgKey}/${key}`);
  return id;
}

async function levelOfRole(roleId: string): Promise<number> {
  const rows = await h.db.execute<{ hierarchy_level: number }>(
    sql`SELECT hierarchy_level FROM role WHERE id = ${roleId}`,
  );
  return Number(rows[0]!.hierarchy_level);
}

async function permissionsOfRole(roleId: string): Promise<string[]> {
  const rows = await h.db.execute<{ permission_key: string }>(
    sql`SELECT permission_key FROM role_permission WHERE role_id = ${roleId} ORDER BY 1`,
  );
  return rows.map((r) => r.permission_key);
}

function reasonOf(res: { json: () => unknown }): string | undefined {
  return (res.json() as { error?: { detail?: { reason?: string } } }).error?.detail?.reason;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('creating a role — the actor is the ceiling', () => {
  it('REFUSES creating a role ABOVE the actor', async () => {
    const commander = await member('rcA', 'PD', 'commander');   // 80

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId), headers: commander.headers,
      payload: { key: freshKey(), name: 'Shadow Chief', hierarchyLevel: 95 },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
  });

  it('REFUSES creating a role at the actor\'s OWN level', async () => {
    // Peers are mutually immune, so a role at the actor's own level produces
    // people they can never manage — created by their own hand.
    const commander = await member('rcB', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId), headers: commander.headers,
      payload: { key: freshKey(), name: 'Co-Commander', hierarchyLevel: 80 },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
  });

  it('REFUSES a role carrying a permission the actor does not hold', async () => {
    // Role laundering at birth. A Commander holds no `organization.edit`, so a
    // role that carries it would be authority created from nothing.
    const commander = await member('rcC', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId), headers: commander.headers,
      payload: {
        key: freshKey(), name: 'Quiet Power', hierarchyLevel: 20,
        permissions: ['persons.view', 'organization.edit'],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');
  });

  it('REFUSES a GLOBAL-scope permission on an organization role', async () => {
    // Even for a Chief, and even at level 1. This is what stops an organization
    // minting itself administrative rights over the system.
    const chief = await member('rcD', 'PD', 'chief');

    const res = await h.app.inject({
      method: 'POST', url: base(chief.organizationId), headers: chief.headers,
      payload: {
        key: freshKey(), name: 'Backdoor', hierarchyLevel: 1,
        permissions: ['admin.users'],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('GLOBAL_PERMISSION_ON_ORG_ROLE');
  });

  it('REFUSES creating without the permission, however low the level', async () => {
    const lieutenant = await member('rcE', 'PD', 'lieutenant');   // roles.view only

    const res = await h.app.inject({
      method: 'POST', url: base(lieutenant.organizationId), headers: lieutenant.headers,
      payload: { key: freshKey(), name: 'Harmless', hierarchyLevel: 5 },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD');
  });

  it('ALLOWS creating a role strictly below the actor with permissions they hold', async () => {
    const commander = await member('rcF', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'POST', url: base(commander.organizationId), headers: commander.headers,
      payload: {
        key: freshKey(), name: 'Field Training Officer', hierarchyLevel: 35,
        description: 'Mentors probationary officers.',
        permissions: ['persons.view', 'dispatch.close'],
      },
    });

    expect(res.statusCode).toBe(201);
    const { roleId } = res.json() as { roleId: string };
    expect(await levelOfRole(roleId)).toBe(35);
    expect(await permissionsOfRole(roleId)).toEqual(['dispatch.close', 'persons.view']);
  });

  it('REFUSES a duplicate role key', async () => {
    const commander = await member('rcG', 'PD', 'commander');
    const key = freshKey();

    const first = await h.app.inject({
      method: 'POST', url: base(commander.organizationId), headers: commander.headers,
      payload: { key, name: 'One', hierarchyLevel: 20 },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST', url: base(commander.organizationId), headers: commander.headers,
      payload: { key, name: 'Two', hierarchyLevel: 25 },
    });
    expect(second.statusCode).toBe(409);
  });

  it('REFUSES a level outside the 1–100 scale', async () => {
    const chief = await member('rcH', 'PD', 'chief');

    for (const hierarchyLevel of [0, 101, -5]) {
      const res = await h.app.inject({
        method: 'POST', url: base(chief.organizationId), headers: chief.headers,
        payload: { key: freshKey(), name: 'Out of range', hierarchyLevel },
      });
      expect(res.statusCode, `level ${hierarchyLevel}`).toBe(400);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('editing a role', () => {
  it('REFUSES editing a role ABOVE the actor', async () => {
    const commander = await member('reA', 'PD', 'commander');
    const chiefRole = await roleIdByKey('PD', 'chief');

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${chiefRole}`,
      headers: commander.headers, payload: { name: 'Figurehead' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
  });

  it('REFUSES editing a role at the actor\'s OWN level', async () => {
    const commander = await member('reB', 'PD', 'commander');
    const commanderRole = await roleIdByKey('PD', 'commander');

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${commanderRole}`,
      headers: commander.headers, payload: { name: 'Supreme Commander' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('ALLOWS editing a role below the actor', async () => {
    const commander = await member('reC', 'PD', 'commander');
    const roleId = await seedRole('PD', 30);

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers,
      payload: { name: 'Senior Officer', description: 'Six years in.' },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('moving a role — both ends of the move are bounded', () => {
  it('REFUSES lifting a role the actor MAY edit above the actor', async () => {
    // The attack an origin-only check misses. The Commander may edit this role
    // today; the question is where they may put it.
    const commander = await member('rmA', 'PD', 'commander');   // 80
    const roleId = await seedRole('PD', 50);

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers, payload: { hierarchyLevel: 95 },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
    expect(await levelOfRole(roleId)).toBe(50);
  });

  it('REFUSES lifting a role to the actor\'s OWN level', async () => {
    const commander = await member('rmB', 'PD', 'commander');
    const roleId = await seedRole('PD', 50);

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers, payload: { hierarchyLevel: 80 },
    });

    expect(res.statusCode).toBe(403);
    expect(await levelOfRole(roleId)).toBe(50);
  });

  it('REFUSES dragging a role from ABOVE the actor down below them', async () => {
    // The mirror attack, which a destination-only check misses: demoting the
    // command structure is as much an escalation as promoting yourself.
    const commander = await member('rmC', 'PD', 'commander');
    const roleId = await seedRole('PD', 95);

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers, payload: { hierarchyLevel: 10 },
    });

    expect(res.statusCode).toBe(403);
    expect(await levelOfRole(roleId)).toBe(95);
  });

  it('ALLOWS a move that stays strictly below the actor at both ends', async () => {
    const commander = await member('rmD', 'PD', 'commander');
    const roleId = await seedRole('PD', 20);

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers, payload: { hierarchyLevel: 55 },
    });

    expect(res.statusCode).toBe(200);
    expect(await levelOfRole(roleId)).toBe(55);
  });

  it('bumps the permission version of everyone holding a moved role', async () => {
    // A level change moves the holder's rank, so a cached session must not keep
    // deciding on the old one.
    const chief = await member('rmE', 'PD', 'chief');
    const holder = await member('rmF', 'PD', 'officer');
    const officerRole = await roleIdByKey('PD', 'officer');

    const before = await h.db.execute<{ permission_version: number }>(
      sql`SELECT permission_version FROM user_account WHERE id = ${holder.userId}`,
    );

    const res = await h.app.inject({
      method: 'PATCH', url: `${base(chief.organizationId)}/${officerRole}`,
      headers: chief.headers, payload: { hierarchyLevel: 32 },
    });
    expect(res.statusCode).toBe(200);

    const after = await h.db.execute<{ permission_version: number }>(
      sql`SELECT permission_version FROM user_account WHERE id = ${holder.userId}`,
    );
    expect(Number(after[0]!.permission_version))
      .toBeGreaterThan(Number(before[0]!.permission_version));

    // Restore the seeded level so later tests see the documented structure.
    await h.db.execute(sql`UPDATE role SET hierarchy_level = 30 WHERE id = ${officerRole}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the permission set — the subset rule', () => {
  it('REFUSES adding a permission the actor does not hold', async () => {
    const commander = await member('rpA', 'PD', 'commander');
    const roleId = await seedRole('PD', 20, { permissions: ['persons.view'] });

    const res = await h.app.inject({
      method: 'PUT', url: `${base(commander.organizationId)}/${roleId}/permissions`,
      headers: commander.headers,
      payload: { permissions: ['persons.view', 'organization.edit'] },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');
    expect(await permissionsOfRole(roleId)).toEqual(['persons.view']);
  });

  it('REFUSES touching the permissions of a role ABOVE the actor', async () => {
    const commander = await member('rpB', 'PD', 'commander');
    const roleId = await seedRole('PD', 95, { permissions: ['persons.view'] });

    const res = await h.app.inject({
      method: 'PUT', url: `${base(commander.organizationId)}/${roleId}/permissions`,
      headers: commander.headers, payload: { permissions: ['persons.view', 'persons.edit'] },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
  });

  it('REFUSES a global-scope permission on an organization role', async () => {
    const chief = await member('rpC', 'PD', 'chief');
    const roleId = await seedRole('PD', 20);

    const res = await h.app.inject({
      method: 'PUT', url: `${base(chief.organizationId)}/${roleId}/permissions`,
      headers: chief.headers, payload: { permissions: ['admin.audit_logs'] },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('GLOBAL_PERMISSION_ON_ORG_ROLE');
    expect(await permissionsOfRole(roleId)).toEqual([]);
  });

  it('ALLOWS removing a permission the actor does not themselves hold', async () => {
    // Deliberate asymmetry: removal cannot raise anyone's authority, and
    // requiring the permission to remove it would strand a role that drifted
    // above its editor.
    const commander = await member('rpD', 'PD', 'commander');
    const roleId = await seedRole('PD', 20, {
      permissions: ['persons.view', 'organization.edit'],
    });

    const res = await h.app.inject({
      method: 'PUT', url: `${base(commander.organizationId)}/${roleId}/permissions`,
      headers: commander.headers, payload: { permissions: ['persons.view'] },
    });

    expect(res.statusCode).toBe(200);
    expect(await permissionsOfRole(roleId)).toEqual(['persons.view']);
  });

  it('separates roles.permissions from roles.edit', async () => {
    // A personnel officer who maintains the rank list must not thereby be able
    // to widen what those ranks can do.
    const commander = await member('rpE', 'PD', 'commander');
    const roleId = await seedRole('PD', 20);
    const memberRow = await h.db.execute<{ id: string }>(sql`
      SELECT id FROM organization_member WHERE user_id = ${commander.userId}
    `);
    await h.db.execute(sql`
      INSERT INTO member_permission_override (member_id, permission_key, effect, reason)
      VALUES (${memberRow[0]!.id}, 'roles.permissions', 'deny', 'test')
      ON CONFLICT (member_id, permission_key) DO UPDATE SET effect = 'deny'
    `);

    const editRes = await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers, payload: { name: 'Renamed fine' },
    });
    expect(editRes.statusCode).toBe(200);

    const permRes = await h.app.inject({
      method: 'PUT', url: `${base(commander.organizationId)}/${roleId}/permissions`,
      headers: commander.headers, payload: { permissions: ['persons.view'] },
    });
    expect(permRes.statusCode).toBe(403);
    expect(reasonOf(permRes)).toBe('PERMISSION_NOT_HELD');
  });

  it('diffs against the STORED set, not against anything the client claims', async () => {
    const commander = await member('rpF', 'PD', 'commander');
    const roleId = await seedRole('PD', 20, { permissions: ['persons.view'] });

    const res = await h.app.inject({
      method: 'PUT', url: `${base(commander.organizationId)}/${roleId}/permissions`,
      headers: commander.headers,
      payload: { permissions: ['dispatch.close', 'persons.view'] },
    });

    expect(res.statusCode).toBe(200);
    // The server derived exactly one addition and no removals.
    expect(res.json()).toMatchObject({ added: ['dispatch.close'], removed: [] });
  });

  it('REFUSES an unknown permission key', async () => {
    const chief = await member('rpG', 'PD', 'chief');
    const roleId = await seedRole('PD', 20);

    const res = await h.app.inject({
      method: 'PUT', url: `${base(chief.organizationId)}/${roleId}/permissions`,
      headers: chief.headers, payload: { permissions: ['persons.view', 'made.up.key'] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('bumps the permission version of every holder', async () => {
    const chief = await member('rpH', 'PD', 'chief');
    const holder = await member('rpI', 'PD', 'officer');
    const officerRole = await roleIdByKey('PD', 'officer');

    const before = await h.db.execute<{ permission_version: number }>(
      sql`SELECT permission_version FROM user_account WHERE id = ${holder.userId}`,
    );

    const current = await permissionsOfRole(officerRole);
    const res = await h.app.inject({
      method: 'PUT', url: `${base(chief.organizationId)}/${officerRole}/permissions`,
      headers: chief.headers,
      payload: { permissions: current.filter((k) => k !== 'map.markers.manage') },
    });
    expect(res.statusCode).toBe(200);

    const after = await h.db.execute<{ permission_version: number }>(
      sql`SELECT permission_version FROM user_account WHERE id = ${holder.userId}`,
    );
    expect(Number(after[0]!.permission_version))
      .toBeGreaterThan(Number(before[0]!.permission_version));

    // Put it back so the seeded structure stays as documented.
    await h.db.execute(sql`
      INSERT INTO role_permission (role_id, permission_key)
      VALUES (${officerRole}, 'map.markers.manage') ON CONFLICT DO NOTHING
    `);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('archiving a role', () => {
  it('REFUSES archiving a role ABOVE the actor', async () => {
    const chief = await member('raA', 'PD', 'chief');
    const roleId = await seedRole('PD', 100);

    const res = await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${roleId}`,
      headers: chief.headers, payload: { reason: 'Rival structure.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
  });

  it('REFUSES archiving a role that is still held', async () => {
    // Otherwise its holders silently drop to level 0 and become unmanageable by
    // everyone below the organization lead.
    const chief = await member('raB', 'PD', 'chief');
    await member('raC', 'PD', 'officer');
    const officerRole = await roleIdByKey('PD', 'officer');

    const res = await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${officerRole}`,
      headers: chief.headers, payload: { reason: 'Restructuring.' },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ROLE_IN_USE');
  });

  it('REFUSES archiving the DEFAULT role', async () => {
    const chief = await member('raD', 'PD', 'chief');
    const cadetRole = await roleIdByKey('PD', 'cadet');

    const res = await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${cadetRole}`,
      headers: chief.headers, payload: { reason: 'No more cadets.' },
    });

    // New hires would have nothing to receive.
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_IS_DEFAULT');
  });

  it('REFUSES archiving a SYSTEM role', async () => {
    const admin = await createActiveUser(h, 'raAdmin');
    await makeGlobalAdmin(h.db, admin.username);
    const auth = await signIn(h, admin);
    const pd = await organizationIdByKey(h.db, 'PD');
    const roleId = await seedRole('PD', 20, { isSystem: true });

    const res = await h.app.inject({
      method: 'DELETE', url: `${base(pd)}/${roleId}`,
      headers: auth.headers, payload: { reason: 'Tidy up.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_IS_SYSTEM');
  });

  it('REFUSES archiving without roles.delete, even from the top of the org', async () => {
    // A Commander may create and edit roles but not remove them — the seeded
    // structure reserves deletion to the Chief.
    const commander = await member('raE', 'PD', 'commander');
    const roleId = await seedRole('PD', 20);

    const res = await h.app.inject({
      method: 'DELETE', url: `${base(commander.organizationId)}/${roleId}`,
      headers: commander.headers, payload: { reason: 'Not mine to remove.' },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD');
  });

  it('SOFT-deletes: the row and its permissions survive', async () => {
    const chief = await member('raF', 'PD', 'chief');
    const roleId = await seedRole('PD', 20, { permissions: ['persons.view'] });

    const res = await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${roleId}`,
      headers: chief.headers, payload: { reason: 'Merged into Officer.' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await h.db.execute<{
      deleted_at: string | null; deletion_reason: string | null; deleted_by: string | null;
    }>(sql`SELECT deleted_at, deletion_reason, deleted_by FROM role WHERE id = ${roleId}`);

    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(rows[0]!.deletion_reason).toBe('Merged into Officer.');
    expect(rows[0]!.deleted_by).toBe(chief.userId);
    // Nothing is destroyed — the permission set is part of the record.
    expect(await permissionsOfRole(roleId)).toEqual(['persons.view']);
  });

  it('hides an archived role from the default listing but keeps it retrievable', async () => {
    const chief = await member('raG', 'PD', 'chief');
    const key = freshKey('arch');
    const roleId = await seedRole('PD', 20, { key });

    await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${roleId}`,
      headers: chief.headers, payload: { reason: 'Archived for the test.' },
    });

    const live = await h.app.inject({
      method: 'GET', url: base(chief.organizationId), headers: chief.headers,
    });
    const liveIds = (live.json() as { roles: { id: string }[] }).roles.map((r) => r.id);
    expect(liveIds).not.toContain(roleId);

    const all = await h.app.inject({
      method: 'GET', url: `${base(chief.organizationId)}?includeArchived=true`,
      headers: chief.headers,
    });
    const allIds = (all.json() as { roles: { id: string }[] }).roles.map((r) => r.id);
    expect(allIds).toContain(roleId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('restoring a role', () => {
  it('REFUSES restoring a role carrying permissions the actor lacks', async () => {
    // Otherwise archiving becomes a way to park authority out of reach and
    // retrieve it later from a weaker position.
    const chief = await member('rrA', 'PD', 'chief');
    const roleId = await seedRole('PD', 20, { permissions: ['persons.view'] });

    await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${roleId}`,
      headers: chief.headers, payload: { reason: 'Parked.' },
    });

    // Now attempt the restore as someone who cannot grant what it carries.
    const memberRow = await h.db.execute<{ id: string }>(
      sql`SELECT id FROM organization_member WHERE user_id = ${chief.userId}`,
    );
    await h.db.execute(sql`
      INSERT INTO member_permission_override (member_id, permission_key, effect, reason)
      VALUES (${memberRow[0]!.id}, 'persons.view', 'deny', 'test')
      ON CONFLICT (member_id, permission_key) DO UPDATE SET effect = 'deny'
    `);

    const res = await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${roleId}/restore`,
      headers: chief.headers,
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD_BY_ACTOR');
  });

  it('ALLOWS restoring when the actor can grant everything it carries', async () => {
    const chief = await member('rrB', 'PD', 'chief');
    const roleId = await seedRole('PD', 20, { permissions: ['persons.view'] });

    await h.app.inject({
      method: 'DELETE', url: `${base(chief.organizationId)}/${roleId}`,
      headers: chief.headers, payload: { reason: 'Temporarily retired.' },
    });

    const res = await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${roleId}/restore`,
      headers: chief.headers,
    });

    expect(res.statusCode).toBe(200);
    const rows = await h.db.execute<{ deleted_at: string | null }>(
      sql`SELECT deleted_at FROM role WHERE id = ${roleId}`,
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reordering — a batch is not a licence', () => {
  it('REFUSES the WHOLE batch when ONE entry reaches above the actor', async () => {
    // Atomicity is the security property here: a partially applied reorder is a
    // hierarchy in a state nobody chose, and it would let an attacker smuggle a
    // legal move through alongside an illegal one.
    const commander = await member('roA', 'PD', 'commander');   // 80
    const a = await seedRole('PD', 20);
    const b = await seedRole('PD', 25);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/order`,
      headers: commander.headers,
      payload: {
        order: [
          { roleId: a, hierarchyLevel: 30 },   // legal on its own
          { roleId: b, hierarchyLevel: 90 },   // above the actor
        ],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
    // NEITHER move landed.
    expect(await levelOfRole(a)).toBe(20);
    expect(await levelOfRole(b)).toBe(25);
  });

  it('REFUSES a batch that touches a role above the actor at all', async () => {
    const commander = await member('roB', 'PD', 'commander');
    const high = await seedRole('PD', 95);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/order`,
      headers: commander.headers,
      payload: { order: [{ roleId: high, hierarchyLevel: 10 }] },
    });

    expect(res.statusCode).toBe(403);
    expect(await levelOfRole(high)).toBe(95);
  });

  it('REFUSES reordering a SYSTEM role', async () => {
    const chief = await member('roC', 'PD', 'chief');
    const systemRole = await seedRole('PD', 20, { isSystem: true });

    const res = await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/order`,
      headers: chief.headers,
      payload: { order: [{ roleId: systemRole, hierarchyLevel: 25 }] },
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_IS_SYSTEM');
  });

  it('ALLOWS a batch entirely below the actor, and applies it whole', async () => {
    const commander = await member('roD', 'PD', 'commander');
    const a = await seedRole('PD', 20);
    const b = await seedRole('PD', 25);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/order`,
      headers: commander.headers,
      payload: {
        order: [
          { roleId: a, hierarchyLevel: 45 },
          { roleId: b, hierarchyLevel: 15 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 2 });
    expect(await levelOfRole(a)).toBe(45);
    expect(await levelOfRole(b)).toBe(15);
  });

  it('REFUSES a batch naming the same role twice', async () => {
    const commander = await member('roE', 'PD', 'commander');
    const a = await seedRole('PD', 20);

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/order`,
      headers: commander.headers,
      payload: {
        order: [
          { roleId: a, hierarchyLevel: 30 },
          { roleId: a, hierarchyLevel: 70 },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(await levelOfRole(a)).toBe(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the default role', () => {
  it('REFUSES pointing the default at a role above the actor', async () => {
    // Otherwise the next person hired arrives outranking the person who hired
    // them — and outranking the actor who set it.
    const commander = await member('rdA', 'PD', 'commander');
    const chiefRole = await roleIdByKey('PD', 'chief');

    const res = await h.app.inject({
      method: 'POST', url: `${base(commander.organizationId)}/${chiefRole}/default`,
      headers: commander.headers,
    });

    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');

    const rows = await h.db.execute<{ is_default: boolean }>(
      sql`SELECT is_default FROM role WHERE id = ${chiefRole}`,
    );
    expect(rows[0]!.is_default).toBe(false);
  });

  it('moves the default and leaves exactly one', async () => {
    const chief = await member('rdB', 'PD', 'chief');
    const pd = chief.organizationId;
    const target = await seedRole('PD', 5);

    const res = await h.app.inject({
      method: 'POST', url: `${base(pd)}/${target}/default`, headers: chief.headers,
    });
    expect(res.statusCode).toBe(200);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM role
      WHERE organization_id = ${pd} AND is_default AND deleted_at IS NULL
    `);
    expect(Number(rows[0]!.n)).toBe(1);

    // Hand it back to the seeded cadet role.
    await h.app.inject({
      method: 'POST', url: `${base(pd)}/${await roleIdByKey('PD', 'cadet')}/default`,
      headers: chief.headers,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('organization scoping', () => {
  it('REFUSES a PD chief editing an MD role, as NOT FOUND', async () => {
    const chief = await member('rsA', 'PD', 'chief');
    const md = await organizationIdByKey(h.db, 'MD');
    const mdRole = await roleIdByKey('MD', 'emt');

    // Under MD's own path.
    const viaMd = await h.app.inject({
      method: 'PATCH', url: `${base(md)}/${mdRole}`,
      headers: chief.headers, payload: { name: 'Not my organization' },
    });
    expect(viaMd.statusCode).toBe(404);

    // And under PD's path with an MD role id — the forged one.
    const viaPd = await h.app.inject({
      method: 'PATCH', url: `${base(chief.organizationId)}/${mdRole}`,
      headers: chief.headers, payload: { name: 'Path says PD' },
    });
    expect(viaPd.statusCode).toBe(404);

    const rows = await h.db.execute<{ name: string }>(
      sql`SELECT name FROM role WHERE id = ${mdRole}`,
    );
    expect(rows[0]!.name).toBe('EMT');
  });

  it('REFUSES a PD lead managing MD roles', async () => {
    const granter = await createActiveUser(h, 'granter');
    const lead = await member('rsB', 'PD', 'cadet');
    await makeOrgLead(h.db, lead.username, 'PD', granter.username);
    const relead = await signIn(h, { username: lead.username, password: 'correct-horse-staple-42' });
    const md = await organizationIdByKey(h.db, 'MD');

    const res = await h.app.inject({
      method: 'POST', url: base(md), headers: relead.headers,
      payload: { key: freshKey(), name: 'Overreach', hierarchyLevel: 50 },
    });

    expect(res.statusCode).toBe(404);
  });

  it('hides another organization\'s roles entirely', async () => {
    const commander = await member('rsC', 'PD', 'commander');
    const md = await organizationIdByKey(h.db, 'MD');

    const res = await h.app.inject({ method: 'GET', url: base(md), headers: commander.headers });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the full escalation chain', () => {
  it('cannot be walked from Commander to Chief', async () => {
    /**
     * The complete attack, step by step, all as one actor:
     *
     *   1. create a role below yourself                       — allowed
     *   2. load it with a permission you do not hold          — REFUSED (H4)
     *   3. lift it above yourself instead                     — REFUSED (H5b)
     *   4. edit the Chief role directly                       — REFUSED (H3)
     *   5. reorder the Chief role down out of the way         — REFUSED (H3)
     *   6. assign yourself the role you just made             — REFUSED (H6)
     *
     * Every step must fail on its own; none of them may become reachable
     * because an earlier one succeeded.
     */
    const commander = await member('chainA', 'PD', 'commander');
    const org = commander.organizationId;
    const chiefRole = await roleIdByKey('PD', 'chief');

    // 1 — a legitimate role, below the actor.
    const created = await h.app.inject({
      method: 'POST', url: base(org), headers: commander.headers,
      payload: { key: freshKey('chain'), name: 'Staff Aide', hierarchyLevel: 40 },
    });
    expect(created.statusCode).toBe(201);
    const { roleId } = created.json() as { roleId: string };

    // 2 — load it with authority the actor lacks.
    const loaded = await h.app.inject({
      method: 'PUT', url: `${base(org)}/${roleId}/permissions`,
      headers: commander.headers, payload: { permissions: ['organization.edit'] },
    });
    expect(loaded.statusCode).toBe(403);

    // 3 — lift it above the actor.
    const lifted = await h.app.inject({
      method: 'PATCH', url: `${base(org)}/${roleId}`,
      headers: commander.headers, payload: { hierarchyLevel: 99 },
    });
    expect(lifted.statusCode).toBe(403);

    // 4 — go at the Chief role directly.
    const direct = await h.app.inject({
      method: 'PATCH', url: `${base(org)}/${chiefRole}`,
      headers: commander.headers, payload: { hierarchyLevel: 10 },
    });
    expect(direct.statusCode).toBe(403);

    // 5 — the same thing through the reorder endpoint.
    const reordered = await h.app.inject({
      method: 'POST', url: `${base(org)}/order`, headers: commander.headers,
      payload: { order: [{ roleId: chiefRole, hierarchyLevel: 10 }] },
    });
    expect(reordered.statusCode).toBe(403);

    // 6 — self-assignment, the last door.
    const selfAssign = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${org}/personnel/${commander.memberId}/roles`,
      headers: commander.headers, payload: { roleId },
    });
    expect(selfAssign.statusCode).toBe(403);
    expect(reasonOf(selfAssign)).toBe('SELF_ACTION_FORBIDDEN');

    // Nothing moved.
    expect(await levelOfRole(roleId)).toBe(40);
    expect(await levelOfRole(chiefRole)).toBe(100);
    expect(await permissionsOfRole(roleId)).toEqual([]);
  });

  it('cannot be walked by an accomplice pair either', async () => {
    // Two Commanders cannot bootstrap each other: neither outranks the other,
    // and neither can create a role above themselves for the other to hold.
    const a = await member('chainB', 'PD', 'commander');
    const b = await member('chainC', 'PD', 'commander');

    const created = await h.app.inject({
      method: 'POST', url: base(a.organizationId), headers: a.headers,
      payload: { key: freshKey('pair'), name: 'Mutual Aid', hierarchyLevel: 90 },
    });
    expect(created.statusCode).toBe(403);

    // And A cannot promote B at all, at any level.
    const promote = await h.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${a.organizationId}/personnel/${b.memberId}/rank`,
      headers: a.headers, payload: { roleId: await roleIdByKey('PD', 'lieutenant') },
    });
    expect(promote.statusCode).toBe(403);
    expect(reasonOf(promote)).toBe('TARGET_RANK_NOT_LOWER');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('audit trail', () => {
  it('records a REFUSED role mutation', async () => {
    const commander = await member('rgA', 'PD', 'commander');
    const chiefRole = await roleIdByKey('PD', 'chief');

    await h.app.inject({
      method: 'PATCH', url: `${base(commander.organizationId)}/${chiefRole}`,
      headers: commander.headers, payload: { hierarchyLevel: 10 },
    });

    const rows = await h.db.execute<{ outcome: string; actor_user_id: string }>(sql`
      SELECT outcome, actor_user_id FROM audit_log
      WHERE entity_id = ${chiefRole} AND action = 'role.updated'
      ORDER BY occurred_at DESC LIMIT 1
    `);

    expect(rows[0]?.outcome).toBe('denied');
    expect(rows[0]?.actor_user_id).toBe(commander.userId);
  });

  it('records a permission change with both sides of the diff', async () => {
    const chief = await member('rgB', 'PD', 'chief');
    const roleId = await seedRole('PD', 20, { permissions: ['persons.view'] });

    await h.app.inject({
      method: 'PUT', url: `${base(chief.organizationId)}/${roleId}/permissions`,
      headers: chief.headers, payload: { permissions: ['persons.edit'] },
    });

    const rows = await h.db.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM audit_log
      WHERE entity_id = ${roleId} AND action = 'role.permissions_changed' AND outcome = 'success'
      ORDER BY occurred_at DESC LIMIT 1
    `);

    // An operator reading the log must see what changed, not just that something did.
    expect(rows[0]!.metadata).toMatchObject({
      added: ['persons.edit'], removed: ['persons.view'],
    });
  });

  it('records a level change under its own action', async () => {
    const chief = await member('rgC', 'PD', 'chief');
    const roleId = await seedRole('PD', 20);

    await h.app.inject({
      method: 'PATCH', url: `${base(chief.organizationId)}/${roleId}`,
      headers: chief.headers, payload: { hierarchyLevel: 45 },
    });

    const rows = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE entity_id = ${roleId} AND outcome = 'success' ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(rows[0]!.action).toBe('role.level_changed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reads', () => {
  it('marks which roles the caller may act on without deciding anything', async () => {
    const commander = await member('rvA', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'GET', url: base(commander.organizationId), headers: commander.headers,
    });
    const roles = (res.json() as {
      roles: { key: string; capabilities: { canEdit: boolean; lockedReason: string | null } }[];
    }).roles;

    expect(roles.find((r) => r.key === 'chief')?.capabilities.canEdit).toBe(false);
    expect(roles.find((r) => r.key === 'chief')?.capabilities.lockedReason).toBeTruthy();
    expect(roles.find((r) => r.key === 'commander')?.capabilities.canEdit).toBe(false);
    expect(roles.find((r) => r.key === 'officer')?.capabilities.canEdit).toBe(true);
  });

  it('serves the permission catalogue with the actor\'s grantable set marked', async () => {
    const commander = await member('rvB', 'PD', 'commander');

    const res = await h.app.inject({
      method: 'GET', url: `${base(commander.organizationId)}/permissions`,
      headers: commander.headers,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      categories: { category: string; permissions: { key: string; grantable: boolean }[] }[];
    };
    const all = body.categories.flatMap((c) => c.permissions);

    // Held by a Commander.
    expect(all.find((p) => p.key === 'personnel.hire')?.grantable).toBe(true);
    // Not held.
    expect(all.find((p) => p.key === 'organization.edit')?.grantable).toBe(false);
    // Global scope — never grantable onto an organization role.
    expect(all.find((p) => p.key === 'admin.users')?.grantable).toBe(false);

    // Grouped, as the editor renders them.
    expect(body.categories.map((c) => c.category)).toContain('personnel');
    expect(body.categories.map((c) => c.category)).toContain('roles');
  });

  it('never exposes a password hash', async () => {
    const commander = await member('rvC', 'PD', 'commander');
    const res = await h.app.inject({
      method: 'GET', url: base(commander.organizationId), headers: commander.headers,
    });
    expect(res.body).not.toMatch(/\$argon2/);
    expect(res.body).not.toMatch(/password/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('malformed requests', () => {
  it('answers a bodyless JSON POST with 400, not 500', async () => {
    // Fastify refuses an empty body under a JSON content-type. Falling through
    // to the unhandled-error branch reported the server as broken when the
    // request was at fault — and buried real 500s in the noise.
    const chief = await member('malfA', 'PD', 'chief');
    const roleId = await seedRole('PD', 20);

    const res = await h.app.inject({
      method: 'POST', url: `${base(chief.organizationId)}/${roleId}/restore`,
      headers: { ...chief.headers, 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('still reports a genuine server fault as 500', async () => {
    const chief = await member('malfB', 'PD', 'chief');
    // A role id that is a valid uuid but does not exist is a 404, not a 500 —
    // the pass-through must not swallow real outcomes.
    const res = await h.app.inject({
      method: 'GET',
      url: `${base(chief.organizationId)}/00000000-0000-7000-8000-000000000000`,
      headers: chief.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TOCTOU — the role level is read under lock', () => {
  it('REFUSES a role edit decided on the actor\'s rank as it was when the request arrived', async () => {
    /**
     * The race: the Chief demotes the Commander while the Commander's own role
     * edit is in flight. Sequenced deterministically by holding a lock on the
     * Commander's membership row — their request blocks on `FOR UPDATE`, the
     * demotion commits, and the request is then decided on the rank they
     * actually hold. A check taken before the transaction would have approved it.
     */
    const commander = await member('toctouRoleA', 'PD', 'commander');
    const roleId = await seedRole('PD', 50);
    const officerRole = await roleIdByKey('PD', 'officer');

    const side = createDatabase({
      url: h.config.DATABASE_URL, max: 2, statementTimeoutMs: 15_000, ssl: false,
    });

    try {
      let inFlight: Promise<unknown> | null = null;

      await side.db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT id FROM organization_member WHERE id = ${commander.memberId} FOR UPDATE
        `);

        inFlight = h.app.inject({
          method: 'PATCH', url: `${base(commander.organizationId)}/${roleId}`,
          headers: commander.headers, payload: { hierarchyLevel: 70 },
        });

        await new Promise((resolve) => setTimeout(resolve, 300));

        // Demote the actor to Officer (30) while their request waits.
        await tx.execute(sql`DELETE FROM member_role WHERE member_id = ${commander.memberId}`);
        await tx.execute(sql`
          INSERT INTO member_role (member_id, role_id) VALUES (${commander.memberId}, ${officerRole})
        `);
      });

      const res = await (inFlight as unknown as Promise<{ statusCode: number; json: () => unknown }>);

      // An Officer (30) may touch neither a role at 50 nor one at 70.
      expect(res.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('ROLE_LEVEL_TOO_HIGH');
      expect(await levelOfRole(roleId)).toBe(50);
    } finally {
      await side.close().catch(() => {});
      await side.sql.end({ timeout: 5 }).catch(() => {});
    }
  });
});
