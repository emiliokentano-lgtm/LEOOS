'use client';

import * as React from 'react';
import { AtSign, MailCheck } from 'lucide-react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { forgotPasswordAction } from '@/lib/auth-actions';
import { IDLE } from '@/lib/auth-action-types';

export function ForgotPasswordForm() {
  const [state, formAction, pending] = React.useActionState(forgotPasswordAction, IDLE);

  if (state.status === 'success') {
    return (
      <div className="flex flex-col gap-3">
        {/* The generic wording is deliberate — it must not reveal whether the
            account exists. The copy reflects that rather than fighting it. */}
        <div className="flex items-start gap-2.5 rounded-md border border-border-subtle bg-raised px-3 py-2.5">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div>
            <p className="text-sm font-medium text-text-primary">Check your email</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {state.message} The link expires in one hour and can be used once.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      {state.status === 'error' ? (
        <Alert tone="danger" title="Request failed">{state.message}</Alert>
      ) : null}
      <Field label="Email" htmlFor="reset-email" required>
        <Input id="reset-email" name="email" type="email" autoComplete="email" required
          autoFocus disabled={pending} icon={<AtSign aria-hidden />} placeholder="you@example.com" />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Send reset link
      </Button>
    </form>
  );
}
