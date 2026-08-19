'use client';

import * as React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dropdown = Menu.Root;
export const DropdownTrigger = Menu.Trigger;

/**
 * Menu clicks stop here.
 *
 * The content is rendered through a React portal, and a React portal propagates
 * events along the REACT tree rather than the DOM tree — so a menu opened from
 * inside a clickable table row bubbles its clicks straight into that row's
 * handler. Selecting "Change rank" would open the rank dialog AND the row's
 * detail drawer, and the drawer's overlay would then sit on top of the dialog.
 *
 * A menu's clicks are never meant for whatever is behind it, so this is stopped
 * here for every menu rather than remembered at each call site.
 */
export function DropdownContent({
  className, align = 'end', sideOffset = 4, onClick, ...props
}: React.ComponentPropsWithoutRef<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={sideOffset}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.(event);
        }}
        className={cn(
          'z-50 min-w-[180px] overflow-hidden rounded-xs border border-border bg-overlay p-1',
          'shadow-(--shadow-overlay) animate-in-fast',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownItem({
  className, inset, destructive, shortcut, children, ...props
}: React.ComponentPropsWithoutRef<typeof Menu.Item> & {
  inset?: boolean;
  destructive?: boolean;
  shortcut?: string;
}) {
  return (
    <Menu.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5',
        'text-sm outline-none transition-colors duration-(--duration-fast)',
        'data-[highlighted]:bg-hover',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        destructive ? 'text-danger data-[highlighted]:bg-danger/10' : 'text-text-primary',
        inset && 'pl-7',
        '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-text-tertiary',
        className,
      )}
      {...props}
    >
      {children}
      {shortcut ? (
        <span className="ml-auto pl-4 font-mono text-2xs text-text-tertiary">{shortcut}</span>
      ) : null}
    </Menu.Item>
  );
}

export function DropdownCheckboxItem({
  className, children, ...props
}: React.ComponentPropsWithoutRef<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-xs py-1.5 pl-7 pr-2',
        'text-sm text-text-primary outline-none data-[highlighted]:bg-hover',
        className,
      )}
      {...props}
    >
      <Menu.ItemIndicator className="absolute left-2 flex">
        <Check className="size-3.5 text-accent" aria-hidden />
      </Menu.ItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownLabel({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn(
        'px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-text-tertiary',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownSeparator({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border-subtle', className)} {...props} />;
}

export function DropdownSub({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger
        className={cn(
          'flex cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5',
          'text-sm text-text-primary outline-none data-[highlighted]:bg-hover',
          '[&_svg]:size-3.5 [&_svg]:text-text-tertiary',
        )}
      >
        {label}
        <ChevronRight className="ml-auto" aria-hidden />
      </Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent
          className={cn(
            'z-50 min-w-[160px] rounded-xs border border-border bg-overlay p-1',
            'shadow-(--shadow-overlay) animate-in-fast',
          )}
        >
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}
