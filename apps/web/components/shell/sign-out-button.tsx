'use client';

import * as React from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui';
import { logoutAction } from '@/lib/auth-actions';

export function SignOutButton({
  variant = 'secondary',
}: {
  variant?: 'secondary' | 'ghost';
}) {
  const [pending, startTransition] = React.useTransition();

  return (
    <Button
      variant={variant}
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => { void logoutAction(); })}
    >
      <LogOut aria-hidden />
      Sign out
    </Button>
  );
}
