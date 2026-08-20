import {
  UNIT_OFFLINE_AFTER_MS, UNIT_STALE_AFTER_MS, freshnessOf,
  type LocationFreshness, type MapSnapshot, type MapTick, type MapUnit, type UnitLocation,
} from '@leoos/contracts';

/**
 * The live map's state, split by HOW OFTEN EACH PART CHANGES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * Positions arrive once a second. Callsigns, crews, vehicles, organizations and
 * assignments do not — they change a handful of times a shift. Holding both in
 * one piece of React state means every position sample re-renders the entire
 * screen: 150 unit rows, the filter bar, the detail panel, all of it, every
 * second, to move some pixels on a canvas that was going to repaint anyway.
 *
 * So they are separated:
 *
 *   ROSTER      who exists and what they are. React state. Changes rarely.
 *   POSITIONS   where they are. NOT React state. Changes at 1 Hz.
 *   FRESHNESS   whether a position can still be trusted. Derived, and published
 *               only when a unit crosses a THRESHOLD — live→stale→offline — not
 *               on every sample.
 *
 * The canvas reads positions directly inside its own animation frame, which is
 * the only place they are needed sixty times a second. React never sees them
 * unless a component asks for one specific unit (the detail panel does; the list
 * deliberately does not).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * IMMUTABLE, NOT MUTATED IN PLACE. Positions live in their own map rather than
 * being written onto the `MapUnit` objects React is rendering from. Mutating
 * those would make a memoised child comparing `prev.unit === next.unit` never
 * update — the classic version of this optimisation that silently breaks a
 * screen months later.
 */

export interface RosterSnapshot {
  /** Bumped when something a rendering component cares about changed. */
  version: number;
  units: MapUnit[];
  /** Current level per unit id. Only ever changes at a threshold crossing. */
  freshness: ReadonlyMap<string, LocationFreshness>;
}

type Listener = () => void;

export class MapUnitStore {
  private roster: MapUnit[] = [];
  private readonly positions = new Map<string, UnitLocation>();
  private freshness = new Map<string, LocationFreshness>();

  private version = 0;
  private snapshot: RosterSnapshot = { version: 0, units: [], freshness: new Map() };

  private readonly rosterListeners = new Set<Listener>();
  private readonly positionListeners = new Set<Listener>();

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly staleAfterMs = UNIT_STALE_AFTER_MS,
    private readonly offlineAfterMs = UNIT_OFFLINE_AFTER_MS,
  ) {}

  // ── React-facing: the roster ─────────────────────────────────────────────

  readonly subscribeRoster = (listener: Listener): (() => void) => {
    this.rosterListeners.add(listener);
    this.startSweep();
    return () => {
      this.rosterListeners.delete(listener);
      if (this.rosterListeners.size === 0) this.stopSweep();
    };
  };

  /**
   * Stable between roster changes.
   *
   * `useSyncExternalStore` calls this on every render and compares by identity,
   * so returning a fresh object each time would defeat the whole design — it
   * would re-render exactly as often as rebuilding the array did.
   */
  readonly getRosterSnapshot = (): RosterSnapshot => this.snapshot;

  /** Server rendering has no store; an empty roster is the honest answer. */
  readonly getServerSnapshot = (): RosterSnapshot => EMPTY_SNAPSHOT;

  // ── Canvas-facing: positions ─────────────────────────────────────────────

  /**
   * Fires on every position batch.
   *
   * NOT a React subscription. The canvas uses it to schedule an animation frame;
   * routing it through React state would be a render per second to move pixels
   * the canvas draws itself.
   */
  readonly subscribePositions = (listener: Listener): (() => void) => {
    this.positionListeners.add(listener);
    return () => { this.positionListeners.delete(listener); };
  };

  /**
   * The live position, falling back to whatever the last snapshot carried.
   *
   * The fallback matters on a cold load: the snapshot's `unit.pos_*` values come
   * from the database cache, which is what renders before the first live batch
   * arrives. Without it the map would be blank for a second on every page load.
   */
  positionOf(unitId: string): UnitLocation | null {
    const live = this.positions.get(unitId);
    if (live !== undefined) return live;
    return this.roster.find((u) => u.id === unitId)?.location ?? null;
  }

  /** Units with their CURRENT positions merged in. For the draw loop only. */
  livingUnits(): MapUnit[] {
    return this.roster.map((unit) => {
      const live = this.positions.get(unit.id);
      return live === undefined ? unit : { ...unit, location: live };
    });
  }

  freshnessOfUnit(unitId: string): LocationFreshness {
    return this.freshness.get(unitId) ?? 'unknown';
  }

  // ── Ingest ───────────────────────────────────────────────────────────────

  applySnapshot(snapshot: MapSnapshot, now = Date.now()): void {
    this.roster = snapshot.units;

    /**
     * Positions are REPLACED, not merged.
     *
     * A snapshot is the authoritative answer to "what may this caller see". A
     * unit that has left the roster — disbanded, gone covert, its organization
     * stopped sharing — must lose its position too, and merging would leave a
     * marker on the map for a unit the server just said is not there.
     */
    this.positions.clear();
    for (const unit of snapshot.units) {
      if (unit.location !== null) this.positions.set(unit.id, unit.location);
    }

    this.recomputeFreshness(now);
    this.publishRoster();
    this.publishPositions();
  }

  /**
   * A position batch.
   *
   * Deliberately does NOT publish to React. It updates the position map, tells
   * the canvas, and leaves the roster snapshot alone — which is the entire point
   * of the split.
   */
  applyTick(tick: MapTick, now = Date.now()): void {
    /**
     * A delta can carry a STATUS CHANGE, and that is a roster fact.
     *
     * The HTTP tick reports each unit's current `statusKey`, so a unit going to
     * panic is visible from the position feed alone — which matters, because it
     * is the one status change nobody should have to wait a refetch for. It is
     * published to React rather than kept in the position map: a status is what
     * the list, the filters and the detail panel all render from.
     *
     * The socket path carries a cached status instead, and real status changes
     * arrive there as `unit.status.updated` — so this is not the only route, and
     * neither route is the only route.
     */
    let rosterChanged = false;

    for (const delta of tick.positions) {
      // `organizationId` comes from the ROSTER, never from the delta — a
      // position update has no business restating which agency a unit belongs
      // to, and a tick that disagreed with the roster would be a tick that could
      // move a unit between organizations.
      const organizationId = this.roster.find((u) => u.id === delta.unitId)?.organization.id
        ?? this.positions.get(delta.unitId)?.organizationId
        ?? '';

      this.positions.set(delta.unitId, {
        unitId: delta.unitId,
        organizationId,
        x: delta.x,
        y: delta.y,
        z: null,
        heading: delta.heading,
        speed: delta.speed,
        updatedAt: delta.updatedAt,
      });
    }

    for (const delta of tick.positions) {
      const index = this.roster.findIndex((u) => u.id === delta.unitId);
      if (index < 0) continue;

      const unit = this.roster[index]!;
      const statusMoved = unit.status.key !== delta.statusKey;
      const releasedFromCall = delta.incidentId === null && unit.incident !== null;
      if (!statusMoved && !releasedFromCall) continue;

      // A NEW array and a NEW object, so a memoised row actually re-renders.
      // This is the mirror of the position path's promise never to mutate.
      this.roster = [...this.roster];
      this.roster[index] = {
        ...unit,
        status: statusMoved ? { ...unit.status, key: delta.statusKey } : unit.status,
        incident: delta.incidentId === null ? null : unit.incident,
      };
      rosterChanged = true;
    }

    for (const unitId of tick.removed) this.positions.delete(unitId);

    /**
     * A removal is NOT a roster change.
     *
     * The unit is still on the board and still in the list; we have simply
     * stopped being told where it is, which is what `offline` means. Dropping it
     * from the roster here would delete history the operator may still need —
     * "where was this unit last seen" is a question asked after the fact.
     */
    if (tick.removed.length > 0 && this.recomputeFreshness(now)) rosterChanged = true;

    if (rosterChanged) {
      this.recomputeFreshness(now);
      this.publishRoster();
    }
    this.publishPositions();
  }

  // ── Freshness ────────────────────────────────────────────────────────────

  /**
   * Recomputes levels, publishing ONLY if one actually crossed a threshold.
   *
   * This is what keeps a ticking clock from being a render loop. A unit's age
   * changes every second; its LEVEL changes twice in its whole life, so that is
   * what React is told about.
   */
  sweepFreshness(now = Date.now()): boolean {
    const changed = this.recomputeFreshness(now);
    if (changed) this.publishRoster();
    return changed;
  }

  private recomputeFreshness(now: number): boolean {
    const next = new Map<string, LocationFreshness>();
    let changed = this.freshness.size !== this.roster.length;

    for (const unit of this.roster) {
      const level = freshnessOf(
        this.positions.get(unit.id) ?? unit.location,
        now,
        this.staleAfterMs,
        this.offlineAfterMs,
      );
      next.set(unit.id, level);
      if (this.freshness.get(unit.id) !== level) changed = true;
    }

    if (changed) this.freshness = next;
    return changed;
  }

  private startSweep(): void {
    if (this.sweepTimer !== null) return;
    // One second: the finest granularity any threshold is expressed in, and the
    // longest a unit should linger at the wrong level.
    this.sweepTimer = setInterval(() => this.sweepFreshness(), 1_000);
  }

  private stopSweep(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // ── Publication ──────────────────────────────────────────────────────────

  private publishRoster(): void {
    this.version += 1;
    this.snapshot = {
      version: this.version,
      units: this.roster,
      freshness: this.freshness,
    };
    for (const listener of this.rosterListeners) listener();
  }

  private publishPositions(): void {
    for (const listener of this.positionListeners) listener();
  }

  /** Releases the sweep timer. Called when the screen unmounts. */
  dispose(): void {
    this.stopSweep();
    this.rosterListeners.clear();
    this.positionListeners.clear();
  }
}

const EMPTY_SNAPSHOT: RosterSnapshot = { version: 0, units: [], freshness: new Map() };
