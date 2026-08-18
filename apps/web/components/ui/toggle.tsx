'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

export interface ToggleProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: string;
  description?: string;
}

export const Toggle = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  ToggleProps
>(function Toggle({ className, label, description, id, ...props }, ref) {
  const generated = React.useId();
  const inputId = id ?? generated;

  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={inputId}
      className={cn(
        'peer inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-border-strong',
        'bg-raised transition-colors duration-(--duration-fast)',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3 rounded-full bg-text-secondary',
          'transition-transform duration-(--duration-fast)',
          'translate-x-0.5 data-[state=checked]:translate-x-4 data-[state=checked]:bg-white',
        )}
      />
    </SwitchPrimitive.Root>
  );

  if (!label) return control;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={inputId} className="cursor-pointer text-sm text-text-primary">{label}</label>
        {description ? <p className="text-xs text-text-tertiary">{description}</p> : null}
      </div>
      {control}
    </div>
  );
});
