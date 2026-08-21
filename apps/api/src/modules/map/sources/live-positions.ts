import { clampToWorld } from '@leoos/contracts';

/**
 * The live position store.
 *
 * ARCHITECTURAL NOTE, because this is a stand-in and must not be mistaken for
 * the finished thing: docs/architecture/03-realtime.md and §9 of the data model
 * put live positions in REDIS, with Postgres receiving only a low-rate
 * downsample. Redis is not provisioned yet, so this is an in-process Map with
 * the same interface and the same semantics.
 *
 * What that costs, stated plainly rather than discovered later:
 *   • It does not survive a restart. Positions repopulate on the next tick.
 *   • It does not span processes. A second API instance would have its own
 *     copy, so this is single-node until Redis lands.
 *
 * What it buys is the property that actually matters for engineering rules 21
 * and 22: position updates at 1 Hz do NOT become 1 Hz of database writes.
 * Postgres sees a flush at a fraction of that rate, which is exactly what
 * `unit.pos_x` is documented to be — a cache, not a telemetry log.
 *
 * Swapping in Redis means implementing this interface against it. Nothing above
 * this file knows which one it is talking to.
 */

export interface PositionSample {
  unitId: string;
  organizationId: string;
  x: number;
  y: number;
  z: number | null;
  heading: number | null;
  speed: number | null;
  sampledAt: Date;
}

export interface LivePositionStore {
  set(sample: PositionSample): void;
  setMany(samples: readonly PositionSample[]): void;
  get(unitId: string): PositionSample | undefined;
  all(): PositionSample[];
  /**
   * Samples whose value CHANGED after `revision`, plus the current revision.
   *
   * The broadcaster's whole reason for existing is to send as little as
   * possible, and `all()` is the opposite of that: a fleet parked at HQ has a
   * sample per unit that never changes, and re-sending it every second is pure
   * waste that scales with the fleet rather than with the activity. Pass the
   * revision from the previous tick and get only what moved.
   */
  changedSince(revision: number): { revision: number; samples: PositionSample[] };
  /** The current revision, for a subscriber that has just been given a full set. */
  readonly revision: number;
  delete(unitId: string): void;
  /** Drops samples older than `maxAgeMs`. Keeps memory flat over a long shift. */
  prune(maxAgeMs: number, now?: number): number;
  readonly size: number;
}

export class InMemoryPositionStore implements LivePositionStore {
  private readonly samples = new Map<string, PositionSample>();
  /** Per-unit revision, so a reader can ask what has changed since it last looked. */
  private readonly revisions = new Map<string, number>();
  private currentRevision = 0;

  set(sample: PositionSample): void {
    // Clamped on the way IN, once, so nothing downstream has to defend against a
    // coordinate outside the world. A bad sample is a bad sample; it is not a
    // reason to lose track of the unit entirely.
    const clamped = clampToWorld({ x: sample.x, y: sample.y, z: sample.z });
    const next: PositionSample = {
      ...sample,
      x: clamped.x,
      y: clamped.y,
      z: clamped.z ?? null,
    };

    /**
     * A RE-REPORT OF THE SAME PLACE IS NOT A CHANGE.
     *
     * The FiveM bridge sends a keep-alive on an interval even when a unit has
     * not moved, so that the server can tell "parked" from "crashed". That is
     * the right thing for the bridge to do and the wrong thing to forward: a
     * unit sitting at HQ would otherwise be broadcast to every subscriber every
     * second, forever.
     *
     * `sampledAt` is deliberately EXCLUDED from the comparison. It moves on
     * every keep-alive by definition, so including it would make this test
     * always false and the whole optimisation a no-op. Freshness is derived by
     * the client from the last position it received, and a unit that has not
     * moved has not moved regardless of when it last said so.
     */
    const previous = this.samples.get(sample.unitId);
    const unchanged = previous !== undefined
      && previous.x === next.x
      && previous.y === next.y
      && previous.z === next.z
      && previous.heading === next.heading
      && previous.speed === next.speed;

    this.samples.set(sample.unitId, next);
    if (!unchanged) {
      this.currentRevision += 1;
      this.revisions.set(sample.unitId, this.currentRevision);
    }
  }

  get revision(): number {
    return this.currentRevision;
  }

  changedSince(revision: number): { revision: number; samples: PositionSample[] } {
    const samples: PositionSample[] = [];
    // Walked rather than indexed: the map holds one entry per live unit — a few
    // hundred — so a scan per tick is cheaper than maintaining a second index,
    // and it cannot drift out of step with the samples it describes.
    for (const [unitId, sample] of this.samples) {
      if ((this.revisions.get(unitId) ?? 0) > revision) samples.push(sample);
    }
    return { revision: this.currentRevision, samples };
  }

  setMany(samples: readonly PositionSample[]): void {
    for (const sample of samples) this.set(sample);
  }

  get(unitId: string): PositionSample | undefined {
    return this.samples.get(unitId);
  }

  all(): PositionSample[] {
    return [...this.samples.values()];
  }

  delete(unitId: string): void {
    this.samples.delete(unitId);
    this.revisions.delete(unitId);
  }

  prune(maxAgeMs: number, now = Date.now()): number {
    let removed = 0;
    for (const [id, sample] of this.samples) {
      if (now - sample.sampledAt.getTime() > maxAgeMs) {
        this.samples.delete(id);
        this.revisions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.samples.size;
  }
}
