'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input';

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Keyboard hint rendered on the right when the field is empty. */
  shortcut?: string;
  inputSize?: 'sm' | 'md';
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    { value, onValueChange, shortcut, placeholder = 'Search…', className, inputSize, ...props },
    ref,
  ) {
    return (
      <Input
        ref={ref}
        type="search"
        role="searchbox"
        value={value}
        placeholder={placeholder}
        inputSize={inputSize}
        onChange={(e) => onValueChange(e.target.value)}
        icon={<Search aria-hidden />}
        className={cn('[&::-webkit-search-cancel-button]:hidden', className)}
        trailing={
          value ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onValueChange('')}
              className="rounded-xs p-0.5 text-text-tertiary hover:text-text-primary"
            >
              <X aria-hidden />
            </button>
          ) : shortcut ? (
            <kbd className="rounded-xs border border-border bg-raised px-1 font-mono text-2xs text-text-tertiary">
              {shortcut}
            </kbd>
          ) : null
        }
        {...props}
      />
    );
  },
);
