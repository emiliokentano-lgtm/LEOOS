'use client';

import * as React from 'react';
import type { DispatchSelfState, OperationalStatusMeta } from '@leoos/contracts';
import {
  resolvePanic, setOwnStatus, triggerPanic as triggerPanicAction,
} from '@/lib/dispatch-actions';
import { useRealtimeRefresh } from '@/lib/realtime/realtime-context';
import { useAuth } from './auth-context';

/**
 * The operator's duty status, for the shell.
 *
 * SERVER STATE, not UI state. This used to hold a local `useState` that every
 * screen read — which was fine while nothing was persisted, and became a
 * parallel truth the moment dispatch shipped (engineering rule 3). A top bar
 * showing "Available" because of a click, while the server and every other
 * operator's board say "Busy", is precisely the failure this system exists to
 * avoid.
 *
 * So: it loads from the API, every mutation goes through the API, and the value
 * is re-read afterwards. Nothing here decides anything — it reflects.
 *
 * It polls slowly, and subscribes to the panic and unit topics for the cases
 * where waiting fifteen seconds is not acceptable — someone else standing down
 * your alert, or a status change made in another tab. Screens that mutate call
 * `refresh()` directly, so the poll is a backstop rather than the mechanism.
 */

interface DutyStatusContextValue {
  /** Null while loading, or when the account has no dispatch access. */
  self: DispatchSelfState | null;
  statuses: OperationalStatusMeta[];
  loading: boolean;
  /** True when the caller has an unresolved panic of their own. */
  panic: boolean;
  /**
   * The catalogue entry for the current status, resolved here rather than by
   * each consumer looking up a hardcoded map. Statuses are database rows
   * (engineering rules 5-7), so an organization's own status has to render the
   * same way the seeded ones do.
   */
  currentStatus: OperationalStatusMeta | null;
  setStatus: (statusKey: string) => Promise<{ ok: boolean; error?: string }>;
  triggerPanic: () => Promise<{ ok: boolean; error?: string }>;
  clearPanic: () => Promise<{ ok: boolean; error?: string }>;
  refresh: () => void;
}

const DutyStatusContext = React.createContext<DutyStatusContextValue | null>(null);

export function useDutyStatus(): DutyStatusContextValue {
  const ctx = React.useContext(DutyStatusContext);
  if (!ctx) throw new Error('useDutyStatus must be used inside <DutyStatusProvider>');
  return ctx;
}

/** Backstop poll. The dispatch screen refreshes far faster on its own. */
const SHELL_POLL_MS = 15_000;

export function DutyStatusProvider({ children }: { children: React.ReactNode }) {
  const [self, setSelf] = React.useState<DispatchSelfState | null>(null);
  const [statuses, setStatuses] = React.useState<OperationalStatusMeta[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [token, setToken] = React.useState(0);

  const refresh = React.useCallback(() => setToken((t) => t + 1), []);
  const auth = useAuth();

  /**
   * The shell watches only what is about the OPERATOR.
   *
   * Panic and unit topics, not incidents: the top bar shows a status, a unit and
   * a panic button, and refetching it every time an unrelated call is updated
   * would put the whole board's event rate onto a request the shell makes on
   * every screen.
   */
  const topics = React.useMemo(() => {
    const orgId = auth.activeOrganizationId;
    if (orgId === null) return [] as string[];
    return [`org:${orgId}:panic`, `org:${orgId}:units`, `org:${orgId}:personnel`];
  }, [auth.activeOrganizationId]);

  useRealtimeRefresh(topics, refresh, {
    interestingTypes: [
      'panic.triggered', 'panic.resolved',
      'unit.status.updated', 'unit.member.joined', 'unit.member.left',
      'personnel.updated',
    ],
  });

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;

    /**
     * `available: false` stops the poll. Everything else keeps it.
     *
     * The route reports "this caller has no dispatch state" as a successful
     * empty answer rather than a 404, because that is what it is — and an
     * account with no membership is exactly what a global administrator is. It
     * is a STABLE fact: it cannot change without a new session, and a new
     * session remounts this provider anyway. Polling it is a request that can
     * never succeed.
     *
     * A transport failure or a 503 keeps polling: those are transient, and
     * giving up on them would leave an operational shell blank after one blip.
     */
    const stopPolling = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };

    const load = () => {
      fetch('/api/dispatch/self', { cache: 'no-store', signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: {
          self: DispatchSelfState;
          statuses: OperationalStatusMeta[];
          available?: boolean;
        } | null) => {
          if (cancelled) return;
          if (data?.available === false) stopPolling();
          setSelf(data?.self ?? null);
          setStatuses(data?.statuses ?? []);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setLoading(false);
        });
    };

    load();
    timer = setInterval(() => {
      // A hidden tab does not poll. Nothing here is urgent enough to burn a
      // request behind someone's back.
      if (document.visibilityState === 'visible') load();
    }, SHELL_POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      stopPolling();
    };
  }, [token]);

  const setStatus = React.useCallback(async (statusKey: string) => {
    const result = await setOwnStatus(statusKey);
    if (result.ok) refresh();
    return result;
  }, [refresh]);

  const trigger = React.useCallback(async () => {
    const result = await triggerPanicAction();
    if (result.ok) refresh();
    return result;
  }, [refresh]);

  const clear = React.useCallback(async () => {
    const panicId = self?.ownPanicId ?? null;
    if (panicId === null) {
      // Nothing to stand down. Reported rather than silently succeeding, because
      // "I pressed clear and nothing happened" is worse than a message.
      return { ok: false, error: 'You have no active panic alert.' };
    }
    const result = await resolvePanic(panicId);
    if (result.ok) refresh();
    return result;
  }, [self?.ownPanicId, refresh]);

  const currentStatus = React.useMemo(
    () => statuses.find((s) => s.key === self?.statusKey) ?? null,
    [statuses, self?.statusKey],
  );

  const value = React.useMemo<DutyStatusContextValue>(() => ({
    self,
    statuses,
    loading,
    currentStatus,
    panic: self?.ownPanicId != null || self?.statusKey === 'panic',
    setStatus,
    triggerPanic: trigger,
    clearPanic: clear,
    refresh,
  }), [self, statuses, loading, currentStatus, setStatus, trigger, clear, refresh]);

  return <DutyStatusContext.Provider value={value}>{children}</DutyStatusContext.Provider>;
}
