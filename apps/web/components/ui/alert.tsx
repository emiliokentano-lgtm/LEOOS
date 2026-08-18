'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger' | 'critical';

const tones: Record<AlertTone, { border: string; bg: string; fg: string; Icon: React.ElementType }> = {
  info: { border: 'border-info/30', bg: 'bg-info/8', fg: 'text-info', Icon: Info },
  success: { border: 'border-success/30', bg: 'bg-success/8', fg: 'text-success', Icon: CheckCircle2 },
  warning: { border: 'border-warning/30', bg: 'bg-warning/8', fg: 'text-warning', Icon: AlertTriangle },
  danger: { border: 'border-danger/30', bg: 'bg-danger/8', fg: 'text-danger', Icon: AlertTriangle },
  critical: { border: 'border-status-panic/50', bg: 'bg-status-panic/12', fg: 'text-status-panic', Icon: ShieldAlert },
};

export interface AlertProps {
  tone?: AlertTone;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function Alert({ tone = 'info', title, children, action, onDismiss, className }: AlertProps) {
  const t = tones[tone];
  const Icon = t.Icon;
  return (
    <div
      role={tone === 'danger' || tone === 'critical' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2',
        t.border, t.bg,
        tone === 'critical' && 'animate-panic',
        className,
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', t.fg)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-medium', t.fg)}>{title}</p>
        {children ? <div className="mt-0.5 text-xs text-text-secondary">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-xs p-0.5 text-text-tertiary hover:text-text-primary"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
