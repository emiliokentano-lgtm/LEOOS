import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '../auth-card';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset password"
      description="Enter the email on your account. If it exists, a single-use reset link is sent."
      footer={<Link href="/login" className="text-accent hover:underline">Back to sign in</Link>}
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
