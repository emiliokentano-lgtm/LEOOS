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
  delete(unitId: string): void;
  /** Drops samples older than `maxAgeMs`. Keeps memory flat over a long shift. */
  prune(maxAgeMs: number, now?: number): number;
  readonly size: number;
}

export class InMemoryPositionStore implements LivePositionStore {
  private readonly samples = new Map<string, PositionSample>();

  set(sample: PositionSample): void {
    // Clamped on the way IN, once, so nothing downstream has to defend against a
    // coordinate outside the world. A bad sample is a bad sample; it is not a
    // reason to lose track of the unit entirely.
    const clamped = clampToWorld({ x: sample.x, y: sample.y, z: sample.z });
    this.samples.set(sample.unitId, {
      ...sample,
      x: clamped.x,
      y: clamped.y,
      z: clamped.z ?? null,
    });
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
  }

  prune(maxAgeMs: number, now = Date.now()): number {
    let removed = 0;
    for (const [id, sample] of this.samples) {
      if (now - sample.sampledAt.getTime() > maxAgeMs) {
        this.samples.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.samples.size;
  }
}
