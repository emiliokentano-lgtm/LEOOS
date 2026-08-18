'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { OrganizationSummary } from '@leoos/contracts';
import { cn } from '@/lib/utils';
import type { NavSection } from '@/lib/navigation';
import { Icon } from '@/components/icon';
import { Tooltip } from '@/components/ui';
import { OrgSwitcher } from './org-switcher';
import { UserCard } from './user-card';
import type { Session } from '@/lib/session';

const COLLAPSE_EVENT = 'leoos:sidebar-collapse';
const STORAGE_KEY = 'leoos.sidebar.collapsed';

/**
 * Reads the operator's collapsed preference from localStorage.
 *
 * `useSyncExternalStore` rather than an effect: it gives a defined server
 * snapshot (expanded), so there is no hydration mismatch and no post-mount state
 * update that would flash the sidebar open then closed.
 */
function useCollapsedPreference(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      window.addEventListener(COLLAPSE_EVENT, onChange);
      window.addEventListener('storage', onChange);
      return () => {
        window.removeEventListener(COLLAPSE_EVENT, onChange);
        window.removeEventListener('storage', onChange);
      };
    },
    () => window.localStorage.getItem(STORAGE_KEY) === '1',
    () => false,
  );
}

/**
 * Persistent left navigation.
 *
 * `sections` arrives already filtered by permission on the SERVER — this
 * component never sees an item the user cannot access, so nothing is hidden by
 * CSS and nothing leaks into the HTML payload.
 */
export function Sidebar({
  sections, session, organization, organizations,
}: {
  sections: NavSection[];
  session: Session;
  organization: OrganizationSummary;
  organizations: OrganizationSummary[];
}) {
  const pathname = usePathname();
  const collapsed = useCollapsedPreference();

  function toggle() {
    window.localStorage.setItem('leoos.sidebar.collapsed', collapsed ? '0' : '1');
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        'flex shrink-0 flex-col border-r border-border-subtle bg-surface',
        'transition-[width] duration-(--duration-base) ease-(--ease-out)',
        collapsed ? 'w-(--spacing-sidebar-collapsed)' : 'w-(--spacing-sidebar)',
      )}
    >
      {/* Brand + organization identity */}
      <div className="flex h-(--spacing-topbar) shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <div
          className="flex size-6 shrink-0 items-center justify-center rounded-xs font-mono text-2xs font-bold"
          style={{ backgroundColor: organization.color, color: '#0b0e14' }}
          aria-hidden
        >
          {organization.shortName.slice(0, 2)}
        </div>
        {!collapsed ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold leading-tight text-text-primary">LEOOS</p>
            <p className="truncate text-2xs leading-tight text-text-tertiary">
              {organization.shortName}
            </p>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="border-b border-border-subtle p-2">
          <OrgSwitcher active={organization} organizations={organizations} />
        </div>
      ) : null}

      {/* Navigation */}
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Main navigation">
        {sections.map((section) => (
          <div key={section.id} className="mb-3 last:mb-0">
            {section.label && !collapsed ? (
              <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-text-disabled">
                {section.label}
              </p>
            ) : null}
            {section.label && collapsed ? (
              <div className="mx-2 mb-2 border-t border-border-subtle" aria-hidden />
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const link = (
                  <Link
                    href={item.href as never}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex h-7 items-center gap-2.5 rounded-xs px-2',
                      'text-xs transition-colors duration-(--duration-fast)',
                      active
                        ? 'bg-active text-text-primary'
                        : 'text-text-secondary hover:bg-hover hover:text-text-primary',
                      collapsed && 'justify-center px-0',
                    )}
                  >
                    {/* Active marker: a 2px bar, not a coloured pill. */}
                    {active ? (
                      <span
                        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent"
                        aria-hidden
                      />
                    ) : null}
                    <Icon
                      name={item.icon}
                      className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-text-tertiary')}
                    />
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                  </Link>
                );

                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip content={item.label} side="right" shortcut={item.shortcut}>
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Current user, rank, operational status */}
      <div className="shrink-0 border-t border-border-subtle p-2">
        <UserCard session={session} organization={organization} collapsed={collapsed} />
      </div>

      <div className="shrink-0 border-t border-border-subtle p-1">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className={cn(
            'flex h-7 w-full items-center gap-2 rounded-xs px-2 text-2xs',
            'text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden />
          ) : (
            <>
              <PanelLeftClose className="size-4" aria-hidden />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
