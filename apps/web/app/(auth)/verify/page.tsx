import type { Metadata } from 'next';
import Link from 'next/link';
import { MailCheck, ShieldQuestion } from 'lucide-react';
import { Alert, Button } from '@/components/ui';
import { AuthCard } from '../auth-card';

export const metadata: Metadata = { title: 'Verify your account' };

/**
 * Account verification.
 *
 * Renders the three states the real flow will have — pending, success, expired —
 * so the layout is settled before the backend exists. Which one shows is driven
 * by the `state` query parameter in this phase.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state = 'pending' } = await searchParams;

  if (state === 'success') {
    return (
      <AuthCard title="Account verified">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <MailCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <p className="text-sm text-text-secondary">
              Your email address is confirmed. An organization administrator must now
              assign your membership before you can access operational screens.
            </p>
          </div>
          <Button asChild variant="primary" size="lg" className="w-full">
            <Link href="/login">Continue to sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (state === 'expired') {
    return (
      <AuthCard title="Verification link expired">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="text-sm text-text-secondary">
              Verification links are valid for 24 hours and can be used once. Request a
              new one and the previous link stops working.
            </p>
          </div>
          <Button variant="secondary" size="lg" className="w-full">Send a new link</Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Verify your account"
      description="We sent a confirmation link to your email address. It expires in 24 hours."
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">
          Once verified, your account still needs an organization membership before any
          operational screen becomes available. Your organization&apos;s leadership assigns that.
        </p>
        <Alert tone="info" title="Mail delivery is not connected">
          Verification lands in Phase 1. The development mail transport writes to the
          console and delivers nothing.
        </Alert>
        <div className="flex gap-2">
          <Button variant="secondary" size="md" className="flex-1">Resend link</Button>
          <Button asChild variant="ghost" size="md" className="flex-1">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </div>
    </AuthCard>
  );
}
