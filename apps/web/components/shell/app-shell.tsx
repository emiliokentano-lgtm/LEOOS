'use client';

import type { OrganizationSummary } from '@leoos/contracts';
import type { NavSection } from '@/lib/navigation';
import type { Session } from '@/lib/session';
import { ToastProvider, TooltipProvider } from '@/components/ui';
import { AuthProvider, type AuthState } from './auth-context';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { StatusBar } from './status-bar';
import { DutyStatusProvider } from './duty-status-context';
import { CommandPaletteProvider } from './command-palette';

/**
 * The global application shell.
 *
 *   ┌──────────┬──────────────────────────────────┐
 *   │          │  TopBar                          │
 *   │ Sidebar  ├──────────────────────────────────┤
 *   │          │  main (scroll container)         │
 *   │          ├──────────────────────────────────┤
 *   │          │  StatusBar                       │
 *   └──────────┴──────────────────────────────────┘
 *
 * The shell owns the only page-level scroll container. Screens fill the height
 * they are given and manage their own internal scrolling, which is what keeps
 * dense tables and the map usable without the whole page moving.
 */
export function AppShell({
  sections, session, organization, organizations, authState, children,
}: {
  sections: NavSection[];
  session: Session;
  organization: OrganizationSummary;
  organizations: OrganizationSummary[];
  /** Cosmetic client-side view of who is signed in — never authoritative. */
  authState: AuthState;
  children: React.ReactNode;
}) {
  return (
    <AuthProvider state={authState}>
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <DutyStatusProvider initialStatus="available">
        <CommandPaletteProvider sections={sections}>
          <ToastProvider>
            <div className="flex h-dvh w-full overflow-hidden bg-base">
              <Sidebar
                sections={sections}
                session={session}
                organization={organization}
                organizations={organizations}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <TopBar />
                <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
                <StatusBar session={session} organization={organization} />
              </div>
            </div>
          </ToastProvider>
        </CommandPaletteProvider>
      </DutyStatusProvider>
    </TooltipProvider>
    </AuthProvider>
  );
}
