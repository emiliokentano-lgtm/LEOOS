'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const fieldBase = cn(
  'w-full rounded-xs border border-border bg-raised text-text-primary',
  'placeholder:text-text-tertiary',
  'transition-colors duration-(--duration-fast)',
  'hover:border-border-strong',
  'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger',
);

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Renders a leading icon inside the field. */
  icon?: React.ReactNode;
  /** Trailing adornment — a unit, a clear button, a shortcut hint. */
  trailing?: React.ReactNode;
  invalid?: boolean;
  inputSize?: 'sm' | 'md';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, icon, trailing, invalid, inputSize = 'md', ...props }, ref,
) {
  const sizing = inputSize === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm';
  const field = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase, sizing,
        icon ? 'pl-8' : 'px-2.5',
        trailing ? 'pr-8' : icon ? 'pr-2.5' : undefined,
        className,
      )}
      {...props}
    />
  );
  if (!icon && !trailing) return field;
  return (
    <div className="relative flex items-center">
      {icon ? (
        <span className="pointer-events-none absolute left-2.5 flex text-text-tertiary [&_svg]:size-3.5">
          {icon}
        </span>
      ) : null}
      {field}
      {trailing ? (
        <span className="absolute right-2 flex items-center text-text-tertiary [&_svg]:size-3.5">
          {trailing}
        </span>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(fieldBase, 'min-h-[72px] resize-y px-2.5 py-1.5 text-sm', className)}
        {...props}
      />
    );
  },
);

/** Label + field + hint/error wrapper. Used by every form in the product so that
 *  error placement and spacing never drift between screens. */
export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-text-secondary">
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden>*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}
