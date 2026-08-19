import {
  INTERPOLATION_CAP_MS, lerpHeading, type MapUnit, type WorldPosition,
} from '@leoos/contracts';

/**
 * Between-tick position interpolation.
 *
 * Positions arrive at 1 Hz. Drawn as they arrive, units teleport once a second
 * — which reads as a broken map rather than as a low data rate, and makes it
 * genuinely hard to follow a pursuit. Interpolating across the tick with
 * `requestAnimationFrame` makes movement continuous while the data rate stays
 * at 1 Hz (docs/architecture/05-map.md §4).
 *
 * THE HONESTY CONSTRAINT, which is what stops this being a lie: interpolation
 * only ever draws a unit BETWEEN two positions it actually reported, and only
 * while the samples are close enough together for a straight line to be a
 * defensible guess. Past `INTERPOLATION_CAP_MS` the unit SNAPS. Sliding a
 * marker smoothly down a coastline the unit never drove would be the renderer
 * inventing a route, and an operator would have no way to tell.
 *
 * Extrapolation — continuing past the last known position on the assumption the
 * unit kept going — is deliberately NOT implemented for the same reason. A unit
 * that stopped reporting is drawn where it was last seen, and marked stale.
 */

export interface InterpolationTrack {
  from: WorldPosition;
  to: WorldPosition;
  fromHeading: number;
  toHeading: number;
  /** Client clock, not server clock — see `MapInterpolator.update`. */
  startedAt: number;
  durationMs: number;
}

export interface InterpolatedPose {
  x: number;
  y: number;
  heading: number;
}

export class MapInterpolator {
  private readonly tracks = new Map<string, InterpolationTrack>();

  /**
   * Records the new positions and starts a track toward each.
   *
   * Timing uses the CLIENT clock. Interpolating against the server's timestamps
   * would tie the animation to clock skew between the browser and the API — a
   * few seconds of skew is common and would make every unit either freeze or
   * jump permanently. Server timestamps are still used for staleness, where
   * they are the right answer; they are the wrong answer for animation.
   */
  update(units: readonly MapUnit[], now: number, tickMs: number): void {
    const seen = new Set<string>();

    for (const unit of units) {
      if (unit.location === null) continue;
      seen.add(unit.id);

      const target: WorldPosition = { x: unit.location.x, y: unit.location.y };
      const heading = unit.location.heading ?? 0;
      const existing = this.tracks.get(unit.id);

      if (existing === undefined) {
        // First sighting: no motion to interpolate, so it appears where it is.
        this.tracks.set(unit.id, {
          from: target, to: target,
          fromHeading: heading, toHeading: heading,
          startedAt: now, durationMs: tickMs,
        });
        continue;
      }

      if (existing.to.x === target.x && existing.to.y === target.y
        && existing.toHeading === heading) {
        continue; // Unchanged sample: let the current track finish.
      }

      // Start from where the unit is being DRAWN, not from its last reported
      // position. Otherwise a tick arriving mid-animation snaps the marker back
      // before moving it forward — a visible stutter once a second.
      const current = this.poseOf(unit.id, now) ?? { ...existing.to, heading: existing.toHeading };

      this.tracks.set(unit.id, {
        from: { x: current.x, y: current.y },
        to: target,
        fromHeading: current.heading,
        toHeading: heading,
        startedAt: now,
        durationMs: tickMs,
      });
    }

    // Units that vanished from the payload — off duty, disbanded, or no longer
    // visible to this viewer — leave no track behind. Keeping them is both a
    // leak over an 8 hour shift and a way for a removed unit to reappear.
    for (const id of [...this.tracks.keys()]) {
      if (!seen.has(id)) this.tracks.delete(id);
    }
  }

  /** Where a unit should be drawn right now. */
  poseOf(unitId: string, now: number): InterpolatedPose | null {
    const track = this.tracks.get(unitId);
    if (track === undefined) return null;

    const elapsed = now - track.startedAt;

    // A gap longer than the cap means the unit was not being tracked for a
    // while. Snapping is the honest rendering.
    const gap = Math.hypot(track.to.x - track.from.x, track.to.y - track.from.y);
    if (track.durationMs > INTERPOLATION_CAP_MS || gap > 1_000) {
      return { x: track.to.x, y: track.to.y, heading: track.toHeading };
    }

    const t = Math.min(1, Math.max(0, elapsed / track.durationMs));
    return {
      x: track.from.x + (track.to.x - track.from.x) * t,
      y: track.from.y + (track.to.y - track.from.y) * t,
      heading: lerpHeading(track.fromHeading, track.toHeading, t),
    };
  }

  /**
   * Whether anything is still moving.
   *
   * The render loop uses this to stop requesting frames once every track has
   * settled. A map of parked units should cost nothing to display — that is
   * most of the difference between a tab that survives an eight-hour shift and
   * one that does not.
   */
  isAnimating(now: number): boolean {
    for (const track of this.tracks.values()) {
      if (now - track.startedAt >= track.durationMs) continue;
      if (track.from.x !== track.to.x || track.from.y !== track.to.y
        || track.fromHeading !== track.toHeading) return true;
    }
    return false;
  }

  clear(): void {
    this.tracks.clear();
  }

  get size(): number {
    return this.tracks.size;
  }
}
