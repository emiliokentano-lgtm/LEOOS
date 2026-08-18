'use client';

import * as React from 'react';
import { KeyRound } from 'lucide-react';
import { Alert, Button, Field, Input } from '@/components/ui';

export function ResetPasswordForm() {
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [notice, setNotice] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setSubmitting(true);
    setTimeout(() => { setSubmitting(false); setNotice(true); }, 350);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      {notice ? (
        <Alert tone="info" title="Password reset is not implemented yet" onDismiss={() => setNotice(false)}>
          This lands in Phase 1. Nothing was changed.
        </Alert>
      ) : null}

      <Field label="New password" htmlFor="pw" required hint="At least 12 characters.">
        <Input
          id="pw" type="password" autoComplete="new-password" required minLength={12}
          value={password} onChange={(e) => setPassword(e.target.value)}
          icon={<KeyRound aria-hidden />}
        />
      </Field>

      <Field
        label="Confirm new password"
        htmlFor="pw2"
        required
        error={mismatch ? 'Passwords do not match.' : undefined}
      >
        <Input
          id="pw2" type="password" autoComplete="new-password" required
          value={confirm} onChange={(e) => setConfirm(e.target.value)}
          invalid={mismatch}
          icon={<KeyRound aria-hidden />}
        />
      </Field>

      <Button
        type="submit" variant="primary" size="lg"
        loading={submitting} disabled={mismatch || password.length < 12}
        className="w-full"
      >
        Set new password
      </Button>
    </form>
  );
}
