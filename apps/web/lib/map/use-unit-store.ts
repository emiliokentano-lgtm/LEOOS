'use client';

import * as React from 'react';
import type { LocationFreshness, MapUnit, UnitLocation } from '@leoos/contracts';
import type { MapUnitStore, RosterSnapshot } from './unit-store';

/**
 * React's view of the unit store.
 *
 * Three hooks, at three deliberately different granularities:
 *
 *   `useRoster`        who exists. Re-renders when the roster or a freshness
 *                      LEVEL changes — a few times a shift, not once a second.
 *   `useUnitPosition`  one unit's live position. Re-renders that component at
 *                      1 Hz, which is right for a detail panel showing
 *                      coordinates and wrong for a list of 150 rows.
 *   `usePositionTicks` a bare notification with no data, for a component that
 *                      needs to know something moved without needing what.
 *
 * The list uses the first. The detail panel uses the second. The canvas uses
 * none of them — it subscribes to the store directly, because a render is
 * exactly what it does not want.
 */

export function useRoster(store: MapUnitStore): RosterSnapshot {
  return React.useSyncExternalStore(
    store.subscribeRoster,
    store.getRosterSnapshot,
    store.getServerSnapshot,
  );
}

/**
 * One unit's live position.
 *
 * Returns a NEW object only when the position actually differs, so a component
 * holding it in a dependency array is not woken by an identical sample. The
 * feed sends a unit only when it has moved, but a resync or a snapshot can
 * legitimately redeliver the same coordinates.
 */
export function useUnitPosition(
  store: MapUnitStore,
  unitId: string | null,
): UnitLocation | null {
  const cache = React.useRef<UnitLocation | null>(null);

  const getSnapshot = React.useCallback(() => {
    if (unitId === null) return null;
    const next = store.positionOf(unitId);
    const previous = cache.current;

    if (
      next !== null && previous !== null
      && next.x === previous.x && next.y === previous.y
      && next.heading === previous.heading
      && next.updatedAt === previous.updatedAt
    ) {
      // Identical: hand back the SAME object so `useSyncExternalStore` sees no
      // change and skips the render.
      return previous;
    }

    cache.current = next;
    return next;
  }, [store, unitId]);

  return React.useSyncExternalStore(
    store.subscribePositions,
    getSnapshot,
    () => null,
  );
}

/** Freshness for one unit, without subscribing to every position. */
export function useUnitFreshness(
  store: MapUnitStore,
  unitId: string | null,
): LocationFreshness {
  const roster = useRoster(store);
  if (unitId === null) return 'unknown';
  return roster.freshness.get(unitId) ?? 'unknown';
}

/**
 * The units a component should show, filtered and sorted, computed once.
 *
 * Memoised on the roster VERSION rather than on the array, because the array is
 * the same object between roster changes by design and a dependency on it would
 * never invalidate.
 */
export function useFilteredUnits(
  store: MapUnitStore,
  predicate: (unit: MapUnit, freshness: LocationFreshness) => boolean,
  predicateKey: string,
): MapUnit[] {
  const roster = useRoster(store);

  return React.useMemo(
    () => roster.units.filter(
      (unit) => predicate(unit, roster.freshness.get(unit.id) ?? 'unknown'),
    ),
    // `predicateKey` stands in for the predicate's identity: it is rebuilt on
    // every render by design, and depending on it would defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roster.version, predicateKey],
  );
}
