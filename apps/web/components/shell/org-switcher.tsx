'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import {
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { switchOrganizationAction } from '@/lib/auth-actions';

/**
 * Switches the active organization context.
 *
 * Only rendered when the user holds more than one membership. Switching changes
 * the scope of every permission, personnel view and dispatch board — which is why
 * it sits at the top of the sidebar rather than being buried in a settings menu.
 */
export function OrgSwitcher({
  active, organizations,
}: {
  active: OrganizationSummary;
  organizations: OrganizationSummary[];
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();

  function switchTo(id: string) {
    if (id === active.id) return;
    startTransition(async () => {
      await switchOrganizationAction(id);
      // Permissions are re-derived server-side for the new context.
      router.refresh();
    });
  }

  if (organizations.length <= 1) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-xs border border-border-subtle px-2">
        <span className="size-2 shrink-0 rounded-[1px]" style={{ backgroundColor: active.color }} aria-hidden />
        <span className="truncate text-xs text-text-secondary">{active.name}</span>
      </div>
    );
  }

  return (
    <Dropdown>
      <DropdownTrigger
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-xs border border-border bg-raised px-2',
          'text-xs text-text-primary transition-colors hover:border-border-strong hover:bg-hover',
        )}
      >
        <span className="size-2 shrink-0 rounded-[1px]" style={{ backgroundColor: active.color }} aria-hidden />
        <span className="truncate">{active.shortName}</span>
        <ChevronsUpDown className="ml-auto size-3 shrink-0 text-text-tertiary" aria-hidden />
      </DropdownTrigger>
      <DropdownContent align="start" className="w-[220px]">
        <DropdownLabel>Active organization</DropdownLabel>
        <DropdownSeparator />
        {organizations.map((org) => (
          <DropdownItem key={org.id} className="gap-2" onSelect={() => switchTo(org.id)}>
            <span
              className="size-2 shrink-0 rounded-[1px]"
              style={{ backgroundColor: org.color }}
              aria-hidden
            />
            <span className="truncate">{org.name}</span>
            {org.id === active.id ? (
              <Check className="ml-auto size-3.5 shrink-0 text-accent" aria-hidden />
            ) : null}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}
