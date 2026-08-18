import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '../auth-card';
import { RegisterForm } from './register-form';

export const metadata: Metadata = { title: 'Request access' };

export default function RegisterPage() {
  return (
    <AuthCard
      title="Request access"
      description="Accounts are verified by email, then assigned to an organization by that organization's leadership."
      footer={
        <span>
          Already have an account?{' '}
          <Link href="/login" className="text-accent hover:underline">Sign in</Link>
        </span>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
