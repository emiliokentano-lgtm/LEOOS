'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';
import { Badge } from './badge';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex h-8 items-center gap-0.5 border-b border-border-subtle', className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className, children, count, ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { count?: number }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium',
        'text-text-tertiary transition-colors duration-(--duration-fast)',
        'hover:text-text-secondary',
        'data-[state=active]:text-text-primary',
        // Active marker: a 2px underline rather than a filled pill — quieter and
        // it does not shift the row height.
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent',
        'data-[state=active]:after:bg-accent',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
      {typeof count === 'number' ? (
        <Badge size="sm" variant="neutral" mono>{count}</Badge>
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('min-h-0 flex-1 outline-none', className)} {...props} />;
}
