import { sql } from 'drizzle-orm';
import {
  FIVEM_MAX_IMPLIED_SPEED_MS, isWithinWorldBounds, worldDistance,
  type FiveMIngestOutcome, type FiveMRejectReason,
} from '@leoos/contracts';
import { gameServerState, type Database } from '@leoos/db';
import type { LivePositionStore, PositionSample } from '../map/sources/live-positions.js';
import type { TelemetryInput } from './fivem.schema.js';
import {
  parseIdentifier, primaryIdentifier, resolvePlayers, touchIdentities,
  type ParsedIdentifier, type ResolvedPlayer,
} from './fivem.identity.js';

/**
 * The telemetry pipeline.
 *
 *   signed & validated (upstream)
 *         ▼
 *   identifier extraction  ──── no usable identifier ────▶ reject
 *         ▼
 *   duplicate detection    ──── same id twice in a batch ─▶ reject batch
 *         ▼
 *   identity resolution (database only)
 *         ▼
 *   sanity filters         ──── out of bounds / teleport ─▶ reject sample
 *         ▼
 *   live position store  ─────▶ realtime broadcaster ────▶ map:units
 *         ▼
 *   Postgres cache, at a fraction of the rate
 *
 * WHAT "REJECT" MEANS HERE, precisely: the sample is not stored and a counter
 * moves. It is never clamped into range and it is never silently discarded. A
 * position outside the world is evidence — of a bug, a mod, or a compromised
 * host — and an operator needs to be able to see that it happened. That is a
 * different judgement from the one the live store makes, which clamps, because
 * there losing track of a unit entirely is worse than a slightly wrong pin.
 *
 * WHAT NEVER HAPPENS HERE: nothing in this file reads an organization, a rank or
 * a callsign from the payload, because the payload has nowhere to put one. Every
 * such value comes from `resolvePlayers`, which reads the database.
 */

export interface IngestDeps {
  db: Database;
  store: LivePositionStore;
  /** Persists `unit.pos_*`. Called at a fraction of the tick rate. */
  now?: () => number;
}

export interface IngestContext {
  gameServerId: string;
}

interface Rejection {
  identifier: string | null;
  reason: FiveMRejectReason;
}

/** A sample that survived every filter, with its resolved LEOOS identity. */
export interface AcceptedSample {
  identifier: string;
  resolved: ResolvedPlayer;
  sample: PositionSample;
  requestedStatus: string | null;
  vehicleModel: string | null;
  vehiclePlate: string | null;
}

export interface IngestResult extends FiveMIngestOutcome {
  accepted: number;
  rejected: number;
  reasons: Partial<Record<FiveMRejectReason, number>>;
  /** Units this batch produced a position for. Used for offline reconciliation. */
  unitIds: string[];
  /** Players the game reported who are not linked to any LEOOS account. */
  unlinked: string[];
  samples: AcceptedSample[];
}

function countReason(
  reasons: Partial<Record<FiveMRejectReason, number>>,
  reason: FiveMRejectReason,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

/**
 * Normalises a heading into [0, 360).
 *
 * Lua headings wrap unpredictably — some natives return negatives, some return
 * values past 360 after a rotation. Normalising once, here, means nothing
 * downstream has to guess which convention a sample used.
 */
function normaliseHeading(raw: number): number {
  return ((raw % 360) + 360) % 360;
}

export async function ingestTelemetry(
  input: TelemetryInput,
  context: IngestContext,
  deps: IngestDeps,
): Promise<IngestResult> {
  const now = deps.now?.() ?? Date.now();
  const reasons: Partial<Record<FiveMRejectReason, number>> = {};
  const rejections: Rejection[] = [];

  // ── Identifier extraction and duplicate detection ────────────────────────
  const parsed = new Map<string, ParsedIdentifier>();
  const usable: { identifier: ParsedIdentifier; player: TelemetryInput['players'][number] }[] = [];

  for (const player of input.players) {
    const identifier = primaryIdentifier(player.identifiers);
    if (identifier === null) {
      // A player the game cannot identify is a player we cannot attribute. Not
      // an error — a server may be configured without licence identifiers — but
      // not something that can become a unit either.
      rejections.push({ identifier: null, reason: 'no-identifier' });
      countReason(reasons, 'no-identifier');
      continue;
    }

    /**
     * The same identifier twice in one batch is MALFORMED, not a race.
     *
     * A player is in exactly one place. Two samples means the resource is
     * looping wrong or someone is constructing payloads by hand, and taking
     * either one would be choosing arbitrarily between two claims about the same
     * unit. Both are rejected and the anomaly is counted.
     */
    if (parsed.has(identifier.full)) {
      rejections.push({ identifier: identifier.full, reason: 'duplicate-identifier' });
      countReason(reasons, 'duplicate-identifier');
      // Remove the earlier one too — neither claim is trustworthy now.
      const index = usable.findIndex((u) => u.identifier.full === identifier.full);
      if (index >= 0) {
        usable.splice(index, 1);
        countReason(reasons, 'duplicate-identifier');
      }
      continue;
    }

    parsed.set(identifier.full, identifier);
    usable.push({ identifier, player });
  }

  /**
   * Departed identifiers are resolved TOO, not just present ones.
   *
   * A batch that reports only departures — everybody logged off, or the last
   * officer went off duty — has no players to resolve, so looking a departure up
   * in the present-players map would find nothing and the unit would linger on
   * the map until its TTL expired. Which is precisely the case the departure
   * list exists to handle promptly.
   */
  const departedIdentifiers: ParsedIdentifier[] = [];
  for (const raw of input.departed ?? []) {
    const identifier = raw.includes(':') ? parseIdentifier(raw) : null;
    if (identifier !== null && !parsed.has(identifier.full)) {
      departedIdentifiers.push(identifier);
    }
  }

  // ── Identity resolution — the trust boundary ─────────────────────────────
  const resolved = await resolvePlayers(
    deps.db, [...parsed.values(), ...departedIdentifiers],
  );

  const accepted: AcceptedSample[] = [];
  const unlinked: string[] = [];

  for (const { identifier, player } of usable) {
    const who = resolved.get(identifier.full);

    if (who === undefined || who.userId === null) {
      /**
       * Tracked as seen, attributed to nobody.
       *
       * This is the case that stops the map being made to show a fake ICE unit:
       * an unknown identifier produces no organization, no callsign and no unit,
       * however convincing the rest of its payload is.
       */
      unlinked.push(identifier.full);
      countReason(reasons, 'unlinked');
      continue;
    }

    if (who.unitId === null || who.organizationId === null) {
      // Linked and on duty somewhere, but not crewed in a unit. The map shows
      // units; a person is not one.
      countReason(reasons, 'not-on-duty');
      continue;
    }

    // ── Sanity filters ─────────────────────────────────────────────────────
    //
    // The schema already bounded the coordinate. This re-checks with the shared
    // world predicate rather than trusting that the two agree — they are in
    // different packages and could drift, and the cost is a pair of comparisons.
    if (!isWithinWorldBounds({ x: player.x, y: player.y })) {
      rejections.push({ identifier: identifier.full, reason: 'out-of-bounds' });
      countReason(reasons, 'out-of-bounds');
      continue;
    }

    /**
     * Teleport detection, against the unit's LAST STORED position.
     *
     * A jump of more than 200 m/s is faster than anything in the game, so it is
     * a lag spike, a bug, or a spoof. The previous position is KEPT rather than
     * replaced: a dispatcher acting on a slightly stale position is far better
     * off than one acting on a position in the ocean.
     *
     * A unit with no previous sample is exempt — the first position after
     * connecting has nothing to be implausible relative to.
     */
    const previous = deps.store.get(who.unitId);
    if (previous !== undefined) {
      const elapsedSeconds = Math.max(0.001, (now - previous.sampledAt.getTime()) / 1000);
      const impliedSpeed =
        worldDistance({ x: previous.x, y: previous.y }, { x: player.x, y: player.y })
        / elapsedSeconds;

      if (impliedSpeed > FIVEM_MAX_IMPLIED_SPEED_MS) {
        rejections.push({ identifier: identifier.full, reason: 'teleport' });
        countReason(reasons, 'teleport');
        continue;
      }
    }

    accepted.push({
      identifier: identifier.full,
      resolved: who,
      sample: {
        unitId: who.unitId,
        organizationId: who.organizationId,
        x: player.x,
        y: player.y,
        z: player.z,
        heading: normaliseHeading(player.heading),
        speed: player.speed ?? null,
        // The SERVER's clock, not the resource's. `sentAt` is carried for
        // diagnostics but never used for ordering or staleness: a game host with
        // a wrong clock would otherwise make every one of its units look stale,
        // or worse, permanently fresh.
        sampledAt: new Date(now),
      },
      requestedStatus: player.requestedStatus ?? null,
      vehicleModel: player.vehicle?.model ?? null,
      vehiclePlate: player.vehicle?.plate ?? null,
    });
  }

  // ── Write ────────────────────────────────────────────────────────────────
  deps.store.setMany(accepted.map((a) => a.sample));

  /**
   * Departed players are removed IMMEDIATELY.
   *
   * The position TTL would eventually expire them anyway — that is the safety
   * net — but "eventually" is up to 45 seconds of a dispatcher looking at a unit
   * that logged off. When the game server knows, it says so, and we act on it.
   */
  for (const raw of input.departed ?? []) {
    const identifier = raw.includes(':') ? parseIdentifier(raw) : null;
    if (identifier === null) continue;
    const who = resolved.get(identifier.full);
    if (who?.unitId) deps.store.delete(who.unitId);
  }

  await touchIdentities(deps.db, [...parsed.values()]);

  if (rejections.length > 0) {
    await recordAnomalies(deps.db, context.gameServerId, rejections.length, now);
  }

  return {
    accepted: accepted.length,
    rejected: rejections.length,
    reasons,
    unitIds: accepted.map((a) => a.sample.unitId),
    unlinked,
    samples: accepted,
  };
}

/**
 * Counts anomalies against the game server that produced them.
 *
 * A NUMBER SOMEBODY CAN LOOK AT, not a log line nobody reads. Sustained
 * anomalies are the signal that a game server is compromised or misconfigured,
 * and the only way that signal is useful is if it accumulates somewhere an
 * administrator sees it — so it goes on `game_server_state` and surfaces in the
 * admin view.
 */
export async function recordAnomalies(
  db: Database,
  gameServerId: string,
  count: number,
  now: number,
): Promise<void> {
  await db
    .insert(gameServerState)
    .values({ gameServerId, anomalyCount: count, lastAnomalyAt: new Date(now) })
    .onConflictDoUpdate({
      target: gameServerState.gameServerId,
      set: {
        anomalyCount: sql`${gameServerState.anomalyCount} + ${count}`,
        lastAnomalyAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
}

/**
 * Flushes the live positions into the Postgres cache.
 *
 * NOT called per tick. `unit.pos_*` is documented as a low-rate cache, not a
 * telemetry log: 1 Hz of position writes across a shift is the ~13M rows/day
 * that engineering rules 21 and 22 exist to prevent. The live truth is the
 * in-memory store; this is what survives a restart and what a cold page load
 * renders before the first socket batch arrives.
 *
 * `pos_game_server_id` is written alongside, because offline detection needs to
 * know WHICH server was reporting a unit — a deployment with two game servers
 * must not have one going quiet blank the other's units.
 */
export async function flushPositions(
  db: Database,
  store: LivePositionStore,
  gameServerId: string,
  unitIds: readonly string[],
): Promise<number> {
  if (unitIds.length === 0) return 0;

  let written = 0;
  for (const unitId of unitIds) {
    const sample = store.get(unitId);
    if (sample === undefined) continue;

    await db.execute(sql`
      UPDATE unit
         SET pos_x = ${sample.x},
             pos_y = ${sample.y},
             pos_z = ${sample.z},
             heading = ${sample.heading},
             speed = ${sample.speed},
             -- ISO string, not a JS Date: a raw \`sql\` template binds through
             -- the driver, which throws on a Date. The query builder converts;
             -- this does not.
             position_updated_at = ${sample.sampledAt.toISOString()},
             pos_game_server_id = ${gameServerId}
       WHERE id = ${unitId}
    `);
    written += 1;
  }
  return written;
}
