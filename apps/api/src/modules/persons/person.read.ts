import { and, asc, desc, eq, isNull, isNotNull, or, sql } from 'drizzle-orm';
import {
  criminalCharge, license, medicalRecord, organization, person, personAlias, personFlag,
  vehicle, warrant, type Database,
} from '@leoos/db';

/**
 * Person reads.
 *
 * Persons are a SHARED, cross-organization register: a citizen is not owned by
 * PD or MD. Access is therefore decided by PERMISSION rather than by
 * organization scope — which is what lets one organization see more than
 * another without any of it being hardcoded (engineering rules 5, 7, 8).
 *
 * The sensitive sections — criminal history, medical record — are separate
 * queries rather than joins, so a caller without the permission never has the
 * data loaded, let alone serialized. A field trimmed at the DTO boundary has
 * still been read.
 */

export interface PersonListItem {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phoneNumber: string | null;
  address: string | null;
  status: string;
  isDeceased: boolean;
  aliases: string[];
  /** Live flags only — resolved ones are history, not a banner. */
  flagCount: number;
  highestFlagSeverity: string | null;
  activeWarrants: number;
  vehicleCount: number;
  isArchived: boolean;
  createdAt: string;
}

export interface PersonSearchFilters {
  /** Matched against name, alias, phone, address and the id prefix. */
  search?: string;
  status?: 'alive' | 'deceased' | 'missing' | 'incarcerated' | 'all';
  dateOfBirth?: string;
  phone?: string;
  onlyFlagged?: boolean;
  onlyWanted?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface PersonPage {
  rows: PersonListItem[];
  total: number;
}


/**
 * The outer row's id, EXPLICITLY QUALIFIED.
 *
 * Drizzle renders `${person.id}` unqualified — as bare `"id"` — inside a SELECT
 * projection when the query has no joins. In a correlated subquery like
 * `(SELECT count(*) FROM person_flag f WHERE f.person_id = "id")` that bare
 * name binds to the SUBQUERY's table, and `person_flag` has an `id` of its own,
 * so the predicate became `f.person_id = f.id` — always false, no error, every
 * count silently zero.
 *
 * It only reads correctly when the inner table happens NOT to have a column of
 * that name, which is why the alias and owner lookups worked and the counts did
 * not. WHERE clauses are qualified by drizzle; projections are not. Qualifying
 * by hand removes the coin-flip.
 */
const PERSON_ID = sql.raw('"person"."id"');

const FLAG_RANK = sql`CASE severity WHEN 'critical' THEN 3 WHEN 'caution' THEN 2 ELSE 1 END`;

/**
 * Search.
 *
 * The name predicate uses `%` (pg_trgm similarity) so a partial or slightly
 * misspelled name still matches, backed by the GIN trigram indexes created in
 * migration 0001. ILIKE is kept alongside it because trigram similarity misses
 * very short fragments — typing "Ma" should still narrow the list.
 *
 * A bare uuid prefix is matched too, so pasting an identifier from a radio call
 * or another screen finds the record.
 */
export async function searchPersons(
  db: Database,
  filters: PersonSearchFilters = {},
): Promise<PersonPage> {
  const term = filters.search?.trim();
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;
  const status = filters.status ?? 'all';

  const like = term ? `%${term}%` : null;

  /**
   * An identifier search is EXACT, not blended with the fuzzy name match.
   *
   * Pasting a record id from a radio call or another screen must return that
   * record, not a page of trigram near-misses that happens to contain it —
   * which is what a combined predicate produced, because the fuzzy branch
   * matched hundreds of names and the ranking pushed the exact hit off page one.
   *
   * Deliberately narrow: a canonical uuid prefix, or a run of eight or more hex
   * characters that contains at least one of a–f. A looser rule swallowed the
   * phone number `555-0199` — digits and dashes are what phone numbers are made
   * of, and misreading one as an identifier returns nothing at all, which is a
   * worse failure than returning too much.
   */
  const looksLikeId = Boolean(term) && (
    /^[0-9a-f]{8}(-[0-9a-f]{1,4}){0,4}$/i.test(term!)
    || (/^[0-9a-f]{8,}$/i.test(term!) && /[a-f]/i.test(term!))
  );

  const where = and(
    filters.includeArchived ? undefined : isNull(person.deletedAt),
    status === 'all' ? undefined : eq(person.status, status),
    filters.dateOfBirth ? eq(person.dateOfBirth, filters.dateOfBirth) : undefined,
    filters.phone
      ? sql`regexp_replace(${person.phoneNumber}, '[^0-9]', '', 'g')
            LIKE ${'%' + filters.phone.replace(/[^0-9]/g, '') + '%'}`
      : undefined,
    term && looksLikeId
      ? sql`${person.id}::text LIKE ${term.toLowerCase() + '%'}`
      : undefined,
    term && !looksLikeId
      ? or(
          sql`(${person.firstName} || ' ' || ${person.lastName}) ILIKE ${like}`,
          sql`(${person.firstName} || ' ' || ${person.lastName}) % ${term}`,
          sql`${person.phoneNumber} ILIKE ${like}`,
          sql`${person.address} ILIKE ${like}`,
          sql`EXISTS (SELECT 1 FROM person_alias pa
                WHERE pa.person_id = ${person.id} AND (pa.alias ILIKE ${like} OR pa.alias % ${term}))`,
        )
      : undefined,
    filters.onlyFlagged
      ? sql`EXISTS (SELECT 1 FROM person_flag f
            WHERE f.person_id = ${person.id} AND f.resolved_at IS NULL)`
      : undefined,
    filters.onlyWanted
      ? sql`EXISTS (SELECT 1 FROM warrant w
            WHERE w.person_id = ${person.id} AND w.status = 'active')`
      : undefined,
  );

  const totals = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(person)
    .where(where);
  const total = Number(totals[0]?.total ?? 0);

  const rows = await db
    .select({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      dateOfBirth: person.dateOfBirth,
      phoneNumber: person.phoneNumber,
      address: person.address,
      status: person.status,
      isDeceased: person.isDeceased,
      deletedAt: person.deletedAt,
      createdAt: person.createdAt,
      flagCount: sql<number>`(SELECT count(*) FROM person_flag f
        WHERE f.person_id = ${PERSON_ID} AND f.resolved_at IS NULL)::int`,
      highestFlagSeverity: sql<string | null>`(
        SELECT severity::text FROM person_flag f
        WHERE f.person_id = ${PERSON_ID} AND f.resolved_at IS NULL
        ORDER BY ${FLAG_RANK} DESC LIMIT 1)`,
      activeWarrants: sql<number>`(SELECT count(*) FROM warrant w
        WHERE w.person_id = ${PERSON_ID} AND w.status = 'active')::int`,
      vehicleCount: sql<number>`(SELECT count(*) FROM vehicle v
        WHERE v.owner_person_id = ${PERSON_ID} AND v.deleted_at IS NULL)::int`,
    })
    .from(person)
    .where(where)
    // Wanted first, then flagged, then by name — an operator scanning this list
    // is looking for the exceptions. `id` last so the sort is total and pages
    // cannot overlap.
    .orderBy(
      desc(sql`(SELECT count(*) FROM warrant w
        WHERE w.person_id = ${PERSON_ID} AND w.status = 'active')`),
      asc(person.lastName), asc(person.firstName), asc(person.id),
    )
    .limit(limit)
    .offset(offset);

  if (rows.length === 0) return { rows: [], total };

  const ids = rows.map((r) => r.id);
  const aliasRows = await db
    .select({ personId: personAlias.personId, alias: personAlias.alias })
    .from(personAlias)
    .where(sql`${personAlias.personId} = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})`);

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      dateOfBirth: r.dateOfBirth,
      phoneNumber: r.phoneNumber,
      address: r.address,
      status: r.status,
      isDeceased: r.isDeceased,
      aliases: aliasRows.filter((a) => a.personId === r.id).map((a) => a.alias),
      flagCount: Number(r.flagCount),
      highestFlagSeverity: r.highestFlagSeverity,
      activeWarrants: Number(r.activeWarrants),
      vehicleCount: Number(r.vehicleCount),
      isArchived: r.deletedAt !== null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// ── Profile ────────────────────────────────────────────────────────────────

export interface PersonCore {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  gender: string | null;
  phoneNumber: string | null;
  address: string | null;
  heightCm: number | null;
  weightKg: number | null;
  eyeColor: string | null;
  hairColor: string | null;
  notes: string | null;
  status: string;
  isDeceased: boolean;
  isArchived: boolean;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
}

export async function getPersonCore(
  db: Database,
  personId: string,
): Promise<PersonCore | null> {
  const rows = await db
    .select({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      dateOfBirth: person.dateOfBirth,
      gender: person.gender,
      phoneNumber: person.phoneNumber,
      address: person.address,
      heightCm: person.heightCm,
      weightKg: person.weightKg,
      eyeColor: person.eyeColor,
      hairColor: person.hairColor,
      notes: person.notes,
      status: person.status,
      isDeceased: person.isDeceased,
      deletedAt: person.deletedAt,
      deletionReason: person.deletionReason,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
      createdByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u
        WHERE u.id = ${sql.raw('"person"."created_by"')})`,
      updatedByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u
        WHERE u.id = ${sql.raw('"person"."updated_by"')})`,
    })
    .from(person)
    .where(eq(person.id, personId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    ...row,
    isArchived: row.deletedAt !== null,
    archivedReason: row.deletionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface PersonAliasRow { id: string; alias: string; note: string | null }

export async function listAliases(db: Database, personId: string): Promise<PersonAliasRow[]> {
  return db
    .select({ id: personAlias.id, alias: personAlias.alias, note: personAlias.note })
    .from(personAlias)
    .where(eq(personAlias.personId, personId))
    .orderBy(asc(personAlias.alias));
}

export interface PersonFlagRow {
  id: string;
  type: string;
  severity: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
  resolvedAt: string | null;
}

export async function listFlags(
  db: Database,
  personId: string,
  includeResolved = false,
): Promise<PersonFlagRow[]> {
  const rows = await db
    .select({
      id: personFlag.id,
      type: personFlag.type,
      severity: personFlag.severity,
      note: personFlag.note,
      createdAt: personFlag.createdAt,
      resolvedAt: personFlag.resolvedAt,
      createdByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${personFlag.createdBy})`,
    })
    .from(personFlag)
    .where(and(
      eq(personFlag.personId, personId),
      includeResolved ? undefined : isNull(personFlag.resolvedAt),
    ))
    .orderBy(desc(FLAG_RANK), desc(personFlag.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }));
}

export interface WarrantRow {
  id: string;
  type: string;
  status: string;
  reason: string;
  organizationKey: string;
  organizationName: string;
  issuedAt: string;
  issuedByName: string | null;
  expiresAt: string | null;
}

export async function listWarrants(db: Database, personId: string): Promise<WarrantRow[]> {
  const rows = await db
    .select({
      id: warrant.id,
      type: warrant.type,
      status: warrant.status,
      reason: warrant.reason,
      organizationKey: organization.key,
      organizationName: organization.name,
      issuedAt: warrant.issuedAt,
      expiresAt: warrant.expiresAt,
      issuedByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${warrant.issuedBy})`,
    })
    .from(warrant)
    .innerJoin(organization, eq(organization.id, warrant.organizationId))
    .where(eq(warrant.personId, personId))
    .orderBy(desc(warrant.issuedAt));

  return rows.map((r) => ({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

export interface ChargeRow {
  id: string;
  title: string;
  severity: string;
  status: string;
  statuteCode: string | null;
  fineAmount: number | null;
  jailTimeMinutes: number | null;
  filedAt: string;
  filedByName: string | null;
}

/** Criminal history. Gated by `persons.criminal.view` at the route. */
export async function listCharges(db: Database, personId: string): Promise<ChargeRow[]> {
  const rows = await db
    .select({
      id: criminalCharge.id,
      title: criminalCharge.title,
      severity: criminalCharge.severity,
      status: criminalCharge.status,
      statuteCode: criminalCharge.statuteCode,
      fineAmount: criminalCharge.fineAmount,
      jailTimeMinutes: criminalCharge.jailTimeMinutes,
      filedAt: criminalCharge.filedAt,
      filedByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${criminalCharge.filedBy})`,
    })
    .from(criminalCharge)
    .where(eq(criminalCharge.personId, personId))
    .orderBy(desc(criminalCharge.filedAt));

  return rows.map((r) => ({ ...r, filedAt: r.filedAt.toISOString() }));
}

export interface LicenseRow {
  id: string;
  type: string;
  status: string;
  issuedAt: string;
  expiresAt: string | null;
  suspendedReason: string | null;
}

export async function listLicenses(db: Database, personId: string): Promise<LicenseRow[]> {
  const rows = await db
    .select({
      id: license.id, type: license.type, status: license.status,
      issuedAt: license.issuedAt, expiresAt: license.expiresAt,
      suspendedReason: license.suspendedReason,
    })
    .from(license)
    .where(eq(license.personId, personId))
    .orderBy(asc(license.type));

  return rows.map((r) => ({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

export interface MedicalRow {
  bloodType: string | null;
  allergies: string[];
  conditions: string[];
  medications: string[];
  emergencyContact: string | null;
  notes: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

/**
 * Medical record. Gated by `persons.medical.view`, and every read is audited.
 *
 * Loaded only when the caller holds the permission — never fetched and then
 * trimmed, because a field removed at the DTO boundary has still left the
 * database and passed through the process.
 */
export async function getMedical(db: Database, personId: string): Promise<MedicalRow | null> {
  const rows = await db
    .select({
      bloodType: medicalRecord.bloodType,
      allergies: medicalRecord.allergies,
      conditions: medicalRecord.conditions,
      medications: medicalRecord.medications,
      emergencyContact: medicalRecord.emergencyContact,
      notes: medicalRecord.notes,
      updatedAt: medicalRecord.updatedAt,
      updatedByName: sql<string | null>`(
        SELECT u.display_name FROM user_account u WHERE u.id = ${medicalRecord.updatedBy})`,
    })
    .from(medicalRecord)
    .where(eq(medicalRecord.personId, personId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    ...row,
    allergies: row.allergies ?? [],
    conditions: row.conditions ?? [],
    medications: row.medications ?? [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface OwnedVehicleRow {
  id: string;
  plate: string;
  model: string;
  displayName: string | null;
  color: string | null;
  registrationStatus: string;
  insuranceStatus: string;
  flagCount: number;
}

export async function listOwnedVehicles(
  db: Database,
  personId: string,
): Promise<OwnedVehicleRow[]> {
  const rows = await db
    .select({
      id: vehicle.id,
      plate: vehicle.plate,
      model: vehicle.model,
      displayName: vehicle.displayName,
      color: vehicle.color,
      registrationStatus: vehicle.registrationStatus,
      insuranceStatus: vehicle.insuranceStatus,
      flagCount: sql<number>`(SELECT count(*) FROM vehicle_flag vf
        WHERE vf.vehicle_id = ${sql.raw('"vehicle"."id"')} AND vf.resolved_at IS NULL)::int`,
    })
    .from(vehicle)
    .where(and(eq(vehicle.ownerPersonId, personId), isNull(vehicle.deletedAt)))
    .orderBy(asc(vehicle.plate));

  return rows.map((r) => ({ ...r, flagCount: Number(r.flagCount) }));
}

/**
 * Organization affiliations.
 *
 * A person is affiliated with an organization when the account linked to them
 * through a game identity is an active member of it. Derived rather than stored,
 * so it cannot disagree with the personnel roster — the roster is the source of
 * truth for employment (engineering rule 3: no parallel state).
 */
export interface AffiliationRow {
  organizationId: string;
  organizationKey: string;
  organizationName: string;
  organizationColor: string;
  roleName: string | null;
  callsign: string | null;
  status: string;
}

export async function listAffiliations(
  db: Database,
  personId: string,
): Promise<AffiliationRow[]> {
  const rows = await db.execute<{
    organization_id: string; organization_key: string; organization_name: string;
    organization_color: string; role_name: string | null; callsign: string | null;
    status: string;
  }>(sql`
    SELECT DISTINCT ON (o.id)
      o.id            AS organization_id,
      o.key::text     AS organization_key,
      o.name          AS organization_name,
      o.color         AS organization_color,
      r.name          AS role_name,
      m.callsign::text AS callsign,
      m.status::text  AS status
    FROM game_identity gi
    JOIN organization_member m ON m.user_id = gi.user_id
    JOIN organization o        ON o.id = m.organization_id AND o.deleted_at IS NULL
    LEFT JOIN member_role mr   ON mr.member_id = m.id
    LEFT JOIN role r           ON r.id = mr.role_id AND r.deleted_at IS NULL
    WHERE gi.person_id = ${personId} AND m.status = 'active'
    ORDER BY o.id, r.hierarchy_level DESC NULLS LAST
  `);

  return rows.map((r) => ({
    organizationId: r.organization_id,
    organizationKey: r.organization_key,
    organizationName: r.organization_name,
    organizationColor: r.organization_color,
    roleName: r.role_name,
    callsign: r.callsign,
    status: r.status,
  }));
}

/** Distinct flag types already in use, so the UI offers them before free text. */
export async function listFlagTypes(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ type: personFlag.type })
    .from(personFlag)
    .where(isNotNull(personFlag.type))
    .orderBy(asc(personFlag.type))
    .limit(50);
  return rows.map((r) => r.type);
}
