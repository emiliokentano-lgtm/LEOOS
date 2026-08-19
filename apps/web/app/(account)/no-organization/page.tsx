import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Building2, ShieldCheck } from 'lucide-react';
import { Alert, Panel, PanelHeader } from '@/components/ui';
import { getSessionOrNull } from '@/lib/session';
import { SignOutButton } from '@/components/shell/sign-out-button';

export const metadata: Metadata = { title: 'Awaiting assignment' };

/**
 * Holding screen for a verified account with no organization membership.
 *
 * This is the normal outcome of registration, not an error: registration grants
 * no privileges at all, and organization access is assigned by that
 * organization's leadership. Saying so plainly is better than an empty shell.
 */
export default async function NoOrganizationPage() {
  const session = await getSessionOrNull();
  if (!session) redirect('/login');
  if (session.organizationId) redirect('/dashboard');

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <Panel flush>
          <PanelHeader title="Awaiting organization assignment" icon={<Building2 />} />
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <div>
                <p className="text-sm text-text-primary">
                  Signed in as <span className="font-medium">{session.displayName}</span>
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">{session.email}</p>
              </div>
            </div>

            <p className="text-sm text-text-secondary">
              Your account is verified but not yet a member of any organization. Operational
              screens stay unavailable until an administrator of your department assigns your
              membership and rank.
            </p>

            <Alert tone="info" title="This is expected">
              Registering an account never grants access to an organization. That decision
              belongs to the organization&apos;s leadership.
            </Alert>

            <div className="flex justify-end pt-1">
              <SignOutButton />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
