import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '../auth-card';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const { next = '', reason } = await searchParams;

  return (
    <AuthCard
      title="Sign in"
      description="Use your issued LEOOS account. Access is scoped to your organization and rank."
      footer={
        <div className="flex items-center justify-between">
          <Link href="/forgot-password" className="text-accent hover:underline">
            Forgot password
          </Link>
          <span>
            No account?{' '}
            <Link href="/register" className="text-accent hover:underline">Request access</Link>
          </span>
        </div>
      }
    >
      <LoginForm next={next} expired={reason === 'expired'} />
    </AuthCard>
  );
}
