'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip';

const iconButtonVariants = cva(
  cn(
    'inline-flex items-center justify-center rounded-xs shrink-0',
    'transition-colors duration-(--duration-fast)',
    'disabled:pointer-events-none disabled:opacity-40',
  ),
  {
    variants: {
      variant: {
        ghost: 'text-text-secondary hover:bg-hover hover:text-text-primary',
        secondary: 'bg-raised border border-border text-text-primary hover:bg-hover',
        danger: 'text-danger hover:bg-danger/10',
      },
      size: {
        xs: 'size-6 [&_svg]:size-3.5',
        sm: 'size-7 [&_svg]:size-4',
        md: 'size-8 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  /** Required: an icon-only control must always have an accessible name. */
  label: string;
  /** Show the label in a tooltip on hover/focus. Defaults to true — nothing
   *  important should be discoverable only by guessing an icon. */
  tooltip?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, variant, size, label, tooltip = true, children, ...props }, ref) {
    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </button>
    );
    return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
  },
);
