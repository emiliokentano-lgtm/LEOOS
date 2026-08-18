'use client';

import * as React from 'react';
import type { DutyStatusKey } from '@leoos/contracts';

/**
 * Holds the operator's current duty status for the shell.
 *
 * UI-local state only, for this phase. From Phase 5 the setter calls the API and
 * the value arrives back over the WebSocket — the consumer contract stays the
 * same, so the sidebar, top bar and status bar do not change.
 *
 * This is NOT an authorization boundary and it is NOT authoritative: the server
 * owns duty status.
 */

interface DutyStatusContextValue {
  status: DutyStatusKey;
  setStatus: (status: DutyStatusKey) => void;
  panic: boolean;
  triggerPanic: () => void;
  clearPanic: () => void;
}

const DutyStatusContext = React.createContext<DutyStatusContextValue | null>(null);

export function useDutyStatus(): DutyStatusContextValue {
  const ctx = React.useContext(DutyStatusContext);
  if (!ctx) throw new Error('useDutyStatus must be used inside <DutyStatusProvider>');
  return ctx;
}

export function DutyStatusProvider({
  initialStatus = 'available',
  children,
}: {
  initialStatus?: DutyStatusKey;
  children: React.ReactNode;
}) {
  const [status, setStatusInternal] = React.useState<DutyStatusKey>(initialStatus);
  const [previous, setPrevious] = React.useState<DutyStatusKey>(initialStatus);

  const setStatus = React.useCallback((next: DutyStatusKey) => {
    setStatusInternal((current) => {
      if (current !== 'panic') setPrevious(current);
      return next;
    });
  }, []);

  const triggerPanic = React.useCallback(() => {
    setStatusInternal((current) => {
      if (current !== 'panic') setPrevious(current);
      return 'panic';
    });
  }, []);

  const clearPanic = React.useCallback(() => {
    setStatusInternal(previous === 'panic' ? 'available' : previous);
  }, [previous]);

  const value = React.useMemo(
    () => ({ status, setStatus, panic: status === 'panic', triggerPanic, clearPanic }),
    [status, setStatus, triggerPanic, clearPanic],
  );

  return <DutyStatusContext.Provider value={value}>{children}</DutyStatusContext.Provider>;
}
