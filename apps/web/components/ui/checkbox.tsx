'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps
  extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  label?: string;
  description?: string;
}

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(function Checkbox({ className, label, description, id, ...props }, ref) {
  const generated = React.useId();
  const inputId = id ?? generated;

  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={inputId}
      className={cn(
        'peer size-4 shrink-0 rounded-xs border border-border-strong bg-raised',
        'transition-colors duration-(--duration-fast)',
        'hover:border-accent',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-white">
        {props.checked === 'indeterminate'
          ? <Minus className="size-3" aria-hidden />
          : <Check className="size-3" aria-hidden />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );

  if (!label) return box;
  return (
    <div className="flex items-start gap-2">
      {box}
      <div className="flex flex-col gap-0.5">
        <label htmlFor={inputId} className="cursor-pointer text-sm leading-4 text-text-primary">
          {label}
        </label>
        {description ? <p className="text-xs text-text-tertiary">{description}</p> : null}
      </div>
    </div>
  );
});
