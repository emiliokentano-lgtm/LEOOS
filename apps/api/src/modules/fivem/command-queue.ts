import { randomUUID } from 'node:crypto';
import {
  FIVEM_COMMAND_BATCH_MAX, FIVEM_COMMAND_QUEUE_MAX,
  type FiveMCommand, type FiveMCommandType,
} from '@leoos/contracts';

/**
 * Things LEOOS wants a game client to do.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DIRECTION THIS SOLVES
 *
 * Everything else in the FiveM integration flows game server → LEOOS. In-game
 * prompts need the other direction, and the game host must not have to listen
 * for it: a dispatch backend that opens connections into a game server is a
 * dispatch backend worth attacking for that reason alone.
 *
 * So commands ride back in the RESPONSE BODY of a request the bridge itself
 * made. Nothing that has not already passed the signature check can reach the
 * command handler, because there is nowhere for it to arrive.
 *
 * The consumer has existed since Phase 7 — the contract, the wire format and
 * the resource's `Commands.apply`. What was missing was anything that produced
 * a command. See docs/architecture/04-fivem-integration.md §7.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * AT-MOST-ONCE, and that is the design rather than a shortcut. A batch handed
 * out is removed; if the response never arrives, those commands are gone. An
 * acknowledgement protocol would buy at-least-once, and a duplicated in-game
 * popup is worse than a missed one. Anything that must not be lost belongs in
 * the web UI, where a person can acknowledge it.
 *
 * IN-PROCESS, like the nonce store, the ticket store and the position store,
 * and for the same reason: Redis is not provisioned. On two API nodes a command
 * queued on one is invisible to the other, so a prompt would reach a player
 * only if their game server's next request happened to land on the right
 * instance. Recorded in the project report's known limitations.
 */
export interface QueuedCommand extends FiveMCommand {
  /** When it was queued. Used only to expire a backlog nobody drained. */
  queuedAt: number;
}

/**
 * Commands go stale.
 *
 * A backup prompt that surfaces four minutes after it was raised is not help,
 * it is confusion — the situation has resolved one way or the other. Expiry is
 * checked on drain rather than on a timer, so a queue nobody reads costs
 * nothing until somebody reads it.
 */
export const COMMAND_TTL_MS = 60_000;

export class FiveMCommandQueue {
  /** Keyed by game server id. A server with nothing waiting holds no entry. */
  private readonly queues = new Map<string, QueuedCommand[]>();

  constructor(
    private readonly queueMax = FIVEM_COMMAND_QUEUE_MAX,
    private readonly batchMax = FIVEM_COMMAND_BATCH_MAX,
    private readonly ttlMs = COMMAND_TTL_MS,
  ) {}

  /**
   * Queues one command for one player on one game server.
   *
   * `target` is a FiveM identifier, not a LEOOS user id: the resource resolves
   * it against the players currently connected, and a player who has since
   * disconnected simply matches nothing. Deliberate — it means this queue never
   * needs to know who is online.
   */
  push(
    gameServerId: string,
    input: { type: FiveMCommandType; target: string; payload?: Record<string, unknown> },
    now = Date.now(),
  ): QueuedCommand {
    const command: QueuedCommand = {
      id: randomUUID(),
      type: input.type,
      target: input.target,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      queuedAt: now,
    };

    const queue = this.queues.get(gameServerId) ?? [];
    queue.push(command);

    /**
     * Drop the OLDEST past the cap, not the newest.
     *
     * A game server unreachable for an hour must not be able to make the API
     * hold a backlog for it. When something has to go, the stale prompt is the
     * one worth losing: the newest command is the one still describing a
     * situation that exists.
     */
    while (queue.length > this.queueMax) queue.shift();

    this.queues.set(gameServerId, queue);
    return command;
  }

  /**
   * Hands out the next batch and forgets it.
   *
   * Returns `pending` when more remain, so the caller can tell the bridge to
   * come back immediately instead of waiting a full tick — otherwise a burst
   * would trickle out at one batch per second.
   */
  drain(gameServerId: string, now = Date.now()): { commands: FiveMCommand[]; pending: boolean } {
    const queue = this.queues.get(gameServerId);
    if (queue === undefined || queue.length === 0) return { commands: [], pending: false };

    // Expiry first, so a stale backlog does not consume the batch and starve
    // the commands somebody is actually waiting for.
    const live = queue.filter((c) => now - c.queuedAt < this.ttlMs);

    const batch = live.slice(0, this.batchMax);
    const rest = live.slice(this.batchMax);
    this.queues.set(gameServerId, rest);

    return {
      commands: batch.map(({ queuedAt: _queuedAt, ...command }) => command),
      pending: rest.length > 0,
    };
  }

  /** Depth for one server, for the admin surface and for tests. */
  depth(gameServerId: string, now = Date.now()): number {
    const queue = this.queues.get(gameServerId);
    if (queue === undefined) return 0;
    return queue.filter((c) => now - c.queuedAt < this.ttlMs).length;
  }

  /** Dropped when a credential is revoked: those commands can never be read. */
  forget(gameServerId: string): void {
    this.queues.delete(gameServerId);
  }

  clear(): void {
    this.queues.clear();
  }
}
