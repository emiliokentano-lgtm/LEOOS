'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Keyboard shortcut shown on the right of the tooltip. */
  shortcut?: string;
  delayDuration?: number;
}

export function Tooltip({
  content, children, side = 'top', shortcut, delayDuration = 400,
}: TooltipProps) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 flex items-center gap-2 rounded-xs border border-border bg-overlay',
            'px-2 py-1 text-xs text-text-primary shadow-(--shadow-overlay)',
            'animate-in-fast max-w-xs',
          )}
        >
          {content}
          {shortcut ? (
            <kbd className="rounded-xs border border-border bg-raised px-1 font-mono text-2xs text-text-tertiary">
              {shortcut}
            </kbd>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
