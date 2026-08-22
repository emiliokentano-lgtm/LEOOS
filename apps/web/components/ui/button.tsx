'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xs',
    'font-medium transition-colors duration-(--duration-fast)',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    /**
     * An EXPLICIT focus ring, offset from the control.
     *
     * There was none: the button relied on the browser default, which the base
     * layer's reset suppresses, so tabbing through a dialog moved an invisible
     * cursor. Offset rather than inset so it reads on a filled button as well
     * as an outlined one, and `focus-visible` rather than `focus` so a mouse
     * click does not leave a ring behind.
     */
    'outline-none focus-visible:[outline-style:solid] focus-visible:outline-2',
    'focus-visible:outline-offset-2 focus-visible:outline-accent',
  ),
  {
    variants: {
      variant: {
        /**
         * `accent-solid`, not `accent`. White on the lighter accent measured
         * 3.31:1 — on the single control every operator presses most. The solid
         * fill carries white at 4.73:1, and hover DARKENS rather than fading:
         * lowering the fill's opacity would have walked the contrast back down
         * exactly when the pointer is on it.
         */
        primary:
          'bg-accent-solid text-white hover:bg-accent-solid/90 hover:brightness-110 '
          + 'active:brightness-95',
        secondary:
          'bg-raised text-text-primary border border-border hover:bg-hover hover:border-border-strong',
        ghost: 'text-text-secondary hover:bg-hover hover:text-text-primary',
        danger:
          'bg-danger-solid text-white hover:brightness-110 active:brightness-95',
        /** For destructive actions that need weight without shouting. */
        'danger-outline':
          'border border-danger/50 text-danger hover:bg-danger/10 hover:border-danger',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 text-2xs [&_svg]:size-3',
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-sm [&_svg]:size-4',
        lg: 'h-9 px-4 text-base [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, children, disabled, ...props },
  ref,
) {
  if (asChild) {
    // Slot forwards props onto a single child element, so it cannot accept the
    // spinner as a sibling. `asChild` is for wrapping links; a link does not have
    // a loading state, so this is not a lost capability.
    return (
      <Slot
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export { buttonVariants };
