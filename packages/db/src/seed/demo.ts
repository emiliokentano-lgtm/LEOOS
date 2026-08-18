import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  incident, memberRole, memberStatus, organization, organizationMember, person, role,
  unit, unitMember, userAccount, vehicle,
} from '../schema/index.js';

/**
 * DEMO FIXTURES — NOT PRODUCTION DATA.
 *
 * Fabricated records for local development and review. Per engineering rules 34
 * and 35 this is never loaded into a production database: the function refuses
 * to run when NODE_ENV is production unless ALLOW_DEMO_SEED is explicitly set,
 * and it logs a warning either way.
 *
 * Every account created here uses a placeholder password hash that verifies
 * against nothing — these are not usable logins, they are row fixtures.
 */

/**
 * A syntactically valid Argon2id hash that no password produces. Deliberate:
 * a demo account must never be signable-into, and storing an obviously fake
 * value makes that visible in the database rather than implied.
 */
const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ZGVtby1zZWVkLW5vLWxvZ2lu$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface DemoSeedResult {
  summary: string;
}

export async function seedDemoData(db: Database): Promise<DemoSeedResult> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'Refusing to load demo fixtures into a production database. ' +
        'Set ALLOW_DEMO_SEED=true only if this is genuinely intended.',
    );
  }
  console.warn('  ⚠ loading DEMO fixtures — fabricated data, not real records');

  const orgs = await db.select().from(organization);
  const byKey = new Map(orgs.map((o) => [o.key.toLowerCase(), o]));
  const pd = byKey.get('pd');
  const md = byKey.get('md');
  if (!pd || !md) throw new Error('Baseline organizations missing — run the base seed first.');

  // ── accounts & persons ───────────────────────────────────────────────────
  const people = [
    { first: 'Jordan', last: 'Mercer', username: 'demo.mercer', roleKey: 'lieutenant', org: pd, callsign: '3-ADAM-12' },
    { first: 'Marcus', last: 'Boone', username: 'demo.boone', roleKey: 'commander', org: pd, callsign: '1-SAM-7' },
    { first: 'Dana', last: 'Whitfield', username: 'demo.whitfield', roleKey: 'sergeant', org: pd, callsign: '2-LINCOLN-4' },
    { first: 'Alex', last: 'Reyes', username: 'demo.reyes', roleKey: 'officer', org: pd, callsign: '3-ADAM-12B' },
    { first: 'Sam', last: 'Okafor', username: 'demo.okafor', roleKey: 'paramedic', org: md, callsign: 'MED-3' },
  ];

  const memberIds: string[] = [];

  for (const p of people) {
    const [account] = await db
      .insert(userAccount)
      .values({
        email: `${p.username}@demo.invalid`,
        username: p.username,
        displayName: `${p.first} ${p.last}`,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        status: 'active',
        emailVerifiedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning();

    const acct =
      account ??
      (await db.select().from(userAccount).where(eq(userAccount.username, p.username)))[0];
    if (!acct) throw new Error(`demo account ${p.username} could not be created`);

    const [personRow] = await db
      .insert(person)
      .values({ firstName: p.first, lastName: p.last, createdBy: acct.id })
      .returning();

    const [member] = await db
      .insert(organizationMember)
      .values({
        userId: acct.id,
        organizationId: p.org.id,
        personId: personRow?.id ?? null,
        callsign: p.callsign,
        status: 'active',
      })
      .onConflictDoNothing()
      .returning();

    if (!member) continue;
    memberIds.push(member.id);

    const [roleRow] = await db
      .select()
      .from(role)
      .where(sql`${role.organizationId} = ${p.org.id} AND ${role.key} = ${p.roleKey}`);
    if (roleRow) {
      await db
        .insert(memberRole)
        .values({ memberId: member.id, roleId: roleRow.id })
        .onConflictDoNothing();
    }

    await db
      .insert(memberStatus)
      .values({ memberId: member.id, statusKey: 'available' })
      .onConflictDoNothing();
  }

  // ── civilians & vehicles ─────────────────────────────────────────────────
  const [suspect] = await db
    .insert(person)
    .values({
      firstName: 'Diego', lastName: 'Castellanos',
      dateOfBirth: '1991-03-14', phoneNumber: '555-0142',
      address: 'Mirror Park, Nikola Ave 12',
    })
    .returning();

  await db
    .insert(vehicle)
    .values([
      {
        plate: '44XKM921', model: 'sultan', displayName: 'Karin Sultan', color: 'Grey',
        ownerPersonId: suspect?.id ?? null,
        registrationStatus: 'expired', insuranceStatus: 'uninsured',
      },
      {
        plate: 'LSPD0412', model: 'police3', displayName: 'Police Cruiser',
        color: 'Black/White', ownerOrganizationId: pd.id, isFleet: true,
        registrationStatus: 'registered', insuranceStatus: 'insured',
      },
    ])
    .onConflictDoNothing({ target: vehicle.plate, where: sql`deleted_at IS NULL` });

  // ── a unit and an open incident ──────────────────────────────────────────
  const [patrol] = await db
    .insert(unit)
    .values({
      organizationId: pd.id, callsign: '3-ADAM-12', unitType: 'patrol',
      statusKey: 'on_scene', posX: 149, posY: -1040, heading: 87,
    })
    .onConflictDoNothing({ target: [unit.organizationId, unit.callsign], where: sql`status = 'active'` })
    .returning();

  if (patrol && memberIds[0]) {
    await db
      .insert(unitMember)
      .values({ unitId: patrol.id, memberId: memberIds[0], isLeader: true })
      .onConflictDoNothing();
  }

  const [call] = await db
    .insert(incident)
    .values({
      organizationId: pd.id, typeKey: 'armed_robbery', priority: 1, status: 'dispatched',
      title: 'Armed robbery in progress — Fleeca Bank',
      locationText: 'Legion Square, Alta St',
      posX: 149, posY: -1040, source: 'manual',
    })
    .returning();

  return {
    summary:
      `${people.length} accounts, ${people.length + 1} persons, 2 vehicles, ` +
      `${patrol ? 1 : 0} unit, ${call ? 1 : 0} incident`,
  };
}
