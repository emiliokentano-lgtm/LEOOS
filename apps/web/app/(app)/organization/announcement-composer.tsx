'use client';

import * as React from 'react';
import { Megaphone, Send } from 'lucide-react';
import {
  Alert, Button, Field, Input, Panel, PanelBody, PanelHeader, Select, Textarea, useToast,
} from '@/components/ui';
import { sendAnnouncement } from '@/lib/notification-actions';

/**
 * Organization announcements.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE NOTIFICATION A HUMAN COMPOSES
 *
 * Everything else in the notification system is emitted by the domain event that
 * caused it — a panic row, an assignment, a status change — which is what makes
 * those unforgeable. This is the exception, and the screen is written to make
 * its shape obvious to the person using it:
 *
 *   · the AUDIENCE is stated and not chosen. Every active member of this
 *     organization. There is no recipient picker here because there is no
 *     recipient parameter at the API;
 *   · `critical` is NOT OFFERED. Critical is the level a panic uses to earn a
 *     banner that will not dismiss itself and, if the operator asked for it, a
 *     sound. An announcement that could imitate one is how people learn to
 *     dismiss the level that matters. The API caps it as well;
 *   · the operator is told it is AUDITED before they send, not after.
 *
 * The permission check below is cosmetic, as everywhere in this application: the
 * API re-derives `organization.announce` inside the transaction and would refuse
 * a request this screen never offered (engineering rule 9).
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface AnnouncementComposerProps {
  organizationId: string;
  organizationName: string;
  memberCount: number;
  canAnnounce: boolean;
}

export function AnnouncementComposer({
  organizationId, organizationName, memberCount, canAnnounce,
}: AnnouncementComposerProps) {
  const toast = useToast();
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [severity, setSeverity] = React.useState<'info' | 'warning'>('info');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<number | null>(null);

  if (!canAnnounce) {
    return (
      <Panel>
        <PanelHeader title="Announcements" icon={<Megaphone />} />
        <PanelBody>
          <Alert tone="info" title="You cannot send announcements">
            Sending an announcement writes an entry into every member&rsquo;s
            notification list, so it needs the <code>organization.announce</code>{' '}
            permission. Your organization&rsquo;s command roles hold it by default.
          </Alert>
        </PanelBody>
      </Panel>
    );
  }

  const valid = title.trim().length >= 3 && body.trim().length > 0;

  async function send() {
    setSending(true);
    setError(null);
    const result = await sendAnnouncement(organizationId, {
      title: title.trim(), body: body.trim(), severity,
    });
    setSending(false);

    if (!result.ok) {
      setError(result.error ?? 'The announcement was not sent.');
      return;
    }

    setTitle('');
    setBody('');
    setSeverity('info');
    // The count the SERVER reported, not the roster size this screen happened to
    // render. They differ whenever somebody was deactivated since the page
    // loaded, and the honest number is the one that describes what happened.
    setSent(result.recipients ?? 0);
    toast.push({
      tone: 'success',
      title: 'Announcement sent',
      description: `Delivered to ${result.recipients ?? 0} ${
        result.recipients === 1 ? 'member' : 'members'
      }.`,
    });
  }

  return (
    <Panel>
      <PanelHeader
        title="Send an announcement"
        description={`Every active member of ${organizationName} — about ${memberCount} people.`}
        icon={<Megaphone />}
      />
      <PanelBody className="flex flex-col gap-3">
        <Alert tone="info" title="What this does">
          <ul className="list-inside list-disc space-y-0.5">
            <li>Writes a notification for every active member of this organization</li>
            <li>Shows them a banner now if they are signed in, and an entry in their centre either way</li>
            <li>Records who sent it, and to how many people, in the audit log</li>
            <li>Does not make a sound — announcements never do</li>
          </ul>
        </Alert>

        <Field label="Title" hint="What a member sees at a glance. Keep it short.">
          <Input
            value={title}
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Shift briefing moved to 19:00"
          />
        </Field>

        <Field label="Message">
          <Textarea
            value={body}
            rows={4}
            maxLength={2000}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Briefing is in the muster room tonight, not the yard."
          />
        </Field>

        <Field
          label="Level"
          /*
           * Said in words on the control itself. An operator reaching for a
           * louder level needs to know the loudest one is not theirs to use, and
           * why — otherwise the refusal at the API reads as a bug.
           */
          hint="Critical is reserved for panic alerts and life-threatening calls. It is not available here."
        >
          <Select
            value={severity}
            onValueChange={(value) => setSeverity(value as 'info' | 'warning')}
            options={[
              { value: 'info', label: 'Information — appears quietly' },
              { value: 'warning', label: 'Important — highlighted in the list' },
            ]}
          />
        </Field>

        {error !== null ? (
          <Alert tone="danger" title="The announcement was not sent">{error}</Alert>
        ) : null}

        {sent !== null && error === null ? (
          <Alert tone="success" title="Sent">
            Delivered to {sent} {sent === 1 ? 'member' : 'members'}.
            {sent === 0
              ? ' Nobody else is currently an active member of this organization.'
              : ''}
          </Alert>
        ) : null}

        <div className="flex justify-end">
          <Button disabled={!valid || sending} onClick={() => { void send(); }}>
            <Send aria-hidden />
            {sending ? 'Sending…' : 'Send announcement'}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}
