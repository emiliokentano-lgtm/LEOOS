import type { Metadata } from 'next';
import Link from 'next/link';
import { MailCheck, ShieldQuestion } from 'lucide-react';
import { Alert, Button } from '@/components/ui';
import { AuthCard } from '../auth-card';
import { verifyEmailAction } from '@/lib/auth-actions';

export const metadata: Metadata = { title: 'Verify your account' };

/**
 * Account verification.
 *
 * Consuming the token is a state change, so it happens server-side when the
 * page loads with a `token` parameter. Without one, this is the informational
 * "check your email" state.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (token) {
    const { verified } = await verifyEmailAction(token);

    if (verified) {
      return (
        <AuthCard title="Account verified">
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <MailCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <p className="text-sm text-text-secondary">
                Your email address is confirmed. An organization administrator must now assign
                your membership before you can reach operational screens.
              </p>
            </div>
            <Button asChild variant="primary" size="lg" className="w-full">
              <Link href="/login">Continue to sign in</Link>
            </Button>
          </div>
        </AuthCard>
      );
    }

    return (
      <AuthCard title="Verification link is not valid">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="text-sm text-text-secondary">
              Verification links are valid for 24 hours and can be used once. This one has
              expired, was already used, or was not issued by us.
            </p>
          </div>
          <Button asChild variant="secondary" size="lg" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
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
        <Alert tone="info" title="Mail is not being delivered yet">
          No SMTP transport is configured. In development the console transport prints the
          link to the API log instead of sending it.
        </Alert>
        <Button asChild variant="ghost" size="md" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
