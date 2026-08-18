'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Blocks closing by overlay click or Escape. Use only where losing input
   *  would cost the operator real work. */
  dismissible?: boolean;
}

const widths = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

export function Modal({
  open, onOpenChange, title, description, children, footer, size = 'md', dismissible = true,
}: ModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/60 animate-in-fast"
        />
        <DialogPrimitive.Content
          onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
          onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)]',
            '-translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-md border border-border bg-overlay shadow-(--shadow-overlay) animate-in-fast',
            widths[size],
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold text-text-primary">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-xs text-text-secondary">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            {dismissible ? (
              <DialogPrimitive.Close
                aria-label="Close"
                className="shrink-0 rounded-xs p-1 text-text-tertiary hover:bg-hover hover:text-text-primary"
              >
                <X className="size-4" aria-hidden />
              </DialogPrimitive.Close>
            ) : null}
          </div>

          {children ? <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div> : null}

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
