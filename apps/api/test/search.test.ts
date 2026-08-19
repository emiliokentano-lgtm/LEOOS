import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createActiveUser, createHarness, grantMembership, makeGlobalAdmin,
  organizationIdByKey, resetAccounts, setPermissionOverride, signIn, userIdByUsername,
  type TestHarness,
} from './harness.js';

/**
 * Global search.
 *
 * Cross-entity search is the easiest place in the system to leak something: one
 * screen that touches every table, where a category nobody remembered to filter
 * turns the search box into a way to enumerate records the operator could not
 * open directly.
 *
 * So most of this file is one question asked six ways — CAN THE SEARCH BOX
 * REACH SOMETHING THE SCREENS WOULD REFUSE? Including the counts: "MD personnel:
 * 42" leaks the size of another department's roster just as surely as listing
 * them would.
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
  return `${prefix}${seq}${Date.now().toString(36).slice(-4)}`;
}

interface SearchResponse {
  query: string;
  tooShort: boolean;
  minLength: number;
  available: string[];
  grouped?: boolean;
  total: number;
  results: {
    category: string;
    total: number;
    hits: { id: string; title: string; subtitle: string | null; facts: string[];
      href: string; badge: { label: string } | null }[];
  }[];
}

async function search(
  who: { headers: Record<string, string> },
  query: string,
): Promise<SearchResponse> {
  const res = await h.app.inject({
    method: 'GET', url: `/api/v1/search?${query}`, headers: who.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as SearchResponse;
}


/**
 * The payload MINUS the echoed query.
 *
 * A response repeats the term the caller typed, so asserting that the whole body
 * does not contain it is always false. What must not appear is the term inside
 * the RESULTS — that is where a leak would show.
 */
function resultsBlob(body: SearchResponse): string {
  return JSON.stringify(body.results);
}

function category(body: SearchResponse, name: string) {
  return body.results.find((r) => r.category === name);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('the search box cannot reach past the screens', () => {
  it('never returns another organization\'s PERSONNEL, or their count', async () => {
    // The leak that matters most: typing a surname must not enumerate every
    // department's roster.
    const surname = unique('Kowalczyk');
    const pdOfficer = await member('sxA', 'PD', 'officer');

    const mdCreds = await createActiveUser(h, 'sxB');
    await h.db.execute(sql`
      UPDATE user_account SET display_name = ${`Marta ${surname}`}
      WHERE username = ${mdCreds.username}`);
    await grantMembership(h.db, mdCreds.username, { orgKey: 'MD', roleKey: 'doctor' });

    const body = await search(pdOfficer, `q=${surname}`);
    const personnel = category(body, 'personnel');

    // Not "empty results" — the category must contribute nothing at all.
    expect(personnel?.hits ?? []).toHaveLength(0);
    expect(personnel?.total ?? 0).toBe(0);
    // And the name must not appear anywhere in the results.
    expect(resultsBlob(body)).not.toContain(surname);
  });

  it('DOES return the actor\'s own organization\'s personnel', async () => {
    const surname = unique('Ferrante');
    const pdOfficer = await member('sxC', 'PD', 'officer');

    const colleague = await createActiveUser(h, 'sxD');
    await h.db.execute(sql`
      UPDATE user_account SET display_name = ${`Nina ${surname}`}
      WHERE username = ${colleague.username}`);
    await grantMembership(h.db, colleague.username, { orgKey: 'PD', roleKey: 'sergeant' });

    const body = await search(pdOfficer, `q=${surname}`);
    const personnel = category(body, 'personnel');

    expect(personnel?.total).toBe(1);
    expect(personnel?.hits[0]?.title).toContain(surname);
    // The result carries the rank and callsign the brief asked for.
    expect(personnel?.hits[0]?.facts.join(' ')).toMatch(/Rank:/);
  });

  it('never returns another organization\'s UNITS', async () => {
    const callsign = unique('MED').toUpperCase().slice(0, 10);
    const pdOfficer = await member('sxE', 'PD', 'officer');
    const md = await organizationIdByKey(h.db, 'MD');
    await h.db.execute(sql`
      INSERT INTO unit (organization_id, callsign, unit_type) VALUES (${md}, ${callsign}, 'patrol')`);

    const body = await search(pdOfficer, `q=${callsign}`);
    expect(category(body, 'units')?.total ?? 0).toBe(0);
    expect(resultsBlob(body)).not.toContain(callsign);
  });

  it('never returns another organization\'s INCIDENTS', async () => {
    const marker = unique('Backroom');
    const pdOfficer = await member('sxF', 'PD', 'officer');
    const fib = await organizationIdByKey(h.db, 'FIB');
    await h.db.execute(sql`
      INSERT INTO incident (organization_id, title, priority)
      VALUES (${fib}, ${`${marker} surveillance`}, 2)`);

    const body = await search(pdOfficer, `q=${marker}`);
    expect(category(body, 'incidents')?.total ?? 0).toBe(0);
    expect(resultsBlob(body)).not.toContain(marker);
  });

  it('DOES return a MULTI-AGENCY incident to everyone', async () => {
    // An incident with no owning organization is genuinely shared, and hiding it
    // would be the wrong kind of scoping.
    const marker = unique('Pileup');
    const pdOfficer = await member('sxG', 'PD', 'officer');
    await h.db.execute(sql`
      INSERT INTO incident (organization_id, title, priority)
      VALUES (NULL, ${`${marker} on the freeway`}, 1)`);

    const body = await search(pdOfficer, `q=${marker}`);
    expect(category(body, 'incidents')?.total).toBe(1);
    expect(category(body, 'incidents')?.hits[0]?.badge?.label).toBe('P1');
  });

  it('never returns another organization to someone who is not in it', async () => {
    const pdOfficer = await member('sxH', 'PD', 'officer');

    const body = await search(pdOfficer, 'q=Medical');
    const orgs = category(body, 'organizations');

    for (const hit of orgs?.hits ?? []) {
      expect(hit.title).not.toMatch(/Medical/);
    }
    expect(orgs?.total ?? 0).toBe(0);
  });

  it('lets a GLOBAL ADMIN reach every organization', async () => {
    const surname = unique('Vandenberg');
    const admin = await createActiveUser(h, 'sxI');
    await makeGlobalAdmin(h.db, admin.username);
    const auth = await signIn(h, admin);

    const medic = await createActiveUser(h, 'sxJ');
    await h.db.execute(sql`
      UPDATE user_account SET display_name = ${`Ola ${surname}`}
      WHERE username = ${medic.username}`);
    await grantMembership(h.db, medic.username, { orgKey: 'MD', roleKey: 'doctor' });

    const body = await search(auth, `q=${surname}`);
    expect(category(body, 'personnel')?.total).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('categories follow the permission that gates their own screen', () => {
  it('omits categories the caller cannot read', async () => {
    // A Mechanic apprentice holds neither `persons.view` nor `dispatch.view`
    // beyond the basics — search must not become a second, weaker door.
    const apprentice = await member('scA', 'MECHANIC', 'apprentice');

    const body = await search(apprentice, 'q=a');
    expect(body.available).not.toContain('persons');
    expect(body.available).toContain('vehicles');
  });

  it('drops a category asked for EXPLICITLY that the caller cannot read', async () => {
    // Answering "you are not allowed" would itself be a statement about what
    // exists, so the category is dropped rather than refused.
    const apprentice = await member('scB', 'MECHANIC', 'apprentice');
    const surname = unique('Nakamura');
    await h.db.execute(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Kenji', ${surname})`);

    const res = await h.app.inject({
      method: 'GET', url: `/api/v1/search?q=${surname}&category=persons`,
      headers: apprentice.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.results).toHaveLength(0);
    expect(resultsBlob(body)).not.toContain(surname);
  });

  it('honours an explicit permission DENY', async () => {
    const officer = await member('scC', 'PD', 'officer');
    await setPermissionOverride(h.db, officer.memberId, 'persons.view', 'deny');
    const reauth = await signIn(h, {
      username: officer.username, password: 'correct-horse-staple-42',
    });

    const surname = unique('Ostrowski');
    await h.db.execute(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Piotr', ${surname})`);

    const body = await search(reauth, `q=${surname}`);
    expect(body.available).not.toContain('persons');
    expect(resultsBlob(body)).not.toContain(surname);
  });

  it('hides ARCHIVED records without the separate permission', async () => {
    const officer = await member('scD', 'PD', 'officer');
    const surname = unique('Bergstrom');
    const rows = await h.db.execute<{ id: string }>(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Sven', ${surname}) RETURNING id`);
    await h.db.execute(sql`
      UPDATE person SET deleted_at = now(), deleted_by = ${officer.userId},
        deletion_reason = 'test' WHERE id = ${rows[0]!.id}`);

    const body = await search(officer, `q=${surname}`);
    expect(category(body, 'persons')?.total ?? 0).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('search behaviour', () => {
  it('refuses to query anything below the minimum length', async () => {
    // One character against six trigram indexes is a scan of everything.
    const officer = await member('sbA', 'PD', 'officer');

    const body = await search(officer, 'q=a');
    expect(body.tooShort).toBe(true);
    expect(body.minLength).toBe(2);
    expect(body.results).toHaveLength(0);
    // The category list is still returned so the UI can render its filters.
    expect(body.available.length).toBeGreaterThan(0);
  });

  it('groups results by category with a real total each', async () => {
    const officer = await member('sbB', 'PD', 'officer');
    const marker = unique('Zephyr');

    await h.db.execute(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Ada', ${marker})`);
    await h.db.execute(sql`
      INSERT INTO vehicle (plate, model) VALUES (${marker.toUpperCase().slice(0, 10)}, ${marker})`);

    const body = await search(officer, `q=${marker}`);
    const names = body.results.map((r) => r.category);
    expect(names).toContain('persons');
    expect(names).toContain('vehicles');
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('caps each category in a GROUPED search but reports the true total', async () => {
    // The palette shows five; the count tells the operator there are more.
    const officer = await member('sbC', 'PD', 'officer');
    const marker = unique('Multiplex');
    for (let i = 0; i < 8; i += 1) {
      await h.db.execute(sql`
        INSERT INTO person (first_name, last_name) VALUES (${`P${i}`}, ${marker})`);
    }

    const body = await search(officer, `q=${marker}`);
    const persons = category(body, 'persons');
    expect(persons?.hits).toHaveLength(5);
    expect(persons?.total).toBe(8);
  });

  it('pages a single category properly', async () => {
    const officer = await member('sbD', 'PD', 'officer');
    const marker = unique('Paginated');
    for (let i = 0; i < 6; i += 1) {
      await h.db.execute(sql`
        INSERT INTO person (first_name, last_name) VALUES (${`Q${i}`}, ${marker})`);
    }

    const first = await search(officer, `q=${marker}&category=persons&limit=4`);
    expect(category(first, 'persons')?.hits).toHaveLength(4);
    expect(category(first, 'persons')?.total).toBe(6);

    const second = await search(officer, `q=${marker}&category=persons&limit=4&offset=4`);
    expect(category(second, 'persons')?.hits).toHaveLength(2);

    // Pages must not overlap — every category orders by a unique tie-break.
    const ids = new Set([
      ...(category(first, 'persons')?.hits ?? []),
      ...(category(second, 'persons')?.hits ?? []),
    ].map((hit) => hit.id));
    expect(ids.size).toBe(6);
  });

  it('REFUSES an unbounded page size', async () => {
    const officer = await member('sbE', 'PD', 'officer');
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/search?q=test&category=persons&limit=100000',
      headers: officer.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps an empty category in a PAGED response and drops it when grouped', async () => {
    const officer = await member('sbF', 'PD', 'officer');
    const marker = unique('Nothingmatches');

    const grouped = await search(officer, `q=${marker}`);
    expect(grouped.results).toHaveLength(0);

    // Paged keeps its shape, so the screen can say "no results in vehicles"
    // rather than silently falling back to everything.
    const paged = await search(officer, `q=${marker}&category=vehicles`);
    expect(paged.results).toHaveLength(1);
    expect(category(paged, 'vehicles')?.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('result shapes match what an operator reads', () => {
  it('builds a person, vehicle, personnel and incident result', async () => {
    const officer = await member('srA', 'PD', 'officer');
    const marker = unique('Rosetta');
    const pd = officer.organizationId;

    await h.db.execute(sql`
      INSERT INTO person (first_name, last_name, date_of_birth, phone_number)
      VALUES ('John', ${marker}, '1990-06-15', '555-0123')`);
    await h.db.execute(sql`
      INSERT INTO vehicle (plate, model, display_name, color)
      VALUES (${marker.toUpperCase().slice(0, 10)}, 'police3', ${`${marker} Cruiser`}, 'Black')`);
    await h.db.execute(sql`
      INSERT INTO incident (organization_id, title, priority, status)
      VALUES (${pd}, ${`${marker} burglary`}, 1, 'dispatched')`);

    const body = await search(officer, `q=${marker}`);

    const person = category(body, 'persons')?.hits[0];
    expect(person?.title).toContain('John');
    expect(person?.subtitle).toBe('Citizen');
    expect(person?.facts.join(' ')).toMatch(/DOB 1990-06-15/);
    expect(person?.facts.join(' ')).toMatch(/555-0123/);

    const vehicle = category(body, 'vehicles')?.hits[0];
    expect(vehicle?.subtitle).toContain('Cruiser');
    expect(vehicle?.facts.join(' ')).toMatch(/Black/);

    const inc = category(body, 'incidents')?.hits[0];
    // The number is the line read aloud over the radio, so it is the title.
    expect(inc?.title).toMatch(/^\d{4}-\d{2}-\d+$/);
    expect(inc?.subtitle).toContain('burglary');
    expect(inc?.facts.join(' ')).toMatch(/Priority: P1/);
    expect(inc?.facts.join(' ')).toMatch(/Status: dispatched/);
    expect(inc?.badge?.label).toBe('P1');
  });

  it('marks a wanted person on the result row', async () => {
    const officer = await member('srB', 'PD', 'officer');
    const marker = unique('Wantedman');
    const rows = await h.db.execute<{ id: string }>(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Vic', ${marker}) RETURNING id`);
    await h.db.execute(sql`
      INSERT INTO warrant (person_id, organization_id, type, reason)
      VALUES (${rows[0]!.id}, ${officer.organizationId}, 'arrest', 'Wanted')`);

    const body = await search(officer, `q=${marker}`);
    expect(category(body, 'persons')?.hits[0]?.badge?.label).toBe('Wanted');
  });

  it('finds a person by ALIAS and a vehicle by PARTIAL plate', async () => {
    const officer = await member('srC', 'PD', 'officer');
    const alias = unique('Shadowfax');
    const rows = await h.db.execute<{ id: string }>(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Ivo', 'Petrov') RETURNING id`);
    await h.db.execute(sql`
      INSERT INTO person_alias (person_id, alias) VALUES (${rows[0]!.id}, ${alias})`);

    const plate = unique('PLT').toUpperCase().slice(0, 10);
    await h.db.execute(sql`INSERT INTO vehicle (plate, model) VALUES (${plate}, 'sultan')`);

    const byAlias = await search(officer, `q=${alias}`);
    expect(category(byAlias, 'persons')?.total).toBe(1);

    const byPartial = await search(officer, `q=${plate.slice(0, 5)}`);
    expect(category(byPartial, 'vehicles')?.hits.some((v) => v.title === plate)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('auditing', () => {
  it('records a search that matched something', async () => {
    // "Who looked up whom" is a question this system must be able to answer.
    const officer = await member('saA', 'PD', 'officer');
    const marker = unique('Audited');
    await h.db.execute(sql`
      INSERT INTO person (first_name, last_name) VALUES ('Lea', ${marker})`);

    await search(officer, `q=${marker}`);

    const rows = await h.db.execute<{ metadata: Record<string, unknown> }>(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'search.performed' AND actor_user_id = ${officer.userId}
      ORDER BY occurred_at DESC LIMIT 1`);

    expect(rows[0]?.metadata).toMatchObject({ term: marker });
    expect(JSON.stringify(rows[0]?.metadata)).toMatch(/persons:1/);
  });

  it('does NOT record a search that matched nothing', async () => {
    // A search with no results says nothing about anyone, and logging every
    // keystroke pause would bury the entries that matter.
    const officer = await member('saB', 'PD', 'officer');
    const marker = unique('Fruitless');

    await search(officer, `q=${marker}`);

    const rows = await h.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'search.performed' AND actor_user_id = ${officer.userId}`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('records the TERM and the counts, never the matched records', async () => {
    // The audit table must not become a second copy of the register.
    const officer = await member('saC', 'PD', 'officer');
    const marker = unique('Discreet');
    await h.db.execute(sql`
      INSERT INTO person (first_name, last_name, phone_number)
      VALUES ('Yara', ${marker}, '555-0911')`);

    await search(officer, `q=${marker}`);

    const rows = await h.db.execute<{ metadata: unknown }>(sql`
      SELECT metadata FROM audit_log
      WHERE action = 'search.performed' AND actor_user_id = ${officer.userId}
      ORDER BY occurred_at DESC LIMIT 1`);

    const blob = JSON.stringify(rows[0]?.metadata);
    expect(blob).toContain(marker);
    expect(blob).not.toContain('Yara');
    expect(blob).not.toContain('555-0911');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('reads never expose credentials', () => {
  it('keeps password hashes out of every category', async () => {
    const officer = await member('slA', 'PD', 'officer');
    const body = await h.app.inject({
      method: 'GET', url: '/api/v1/search?q=te', headers: officer.headers,
    });
    expect(body.body).not.toMatch(/\$argon2/);
    expect(body.body).not.toMatch(/password/i);
    expect(body.body).not.toMatch(/token_hash|tokenHash/i);
  });
});
