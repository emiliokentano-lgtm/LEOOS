import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/app-shell';
import { NAVIGATION, type NavSection } from '@/lib/navigation';
import { getSessionOrNull, hasPermission } from '@/lib/session';

/**
 * Authenticated shell layout.
 *
 * Navigation is filtered HERE — on the server — so items the user cannot access
 * are never sent to the browser. The client shell receives an already-filtered
 * list and has no ability to reveal more (engineering rule 9: the frontend is
 * never the authorization boundary, and it should not even hold the full map of
 * what exists).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The real guard. Middleware only checks that a cookie exists; this is where
  // the session is actually validated, by the API.
  const session = await getSessionOrNull();
  // NOT `/login`: the middleware would bounce a caller who still holds a stale
  // cookie straight back here, and the two would redirect at each other until
  // the browser gave up. `/api/session/expired` clears the cookie first — see
  // the note there.
  // The cast is because typed routes only enumerate PAGE routes; this is a
  // Route Handler, which is the only thing that can clear a cookie.
  if (!session) redirect('/api/session/expired' as Route);

  const organizations = session.memberships.map((m) => m.organization);
  const organization = organizations.find((o) => o.id === session.organizationId);

  // A verified account with no membership is expected — registration grants
  // nothing. Send them to the holding screen rather than an empty shell.
  if (!organization) redirect('/no-organization');

  const sections: NavSection[] = NAVIGATION
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => item.permission === null || hasPermission(session, item.permission),
      ),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <AppShell
      sections={sections}
      session={session}
      organization={organization}
      organizations={organizations}
      authState={{
        userId: session.userId,
        username: session.username,
        displayName: session.displayName,
        email: session.email,
        memberships: session.memberships,
        activeOrganizationId: session.organizationId,
        isGlobalAdmin: session.isGlobalAdmin,
        globalCapabilities: session.globalCapabilities,
        permissionVersion: session.permissionVersion,
      }}
    >
      {children}
    </AppShell>
  );
}
