'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  /**
   * Must NOT be the empty string. Radix reserves `''` for "nothing selected",
   * so an option with that value can never be shown as chosen — the trigger
   * falls back to the placeholder instead. Use a sentinel such as `'any'` for a
   * "no filter" choice and map it back at the call site.
   */
  value: string;
  label: string;
  /** Rendered before the label — a status dot, an org badge, an icon. */
  adornment?: React.ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}

export function Select({
  value, onValueChange, options, placeholder = 'Select…',
  disabled, invalid, id, className, size = 'md', ...aria
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={aria['aria-label']}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-xs border border-border bg-raised',
          'px-2.5 text-text-primary transition-colors duration-(--duration-fast)',
          'hover:border-border-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-danger',
          'data-[placeholder]:text-text-tertiary',
          size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3.5 text-text-tertiary" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-50 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden',
            'rounded-xs border border-border bg-overlay shadow-(--shadow-overlay) animate-in-fast',
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={cn(
                  'relative flex cursor-default select-none items-center gap-2 rounded-xs',
                  'py-1.5 pl-7 pr-2 text-sm text-text-primary outline-none',
                  'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
                )}
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 flex">
                  <Check className="size-3.5 text-accent" aria-hidden />
                </SelectPrimitive.ItemIndicator>
                {opt.adornment}
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
