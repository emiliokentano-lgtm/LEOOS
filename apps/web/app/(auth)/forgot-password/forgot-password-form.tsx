'use client';

import * as React from 'react';
import { AtSign, MailCheck } from 'lucide-react';
import { Alert, Button, Field, Input } from '@/components/ui';

export function ForgotPasswordForm() {
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setTimeout(() => { setSubmitting(false); setSent(true); }, 350);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-3">
        {/* The generic response is deliberate: it must not reveal whether the
            account exists. The UI copy reflects that rather than fighting it. */}
        <div className="flex items-start gap-2.5 rounded-md border border-border-subtle bg-raised px-3 py-2.5">
          <MailCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div>
            <p className="text-sm font-medium text-text-primary">Check your email</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              If an account exists for that address, a reset link is on its way. The link
              expires in one hour and can be used once.
            </p>
          </div>
        </div>
        <Alert tone="info" title="Mail delivery is not connected">
          Password reset lands in Phase 1. In development the mail transport writes to
          the console and delivers nothing.
        </Alert>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      <Field label="Email" htmlFor="reset-email" required>
        <Input
          id="reset-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          icon={<AtSign aria-hidden />}
          placeholder="you@example.com"
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={submitting} className="w-full">
        Send reset link
      </Button>
    </form>
  );
}
