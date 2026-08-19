'use client';

import * as React from 'react';
import { KeyRound, User } from 'lucide-react';
import { Alert, Button, Checkbox, Field, Input } from '@/components/ui';
import { loginAction } from '@/lib/auth-actions';
import { IDLE } from '@/lib/auth-action-types';

/**
 * Sign-in form.
 *
 * Handles the five states the brief calls for: invalid credentials, disabled
 * accounts, expired sessions, loading, and network errors. The distinction
 * between them comes from the API's error code — the form never guesses.
 */
/**
 * `next` and `expired` arrive as props from the server component rather than
 * from `useSearchParams`. Reading the query on the client would force this
 * subtree to render only after hydration, so the sign-in form would flash in
 * late on the one screen where it must be there immediately.
 */
export function LoginForm({ next = '', expired = false }: { next?: string; expired?: boolean }) {
  const [state, formAction, pending] = React.useActionState(loginAction, IDLE);
  const [identifier, setIdentifier] = React.useState('');

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      {expired && state.status === 'idle' ? (
        <Alert tone="info" title="Your session expired">
          Sign in again to continue where you left off.
        </Alert>
      ) : null}

      {state.status === 'error' ? (
        <Alert
          tone={state.message?.includes('reach') ? 'warning' : 'danger'}
          title={state.message?.includes('reach') ? 'Service unreachable' : 'Sign-in failed'}
        >
          {state.message}
          {state.requestId ? (
            <span className="mt-1 block font-mono text-2xs text-text-tertiary">
              Request {state.requestId}
            </span>
          ) : null}
        </Alert>
      ) : null}

      <input type="hidden" name="next" value={next} />

      <Field label="Username or email" htmlFor="identifier" required>
        <Input
          id="identifier"
          name="identifier"
          autoComplete="username"
          required
          autoFocus
          disabled={pending}
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
          disabled={pending}
          icon={<KeyRound aria-hidden />}
          placeholder="••••••••••••"
        />
      </Field>

      <Checkbox label="Keep me signed in on this station" name="remember" disabled={pending} />

      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        Sign in
      </Button>
    </form>
  );
}
