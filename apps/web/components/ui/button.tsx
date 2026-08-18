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
  ),
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/85 active:bg-accent/75',
        secondary:
          'bg-raised text-text-primary border border-border hover:bg-hover hover:border-border-strong',
        ghost: 'text-text-secondary hover:bg-hover hover:text-text-primary',
        danger: 'bg-danger text-white hover:bg-danger-strong active:bg-danger',
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
