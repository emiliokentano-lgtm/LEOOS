import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership,
  organizationIdByKey, resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';

/**
 * Persons and vehicles — the shared registers.
 *
 * These are NOT hierarchy problems: a citizen record has no rank. Authorization
 * is entirely a question of which permission the actor holds, which is what lets
 * one organization see more than another without a line of organization-specific
 * code. The seeded bundles already encode the split, and these tests use it as
 * the fixture rather than inventing one:
 *
 *   PD officer (FIELD_OFFICER)  persons.criminal.view, NOT persons.medical.view
 *   MD doctor  (MEDICAL_SENIOR) persons.medical.view,  NOT persons.criminal.view
 *
 * The two things that ARE scoped are scoped because the DATA is
 * organization-owned: a warrant belongs to the organization that issued it, and
 * a fleet vehicle belongs to the organization that operates it.
 */

let h: TestHarness;

beforeAll(async () => { h = await createHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await resetAccounts(h.db);
  h.app.limiter.resetAll();
});

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

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

/**
 * A plate that is unique and fits in 12 characters.
 *
 * `unique()` truncated to a plate length silently drops the counter, so two
 * plates minted in the same millisecond collide. The counter goes FIRST here so
 * truncation can never remove the part that distinguishes them.
 */
function uniquePlate(prefix = 'T'): string {
  seq += 1;
  return `${prefix}${seq}${Date.now().toString(36).slice(-4)}`.toUpperCase().slice(0, 12);
}

/** A citizen created directly, so a test can start from a known shape. */
async function seedPerson(overrides: {
  firstName?: string; lastName?: string; dateOfBirth?: string; phone?: string;
} = {}): Promise<string> {
  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO person (first_name, last_name, date_of_birth, phone_number)
    VALUES (${overrides.firstName ?? unique('First')}, ${overrides.lastName ?? unique('Last')},
            ${overrides.dateOfBirth ?? '1990-04-17'}, ${overrides.phone ?? null})
    RETURNING id
  `);
  return rows[0]!.id;
}

async function seedVehicle(options: {
  plate?: string; ownerPersonId?: string; ownerOrganizationId?: string; isFleet?: boolean;
} = {}): Promise<{ id: string; plate: string }> {
  const plate = (options.plate ?? uniquePlate('PL')).toUpperCase().slice(0, 12);
  const rows = await h.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle (plate, model, owner_person_id, owner_organization_id, is_fleet)
    VALUES (${plate}, 'sultan', ${options.ownerPersonId ?? null},
            ${options.ownerOrganizationId ?? null}, ${options.isFleet ?? false})
    RETURNING id
  `);
  return { id: rows[0]!.id, plate };
}

function reasonOf(res: { json: () => unknown }): string | undefined {
  return (res.json() as { error?: { detail?: { reason?: string } } }).error?.detail?.reason;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('persons — permission gating', () => {
  it('REFUSES the whole register without persons.view, as NOT FOUND', async () => {
    const mechanic = await member('pgA', 'MECHANIC', 'apprentice');
    // The Mechanic apprentice bundle deliberately omits `persons.view`.
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/persons', headers: mechanic.headers,
    });
    // 404, not 403 — a 403 would confirm the register exists and is populated.
    expect(res.statusCode).toBe(404);
  });

  it('REFUSES creating without persons.create', async () => {
    const cadet = await member('pgB', 'PD', 'cadet');
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/persons', headers: cadet.headers,
      payload: { firstName: 'Nobody', lastName: 'Important' },
    });
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD');
  });

  it('ALLOWS an officer to create and edit', async () => {
    const officer = await member('pgC', 'PD', 'officer');

    const created = await h.app.inject({
      method: 'POST', url: '/api/v1/persons', headers: officer.headers,
      payload: {
        firstName: 'Marta', lastName: unique('Kovic'),
        dateOfBirth: '1988-11-02', phoneNumber: '555-0142', address: '12 Vespucci Blvd',
      },
    });
    expect(created.statusCode).toBe(201);
    const { personId } = created.json() as { personId: string };

    const edited = await h.app.inject({
      method: 'PATCH', url: `/api/v1/persons/${personId}`, headers: officer.headers,
      payload: { address: '9 Alta Street', status: 'missing' },
    });
    expect(edited.statusCode).toBe(200);

    const rows = await h.db.execute<{ address: string; status: string; is_deceased: boolean }>(
      sql`SELECT address, status::text, is_deceased FROM person WHERE id = ${personId}`,
    );
    expect(rows[0]!.address).toBe('9 Alta Street');
    expect(rows[0]!.status).toBe('missing');
  });

  it('keeps is_deceased in step with status', async () => {
    // The database CHECK requires the two to agree; a valid request must never
    // be the thing that trips it.
    const officer = await member('pgD', 'PD', 'officer');
    const personId = await seedPerson();

    const res = await h.app.inject({
      method: 'PATCH', url: `/api/v1/persons/${personId}`, headers: officer.headers,
      payload: { status: 'deceased' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await h.db.execute<{ is_deceased: boolean }>(
      sql`SELECT is_deceased FROM person WHERE id = ${personId}`,
    );
    expect(rows[0]!.is_deceased).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('persons — the sensitive sections', () => {
  it('withholds CRIMINAL history from a doctor, and MEDICAL from an officer', async () => {
    // The heart of "some organizations have broader access than others": the
    // same endpoint, the same record, two different responses, decided entirely
    // by the permission catalogue.
    const officer = await member('psA', 'PD', 'officer');
    const doctor = await member('psB', 'MD', 'doctor');
    const personId = await seedPerson();

    await h.db.execute(sql`
      INSERT INTO medical_record (person_id, blood_type, notes)
      VALUES (${personId}, 'O-', 'Penicillin allergy')
    `);
    await h.db.execute(sql`
      INSERT INTO criminal_charge (person_id, title, severity)
      VALUES (${personId}, 'Grand theft auto', 'felony')
    `);

    const asOfficer = await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${personId}`, headers: officer.headers,
    });
    expect(asOfficer.statusCode).toBe(200);
    const officerBody = asOfficer.json() as Record<string, unknown> & { withheld: string[] };
    expect(officerBody).toHaveProperty('criminal');
    expect(officerBody).not.toHaveProperty('medical');
    expect(officerBody.withheld).toContain('medical');
    // Not merely nulled — the blood type never left the database.
    expect(asOfficer.body).not.toMatch(/Penicillin/);
    expect(asOfficer.body).not.toMatch(/O-/);

    const asDoctor = await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${personId}`, headers: doctor.headers,
    });
    expect(asDoctor.statusCode).toBe(200);
    const doctorBody = asDoctor.json() as Record<string, unknown> & { withheld: string[] };
    expect(doctorBody).toHaveProperty('medical');
    expect(doctorBody).not.toHaveProperty('criminal');
    expect(doctorBody.withheld).toContain('criminal');
    expect(asDoctor.body).not.toMatch(/Grand theft auto/);
  });

  it('AUDITS a medical read', async () => {
    // Misuse of a police or medical database is overwhelmingly a READ problem,
    // and the audit trail is the only thing that makes it answerable afterwards.
    const doctor = await member('psC', 'MD', 'doctor');
    const personId = await seedPerson();
    await h.db.execute(sql`
      INSERT INTO medical_record (person_id, blood_type) VALUES (${personId}, 'AB+')
    `);

    await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${personId}`, headers: doctor.headers,
    });

    const rows = await h.db.execute<{ action: string; actor_user_id: string }>(sql`
      SELECT action, actor_user_id FROM audit_log
      WHERE entity_id = ${personId} AND action = 'person.medical_viewed'
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(rows[0]?.action).toBe('person.medical_viewed');
    expect(rows[0]?.actor_user_id).toBe(doctor.userId);
  });

  it('AUDITS an ordinary lookup too', async () => {
    const officer = await member('psD', 'PD', 'officer');
    const personId = await seedPerson();

    await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${personId}`, headers: officer.headers,
    });

    const rows = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE entity_id = ${personId} AND action = 'person.viewed'
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(rows[0]?.action).toBe('person.viewed');
  });

  it('REFUSES editing a medical record without persons.medical.edit', async () => {
    const officer = await member('psE', 'PD', 'officer');
    const personId = await seedPerson();

    const res = await h.app.inject({
      method: 'PUT', url: `/api/v1/persons/${personId}/medical`, headers: officer.headers,
      payload: { bloodType: 'A+' },
    });
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('PERMISSION_NOT_HELD');
  });

  it('never copies medical CONTENT into the audit row', async () => {
    // Recording who changed a record is oversight; copying the diagnosis into a
    // table read under a different permission would defeat gating it at all.
    const doctor = await member('psF', 'MD', 'doctor');
    const personId = await seedPerson();

    await h.app.inject({
      method: 'PUT', url: `/api/v1/persons/${personId}/medical`, headers: doctor.headers,
      payload: { bloodType: 'B-', conditions: ['Arrhythmia'], notes: 'Confidential note' },
    });

    const rows = await h.db.execute<{ metadata: unknown; after: unknown }>(sql`
      SELECT metadata, "after" FROM audit_log
      WHERE entity_id = ${personId} AND outcome = 'success'
      ORDER BY occurred_at DESC LIMIT 1
    `);
    const blob = JSON.stringify(rows[0]);
    expect(blob).not.toMatch(/Arrhythmia/);
    expect(blob).not.toMatch(/Confidential note/);
    expect(blob).not.toMatch(/B-/);
    // But the fact of the change, and which fields, is recorded.
    expect(blob).toMatch(/medicalRecordUpdated/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('person search', () => {
  it('finds a person by full name, partial name, phone, DOB, alias and id', async () => {
    const officer = await member('srA', 'PD', 'officer');
    const surname = unique('Vasquez');
    const personId = await seedPerson({
      firstName: 'Ramona', lastName: surname, dateOfBirth: '1979-02-28', phone: '555-0199',
    });
    const alias = unique('Ghost');
    await h.db.execute(sql`
      INSERT INTO person_alias (person_id, alias) VALUES (${personId}, ${alias})
    `);

    const find = async (query: string) => {
      const res = await h.app.inject({
        method: 'GET', url: `/api/v1/persons?${query}`, headers: officer.headers,
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { persons: { id: string }[] }).persons.map((p) => p.id);
    };

    expect(await find(`search=${encodeURIComponent(`Ramona ${surname}`)}`)).toContain(personId);
    // Partial: typing the first few letters must already narrow the list.
    expect(await find(`search=${surname.slice(0, 6)}`)).toContain(personId);
    expect(await find('search=555-0199')).toContain(personId);
    expect(await find('phone=5550199')).toContain(personId);
    expect(await find('dateOfBirth=1979-02-28')).toContain(personId);
    expect(await find(`search=${alias}`)).toContain(personId);
    // The identifier, as pasted from another screen or a radio call.
    expect(await find(`search=${personId.slice(0, 8)}`)).toContain(personId);
  });

  it('pages the register and reports the full total', async () => {
    /**
     * Filtered by an exact date of birth, not by name.
     *
     * Name search is FUZZY on purpose — `pg_trgm` similarity is what makes
     * "Vazquez" find "Vasquez" — so its result set legitimately includes
     * near-misses and cannot carry an exact-count assertion. Pagination itself
     * is exact, so it is tested through an exact predicate.
     */
    const officer = await member('srB', 'PD', 'officer');
    seq += 1;
    const dob = `19${String(20 + (seq % 70)).padStart(2, '0')}-0${1 + (seq % 8)}-1${seq % 9}`;
    await h.db.execute(sql`DELETE FROM person WHERE date_of_birth = ${dob}`);
    for (let i = 0; i < 4; i += 1) await seedPerson({ dateOfBirth: dob });

    const first = await h.app.inject({
      method: 'GET', url: `/api/v1/persons?dateOfBirth=${dob}&limit=2`, headers: officer.headers,
    });
    const page1 = first.json() as { persons: { id: string }[]; total: number };
    expect(page1.persons).toHaveLength(2);
    expect(page1.total).toBe(4);

    const second = await h.app.inject({
      method: 'GET', url: `/api/v1/persons?dateOfBirth=${dob}&limit=2&offset=2`,
      headers: officer.headers,
    });
    const page2 = second.json() as { persons: { id: string }[]; total: number };
    expect(page2.persons).toHaveLength(2);

    // Pages must not overlap — the ordering carries a tie-break for this.
    const ids = new Set([...page1.persons, ...page2.persons].map((p) => p.id));
    expect(ids.size).toBe(4);
  });

  it('counts flags, warrants and vehicles on the LIST row', async () => {
    /**
     * The counts are correlated subqueries in a SELECT projection, and drizzle
     * renders an outer column unqualified there. A bare `"id"` inside
     * `(SELECT … FROM person_flag f WHERE f.person_id = "id")` binds to
     * `person_flag.id`, so the predicate silently compared a row to itself and
     * every marker came back zero — with no error anywhere.
     *
     * Nothing else in the suite asserted the counts, so the whole marker column
     * was blank in the UI while every test passed.
     */
    const officer = await member('srE', 'PD', 'officer');
    const personId = await seedPerson({ lastName: unique('Markers') });
    const pd = await organizationIdByKey(h.db, 'PD');

    await h.db.execute(sql`
      INSERT INTO person_flag (person_id, type, severity)
      VALUES (${personId}, 'armed', 'critical')`);
    await h.db.execute(sql`
      INSERT INTO warrant (person_id, organization_id, type, reason)
      VALUES (${personId}, ${pd}, 'arrest', 'Wanted')`);
    await seedVehicle({ ownerPersonId: personId });

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/persons?search=${personId.slice(0, 8)}`,
      headers: officer.headers,
    });
    const row = (res.json() as {
      persons: { id: string; flagCount: number; activeWarrants: number;
        vehicleCount: number; highestFlagSeverity: string | null }[];
    }).persons.find((p) => p.id === personId);

    expect(row?.flagCount).toBe(1);
    expect(row?.highestFlagSeverity).toBe('critical');
    expect(row?.activeWarrants).toBe(1);
    expect(row?.vehicleCount).toBe(1);
  });

  it('REFUSES an unbounded page size', async () => {
    const officer = await member('srC', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/persons?limit=100000', headers: officer.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('filters to the flagged and the wanted', async () => {
    const officer = await member('srD', 'PD', 'officer');
    const tag = unique('Filterable');
    const plain = await seedPerson({ lastName: `${tag}Plain` });
    const flagged = await seedPerson({ lastName: `${tag}Flagged` });

    await h.db.execute(sql`
      INSERT INTO person_flag (person_id, type, severity)
      VALUES (${flagged}, 'armed', 'critical')
    `);

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/persons?search=${tag}&onlyFlagged=true`,
      headers: officer.headers,
    });
    const ids = (res.json() as { persons: { id: string }[] }).persons.map((p) => p.id);
    expect(ids).toContain(flagged);
    expect(ids).not.toContain(plain);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('persons — archiving', () => {
  it('REFUSES archiving someone with active warrants', async () => {
    // Archiving out from under a live warrant takes them off every wanted list
    // without anyone revoking it.
    const commander = await member('paA', 'PD', 'commander');
    const personId = await seedPerson();
    const pd = await organizationIdByKey(h.db, 'PD');
    await h.db.execute(sql`
      INSERT INTO warrant (person_id, organization_id, type, reason)
      VALUES (${personId}, ${pd}, 'arrest', 'Outstanding')
    `);

    const res = await h.app.inject({
      method: 'DELETE', url: `/api/v1/persons/${personId}`, headers: commander.headers,
      payload: { reason: 'Cleaning up.' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ACTIVE_WARRANTS');
  });

  it('SOFT-deletes and hides the record from ordinary lookup', async () => {
    const commander = await member('paB', 'PD', 'commander');
    const officer = await member('paC', 'PD', 'officer');
    const personId = await seedPerson();

    const archived = await h.app.inject({
      method: 'DELETE', url: `/api/v1/persons/${personId}`, headers: commander.headers,
      payload: { reason: 'Duplicate record.' },
    });
    expect(archived.statusCode).toBe(200);

    const rows = await h.db.execute<{ deleted_at: string | null; deletion_reason: string }>(
      sql`SELECT deleted_at, deletion_reason FROM person WHERE id = ${personId}`,
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(rows[0]!.deletion_reason).toBe('Duplicate record.');

    // An officer holds no `persons.view_deleted`, so it is simply gone for them.
    const lookup = await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${personId}`, headers: officer.headers,
    });
    expect(lookup.statusCode).toBe(404);
  });

  it('REFUSES archiving without persons.delete', async () => {
    const officer = await member('paD', 'PD', 'officer');
    const personId = await seedPerson();

    const res = await h.app.inject({
      method: 'DELETE', url: `/api/v1/persons/${personId}`, headers: officer.headers,
      payload: { reason: 'Not mine to remove.' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('warrants — organization-owned data', () => {
  it('issues a warrant under the ACTOR\'S organization, never a supplied one', async () => {
    const supervisor = await member('wrA', 'PD', 'sergeant');
    const personId = await seedPerson();

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/persons/${personId}/warrants`, headers: supervisor.headers,
      payload: { type: 'arrest', reason: 'Failure to appear' },
    });
    expect(res.statusCode).toBe(201);

    const rows = await h.db.execute<{ organization_id: string }>(
      sql`SELECT organization_id FROM warrant WHERE person_id = ${personId}`,
    );
    expect(rows[0]!.organization_id).toBe(supervisor.organizationId);
  });

  it('REFUSES revoking another organization\'s warrant', async () => {
    // A warrant is another organization's decision; quietly cancelling it is
    // exactly the cross-organization interference the scope rules prevent.
    const pdSupervisor = await member('wrB', 'PD', 'sergeant');
    const fibSupervisor = await member('wrC', 'FIB', 'senior_agent');
    const personId = await seedPerson();

    const issued = await h.app.inject({
      method: 'POST', url: `/api/v1/persons/${personId}/warrants`, headers: pdSupervisor.headers,
      payload: { type: 'arrest', reason: 'PD matter' },
    });
    const { warrantId } = issued.json() as { warrantId: string };

    const revoked = await h.app.inject({
      method: 'POST', url: `/api/v1/persons/${personId}/warrants/${warrantId}/resolve`,
      headers: fibSupervisor.headers, payload: { outcome: 'revoked' },
    });
    expect(revoked.statusCode).toBe(403);
    expect(reasonOf(revoked)).toBe('CROSS_ORGANIZATION');

    const rows = await h.db.execute<{ status: string }>(
      sql`SELECT status::text FROM warrant WHERE id = ${warrantId}`,
    );
    expect(rows[0]!.status).toBe('active');
  });

  it('ALLOWS another organization to SERVE it', async () => {
    // The mirror case, and the reason revoking and serving are separate: any
    // organization that arrests the subject should be able to close it out.
    const pdSupervisor = await member('wrD', 'PD', 'sergeant');
    const fibSupervisor = await member('wrE', 'FIB', 'senior_agent');
    const personId = await seedPerson();

    const issued = await h.app.inject({
      method: 'POST', url: `/api/v1/persons/${personId}/warrants`, headers: pdSupervisor.headers,
      payload: { type: 'arrest', reason: 'PD matter' },
    });
    const { warrantId } = issued.json() as { warrantId: string };

    const served = await h.app.inject({
      method: 'POST', url: `/api/v1/persons/${personId}/warrants/${warrantId}/resolve`,
      headers: fibSupervisor.headers, payload: { outcome: 'served' },
    });
    expect(served.statusCode).toBe(200);

    const rows = await h.db.execute<{ status: string; served_by: string }>(
      sql`SELECT status::text, served_by FROM warrant WHERE id = ${warrantId}`,
    );
    expect(rows[0]!.status).toBe('served');
    expect(rows[0]!.served_by).toBe(fibSupervisor.userId);
  });

  it('REFUSES issuing without persons.warrants.manage', async () => {
    const officer = await member('wrF', 'PD', 'officer');
    const personId = await seedPerson();

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/persons/${personId}/warrants`, headers: officer.headers,
      payload: { type: 'arrest', reason: 'Not authorised' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('vehicles — permission gating and fleet scope', () => {
  it('REFUSES the register without vehicles.view, as NOT FOUND', async () => {
    const creds = await createActiveUser(h, 'vgA');
    const auth = await signIn(h, creds);
    // No membership at all: no organization permissions.
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/vehicles', headers: auth.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('ALLOWS registering a privately owned vehicle', async () => {
    const officer = await member('vgB', 'PD', 'officer');
    const ownerId = await seedPerson();
    const plate = uniquePlate('PV');

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/vehicles', headers: officer.headers,
      payload: {
        plate, model: 'sultan', color: 'Black',
        ownerPersonId: ownerId, registrationStatus: 'registered', insuranceStatus: 'insured',
      },
    });
    expect(res.statusCode).toBe(201);

    const { vehicleId } = res.json() as { vehicleId: string };
    const rows = await h.db.execute<{ plate: string; owner_person_id: string }>(
      sql`SELECT plate::text, owner_person_id FROM vehicle WHERE id = ${vehicleId}`,
    );
    expect(rows[0]!.plate).toBe(plate);
    expect(rows[0]!.owner_person_id).toBe(ownerId);
  });

  it('REFUSES a duplicate live plate but allows reusing an archived one', async () => {
    const commander = await member('vgC', 'PD', 'commander');
    const plate = uniquePlate('DUP');

    const first = await h.app.inject({
      method: 'POST', url: '/api/v1/vehicles', headers: commander.headers,
      payload: { plate, model: 'sultan' },
    });
    expect(first.statusCode).toBe(201);
    const { vehicleId } = first.json() as { vehicleId: string };

    const clash = await h.app.inject({
      method: 'POST', url: '/api/v1/vehicles', headers: commander.headers,
      payload: { plate, model: 'buffalo' },
    });
    expect(clash.statusCode).toBe(409);

    // Archiving a vehicle must not permanently burn its plate.
    await h.app.inject({
      method: 'DELETE', url: `/api/v1/vehicles/${vehicleId}`, headers: commander.headers,
      payload: { reason: 'Scrapped.' },
    });
    const reissued = await h.app.inject({
      method: 'POST', url: '/api/v1/vehicles', headers: commander.headers,
      payload: { plate, model: 'buffalo' },
    });
    expect(reissued.statusCode).toBe(201);
  });

  it('REFUSES editing another organization\'s FLEET vehicle', async () => {
    // A PD sergeant retagging an MD ambulance is the same class of interference
    // the rank rules exist to prevent.
    const pdOfficer = await member('vgD', 'PD', 'officer');
    const md = await organizationIdByKey(h.db, 'MD');
    const ambulance = await seedVehicle({ ownerOrganizationId: md, isFleet: true });

    const res = await h.app.inject({
      method: 'PATCH', url: `/api/v1/vehicles/${ambulance.id}`, headers: pdOfficer.headers,
      payload: { color: 'Pink' },
    });
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('CROSS_ORGANIZATION');

    const rows = await h.db.execute<{ color: string | null }>(
      sql`SELECT color FROM vehicle WHERE id = ${ambulance.id}`,
    );
    expect(rows[0]!.color).toBeNull();
  });

  it('ALLOWS editing the actor\'s OWN fleet vehicle', async () => {
    const medic = await member('vgE', 'MD', 'deputy_cmo');
    const md = await organizationIdByKey(h.db, 'MD');
    const ambulance = await seedVehicle({ ownerOrganizationId: md, isFleet: true });

    const res = await h.app.inject({
      method: 'PATCH', url: `/api/v1/vehicles/${ambulance.id}`, headers: medic.headers,
      payload: { color: 'White' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('REFUSES pushing a vehicle into ANOTHER organization\'s fleet', async () => {
    // The destination is checked as well as the origin: otherwise a record could
    // be moved somewhere the actor can no longer reach it.
    const pdOfficer = await member('vgF', 'PD', 'officer');
    const md = await organizationIdByKey(h.db, 'MD');
    const car = await seedVehicle();

    const res = await h.app.inject({
      method: 'PATCH', url: `/api/v1/vehicles/${car.id}`, headers: pdOfficer.headers,
      payload: { ownerOrganizationId: md, isFleet: true },
    });
    expect(res.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('CROSS_ORGANIZATION');
  });

  it('ALLOWS flagging another organization\'s fleet vehicle', async () => {
    // Deliberately NOT fleet-scoped: reporting a vehicle as stolen or of
    // interest is exactly what one organization needs to do about another's
    // property, and refusing it would make the shared register useless.
    const pdOfficer = await member('vgG', 'PD', 'officer');
    const md = await organizationIdByKey(h.db, 'MD');
    const ambulance = await seedVehicle({ ownerOrganizationId: md, isFleet: true });

    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/vehicles/${ambulance.id}/flags`, headers: pdOfficer.headers,
      payload: { type: 'stolen', note: 'Reported taken from Pillbox.' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('REFUSES a vehicle owned by both a person and an organization', async () => {
    const commander = await member('vgH', 'PD', 'commander');
    const ownerId = await seedPerson();

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/vehicles', headers: commander.headers,
      payload: {
        plate: uniquePlate('BO'), model: 'sultan',
        ownerPersonId: ownerId, ownerOrganizationId: commander.organizationId,
      },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('vehicle search and profile', () => {
  it('finds a vehicle by full plate, partial plate, model and owner name', async () => {
    const officer = await member('vsA', 'PD', 'officer');
    const surname = unique('Delgado');
    const ownerId = await seedPerson({ firstName: 'Ines', lastName: surname });
    const plate = uniquePlate('SR');
    await seedVehicle({ plate, ownerPersonId: ownerId });

    const find = async (query: string) => {
      const res = await h.app.inject({
        method: 'GET', url: `/api/v1/vehicles?${query}`, headers: officer.headers,
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { vehicles: { plate: string }[] }).vehicles.map((v) => v.plate);
    };

    expect(await find(`search=${plate}`)).toContain(plate);
    // A partial plate read off a dashcam is the commonest lookup in the system.
    expect(await find(`search=${plate.slice(0, 4)}`)).toContain(plate);
    expect(await find(`search=${surname}`)).toContain(plate);
  });

  it('surfaces the owner\'s active warrant on the row', async () => {
    // What a traffic stop actually needs to know before the officer walks up.
    const officer = await member('vsB', 'PD', 'officer');
    const ownerId = await seedPerson();
    const pd = await organizationIdByKey(h.db, 'PD');
    await h.db.execute(sql`
      INSERT INTO warrant (person_id, organization_id, type, reason)
      VALUES (${ownerId}, ${pd}, 'arrest', 'Wanted')
    `);
    const plate = uniquePlate('WT');
    await seedVehicle({ plate, ownerPersonId: ownerId });

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/vehicles?search=${plate}`, headers: officer.headers,
    });
    const row = (res.json() as { vehicles: { plate: string; ownerHasWarrant: boolean }[] })
      .vehicles.find((v) => v.plate === plate);
    expect(row?.ownerHasWarrant).toBe(true);
  });

  it('AUDITS a plate lookup and shows the record\'s history', async () => {
    const officer = await member('vsC', 'PD', 'officer');
    const commander = await member('vsD', 'PD', 'commander');
    const car = await seedVehicle();

    await h.app.inject({
      method: 'PATCH', url: `/api/v1/vehicles/${car.id}`, headers: commander.headers,
      payload: { registrationStatus: 'expired' },
    });

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/vehicles/${car.id}`, headers: officer.headers,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { history: { action: string; summary: string | null }[] };
    const update = body.history.find((entry) => entry.action === 'vehicle.updated');
    expect(update).toBeTruthy();
    expect(update?.summary).toMatch(/registrationStatus: registered → expired/);

    const viewed = await h.db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE entity_id = ${car.id} AND action = 'vehicle.viewed'
      ORDER BY occurred_at DESC LIMIT 1
    `);
    expect(viewed[0]?.action).toBe('vehicle.viewed');
  });

  it('marks another organization\'s fleet as not manageable, with the reason', async () => {
    const pdOfficer = await member('vsE', 'PD', 'officer');
    const md = await organizationIdByKey(h.db, 'MD');
    const plate = uniquePlate('FL');
    await seedVehicle({ plate, ownerOrganizationId: md, isFleet: true });

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/vehicles?search=${plate}`, headers: pdOfficer.headers,
    });
    const row = (res.json() as {
      vehicles: { plate: string; manageable: boolean; lockedReason: string | null }[];
    }).vehicles.find((v) => v.plate === plate);

    expect(row?.manageable).toBe(false);
    expect(row?.lockedReason).toMatch(/MD/);
  });

  it('counts flags on the vehicle LIST row and the profile', async () => {
    // Same projection trap as the person markers: `vehicle_flag` has an `id`,
    // so an unqualified outer reference compared the flag row to itself.
    const officer = await member('vsG', 'PD', 'officer');
    const car = await seedVehicle();
    await h.db.execute(sql`
      INSERT INTO vehicle_flag (vehicle_id, type) VALUES (${car.id}, 'stolen')`);

    const list = await h.app.inject({
      method: 'GET', url: `/api/v1/vehicles?search=${car.plate}`, headers: officer.headers,
    });
    const row = (list.json() as { vehicles: { plate: string; flagCount: number }[] })
      .vehicles.find((v) => v.plate === car.plate);
    expect(row?.flagCount).toBe(1);

    const profile = await h.app.inject({
      method: 'GET', url: `/api/v1/vehicles/${car.id}`, headers: officer.headers,
    });
    expect((profile.json() as { vehicle: { flagCount: number } }).vehicle.flagCount).toBe(1);
  });

  it('counts a person\'s owned vehicles with their flags', async () => {
    const officer = await member('vsH', 'PD', 'officer');
    const ownerId = await seedPerson();
    const car = await seedVehicle({ ownerPersonId: ownerId });
    await h.db.execute(sql`
      INSERT INTO vehicle_flag (vehicle_id, type) VALUES (${car.id}, 'of interest')`);

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${ownerId}`, headers: officer.headers,
    });
    const vehicles = (res.json() as { vehicles: { plate: string; flagCount: number }[] }).vehicles;
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]!.flagCount).toBe(1);
  });

  it('pages the register and reports the full total', async () => {
    // Filtered by owner rather than by plate, for the same reason as the person
    // pagination test: plate search is fuzzy, `ownerPersonId` is exact.
    const officer = await member('vsF', 'PD', 'officer');
    const ownerId = await seedPerson();
    for (let i = 0; i < 3; i += 1) await seedVehicle({ ownerPersonId: ownerId });

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/vehicles?ownerPersonId=${ownerId}&limit=2`,
      headers: officer.headers,
    });
    const body = res.json() as { vehicles: unknown[]; total: number };
    expect(body.vehicles).toHaveLength(2);
    expect(body.total).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('an explicit deny beats a role grant', () => {
  it('withholds criminal history from an officer denied the permission', async () => {
    // The override mechanism is what makes "some organizations have broader
    // access" adjustable per person without inventing a one-off role.
    const officer = await member('ovA', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'persons.criminal.view', 'deny');
    const reauth = await signIn(h, {
      username: officer.username, password: 'correct-horse-staple-42',
    });

    const personId = await seedPerson();
    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/persons/${personId}`, headers: reauth.headers,
    });

    const body = res.json() as Record<string, unknown> & { withheld: string[] };
    expect(body).not.toHaveProperty('criminal');
    expect(body.withheld).toContain('criminal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reads never expose credentials', () => {
  it('keeps password hashes out of both registers', async () => {
    const officer = await member('lkA', 'PD', 'officer');
    await seedPerson();
    await seedVehicle();

    for (const url of ['/api/v1/persons', '/api/v1/vehicles']) {
      const res = await h.app.inject({ method: 'GET', url, headers: officer.headers });
      expect(res.body, url).not.toMatch(/\$argon2/);
      expect(res.body, url).not.toMatch(/password/i);
      expect(res.body, url).not.toMatch(/token_hash|tokenHash/i);
    }
  });
});
