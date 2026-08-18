import { AppShell } from '@/components/shell/app-shell';
import { NAVIGATION, type NavSection } from '@/lib/navigation';
import { getSession, getActiveOrganization, getUserOrganizations, hasPermission } from '@/lib/session';

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
  const session = await getSession();
  const [organization, organizations] = await Promise.all([
    getActiveOrganization(),
    getUserOrganizations(),
  ]);

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
    >
      {children}
    </AppShell>
  );
}
