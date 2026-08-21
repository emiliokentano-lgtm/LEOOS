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

  /**
   * No membership is not automatically a dead end.
   *
   * A verified account with no membership is expected — registration grants
   * nothing — and the holding screen is the right answer for them. But a GLOBAL
   * ADMINISTRATOR legitimately has no membership: administration is not
   * organization-scoped, and a fresh installation's first administrator has
   * nowhere to be a member of yet. Sending them to the holding screen would make
   * the administration panel unreachable on exactly the installation that needs
   * it most, which is a bootstrapping trap rather than a guard.
   *
   * So the shell renders without an organization for them, and the
   * organization-scoped screens each refuse on their own terms.
   */
  const held = new Set(session.globalCapabilities);
  if (!organization && held.size === 0 && !session.isGlobalAdmin) {
    redirect('/no-organization');
  }

  /**
   * Two routes to an item, because there are two kinds of authority.
   *
   * An organization permission reveals the operational screens; a global
   * capability reveals the administration ones. An account administrator holds
   * `user_admin` and no organization permission at all, so filtering on
   * permissions alone would hide the account register from the one person who
   * exists to use it — while a `null` permission plus a capability list keeps a
   * screen like `/admin/system` hidden from everybody but a global admin.
   */
  const sections: NavSection[] = NAVIGATION
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.capabilities?.some((c) => held.has(c))) return true;
        if (item.permission === null) return item.capabilities === undefined;
        return hasPermission(session, item.permission);
      }),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <AppShell
      sections={sections}
      session={session}
      organization={organization ?? null}
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
