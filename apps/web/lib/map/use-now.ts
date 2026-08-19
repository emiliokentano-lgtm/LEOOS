'use client';

import * as React from 'react';

/**
 * A clock that ticks.
 *
 * Staleness is a function of TIME, not of data: a unit that stopped reporting
 * gets more stale every second precisely because nothing is arriving. Reading
 * `Date.now()` during render computes staleness once and then never again —
 * so the case the indicator exists for, a feed that has died, is exactly the
 * case where it would silently keep saying "2s ago" forever.
 *
 * Implemented with `useSyncExternalStore` rather than `useState` + an effect,
 * because it is a subscription to something outside React and that is what the
 * hook is for. One interval per subscribing tree, shared.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = Date.now();

/** One second: the finest granularity anything in the UI displays. */
const TICK_MS = 1_000;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      snapshot = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return snapshot;
}

/**
 * The server snapshot is a fixed value.
 *
 * Server-rendered markup must not depend on the server's clock, or the first
 * client render disagrees with it and React discards the whole tree. Zero makes
 * every age render as "unknown" for one frame, which is correct: on the server
 * we genuinely do not know how old the client's view will be.
 */
function getServerSnapshot(): number {
  return 0;
}

export function useNow(): number {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
