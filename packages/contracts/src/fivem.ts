/**
 * The FiveM bridge protocol.
 *
 * ONE definition, used by the API, by the tests, and quoted verbatim by the Lua
 * resource's README. The resource itself is Lua and cannot import this file, so
 * the protocol is kept small enough to be implemented correctly from the
 * documentation — and the header names and canonical string below are the exact
 * thing both sides must agree on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRUST MODEL, restated here because it is the reason for every shape below.
 *
 *   The game server is authenticated as a MACHINE. It is trusted to report
 *   WHERE PLAYERS ARE. It is never trusted to report WHO THEY ARE in
 *   organizational terms.
 *
 * Position, heading, vehicle and online state come from the game. Organization,
 * rank, callsign, unit and permission always resolve from the LEOOS database by
 * looking up the FiveM identifier in `game_identity`. A compromised game server
 * can therefore lie about coordinates — bounded and detectable — but cannot
 * manufacture a Chief of Police.
 *
 * That is why there is no `organization` field in the telemetry payload. Not
 * "ignored if present": absent from the type, so no one can add a code path that
 * reads one (engineering rules 19, 20).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Protocol version ───────────────────────────────────────────────────────

/**
 * Bumped only for a BREAKING change to the wire format.
 *
 * The API accepts the current version and one previous. Server operators do not
 * update resources promptly — a protocol that cannot tolerate a stale resource
 * is a protocol that takes a game server offline on deploy day.
 */
export const FIVEM_PROTOCOL_VERSION = 1;
export const FIVEM_MIN_PROTOCOL_VERSION = 1;

// ── Headers ────────────────────────────────────────────────────────────────

/**
 * Every request carries all of these. Lower-case because Node normalises
 * incoming header names, and comparing against a capitalised literal is a bug
 * that only shows up at runtime.
 */
export const FIVEM_HEADERS = {
  keyId: 'x-leoos-key-id',
  timestamp: 'x-leoos-timestamp',
  nonce: 'x-leoos-nonce',
  seq: 'x-leoos-seq',
  signature: 'x-leoos-signature',
  protocol: 'x-leoos-protocol',
} as const;

/**
 * The string that gets signed.
 *
 * The BODY HASH is signed rather than the body itself: verification stays cheap
 * on a large telemetry batch, and altering a single coordinate still breaks the
 * signature. Newline-separated with a fixed field order, so there is no
 * ambiguity about where one field ends and the next begins — a delimiter-free
 * concatenation is how signing schemes end up with two different inputs
 * producing one canonical string.
 *
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n SEQ \n hex(sha256(body))
 */
export function fivemCanonicalString(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  seq: string;
  bodySha256Hex: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.seq,
    input.bodySha256Hex.toLowerCase(),
  ].join('\n');
}

// ── Timing and limits ──────────────────────────────────────────────────────

/**
 * How far a request's timestamp may be from the server's clock.
 *
 * Wide enough for an unsynchronised game host, narrow enough that a captured
 * request is worthless within a minute. Combined with the nonce cache, which
 * covers replay inside the window.
 */
export const FIVEM_CLOCK_SKEW_SECONDS = 60;

/** A nonce is remembered for twice the skew window, so it cannot be reused. */
export const FIVEM_NONCE_TTL_SECONDS = FIVEM_CLOCK_SKEW_SECONDS * 2;

/** Default telemetry interval the API asks for at handshake. */
export const FIVEM_DEFAULT_TELEMETRY_MS = 1_000;

/** Default heartbeat interval. */
export const FIVEM_DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * No heartbeat for this long and the whole server is treated as offline —
 * every unit it was reporting goes with it.
 */
export const FIVEM_SERVER_OFFLINE_AFTER_MS = 30_000;

/**
 * A position older than this is not shown as live.
 *
 * The safety net that makes offline detection self-healing: if a removal event
 * is lost, or the game server dies mid-tick, samples expire on their own and
 * nothing has to remember to clean up.
 */
export const FIVEM_POSITION_TTL_MS = 45_000;

/** Largest telemetry batch accepted. A bigger one is malformed, not a big server. */
export const FIVEM_MAX_PLAYERS_PER_BATCH = 512;

/**
 * Implied speed above which a movement is treated as a teleport.
 *
 * 200 m/s is 720 km/h — faster than anything in the game, so a sample beyond it
 * is a bug, a lag spike, or a spoof. The sample is rejected and counted rather
 * than trusted or silently dropped.
 */
export const FIVEM_MAX_IMPLIED_SPEED_MS = 200;

// ── Requests ───────────────────────────────────────────────────────────────

export type FiveMIdentifierProvider =
  | 'license' | 'license2' | 'steam' | 'discord' | 'fivem' | 'xbl' | 'live';

/**
 * The identifiers a player presents.
 *
 * `license` is the one that matters — it is the Rockstar licence and the only
 * identifier a player cannot trivially change. The rest are collected because
 * they help an administrator recognise who a person is when linking an account,
 * and for nothing else.
 */
export type FiveMIdentifiers = Partial<Record<FiveMIdentifierProvider, string>>;

export interface FiveMHandshakeRequest {
  /** Resource version, for the upgrade notice. */
  resourceVersion: string;
  /** Free text from the server's own config. Advisory; used for display. */
  serverName?: string | null;
  maxPlayers?: number | null;
  /** Which adapter the resource selected, and whether it autodetected it. */
  adapter?: string | null;
}

export interface FiveMHandshakeResponse {
  ok: true;
  sessionId: string;
  serverKey: string;
  protocolVersion: number;
  /** The API tells the resource how fast to report. Config without a redeploy. */
  telemetryIntervalMs: number;
  heartbeatIntervalMs: number;
  /** Present when the resource is older than the API would like. */
  upgradeNotice?: string;
}

export interface FiveMHeartbeatRequest {
  sessionId: string;
  playerCount: number;
  uptimeSeconds: number;
  resourceVersion: string;
}

/**
 * One player's state, as the GAME sees it.
 *
 * Note what is absent: organization, rank, callsign, unit, permissions. Those
 * are not "ignored" — there is nowhere to put them.
 */
export interface FiveMPlayerSample {
  /** Transient FiveM server id. Useful for logs; never an identity. */
  src: number;
  identifiers: FiveMIdentifiers;
  /** Advisory only — used for display when no LEOOS account is linked. */
  characterName?: string | null;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Metres per second, from the game. */
  speed?: number | null;
  health?: number | null;
  armor?: number | null;
  /**
   * Whether the game considers this player dead or dying.
   *
   * ────────────────────────────────────────────────────────────────────────
   * A GAME-WORLD FACT, IN THE SAME TRUST CLASS AS A COORDINATE.
   *
   * LEOOS cannot verify it and does not pretend to. The game server observes it
   * with a server-side native and ASSERTS it; LEOOS records what was asserted
   * and acts on it, exactly as it does with position. A compromised game server
   * can lie about this as it can lie about where somebody is standing.
   *
   * What it is NOT is something a browser may set. No session-authenticated
   * route carries a liveness field, and `fivem.test.ts` asserts that.
   *
   * Distinct from `health` deliberately: a roleplay framework can hold a downed
   * player at positive health, so a number does not answer the question a panic
   * button asks.
   * ────────────────────────────────────────────────────────────────────────
   */
  down?: boolean | null;
  vehicle?: {
    model: string;
    plate?: string | null;
    seat?: number | null;
    sirens?: boolean | null;
    lights?: boolean | null;
  } | null;
  /**
   * A duty status the PLAYER asked for in game.
   *
   * Advisory, and named so. The API authorizes it exactly as it would authorize
   * the same request from a browser; the game server asking does not make it so.
   */
  requestedStatus?: string | null;
}

export interface FiveMTelemetryRequest {
  sessionId: string;
  /** Resource clock, milliseconds. Used for diagnostics, never for ordering. */
  sentAt: number;
  players: FiveMPlayerSample[];
  /** Identifiers that left since the last batch. */
  departed?: string[];
}

export type FiveMEventKind =
  | 'player.connected'
  | 'player.dropped'
  | 'player.panic'
  | 'player.status_requested';

/**
 * Discrete occurrences, delivered separately from telemetry.
 *
 * Telemetry is coalesced and never retried — a one-second-old position is
 * worthless. An event is neither, so it gets its own endpoint and its own
 * bounded retry queue in the resource.
 */
export interface FiveMEvent {
  kind: FiveMEventKind;
  /** Resource clock, milliseconds. */
  at: number;
  identifiers: FiveMIdentifiers;
  src?: number | null;
  /** For `player.status_requested`. Authorized server-side like any other. */
  statusKey?: string | null;
  /** For `player.panic`, when the game knows where it happened. */
  x?: number | null;
  y?: number | null;
  reason?: string | null;
  /**
   * Liveness as the game server saw it AT THE MOMENT OF THE PRESS.
   *
   * Carried on the event as well as on telemetry because it is the fresher of
   * the two: telemetry is throttled, so its last sample can be seconds old, and
   * seconds are exactly the window in which somebody dies. Same trust class and
   * same caveat as `FiveMPlayerSample.down`.
   */
  down?: boolean | null;
}

export interface FiveMEventsRequest {
  sessionId: string;
  events: FiveMEvent[];
}

export interface FiveMClaimRequest {
  identifiers: FiveMIdentifiers;
  /** The six-character code the player generated in the web UI. */
  code: string;
  src?: number | null;
}

// ── Responses ──────────────────────────────────────────────────────────────

/**
 * A command the API wants the game server to carry out.
 *
 * Delivered in the RESPONSE BODY of an ingest request rather than pushed, so the
 * game host needs no inbound firewall rule and exposes no listening port. The
 * web application never initiates a connection to a game server.
 */
export type FiveMCommandType = 'notify' | 'setBlip' | 'clearBlip' | 'setWaypoint';

export interface FiveMCommand {
  id: string;
  type: FiveMCommandType;
  /** The identifier this applies to. */
  target: string;
  payload?: Record<string, unknown>;
}

/**
 * How many commands one game server may have waiting.
 *
 * Bounded because a game server that has been unreachable for an hour must not
 * be able to make the API hold a backlog for it. Past the cap the OLDEST is
 * dropped: a stale prompt is worse than a missing one, and the newest command
 * is the one still describing a situation that exists.
 */
export const FIVEM_COMMAND_QUEUE_MAX = 100;

/** Delivered per response, so one batch stays a small body. */
export const FIVEM_COMMAND_BATCH_MAX = 20;

export interface FiveMIngestResponse {
  ok: true;
  /** Lets the API slow a chatty resource down without a resource update. */
  nextIntervalMs?: number;
  /** At-most-once. A duplicated in-game popup is worse than a missed one. */
  commands?: FiveMCommand[];
  /**
   * More commands are waiting than fitted in this batch.
   *
   * The bridge drains again promptly rather than waiting a full tick. Without
   * it, a burst would trickle out at one batch per second.
   */
  commandsPending?: boolean;
  /** What the API did with the batch, for the resource's debug log. */
  accepted?: number;
  rejected?: number;
}

export interface FiveMClaimResponse {
  ok: boolean;
  /** Shown to the player in game. Deliberately vague on failure. */
  message: string;
  displayName?: string | null;
}

// ── Rejection reasons ──────────────────────────────────────────────────────

/**
 * Why a sample was not accepted.
 *
 * Counted per server and surfaced in the admin UI. Sustained anomalies are the
 * signal that a game server is compromised or misconfigured, so they are a
 * number somebody can look at rather than a log line nobody reads.
 */
export type FiveMRejectReason =
  | 'out-of-bounds'
  | 'teleport'
  | 'duplicate-identifier'
  | 'no-identifier'
  | 'unlinked'
  | 'not-on-duty'
  | 'invalid-shape';

export interface FiveMIngestOutcome {
  accepted: number;
  rejected: number;
  reasons: Partial<Record<FiveMRejectReason, number>>;
}

// ── Admin-facing views ─────────────────────────────────────────────────────

/**
 * A game server as the admin UI sees it.
 *
 * No secret, no hash, not even a truncated one — the credential leaves the API
 * exactly once, at creation (engineering rule 16).
 */
export interface GameServerDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  /** Live state, null until the server has ever connected. */
  state: {
    lastHeartbeatAt: string | null;
    playerCount: number;
    resourceVersion: string | null;
    anomalyCount: number;
    /** Derived from the heartbeat age, not stored. */
    online: boolean;
  } | null;
  credentials: GameServerCredentialDto[];
}

export interface GameServerCredentialDto {
  id: string;
  keyId: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** The one and only time a secret is returned. */
export interface GameServerCredentialIssued {
  keyId: string;
  /** Shown once. Never retrievable again — there is no endpoint that can. */
  secret: string;
  expiresAt: string | null;
}
