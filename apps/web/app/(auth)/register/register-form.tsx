'use client';

import * as React from 'react';
import Link from 'next/link';
import { AtSign, KeyRound, MailCheck, User, UserCircle } from 'lucide-react';
import { Alert, Button, Checkbox, Field, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { registerAction } from '@/lib/auth-actions';
import { IDLE } from '@/lib/auth-action-types';

const MIN_LENGTH = 12;

export function RegisterForm() {
  const [state, formAction, pending] = React.useActionState(registerAction, IDLE);
  const [password, setPassword] = React.useState('');
  // Controlled so a failed submit does not wipe what was typed. Retyping four
  // fields because the server said "try again shortly" is its own small outage.
  const [fields, setFields] = React.useState({ displayName: '', username: '', email: '' });
  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((prev) => ({ ...prev, [key]: e.target.value }));

  // Length is the property that matters; composition rules just push people
  // toward `Password1!`. The server enforces the real policy.
  const strength = Math.min(4, Math.floor(password.length / 5));
  const strengthLabel = password.length < MIN_LENGTH
    ? 'Too short'
    : (['Weak', 'Fair', 'Good', 'Strong', 'Strong'][strength] ?? '');

  if (state.status === 'success') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5 rounded-md border border-border-subtle bg-raised px-3 py-2.5">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div>
            <p className="text-sm font-medium text-text-primary">Check your email</p>
            <p className="mt-0.5 text-xs text-text-secondary">{state.message}</p>
          </div>
        </div>
        <Button asChild variant="secondary" size="lg" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      {state.status === 'error' ? (
        <Alert tone="danger" title="Registration failed">
          {state.message}
        </Alert>
      ) : null}

      <Field
        label="Full name" htmlFor="displayName" required
        hint="Your real name, as your organization knows you."
        error={state.fieldErrors?.displayName?.[0]}
      >
        <Input id="displayName" name="displayName" autoComplete="name" required
          disabled={pending} value={fields.displayName} onChange={set('displayName')}
          icon={<UserCircle aria-hidden />} placeholder="Jordan Mercer" />
      </Field>

      <Field label="Username" htmlFor="username" required
        hint="Letters, numbers, dots, underscores and hyphens."
        error={state.fieldErrors?.username?.[0]}
      >
        <Input id="username" name="username" autoComplete="username" required minLength={3}
          disabled={pending} value={fields.username} onChange={set('username')}
          icon={<User aria-hidden />} placeholder="j.mercer" />
      </Field>

      <Field label="Email" htmlFor="email" required error={state.fieldErrors?.email?.[0]}>
        <Input id="email" name="email" type="email" autoComplete="email" required
          disabled={pending} value={fields.email} onChange={set('email')}
          icon={<AtSign aria-hidden />} placeholder="you@example.com" />
      </Field>

      <Field
        label="Password" htmlFor="new-password" required
        hint={`At least ${MIN_LENGTH} characters. Length matters more than symbols.`}
        error={state.fieldErrors?.password?.[0]}
      >
        <Input id="new-password" name="password" type="password" autoComplete="new-password"
          required minLength={MIN_LENGTH} disabled={pending}
          value={password} onChange={(e) => setPassword(e.target.value)}
          icon={<KeyRound aria-hidden />} />
      </Field>

      {password ? (
        <div className="flex items-center gap-2" aria-live="polite">
          <div className="flex h-1 flex-1 gap-0.5" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={cn(
                'h-full flex-1 rounded-full transition-colors',
                password.length >= MIN_LENGTH && i < strength
                  ? strength <= 2 ? 'bg-warning' : 'bg-success'
                  : password.length < MIN_LENGTH ? 'bg-danger/40' : 'bg-border',
              )} />
            ))}
          </div>
          <span className="w-16 text-right text-2xs text-text-tertiary">{strengthLabel}</span>
        </div>
      ) : null}

      <Checkbox
        label="I understand this system is monitored"
        description="All access and record lookups are permanently audited."
        required disabled={pending}
      />

      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        Request access
      </Button>
    </form>
  );
}
