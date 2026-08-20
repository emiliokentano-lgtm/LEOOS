import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, or, gt, sql } from 'drizzle-orm';
import {
  FIVEM_CLOCK_SKEW_SECONDS, FIVEM_HEADERS, FIVEM_MIN_PROTOCOL_VERSION,
  FIVEM_PROTOCOL_VERSION, fivemCanonicalString,
} from '@leoos/contracts';
import { gameServer, gameServerCredential, gameServerState, type Database } from '@leoos/db';
import type { SecretBox } from '../../lib/secret-box.js';
import type { NonceStore } from './nonce-store.js';

/**
 * Authenticating a game server.
 *
 * THE ORDER OF THE CHECKS IS THE DESIGN. Each one is cheaper than the next and
 * each fails closed, so a flood of forged requests is rejected on a header
 * comparison rather than after a database write:
 *
 *   1. every header present and well-formed        — string work
 *   2. protocol version supported                  — integer compare
 *   3. timestamp within the skew window            — integer compare
 *   4. key id resolves to a live credential        — one indexed read
 *   5. nonce unseen                                — in-process map
 *   6. sequence strictly greater than the last     — already read in 4
 *   7. HMAC recomputed and compared constant-time  — the expensive one, last
 *
 * The signature check is LAST on purpose. It is the only step that costs real
 * CPU, and everything above it discards a malformed or replayed request without
 * ever reaching it.
 *
 * WHY BOTH A NONCE AND A SEQUENCE. The nonce catches an exact replay inside the
 * skew window and does not care about ordering. The sequence is persisted, so it
 * survives an API restart and a multi-process deployment where one instance's
 * nonce cache is unknown to another. Neither alone is sufficient; see
 * nonce-store.ts.
 */

export interface FiveMPrincipal {
  gameServerId: string;
  gameServerKey: string;
  gameServerName: string;
  credentialId: string;
  keyId: string;
  seq: bigint;
  protocolVersion: number;
}

export type FiveMAuthFailure =
  | 'missing-headers'
  | 'malformed-headers'
  | 'unsupported-protocol'
  | 'clock-skew'
  | 'unknown-key'
  | 'server-inactive'
  | 'credential-unverifiable'
  | 'replayed-nonce'
  | 'stale-sequence'
  | 'bad-signature';

export type FiveMAuthResult =
  | { ok: true; principal: FiveMPrincipal }
  | { ok: false; reason: FiveMAuthFailure };

export interface VerifyInput {
  method: string;
  /** The path that was signed. Must be the raw path, without the query string. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The body EXACTLY as it arrived. A re-serialised object will not match. */
  rawBody: string;
  /**
   * True only for the handshake, which ESTABLISHES the sequence counter rather
   * than continuing it. See check 6 for why that exemption has to exist.
   */
  isHandshake?: boolean;
  now?: number;
}

export interface VerifyDeps {
  db: Database;
  nonces: NonceStore;
  secretBox: SecretBox | null;
}

function header(
  headers: VerifyInput['headers'],
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  // A repeated header is not something our resource sends. Treating it as
  // absent rather than picking one avoids a class of smuggling ambiguity.
  return null;
}

/** Bounded so a pathological header cannot become a large allocation. */
function isPlausible(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max;
}

export async function verifyFiveMRequest(
  input: VerifyInput,
  deps: VerifyDeps,
): Promise<FiveMAuthResult> {
  const now = input.now ?? Date.now();

  // ── 1. Headers ───────────────────────────────────────────────────────────
  const keyId = header(input.headers, FIVEM_HEADERS.keyId);
  const timestamp = header(input.headers, FIVEM_HEADERS.timestamp);
  const nonce = header(input.headers, FIVEM_HEADERS.nonce);
  const seqRaw = header(input.headers, FIVEM_HEADERS.seq);
  const signature = header(input.headers, FIVEM_HEADERS.signature);

  if (!keyId || !timestamp || !nonce || !seqRaw || !signature) {
    return { ok: false, reason: 'missing-headers' };
  }
  if (
    !isPlausible(keyId, 128) || !isPlausible(nonce, 128)
    || !isPlausible(timestamp, 20) || !isPlausible(seqRaw, 20)
    || !isPlausible(signature, 128)
  ) {
    return { ok: false, reason: 'malformed-headers' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { ok: false, reason: 'malformed-headers' };
  }

  let seq: bigint;
  try {
    seq = BigInt(seqRaw);
  } catch {
    return { ok: false, reason: 'malformed-headers' };
  }
  if (seq < 0n) return { ok: false, reason: 'malformed-headers' };

  // ── 2. Protocol ──────────────────────────────────────────────────────────
  const protocolRaw = header(input.headers, FIVEM_HEADERS.protocol);
  const protocolVersion = protocolRaw === null ? FIVEM_PROTOCOL_VERSION : Number(protocolRaw);
  if (
    !Number.isInteger(protocolVersion)
    || protocolVersion < FIVEM_MIN_PROTOCOL_VERSION
    || protocolVersion > FIVEM_PROTOCOL_VERSION
  ) {
    return { ok: false, reason: 'unsupported-protocol' };
  }

  // ── 3. Clock skew ────────────────────────────────────────────────────────
  //
  // Checked BEFORE the database read, so a clock-skewed flood costs nothing.
  const skewSeconds = Math.abs(Math.floor(now / 1000) - timestampSeconds);
  if (skewSeconds > FIVEM_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'clock-skew' };
  }

  // ── 4. Credential ────────────────────────────────────────────────────────
  const rows = await deps.db
    .select({
      credentialId: gameServerCredential.id,
      keyId: gameServerCredential.keyId,
      secretEnc: gameServerCredential.secretEnc,
      gameServerId: gameServer.id,
      gameServerKey: gameServer.key,
      gameServerName: gameServer.name,
      isActive: gameServer.isActive,
      lastIngestSeq: gameServerState.lastIngestSeq,
    })
    .from(gameServerCredential)
    .innerJoin(gameServer, eq(gameServer.id, gameServerCredential.gameServerId))
    .leftJoin(gameServerState, eq(gameServerState.gameServerId, gameServer.id))
    .where(and(
      eq(gameServerCredential.keyId, keyId),
      isNull(gameServerCredential.revokedAt),
      or(
        isNull(gameServerCredential.expiresAt),
        gt(gameServerCredential.expiresAt, new Date(now)),
      ),
    ))
    .limit(1);

  const credential = rows[0];
  if (!credential) return { ok: false, reason: 'unknown-key' };

  // A deactivated server keeps its credentials but stops being able to write.
  // Distinct from revoking the key: the operator is turning a server off, not
  // dealing with a compromise, and reactivating should not need a reissue.
  if (!credential.isActive) return { ok: false, reason: 'server-inactive' };

  if (deps.secretBox === null || credential.secretEnc === null) {
    // Stated as its own failure rather than folded into a signature mismatch:
    // "your key is unverifiable, reissue it" is actionable, "signature invalid"
    // sends an operator hunting through their Lua.
    return { ok: false, reason: 'credential-unverifiable' };
  }

  const secret = deps.secretBox.open(credential.secretEnc);
  if (secret === null) return { ok: false, reason: 'credential-unverifiable' };

  // ── 5. Nonce ─────────────────────────────────────────────────────────────
  if (!deps.nonces.remember(keyId, nonce, now)) {
    return { ok: false, reason: 'replayed-nonce' };
  }

  // ── 6. Sequence ──────────────────────────────────────────────────────────
  //
  // Strictly greater. Equality is a replay, not a retry — the resource assigns a
  // fresh sequence number to every attempt, including retries, precisely so that
  // this check can be strict.
  //
  // ──────────────────────────────────────────────────────────────────────────
  // THE HANDSHAKE IS EXEMPT, AND THAT EXEMPTION IS LOAD-BEARING.
  //
  // The resource's counter is per PROCESS: a game server that restarts begins
  // again near zero, while this side holds a high-water mark in the thousands.
  // Checking the handshake against it would mean a restarted server could never
  // speak again — and "re-run the handshake", which every session failure tells
  // it to do, would be advice it is structurally unable to take. The credential
  // would be bricked until an administrator issued a new one.
  //
  // Nothing is given up by exempting it. A handshake is still signed, still
  // nonce-checked and still inside the ±60 s skew window, so it cannot be
  // replayed: inside the window the nonce store refuses it, outside it the
  // timestamp does. The handshake handler then RESETS the high-water mark to
  // this request's sequence, so everything that follows is ordered against a
  // baseline the resource actually holds.
  // ──────────────────────────────────────────────────────────────────────────
  if (input.isHandshake !== true) {
    const lastSeq = credential.lastIngestSeq ?? 0n;
    if (seq <= lastSeq) {
      return { ok: false, reason: 'stale-sequence' };
    }
  }

  // ── 7. Signature ─────────────────────────────────────────────────────────
  const bodyHash = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
  const canonical = fivemCanonicalString({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    seq: seqRaw,
    bodySha256Hex: bodyHash,
  });

  const expected = createHmac('sha256', secret).update(canonical, 'utf8').digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // expected length through an exception path. Checked first.
  if (provided.length !== expected.length) return { ok: false, reason: 'bad-signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad-signature' };

  return {
    ok: true,
    principal: {
      gameServerId: credential.gameServerId,
      gameServerKey: credential.gameServerKey,
      gameServerName: credential.gameServerName,
      credentialId: credential.credentialId,
      keyId: credential.keyId,
      seq,
      protocolVersion,
    },
  };
}

/**
 * Records that a request was accepted.
 *
 * Two things happen together and must not drift: the sequence high-water mark
 * advances, and the credential's last-used stamp moves. Written AFTER the
 * request is authenticated but BEFORE the body is processed, so a payload that
 * fails validation still burns its sequence number — otherwise a rejected
 * request could be replayed verbatim once the nonce expired.
 *
 * The `WHERE seq > last_ingest_seq` guard makes this safe under concurrency:
 * two requests racing cannot both advance the counter backwards, and the loser
 * is a no-op rather than an overwrite.
 */
export async function commitSequence(
  db: Database,
  principal: FiveMPrincipal,
): Promise<void> {
  await db
    .insert(gameServerState)
    .values({
      gameServerId: principal.gameServerId,
      lastIngestSeq: principal.seq,
    })
    .onConflictDoUpdate({
      target: gameServerState.gameServerId,
      set: {
        lastIngestSeq: principal.seq,
        updatedAt: new Date(),
      },
      where: sql`${gameServerState.lastIngestSeq} < ${principal.seq}`,
    });

  await db
    .update(gameServerCredential)
    .set({ lastUsedAt: new Date() })
    .where(eq(gameServerCredential.id, principal.credentialId));
}

/**
 * The public-facing message for each failure.
 *
 * Deliberately specific. This is not a browser-facing surface where vagueness
 * protects against enumeration — it is a machine-to-machine integration whose
 * operator is on the same side as us, debugging a Lua resource through a game
 * server console. "Signature invalid" with no further detail turns a five-minute
 * clock-skew fix into an afternoon.
 *
 * What is NEVER returned: whether a key id exists. `unknown-key` and a wrong
 * signature both answer with the same status and a message that names neither.
 */
export function describeAuthFailure(reason: FiveMAuthFailure): { status: number; message: string } {
  switch (reason) {
    case 'missing-headers':
      return { status: 401, message: 'Signed request headers are missing.' };
    case 'malformed-headers':
      return { status: 401, message: 'Signed request headers are malformed.' };
    case 'unsupported-protocol':
      return {
        status: 426,
        message: `This LEOOS API speaks protocol ${FIVEM_MIN_PROTOCOL_VERSION}–${FIVEM_PROTOCOL_VERSION}. Update the leoos_bridge resource.`,
      };
    case 'clock-skew':
      return {
        status: 401,
        message: `Request timestamp is outside the ${FIVEM_CLOCK_SKEW_SECONDS}s window. Check the game host's clock.`,
      };
    case 'unknown-key':
    case 'bad-signature':
      // ONE message for both. Distinguishing them would turn this endpoint into
      // an oracle for which key ids exist.
      return { status: 401, message: 'Request could not be authenticated.' };
    case 'server-inactive':
      return { status: 403, message: 'This game server is deactivated in LEOOS.' };
    case 'credential-unverifiable':
      return {
        status: 503,
        message: 'This credential cannot be verified by the API. Issue a new one.',
      };
    case 'replayed-nonce':
      return { status: 409, message: 'This request nonce has already been used.' };
    case 'stale-sequence':
      return {
        status: 409,
        message: 'Request sequence is not ahead of the last accepted one. Re-run the handshake.',
      };
  }
}
