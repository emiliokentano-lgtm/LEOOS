import { inArray, sql } from 'drizzle-orm';
import type { FiveMIdentifierProvider, FiveMIdentifiers } from '@leoos/contracts';
import type { Database } from '@leoos/db';

/**
 * Turning "who the game says is here" into "who LEOOS says that is".
 *
 * THIS FILE IS THE TRUST BOUNDARY. Everything above it deals in FiveM
 * identifiers, which the game server is trusted to report. Everything below it
 * deals in members, organizations and units, which come only from this database.
 * The game server never supplies either side of that mapping — it supplies a
 * licence string, and the mapping is looked up (engineering rules 19, 20).
 *
 * The consequence worth stating plainly: an identifier nobody has linked
 * resolves to nothing. Its position is not attributed to any organization, and
 * it does not appear as a unit. That is what stops the map being made to show a
 * fake ICE unit by an unknown identifier.
 */

const KNOWN_PROVIDERS: readonly FiveMIdentifierProvider[] = [
  'license', 'license2', 'steam', 'discord', 'fivem', 'xbl', 'live',
];

export interface ParsedIdentifier {
  provider: FiveMIdentifierProvider;
  /** The part after the colon — what `game_identity.identifier` stores. */
  value: string;
  /** The full `provider:value` form, which is what the game and the UI show. */
  full: string;
}

/**
 * Splits `license:110000112345678` into its parts.
 *
 * The provider prefix is stored SEPARATELY from the value, because the unique
 * index is on the pair — storing the prefix in both columns would make
 * `steam:abc` and `license:abc` collide or not depending on which column the
 * query happened to use.
 *
 * Returns null for anything whose prefix is not a provider we know. An unknown
 * provider is a rejection rather than a new enum value: the column is a Postgres
 * enum, and inserting into it from untrusted input is how a game server gets to
 * choose your schema.
 */
export function parseIdentifier(raw: string): ParsedIdentifier | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;

  const prefix = raw.slice(0, separator).toLowerCase();
  const value = raw.slice(separator + 1);
  if (value.length === 0 || value.length > 100) return null;

  const provider = KNOWN_PROVIDERS.find((p) => p === prefix);
  if (provider === undefined) return null;

  return { provider, value, full: `${provider}:${value}` };
}

/**
 * The identifier to key a player on.
 *
 * `license` first, and deliberately: it is the Rockstar licence, it is stable
 * across name changes and Steam accounts, and it is the one a player cannot
 * trivially swap. The rest are fallbacks for a server configured without it,
 * and the order is by how hard each is to change.
 */
export function primaryIdentifier(identifiers: FiveMIdentifiers): ParsedIdentifier | null {
  for (const provider of KNOWN_PROVIDERS) {
    const value = identifiers[provider];
    if (typeof value !== 'string' || value.length === 0) continue;

    // A resource may send either `license:abc` or a bare `abc` under the
    // `license` key. Both are accepted; the prefix is normalised here so the
    // database only ever sees one form.
    const parsed = value.includes(':')
      ? parseIdentifier(value)
      : { provider, value, full: `${provider}:${value}` };

    if (parsed !== null && parsed.provider === provider) return parsed;
  }
  return null;
}

/**
 * Who an identifier belongs to, operationally.
 *
 * Null fields all the way down are normal and meaningful:
 *   `userId` null      — the identifier is known but not linked to an account
 *   `memberId` null    — linked, but not an active member of any organization
 *   `unitId` null      — a member, but not currently crewed in a unit
 *
 * Only the last case produces a position on the map, because the map shows
 * UNITS. A linked officer standing in the lobby is a person the system knows
 * about and is not a unit.
 */
export interface ResolvedPlayer {
  identifier: string;
  identityId: string | null;
  userId: string | null;
  memberId: string | null;
  organizationId: string | null;
  unitId: string | null;
  isCovert: boolean;
  /** The member's own callsign, from the database. Never from the game. */
  callsign: string | null;
  displayName: string | null;
  /** True once the link was proven from both sides by an in-game claim code. */
  verified: boolean;
}

/**
 * Resolves a batch of identifiers in ONE query.
 *
 * One query per tick rather than one per player. At 1 Hz with 150 players the
 * difference is 1 round trip a second against 150, which is the difference
 * between a rounding error and a connection pool.
 *
 * Deliberately NOT cached. A cache here would mean an officer crewing a car
 * keeps reporting under their old unit until it expired, which is exactly the
 * moment a dispatcher is looking. The query is a single indexed lookup on a
 * unique index; buying staleness to avoid it is a poor trade.
 */
export async function resolvePlayers(
  db: Database,
  identifiers: readonly ParsedIdentifier[],
): Promise<Map<string, ResolvedPlayer>> {
  const out = new Map<string, ResolvedPlayer>();
  if (identifiers.length === 0) return out;

  // Grouped by provider so each `IN` list is compared against the right half of
  // the unique index.
  const byProvider = new Map<FiveMIdentifierProvider, string[]>();
  for (const parsed of identifiers) {
    const list = byProvider.get(parsed.provider) ?? [];
    list.push(parsed.value);
    byProvider.set(parsed.provider, list);
  }

  for (const [provider, values] of byProvider) {
    /**
     * Built with the QUERY BUILDER, not raw SQL.
     *
     * Drizzle expands a JS array into one placeholder per element only through
     * `inArray`; a raw `sql` template binds the whole array as a single scalar
     * and Postgres answers "malformed array literal". That has cost this
     * codebase three separate bugs, so array predicates go through the builder.
     */
    const rows = await db.execute<{
      identity_id: string;
      identifier: string;
      user_id: string | null;
      verified_at: Date | null;
      display_name: string | null;
      member_id: string | null;
      organization_id: string | null;
      callsign: string | null;
      unit_id: string | null;
      is_covert: boolean | null;
    }>(sql`
      SELECT
        gi.id                AS identity_id,
        gi.identifier        AS identifier,
        gi.user_id           AS user_id,
        gi.verified_at       AS verified_at,
        ua.display_name      AS display_name,
        om.id                AS member_id,
        om.organization_id   AS organization_id,
        om.callsign          AS callsign,
        u.id                 AS unit_id,
        u.is_covert          AS is_covert
      FROM game_identity gi
      LEFT JOIN user_account ua
        ON ua.id = gi.user_id
      /*
       * ACTIVE membership only. A terminated or suspended member keeps their
       * history (engineering rule 24) and stops appearing on the map — which is
       * the point: someone dismissed this morning must not still be a unit.
       */
      LEFT JOIN organization_member om
        ON om.user_id = gi.user_id AND om.status = 'active'
      LEFT JOIN unit_member um
        ON um.member_id = om.id AND um.left_at IS NULL
      LEFT JOIN unit u
        ON u.id = um.unit_id AND u.status = 'active'
      WHERE gi.provider = ${provider}
        AND ${inArray(sql`gi.identifier`, values)}
    `);

    for (const row of rows) {
      const full = `${provider}:${row.identifier}`;
      /**
       * One row wins per identifier.
       *
       * A user with memberships in two organizations produces two rows. The one
       * that is CREWED wins, because that is the one that is operationally live;
       * with neither crewed the first is taken, and the choice does not matter
       * because neither produces a unit position.
       */
      const existing = out.get(full);
      if (existing && existing.unitId !== null) continue;

      out.set(full, {
        identifier: full,
        identityId: row.identity_id,
        userId: row.user_id,
        memberId: row.member_id,
        organizationId: row.organization_id,
        unitId: row.unit_id,
        isCovert: row.is_covert ?? false,
        callsign: row.callsign,
        displayName: row.display_name,
        verified: row.verified_at !== null,
      });
    }
  }

  return out;
}

/**
 * Records that an identifier was seen, creating it if it is new.
 *
 * An UNLINKED identity row is created for a player nobody has claimed. That is
 * deliberate and is what makes linking possible at all: an administrator cannot
 * offer to link an identifier the system has never heard of, and a player
 * running the in-game claim command needs their identifier to already exist.
 *
 * Such a row has no `user_id` and no `person_id`, so it grants nothing. It is a
 * note that a licence has been seen, and the CHECK constraint on the table means
 * it cannot be created here — see below.
 */
export async function touchIdentities(
  db: Database,
  identifiers: readonly ParsedIdentifier[],
): Promise<void> {
  if (identifiers.length === 0) return;

  /**
   * Only KNOWN identities are touched.
   *
   * `game_identity` has a CHECK requiring a `user_id` or a `person_id`, so a
   * row for an unlinked player cannot be created here even if we wanted one.
   * That constraint is correct and this respects it: an unlinked player is
   * tracked in memory for the duration of the tick and forgotten, and linking
   * happens through the claim flow, which creates the row with a subject.
   */
  const byProvider = new Map<FiveMIdentifierProvider, string[]>();
  for (const parsed of identifiers) {
    const list = byProvider.get(parsed.provider) ?? [];
    list.push(parsed.value);
    byProvider.set(parsed.provider, list);
  }

  for (const [provider, values] of byProvider) {
    /**
     * `now()`, not a bound JS `Date`.
     *
     * A raw `sql` template binds its parameters straight through the driver,
     * which wants a string for a timestamp and throws on a `Date` — the query
     * BUILDER converts, raw SQL does not. Using the database's own clock also
     * removes a source of skew: `last_seen_at` should be the server's idea of
     * now, not the API process's.
     */
    await db.execute(sql`
      UPDATE game_identity
         SET last_seen_at = now()
       WHERE provider = ${provider}
         AND ${inArray(sql`identifier`, values)}
    `);
  }
}

/**
 * Finds the identity row for one identifier, if it exists.
 *
 * Used by the claim flow, which needs to know whether the identifier is already
 * attached to somebody before attaching it to the claimant.
 */
export async function findIdentity(
  db: Database,
  parsed: ParsedIdentifier,
): Promise<{ id: string; userId: string | null; verifiedAt: Date | null } | null> {
  const rows = await db.execute<{ id: string; user_id: string | null; verified_at: Date | null }>(sql`
    SELECT id, user_id, verified_at
      FROM game_identity
     WHERE provider = ${parsed.provider} AND identifier = ${parsed.value}
     LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, userId: row.user_id, verifiedAt: row.verified_at };
}

/** Exported for the tests, which assert the provider list is closed. */
export const FIVEM_PROVIDERS = KNOWN_PROVIDERS;
