import { sql } from 'drizzle-orm';
import {
  FIVEM_DEFAULT_TELEMETRY_MS, FIVEM_POSITION_TTL_MS, FIVEM_SERVER_OFFLINE_AFTER_MS,
  type MapSourceStatus,
} from '@leoos/contracts';
import type { Database } from '@leoos/db';
import type { LivePositionStore } from '../map/sources/live-positions.js';
import type { PositionSource } from '../map/sources/position-source.js';

/**
 * The FiveM position source — the second implementation of `PositionSource`,
 * and the one `position-source.ts` was written for.
 *
 * IT DOES NOT POLL ANYTHING. The interface says a source PUSHES into the store,
 * and that is exactly what happens: the game server pushes telemetry over HTTP
 * and the route writes it. What this class owns is everything around that:
 *
 *   • the honest STATUS the map shows — is a game server actually talking to us?
 *   • STALENESS, so a unit stops being drawn when its data stops arriving
 *   • OFFLINE DETECTION, so a game server that dies takes its own units with it
 *     and nobody else's
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 * A dispatcher looking at a map of units that are not really there, with nothing
 * on screen saying so, is the most dangerous thing this system could do: it
 * looks exactly like working software. Every mechanism below is a different way
 * for a unit to stop being shown as live, and they are independent on purpose —
 * each covers the others' failure mode.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THREE LEVELS, because they fail differently:
 *
 *   PLAYER LEFT     the game server said so, in `departed[]`. Immediate, and the
 *                   only one that is prompt — but it depends on a message that
 *                   can be lost.
 *   POSITION STALE  no sample for `FIVEM_POSITION_TTL_MS`. Self-healing: it does
 *                   not depend on anyone remembering to clean up, so a missed
 *                   removal, an API restart, or a game server dying mid-tick all
 *                   resolve on their own.
 *   SERVER OFFLINE  no heartbeat for `FIVEM_SERVER_OFFLINE_AFTER_MS`. Takes down
 *                   every unit THAT server was reporting, and only those.
 */

export interface FiveMPositionSourceOptions {
  db: Database;
  store: LivePositionStore;
  log?: (message: string) => void;
  /** How often staleness and offline detection run. */
  sweepMs?: number;
  /** The interval the API asks resources to report at. */
  telemetryIntervalMs?: number;
}

interface ServerHealth {
  gameServerId: string;
  key: string;
  name: string;
  lastHeartbeatAt: number | null;
  playerCount: number;
  online: boolean;
}

export class FiveMPositionSource implements PositionSource {
  private readonly db: Database;
  private readonly store: LivePositionStore;
  private readonly log: (message: string) => void;
  private readonly sweepMs: number;
  private readonly telemetryIntervalMs: number;

  /** Last known health per server. Read by `status()`, which must not be async. */
  private health: ServerHealth[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweeping = false;

  constructor(options: FiveMPositionSourceOptions) {
    this.db = options.db;
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.sweepMs = options.sweepMs ?? 5_000;
    this.telemetryIntervalMs = options.telemetryIntervalMs ?? FIVEM_DEFAULT_TELEMETRY_MS;
  }

  /**
   * What the map screen is told, and it is the truth.
   *
   * `connected` is derived from a heartbeat that actually arrived, not from
   * whether the integration is configured. An installation with the bridge
   * enabled and no game server running says so — "waiting for a game server" —
   * rather than showing a green light it has not earned (engineering rule 45).
   */
  status(): MapSourceStatus {
    const online = this.health.filter((h) => h.online);
    const connected = online.length > 0;

    const players = online.reduce((sum, h) => sum + h.playerCount, 0);

    let detail: string;
    if (this.health.length === 0) {
      detail = 'No game server has been registered. Register one to receive live positions.';
    } else if (!connected) {
      detail = `No game server is reporting (${this.health.length} registered). `
        + 'Positions on this map are not live.';
    } else {
      detail = `${FiveMPositionSource.describe(online)} reporting, `
        + `with ${players} player(s) online.`;
    }

    return {
      kind: 'fivem',
      connected,
      label: connected ? 'Live FiveM positions' : 'FiveM bridge — not reporting',
      detail,
      tickMs: this.telemetryIntervalMs,
      // Independent of the bridge: the base raster is blocked on tile licensing
      // (ADR-0012), and a live feed does not change that.
      placeholderBaseLayer: true,
    };
  }

  /**
   * Names a few servers and counts the rest.
   *
   * The status line is read at a glance by someone deciding whether to trust the
   * map. An installation with a few servers should see their names; one with two
   * hundred registered — which a long-lived deployment accumulates — must not get
   * a paragraph of them where a sentence belongs.
   */
  private static describe(servers: readonly ServerHealth[]): string {
    const shown = servers.slice(0, 3).map((h) => h.name);
    const rest = servers.length - shown.length;
    const names = shown.join(', ');
    if (rest <= 0) return `${servers.length} game server(s) — ${names} —`;
    return `${servers.length} game server(s) — ${names} and ${rest} more —`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.sweep();

    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.log(`FIVEM: sweep failed: ${String(error)}`);
      });
    }, this.sweepMs);
    this.timer.unref?.();

    this.log('MAP: FiveM ingest is enabled. Positions come from registered game servers.');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Health for the admin view. A copy, so a caller cannot mutate our state. */
  serverHealth(): ServerHealth[] {
    return this.health.map((h) => ({ ...h }));
  }

  /**
   * One sweep: refresh health, expire stale positions, blank offline servers.
   *
   * Guarded against overlap. A slow database must not let two sweeps interleave
   * and have one restore positions the other just dropped.
   */
  private async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      const rows = await this.db.execute<{
        game_server_id: string;
        key: string;
        name: string;
        last_heartbeat_epoch: number | null;
        player_count: number;
      }>(sql`
        SELECT
          gs.id   AS game_server_id,
          gs.key  AS key,
          gs.name AS name,
          /*
           * Epoch seconds, not the timestamp itself. A raw \`sql<Date>\` in a
           * projection comes back as a string from the driver, and calling a
           * Date method on it fails at runtime rather than at compile time.
           */
          EXTRACT(EPOCH FROM st.last_heartbeat_at)::double precision AS last_heartbeat_epoch,
          COALESCE(st.player_count, 0) AS player_count
        FROM game_server gs
        LEFT JOIN game_server_state st ON st.game_server_id = gs.id
        WHERE gs.is_active
      `);

      const next: ServerHealth[] = rows.map((row) => {
        const lastHeartbeatAt = row.last_heartbeat_epoch === null
          ? null
          : Math.round(row.last_heartbeat_epoch * 1000);
        return {
          gameServerId: row.game_server_id,
          key: row.key,
          name: row.name,
          lastHeartbeatAt,
          playerCount: row.player_count,
          online: lastHeartbeatAt !== null
            && now - lastHeartbeatAt <= FIVEM_SERVER_OFFLINE_AFTER_MS,
        };
      });

      // Servers that were online and are not any more take their units with
      // them. Computed by diffing against the PREVIOUS sweep, so the work
      // happens once at the transition rather than every five seconds forever.
      const wasOnline = new Set(this.health.filter((h) => h.online).map((h) => h.gameServerId));
      this.health = next;

      for (const server of next) {
        if (server.online || !wasOnline.has(server.gameServerId)) continue;
        const dropped = await this.dropUnitsOf(server.gameServerId);
        this.log(
          `FIVEM: ${server.name} stopped sending heartbeats — ${dropped} unit(s) went offline.`,
        );
      }

      // Staleness runs regardless. It is the safety net, and a safety net that
      // only runs when something else already noticed is not one.
      this.store.prune(FIVEM_POSITION_TTL_MS, now);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Removes the live positions of every unit a given server was reporting.
   *
   * Scoped by `unit.pos_game_server_id` rather than blanking the store, because
   * a deployment with two game servers must not have one going quiet blank the
   * other's units — which is precisely the bug that a global clear would be.
   */
  private async dropUnitsOf(gameServerId: string): Promise<number> {
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM unit WHERE pos_game_server_id = ${gameServerId}
    `);
    let dropped = 0;
    for (const row of rows) {
      if (this.store.get(row.id) !== undefined) {
        this.store.delete(row.id);
        dropped += 1;
      }
    }
    return dropped;
  }
}
