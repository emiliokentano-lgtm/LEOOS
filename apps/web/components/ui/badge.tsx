'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  cn(
    'inline-flex items-center gap-1 rounded-xs border font-medium whitespace-nowrap',
    '[&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        neutral: 'border-border bg-raised text-text-secondary',
        outline: 'border-border-strong bg-transparent text-text-secondary',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        danger: 'border-danger/30 bg-danger/10 text-danger',
        info: 'border-info/30 bg-info/10 text-info',
        accent: 'border-accent/30 bg-accent/10 text-accent',
      },
      size: {
        sm: 'h-4 px-1 text-2xs [&_svg]:size-2.5',
        md: 'h-5 px-1.5 text-2xs [&_svg]:size-3',
      },
      mono: { true: 'font-mono tracking-tight', false: '' },
    },
    defaultVariants: { variant: 'neutral', size: 'md', mono: false },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, mono, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size, mono }), className)} {...props} />;
}

export { badgeVariants };
