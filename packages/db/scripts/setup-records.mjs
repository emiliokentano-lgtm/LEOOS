/**
 * The person and vehicle fixtures the records and search walkthroughs assert on.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT THE DEMO SEED
 *
 * `db:seed:demo` is the small, honest demo: five personnel, a suspect, two
 * vehicles, one incident. It is meant to be readable, and it is what somebody
 * loads to look around.
 *
 * These fixtures exist for a different reason — each one is the input to a
 * specific ASSERTION. The walkthrough claims that an officer sees a criminal
 * record and is told the medical record is withheld, that a doctor sees the
 * reverse, that a wanted owner raises a banner on their vehicle, and that
 * another organization's fleet reads as locked. None of those can be checked
 * without a person who is simultaneously flagged, wanted and charged, which is
 * not a person a demo should be full of.
 *
 * They were created by hand once and lived in one developer's database, which
 * made `records-check.mjs` fail on a clean checkout with
 * `waiting for locator('tbody tr').filter({ hasText: 'Holm' })` — a message that
 * says nothing about the missing row it is really about.
 *
 * Idempotent. Refuses a production database.
 *
 * Usage:
 *   DATABASE_URL=… node scripts/setup-records.mjs
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL.');
  process.exit(2);
}

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error(
    'Refusing to write fabricated person and vehicle records into a production '
    + 'database. These are fixtures, not records.',
  );
  process.exit(2);
}

const sql = postgres(DATABASE_URL, { onnotice: () => {} });
const log = (message) => console.error(`[records-fixture] ${message}`);

const [pd] = await sql`SELECT id FROM organization WHERE key = 'PD'`;
const [md] = await sql`SELECT id FROM organization WHERE key = 'MD'`;
if (!pd || !md) {
  console.error('Baseline organizations missing — run `pnpm db:seed` first.');
  process.exit(2);
}

async function upsertPerson(first, last, extra = {}) {
  const existing = await sql`
    SELECT id FROM person
     WHERE first_name = ${first} AND last_name = ${last} AND deleted_at IS NULL
     LIMIT 1
  `;
  if (existing.length > 0) return existing[0].id;
  const [row] = await sql`
    INSERT INTO person (first_name, last_name, date_of_birth, phone_number, address)
    VALUES (${first}, ${last}, ${extra.dob ?? null}, ${extra.phone ?? null}, ${extra.address ?? null})
    RETURNING id
  `;
  return row.id;
}

// ── The wanted person ───────────────────────────────────────────────────────
//
// Flagged critical, warranted and charged, all at once. The records walkthrough
// reads all three banners off one profile, so they have to be on one person.
const holm = await upsertPerson('Erik', 'Holm', {
  dob: '1988-07-02',
  phone: '555-0119',
  address: 'Vespucci Beach, Magellan Ave 3',
});
log(`person Erik Holm → ${holm}`);

await sql`
  INSERT INTO person_alias (person_id, alias, note)
  VALUES (${holm}, 'The Swede', 'Known on the street by this name.')
  ON CONFLICT (person_id, alias) DO NOTHING
`;

/**
 * The flag type is FREE TEXT, entered by an operator — the dialog's own hint
 * says "e.g. armed and dangerous". A snake_case key here would be a fixture
 * written against a schema instead of against the product, and would render as
 * `armed_and_dangerous` on the banner.
 */
const flagExists = await sql`
  SELECT 1 FROM person_flag
   WHERE person_id = ${holm} AND lower(type) = 'armed and dangerous' AND resolved_at IS NULL
`;
if (flagExists.length === 0) {
  await sql`
    INSERT INTO person_flag (person_id, type, severity, note)
    VALUES (${holm}, 'Armed and dangerous', 'critical',
            'Approach with two units.')
  `;
}

const warrantExists = await sql`
  SELECT 1 FROM warrant WHERE person_id = ${holm} AND status = 'active'
`;
if (warrantExists.length === 0) {
  await sql`
    INSERT INTO warrant (person_id, organization_id, type, status, reason)
    VALUES (${holm}, ${pd.id}, 'arrest', 'active',
            'Failure to appear — armed robbery, Fleeca Bank.')
  `;
}

/**
 * The statute the charge cites.
 *
 * `criminal_charge.statute_code` is a foreign key into a catalogue that NOTHING
 * SEEDS — charges are read-only in the API today and no screen files one, so the
 * table has never been populated. The fixture inserts the one row it cites
 * rather than leaving the code null, so the charge reads the way a real one
 * would.
 */
await sql`
  INSERT INTO statute (code, title, description, severity, default_fine, category)
  VALUES ('PC-487', 'Grand theft auto',
          'Theft of a motor vehicle.', 'felony', 5000, 'Property')
  ON CONFLICT (code) DO NOTHING
`;

const chargeExists = await sql`
  SELECT 1 FROM criminal_charge WHERE person_id = ${holm} AND title = 'Grand theft auto'
`;
if (chargeExists.length === 0) {
  await sql`
    INSERT INTO criminal_charge (person_id, statute_code, title, severity, status, notes)
    VALUES (${holm}, 'PC-487', 'Grand theft auto', 'felony', 'convicted',
            'Vehicle recovered at Sandy Shores.')
  `;
}
log('  alias, critical flag, active warrant and a felony charge');

// ── The person with a medical record ────────────────────────────────────────
//
// Alex Reyes comes from the demo seed as PD personnel; if that seed has not run,
// the person is created here so the doctor half of the walkthrough still works.
const reyes = await upsertPerson('Alex', 'Reyes');
await sql`
  INSERT INTO medical_record (person_id, blood_type, allergies, conditions, medications, notes)
  VALUES (${reyes}, 'O-', ARRAY['Penicillin'], ARRAY['Asthma'], ARRAY['Salbutamol inhaler'],
          'Carries an inhaler. Penicillin allergy is severe.')
  ON CONFLICT (person_id) DO UPDATE
     SET allergies = EXCLUDED.allergies, blood_type = EXCLUDED.blood_type
`;
log(`person Alex Reyes → medical record (Penicillin allergy)`);

// ── The vehicles ────────────────────────────────────────────────────────────
async function upsertVehicle(plate, values) {
  const existing = await sql`SELECT id FROM vehicle WHERE plate = ${plate} AND deleted_at IS NULL`;
  if (existing.length > 0) return existing[0].id;
  const [row] = await sql`
    INSERT INTO vehicle (plate, model, display_name, color, owner_person_id,
                         owner_organization_id, is_fleet, registration_status, insurance_status)
    VALUES (${plate}, ${values.model}, ${values.displayName}, ${values.color},
            ${values.ownerPersonId ?? null}, ${values.ownerOrganizationId ?? null},
            ${values.isFleet ?? false}, ${values.registration ?? 'registered'},
            ${values.insurance ?? 'insured'})
    RETURNING id
  `;
  return row.id;
}

/** Owned by the wanted person, and flagged stolen — two banners, one vehicle. */
const rustbkt = await upsertVehicle('RUSTBKT', {
  model: 'rebel', displayName: 'Karin Rebel', color: 'Rust',
  ownerPersonId: holm, registration: 'expired', insurance: 'uninsured',
});
const vFlag = await sql`
  SELECT 1 FROM vehicle_flag WHERE vehicle_id = ${rustbkt} AND type = 'stolen' AND resolved_at IS NULL
`;
if (vFlag.length === 0) {
  await sql`
    INSERT INTO vehicle_flag (vehicle_id, type, note)
    VALUES (${rustbkt}, 'stolen', 'Reported stolen from Paleto Bay.')
  `;
}
log('vehicle RUSTBKT → owned by Holm, flagged stolen');

/** MD fleet, so a PD officer's view of it must read as locked. */
await upsertVehicle('EMS0302', {
  model: 'ambulance', displayName: 'Ambulance', color: 'White',
  ownerOrganizationId: md.id, isFleet: true,
});
log('vehicle EMS0302 → MD fleet (read-only to PD)');

// ── Two incidents and a unit, one per organization ──────────────────────────
//
// The search walkthrough's central claim is that organization scope holds
// through the search path: a PD officer finds the burglary and NOT the cardiac
// arrest, and a doctor finds the mirror image. That needs one open incident in
// each organization, and an MD unit for the callsign half of the same test.
async function upsertIncident(orgId, title, values) {
  const existing = await sql`
    SELECT id FROM incident WHERE title = ${title} AND deleted_at IS NULL LIMIT 1
  `;
  if (existing.length > 0) return existing[0].id;
  const [row] = await sql`
    INSERT INTO incident (organization_id, type_key, priority, status, title,
                          description, location_text, pos_x, pos_y, source)
    VALUES (${orgId}, ${values.typeKey}, ${values.priority}, ${values.status},
            ${title}, ${values.description}, ${values.location},
            ${values.x}, ${values.y}, 'manual')
    RETURNING id
  `;
  return row.id;
}

await upsertIncident(pd.id, 'Burglary in progress — Vinewood Hills', {
  typeKey: 'burglary', priority: 2, status: 'dispatched',
  description: 'Neighbour reports a broken rear window.',
  location: 'Vinewood Hills, Mad Wayne Thunder Dr', x: -1200, y: 500,
});
log('incident "Burglary in progress" → PD');

await upsertIncident(md.id, 'Cardiac arrest — Del Perro Pier', {
  typeKey: 'medical_emergency', priority: 1, status: 'dispatched',
  description: 'Bystander CPR in progress.',
  location: 'Del Perro Pier', x: -1650, y: -1080,
});
log('incident "Cardiac arrest" → MD');

const medicUnit = await sql`
  SELECT id FROM unit WHERE organization_id = ${md.id} AND callsign = 'MEDIC-3'
     AND status = 'active'
`;
if (medicUnit.length === 0) {
  await sql`
    INSERT INTO unit (organization_id, callsign, unit_type, status_key, pos_x, pos_y, heading)
    VALUES (${md.id}, 'MEDIC-3', 'medical', 'available', -1650, -1080, 45)
  `;
}
log('unit MEDIC-3 → MD');

log('');
log('Records fixtures ready for records-check.mjs and search-check.mjs.');

await sql.end({ timeout: 5 });
