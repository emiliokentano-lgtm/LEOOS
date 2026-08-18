'use client';

import * as React from 'react';
import { KeyRound, User } from 'lucide-react';
import { Alert, Button, Checkbox, Field, Input } from '@/components/ui';

/**
 * Login form — presentation only.
 *
 * There is NO authentication behind this in the design phase, and it does not
 * pretend otherwise: submitting shows an explicit "not implemented" notice
 * rather than a fake success (engineering rules 34, 45).
 */
export function LoginForm() {
  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [notice, setNotice] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setTimeout(() => { setSubmitting(false); setNotice(true); }, 350);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      {notice ? (
        <Alert tone="info" title="Authentication is not implemented yet" onDismiss={() => setNotice(false)}>
          This is the design-system phase. Sign-in lands in Phase 1 together with the
          API. No credentials were sent anywhere.
        </Alert>
      ) : null}

      <Field label="Username or email" htmlFor="identifier" required>
        <Input
          id="identifier"
          name="identifier"
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          icon={<User aria-hidden />}
          placeholder="j.mercer"
        />
      </Field>

      <Field label="Password" htmlFor="password" required>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          icon={<KeyRound aria-hidden />}
          placeholder="••••••••••••"
        />
      </Field>

      <Checkbox label="Keep me signed in on this station" />

      <Button type="submit" variant="primary" size="lg" loading={submitting} className="mt-1 w-full">
        Sign in
      </Button>
    </form>
  );
}
