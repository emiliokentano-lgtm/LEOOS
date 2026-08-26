import { z } from 'zod';
import {
  FIVEM_MAX_PLAYERS_PER_BATCH, MAP,
} from '@leoos/contracts';

/**
 * Every shape the bridge may send.
 *
 * VALIDATION IS NOT OPTIONAL HERE and it is not a formality. A signed request
 * proves the game server sent it; it proves nothing about whether the game
 * server is correct. A modded resource, a buggy Lua loop, or a compromised host
 * all produce perfectly signed nonsense, and this is the layer that refuses it
 * (engineering rules 18, 19).
 *
 * Two conventions run through the file:
 *
 *   `.strict()` everywhere a client sends an object. An unknown field is a
 *   rejection, not a silent ignore — it is how a resource sending
 *   `organization: "LSPD"` finds out immediately that the API will never read
 *   it, rather than shipping for months believing it works.
 *
 *   Bounds on every string and number. `z.string()` with no maximum is an
 *   allocation an attacker chooses the size of.
 */

// ── Identifiers ────────────────────────────────────────────────────────────

/**
 * A FiveM identifier, e.g. `license:110000112345678`.
 *
 * Constrained to the character set FiveM actually uses. The provider prefix is
 * validated separately on the way in, because it has to map onto a database
 * enum and an unknown provider is a rejection rather than a new enum value.
 */
const identifierValue = z.string().trim().min(3).max(120)
  .regex(/^[A-Za-z0-9:_-]+$/, 'An identifier may contain letters, digits, colons, hyphens and underscores.');

export const identifiersSchema = z.object({
  license: identifierValue.optional(),
  license2: identifierValue.optional(),
  steam: identifierValue.optional(),
  discord: identifierValue.optional(),
  fivem: identifierValue.optional(),
  xbl: identifierValue.optional(),
  live: identifierValue.optional(),
}).strict();

// ── Geometry ───────────────────────────────────────────────────────────────

/**
 * Coordinates are bounded to the world rectangle AT THE SCHEMA.
 *
 * The same bounds the map and the dispatch routes use — `MAP`, from the shared
 * contracts, so there is one definition of where the world is. A coordinate
 * outside it is not clamped here: clamping is right on a live position store
 * where losing track of a unit is worse than a slightly wrong pin, but at the
 * trust boundary an out-of-world coordinate is evidence and should be counted
 * as such. See `fivem.ingest.ts`.
 *
 * Z is wider than the playable area on purpose — the map is 2D and Z is carried
 * for display only, so a helicopter at altitude or a player in an interior
 * (which FiveM places far below the world) is not a reason to drop a sample.
 */
const worldX = z.number().finite().min(MAP.worldMinX).max(MAP.worldMaxX);
const worldY = z.number().finite().min(MAP.worldMinY).max(MAP.worldMaxY);
const worldZ = z.number().finite().min(-2000).max(3000);

/** Accepted in any range and normalised later — Lua headings wrap unpredictably. */
const heading = z.number().finite().min(-720).max(720);

// ── Handshake ──────────────────────────────────────────────────────────────

export const handshakeSchema = z.object({
  resourceVersion: z.string().trim().min(1).max(40),
  serverName: z.string().trim().max(120).nullish(),
  maxPlayers: z.number().int().min(1).max(2048).nullish(),
  adapter: z.string().trim().max(40).nullish(),
}).strict();

// ── Heartbeat ──────────────────────────────────────────────────────────────

export const heartbeatSchema = z.object({
  sessionId: z.string().trim().min(8).max(64),
  playerCount: z.number().int().min(0).max(FIVEM_MAX_PLAYERS_PER_BATCH),
  uptimeSeconds: z.number().int().min(0).max(60 * 60 * 24 * 365),
  resourceVersion: z.string().trim().min(1).max(40),
}).strict();

// ── Telemetry ──────────────────────────────────────────────────────────────

export const playerSampleSchema = z.object({
  src: z.number().int().min(0).max(65535),
  identifiers: identifiersSchema,
  characterName: z.string().trim().max(80).nullish(),
  x: worldX,
  y: worldY,
  z: worldZ,
  heading,
  /**
   * Metres per second. Capped well above any vehicle in the game so a plainly
   * impossible value is a rejection rather than a number the map then renders.
   */
  speed: z.number().finite().min(0).max(400).nullish(),
  health: z.number().int().min(0).max(1000).nullish(),
  armor: z.number().int().min(0).max(1000).nullish(),
  /**
   * Dead or dying, as the GAME SERVER observed it.
   *
   * Accepted here and nowhere else. No session-authenticated route has a field
   * for liveness, so a browser cannot assert it.
   */
  down: z.boolean().nullish(),
  vehicle: z.object({
    model: z.string().trim().min(1).max(64),
    plate: z.string().trim().max(16).nullish(),
    seat: z.number().int().min(-2).max(16).nullish(),
    sirens: z.boolean().nullish(),
    lights: z.boolean().nullish(),
  }).strict().nullish(),
  /**
   * Advisory. Authorized exactly as the same request from a browser would be;
   * the game server asking does not make it so.
   */
  requestedStatus: z.string().trim().max(60).nullish(),
}).strict();

export const telemetrySchema = z.object({
  sessionId: z.string().trim().min(8).max(64),
  sentAt: z.number().int().min(0),
  /**
   * A batch, always — one request for all online players.
   *
   * Per-player requests would mean 150 HTTP round trips per second out of a Lua
   * runtime that handles HTTP asynchronously and badly under load. The cap is a
   * malformed-batch check, not a player limit: a server with more players than
   * this is not something the resource would produce in one array.
   */
  players: z.array(playerSampleSchema).max(FIVEM_MAX_PLAYERS_PER_BATCH),
  departed: z.array(identifierValue).max(FIVEM_MAX_PLAYERS_PER_BATCH).optional(),
}).strict();

// ── Events ─────────────────────────────────────────────────────────────────

export const eventSchema = z.object({
  kind: z.enum([
    'player.connected',
    'player.dropped',
    'player.panic',
    'player.status_requested',
  ]),
  at: z.number().int().min(0),
  identifiers: identifiersSchema,
  src: z.number().int().min(0).max(65535).nullish(),
  statusKey: z.string().trim().max(60).nullish(),
  x: worldX.nullish(),
  y: worldY.nullish(),
  reason: z.string().trim().max(200).nullish(),
  /** Liveness at the moment of the press. Fresher than the last telemetry sample. */
  down: z.boolean().nullish(),
}).strict()
  // A coordinate is a pair. Half of one puts a panic marker in the sea.
  .refine((v) => (v.x === undefined || v.x === null) === (v.y === undefined || v.y === null), {
    message: 'Provide both x and y, or neither.',
  });

export const eventsSchema = z.object({
  sessionId: z.string().trim().min(8).max(64),
  /** Bounded far below telemetry: events are rare, and a large batch is a bug. */
  events: z.array(eventSchema).min(1).max(64),
}).strict();

// ── Identity claim ─────────────────────────────────────────────────────────

export const claimSchema = z.object({
  identifiers: identifiersSchema,
  /**
   * Six characters, case-insensitive.
   *
   * Normalised to upper case here so the database comparison is exact — the
   * column is `citext`, but relying on that would leave the rate limiter keying
   * two cases of one code as two different codes.
   */
  code: z.string().trim().length(6)
    .regex(/^[A-Za-z0-9]{6}$/, 'A claim code is six letters or digits.')
    .transform((v) => v.toUpperCase()),
  src: z.number().int().min(0).max(65535).nullish(),
}).strict();

// ── Administration ─────────────────────────────────────────────────────────

export const registerServerSchema = z.object({
  key: z.string().trim().min(2).max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'A key is lower-case letters, digits and hyphens.'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullish(),
}).strict();

export const issueCredentialSchema = z.object({
  /** Days until the credential stops working. Null means it does not expire. */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
}).strict();

export type HandshakeInput = z.infer<typeof handshakeSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type TelemetryInput = z.infer<typeof telemetrySchema>;
export type EventsInput = z.infer<typeof eventsSchema>;
export type ClaimInput = z.infer<typeof claimSchema>;
export type PlayerSampleInput = z.infer<typeof playerSampleSchema>;
