'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input } from './input';
import { Modal } from './modal';
import { Alert } from './alert';

export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  tone?: 'default' | 'danger';
  /** Consequences the operator must read before confirming. */
  consequences?: React.ReactNode;
  /**
   * Requires the operator to type this exact string before confirming.
   * Used for high-risk actions — terminating a member, archiving a role.
   * Deliberate friction, not decoration.
   */
  confirmationPhrase?: string;
  loading?: boolean;
}

export function ConfirmationDialog({
  open, onOpenChange, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  onConfirm, tone = 'default', consequences, confirmationPhrase, loading = false,
}: ConfirmationDialogProps) {
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const phraseOk = !confirmationPhrase || typed === confirmationPhrase;

  function handleOpenChange(next: boolean) {
    if (!next) setTyped('');
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (!phraseOk) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            disabled={!phraseOk}
            loading={busy || loading}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
        {consequences ? (
          <Alert tone={tone === 'danger' ? 'danger' : 'warning'} title="This will:">
            {consequences}
          </Alert>
        ) : null}
        {confirmationPhrase ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm-phrase" className="text-xs text-text-secondary">
              Type <span className="font-mono text-text-primary">{confirmationPhrase}</span> to confirm
            </label>
            <Input
              id="confirm-phrase"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              className={cn('font-mono', typed && !phraseOk && 'border-danger')}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
