import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  expectRejection, makeMember, makeUser, orgIdByKey, setupDatabase, unique, type Harness,
} from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await setupDatabase();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('soft deletion (ADR-0008)', () => {
  it('frees a plate for re-registration once the vehicle is archived', async () => {
    // The classic soft-delete bug: a non-partial unique index means archiving a
    // vehicle permanently burns its plate. This test is the guard.
    const plate = unique('PL').slice(0, 12);
    const actor = await makeUser(h.db, 'actor');

    const first = await h.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle (plate, model) VALUES (${plate}, 'sultan') RETURNING id
    `);

    await expectRejection(
      () => h.db.execute(sql`INSERT INTO vehicle (plate, model) VALUES (${plate}, 'futo')`),
      /duplicate key value|vehicle_plate_key/,
    );

    await h.db.execute(sql`
      UPDATE vehicle SET deleted_at = now(), deleted_by = ${actor}, deletion_reason = 'test'
      WHERE id = ${first[0]!.id}
    `);

    // Must now succeed — the plate is available again.
    const second = await h.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle (plate, model) VALUES (${plate}, 'futo') RETURNING id
    `);
    expect(second[0]?.id).toBeTruthy();

    const live = await h.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM vehicle WHERE plate = ${plate} AND deleted_at IS NULL
    `);
    expect(live[0]?.count).toBe(1);
  });

  it('is case-insensitive on plates (citext)', async () => {
    const plate = unique('CI').slice(0, 10).toUpperCase();
    await h.db.execute(sql`INSERT INTO vehicle (plate, model) VALUES (${plate}, 'sultan')`);
    await expectRejection(
      () =>
        h.db.execute(
          sql`INSERT INTO vehicle (plate, model) VALUES (${plate.toLowerCase()}, 'futo')`,
        ),
      /duplicate key value|vehicle_plate_key/,
    );
  });

  it('requires deleted_by and a reason whenever deleted_at is set', async () => {
    const rows = await h.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle (plate, model) VALUES (${unique('RQ').slice(0, 10)}, 'futo')
      RETURNING id
    `);
    // An archived record with no actor is an audit hole.
    await expectRejection(
      () => h.db.execute(sql`UPDATE vehicle SET deleted_at = now() WHERE id = ${rows[0]!.id}`),
      /vehicle_soft_delete_complete/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('callsigns and unit membership', () => {
  it('reuses a callsign once the holder is terminated', async () => {
    const callsign = unique('CS').slice(0, 14);
    await makeMember(h.db, 'PD', { callsign });

    await expectRejection(
      () => makeMember(h.db, 'PD', { callsign }),
      /duplicate key value|organization_member_active_callsign_key/,
    );

    await h.db.execute(sql`
      UPDATE organization_member SET status = 'terminated', left_at = now()
      WHERE callsign = ${callsign}
    `);

    const reused = await makeMember(h.db, 'PD', { callsign });
    expect(reused.memberId).toBeTruthy();
  });

  it('allows the same callsign in two different organizations', async () => {
    const callsign = unique('XO').slice(0, 14);
    await makeMember(h.db, 'PD', { callsign });
    const other = await makeMember(h.db, 'MD', { callsign });
    expect(other.memberId).toBeTruthy();
  });

  it('permits a member in at most one active unit', async () => {
    const { memberId, orgId } = await makeMember(h.db, 'PD');
    const unitA = await h.db.execute<{ id: string }>(sql`
      INSERT INTO unit (organization_id, callsign) VALUES (${orgId}, ${unique('U').slice(0, 12)})
      RETURNING id
    `);
    const unitB = await h.db.execute<{ id: string }>(sql`
      INSERT INTO unit (organization_id, callsign) VALUES (${orgId}, ${unique('U').slice(0, 12)})
      RETURNING id
    `);

    await h.db.execute(
      sql`INSERT INTO unit_member (unit_id, member_id) VALUES (${unitA[0]!.id}, ${memberId})`,
    );

    // Being in two patrols at once is operationally meaningless — the database
    // refuses it so no code path has to remember.
    await expectRejection(
      () =>
        h.db.execute(
          sql`INSERT INTO unit_member (unit_id, member_id) VALUES (${unitB[0]!.id}, ${memberId})`,
        ),
      /duplicate key value|unit_member_one_active_per_member/,
    );

    await h.db.execute(
      sql`UPDATE unit_member SET left_at = now() WHERE unit_id = ${unitA[0]!.id} AND member_id = ${memberId}`,
    );
    await h.db.execute(
      sql`INSERT INTO unit_member (unit_id, member_id) VALUES (${unitB[0]!.id}, ${memberId})`,
    );
    const active = await h.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM unit_member WHERE member_id = ${memberId} AND left_at IS NULL`,
    );
    expect(active[0]?.count).toBe(1);
  });

  it('permits at most one leader per active unit', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    const u = await h.db.execute<{ id: string }>(sql`
      INSERT INTO unit (organization_id, callsign) VALUES (${orgId}, ${unique('L').slice(0, 12)})
      RETURNING id
    `);
    const a = await makeMember(h.db, 'PD');
    const b = await makeMember(h.db, 'PD');
    await h.db.execute(sql`
      INSERT INTO unit_member (unit_id, member_id, is_leader)
      VALUES (${u[0]!.id}, ${a.memberId}, true)
    `);
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO unit_member (unit_id, member_id, is_leader)
          VALUES (${u[0]!.id}, ${b.memberId}, true)
        `),
      /duplicate key value|unit_member_one_leader/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CHECK constraints', () => {
  it('rejects a hierarchy level outside 1–100', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    for (const level of [0, 101, -5]) {
      await expectRejection(
        () =>
          h.db.execute(sql`
            INSERT INTO role (organization_id, key, name, hierarchy_level)
            VALUES (${orgId}, ${unique('r')}, 'Bad', ${level})
          `),
        /role_hierarchy_range/,
      );
    }
  });

  it('rejects an incident priority outside 1–5', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO incident (organization_id, title, priority) VALUES (${orgId}, 'bad', 9)
        `),
      /incident_priority_range/,
    );
  });

  it('requires closed_at and closed_by when an incident is closed', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    const inc = await h.db.execute<{ id: string }>(sql`
      INSERT INTO incident (organization_id, title, priority) VALUES (${orgId}, 'x', 3) RETURNING id
    `);
    await expectRejection(
      () => h.db.execute(sql`UPDATE incident SET status = 'closed' WHERE id = ${inc[0]!.id}`),
      /incident_closure_complete/,
    );

    const closer = await makeUser(h.db, 'closer');
    await h.db.execute(sql`
      UPDATE incident SET status = 'closed', closed_at = now(), closed_by = ${closer}
      WHERE id = ${inc[0]!.id}
    `);
    const done = await h.db.execute<{ status: string }>(
      sql`SELECT status::text FROM incident WHERE id = ${inc[0]!.id}`,
    );
    expect(done[0]?.status).toBe('closed');
  });

  it('rejects a vehicle owned by both a person and an organization', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    const p = await h.db.execute<{ id: string }>(
      sql`INSERT INTO person (first_name, last_name) VALUES ('A', 'B') RETURNING id`,
    );
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO vehicle (plate, model, owner_person_id, owner_organization_id)
          VALUES (${unique('OW').slice(0, 10)}, 'sultan', ${p[0]!.id}, ${orgId})
        `),
      /vehicle_single_owner/,
    );
  });

  it('rejects an active account that has not verified its email', async () => {
    const name = unique('unverified');
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO user_account (email, username, display_name, password_hash, status)
          VALUES (${`${name}@t.invalid`}, ${name}, ${name}, 'x', 'active')
        `),
      /user_account_active_requires_verification/,
    );
  });

  it('rejects a terminated membership with no left_at', async () => {
    const userId = await makeUser(h.db, 'term');
    const orgId = await orgIdByKey(h.db, 'MD');
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO organization_member (user_id, organization_id, status)
          VALUES (${userId}, ${orgId}, 'terminated')
        `),
      /organization_member_termination_complete/,
    );
  });

  it('keeps is_deceased and status consistent', async () => {
    await expectRejection(
      () =>
        h.db.execute(sql`
          INSERT INTO person (first_name, last_name, status, is_deceased)
          VALUES ('C', 'D', 'alive', true)
        `),
      /person_deceased_consistent/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('generated values', () => {
  it('assigns unique, sequential, human-readable incident numbers', async () => {
    const orgId = await orgIdByKey(h.db, 'PD');
    const numbers: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const rows = await h.db.execute<{ number: string }>(sql`
        INSERT INTO incident (organization_id, title, priority)
        VALUES (${orgId}, ${`call ${i}`}, 3) RETURNING number::text
      `);
      numbers.push(rows[0]!.number);
    }
    expect(new Set(numbers).size).toBe(5);
    for (const n of numbers) expect(n).toMatch(/^\d{4}-\d{2}-\d{6}$/);
    // Sequence-backed, so concurrent creation cannot collide the way count(*)+1 would.
    expect([...numbers].sort()).toEqual(numbers);
  });

  it('maintains updated_at through the trigger', async () => {
    const rows = await h.db.execute<{ id: string; updated_at: string }>(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Trig', 'Ger')
      RETURNING id, updated_at
    `);
    const before = rows[0]!.updated_at;
    await new Promise((r) => setTimeout(r, 20));
    await h.db.execute(sql`UPDATE person SET first_name = 'Trig2' WHERE id = ${rows[0]!.id}`);
    const after = await h.db.execute<{ updated_at: string }>(
      sql`SELECT updated_at FROM person WHERE id = ${rows[0]!.id}`,
    );
    expect(new Date(after[0]!.updated_at).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('referential integrity', () => {
  it('never cascades a delete into operational history', async () => {
    // A CASCADE here would destroy incident history the first time someone
    // removed an organization (ADR-0008).
    const rows = await h.db.execute<{ table_name: string; constraint_name: string }>(sql`
      SELECT tc.table_name::text, tc.constraint_name::text
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND rc.delete_rule = 'CASCADE'
        AND tc.table_name IN ('incident', 'incident_log', 'audit_log', 'organization_member',
                              'member_status_history', 'criminal_charge', 'warrant')
    `);
    expect(rows).toEqual([]);
  });

  it('refuses to delete an organization that still has members', async () => {
    await makeMember(h.db, 'ICE');
    const orgId = await orgIdByKey(h.db, 'ICE');
    await expectRejection(
      () => h.db.execute(sql`DELETE FROM organization WHERE id = ${orgId}`),
      /violates foreign key constraint/,
    );
  });
});
