'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Toast notifications.
 *
 * Hand-rolled rather than pulling a toast library: the surface is ~90 lines, and
 * an operations console needs behaviour a generic library does not give us —
 * critical toasts that never auto-dismiss, and a live region so alerts are
 * announced (engineering rule 29, avoid unnecessary dependencies).
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** ms; `null` means it stays until dismissed. Danger toasts default to null —
   *  an operator must not miss a failure because they looked away. */
  duration?: number | null;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = React.useCallback((toast: Omit<Toast, 'id'>) => {
    const id = crypto.randomUUID();
    const duration = toast.duration === undefined
      ? (toast.tone === 'danger' ? null : 5000)
      : toast.duration;
    setToasts((prev) => [...prev, { ...toast, id, duration }]);
    if (duration !== null) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  }, [dismiss]);

  // Clear pending timers on unmount so a dismissed provider cannot fire later.
  React.useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);

  const value = React.useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const toneStyles: Record<ToastTone, { fg: string; border: string; Icon: React.ElementType }> = {
  info: { fg: 'text-info', border: 'border-l-info', Icon: Info },
  success: { fg: 'text-success', border: 'border-l-success', Icon: CheckCircle2 },
  warning: { fg: 'text-warning', border: 'border-l-warning', Icon: AlertTriangle },
  danger: { fg: 'text-danger', border: 'border-l-danger', Icon: AlertTriangle },
};

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-9 right-3 z-100 flex w-[340px] max-w-[calc(100vw-1.5rem)] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const t = toneStyles[toast.tone];
        const Icon = t.Icon;
        return (
          <div
            key={toast.id}
            role={toast.tone === 'danger' ? 'alert' : 'status'}
            aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-xs border border-l-2 border-border',
              'bg-overlay px-3 py-2.5 shadow-(--shadow-overlay) animate-in-fast',
              t.border,
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', t.fg)} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 text-xs text-text-secondary">{toast.description}</p>
              ) : null}
              {toast.action ? (
                <button
                  type="button"
                  onClick={() => { toast.action?.onClick(); onDismiss(toast.id); }}
                  className="mt-1.5 text-xs font-medium text-accent hover:underline"
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded-xs p-0.5 text-text-tertiary hover:text-text-primary"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
