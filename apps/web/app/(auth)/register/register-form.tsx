'use client';

import * as React from 'react';
import { AtSign, KeyRound, User } from 'lucide-react';
import { Alert, Button, Checkbox, Field, Input } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Registration form — presentation only. No account is created. */
export function RegisterForm() {
  const [password, setPassword] = React.useState('');
  const [notice, setNotice] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Length is the property that actually matters; composition rules are noise.
  const strength = Math.min(4, Math.floor(password.length / 4));
  const strengthLabel = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][strength] ?? '';

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setTimeout(() => { setSubmitting(false); setNotice(true); }, 350);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      {notice ? (
        <Alert tone="info" title="Registration is not implemented yet" onDismiss={() => setNotice(false)}>
          Account creation lands in Phase 1. Nothing was submitted.
        </Alert>
      ) : null}

      <Field label="Full name" htmlFor="name" required hint="Your real name, as your organization knows you.">
        <Input id="name" name="name" autoComplete="name" required icon={<User aria-hidden />} placeholder="Jordan Mercer" />
      </Field>

      <Field label="Email" htmlFor="email" required>
        <Input id="email" name="email" type="email" autoComplete="email" required icon={<AtSign aria-hidden />} placeholder="you@example.com" />
      </Field>

      <Field
        label="Password"
        htmlFor="new-password"
        required
        hint="At least 12 characters. Length matters more than symbols."
      >
        <Input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          icon={<KeyRound aria-hidden />}
        />
      </Field>

      {password ? (
        <div className="flex items-center gap-2" aria-live="polite">
          <div className="flex h-1 flex-1 gap-0.5" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={cn(
                  'h-full flex-1 rounded-full transition-colors',
                  i < strength
                    ? strength <= 1 ? 'bg-danger' : strength === 2 ? 'bg-warning' : 'bg-success'
                    : 'bg-border',
                )}
              />
            ))}
          </div>
          <span className="w-16 text-right text-2xs text-text-tertiary">{strengthLabel}</span>
        </div>
      ) : null}

      <Checkbox
        label="I understand this system is monitored"
        description="All access and record lookups are permanently audited."
        required
      />

      <Button type="submit" variant="primary" size="lg" loading={submitting} className="mt-1 w-full">
        Request access
      </Button>
    </form>
  );
}
