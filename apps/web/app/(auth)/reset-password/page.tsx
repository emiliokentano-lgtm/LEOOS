import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '../auth-card';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPasswordPage() {
  return (
    <AuthCard
      title="Choose a new password"
      description="Setting a new password signs out every other session on this account."
      footer={<Link href="/login" className="text-accent hover:underline">Back to sign in</Link>}
    >
      <ResetPasswordForm />
    </AuthCard>
  );
}
