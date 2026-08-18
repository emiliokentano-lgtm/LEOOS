'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  side?: 'right' | 'left';
  width?: 'sm' | 'md' | 'lg';
}

const widths = { sm: 'w-[320px]', md: 'w-[420px]', lg: 'w-[560px]' } as const;

export function Drawer({
  open, onOpenChange, title, description, children, footer, side = 'right', width = 'md',
}: DrawerProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 animate-in-fast" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 z-50 flex max-w-[calc(100vw-2rem)] flex-col bg-surface',
            'shadow-(--shadow-overlay) animate-drawer',
            side === 'right' ? 'right-0 border-l border-border' : 'left-0 border-r border-border',
            widths[width],
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-semibold text-text-primary">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-xs text-text-secondary">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="shrink-0 rounded-xs p-1 text-text-tertiary hover:bg-hover hover:text-text-primary"
            >
              <X className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          {footer ? (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
