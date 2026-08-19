'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { resetPasswordAction } from '@/lib/auth-actions';
import { IDLE } from '@/lib/auth-action-types';

const MIN_LENGTH = 12;

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = React.useActionState(resetPasswordAction, IDLE);
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');

  const mismatch = confirm.length > 0 && password !== confirm;

  if (!token) {
    return (
      <Alert tone="warning" title="This link is incomplete">
        Reset links must be opened exactly as they arrive in your email.{' '}
        <Link href="/forgot-password" className="text-accent hover:underline">
          Request a new one
        </Link>.
      </Alert>
    );
  }

  if (state.status === 'success') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <p className="text-sm text-text-secondary">{state.message}</p>
        </div>
        <Alert tone="info" title="Other sessions were signed out">
          Every other session on this account was ended, on every device.
        </Alert>
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/login">Continue to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      {state.status === 'error' ? (
        <Alert tone="danger" title="Could not reset your password">
          {state.message ?? state.fieldErrors?.password?.[0]}
        </Alert>
      ) : null}

      <input type="hidden" name="token" value={token} />

      <Field label="New password" htmlFor="pw" required
        hint={`At least ${MIN_LENGTH} characters.`}
        error={state.fieldErrors?.password?.[0]}
      >
        <Input id="pw" name="newPassword" type="password" autoComplete="new-password"
          required minLength={MIN_LENGTH} disabled={pending}
          value={password} onChange={(e) => setPassword(e.target.value)}
          icon={<KeyRound aria-hidden />} />
      </Field>

      <Field label="Confirm new password" htmlFor="pw2" required
        error={mismatch ? 'Passwords do not match.' : state.fieldErrors?.confirmPassword?.[0]}
      >
        <Input id="pw2" name="confirmPassword" type="password" autoComplete="new-password"
          required disabled={pending} invalid={mismatch}
          value={confirm} onChange={(e) => setConfirm(e.target.value)}
          icon={<KeyRound aria-hidden />} />
      </Field>

      <Button type="submit" variant="primary" size="lg" loading={pending}
        disabled={mismatch || password.length < MIN_LENGTH} className="w-full">
        Set new password
      </Button>
    </form>
  );
}
