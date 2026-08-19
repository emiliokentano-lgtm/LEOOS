'use client';

import * as React from 'react';
import { PRIORITY_LIST, type IncidentPriority } from '@leoos/contracts';
import { Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { createIncident } from '@/lib/dispatch-actions';

/**
 * Taking a call.
 *
 * Title and priority only are required — everything else can arrive later, and a
 * form that demands a location before it will accept a call is a form that gets
 * bypassed during the calls that matter. Priority defaults from the incident
 * type, which is what the type catalogue is for.
 */
export function NewIncidentDialog({
  incidentTypes, onClose, onCreated,
}: {
  incidentTypes: { key: string; label: string; defaultPriority: IncidentPriority }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [typeKey, setTypeKey] = React.useState('');
  const [priority, setPriority] = React.useState<IncidentPriority>(3);
  const [locationText, setLocationText] = React.useState('');
  const [callerPhone, setCallerPhone] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function pickType(key: string) {
    setTypeKey(key);
    const found = incidentTypes.find((t) => t.key === key);
    if (found) setPriority(found.defaultPriority);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim().length < 3) {
      setError('Give the call a title so the queue means something.');
      return;
    }

    setSaving(true);
    setError(null);
    const result = await createIncident({
      title: title.trim(),
      description: description.trim() === '' ? null : description.trim(),
      typeKey: typeKey === '' ? null : typeKey,
      priority,
      locationText: locationText.trim() === '' ? null : locationText.trim(),
      callerPhone: callerPhone.trim() === '' ? null : callerPhone.trim(),
    });
    setSaving(false);

    // Typed values survive a refusal: re-entering a call under time pressure
    // because the server said no is the worst possible moment to lose them.
    if (!result.ok) { setError(result.error ?? 'The call could not be created.'); return; }
    onCreated();
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="New call">
      <form onSubmit={(e) => { void submit(e); }} className="flex flex-col gap-3">
        <Field label="Title" htmlFor="incident-title" required>
          <Input
            id="incident-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Armed robbery in progress"
            maxLength={160}
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" htmlFor="incident-type" hint="Sets a default priority.">
            <Select
              id="incident-type"
              value={typeKey}
              onValueChange={pickType}
              options={incidentTypes.map((t) => ({ value: t.key, label: t.label }))}
              placeholder="Select…"
            />
          </Field>
          <Field label="Priority" htmlFor="incident-priority" required>
            <Select
              id="incident-priority"
              value={String(priority)}
              onValueChange={(v) => setPriority(Number(v) as IncidentPriority)}
              options={PRIORITY_LIST.map((p) => ({
                value: String(p.value),
                label: `${p.label} · ${p.name}`,
              }))}
            />
          </Field>
        </div>

        <Field label="Location" htmlFor="incident-location" hint="Optional.">
          <Input
            id="incident-location"
            value={locationText}
            onChange={(e) => setLocationText(e.target.value)}
            placeholder="Legion Square"
            maxLength={200}
          />
        </Field>

        <Field label="Details" htmlFor="incident-description" hint="Optional.">
          <Textarea
            id="incident-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="What did the caller say?"
          />
        </Field>

        <Field label="Caller phone" htmlFor="incident-phone" hint="Optional.">
          <Input
            id="incident-phone"
            value={callerPhone}
            onChange={(e) => setCallerPhone(e.target.value)}
            maxLength={40}
          />
        </Field>

        {error !== null ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || title.trim().length < 3}>
            {saving ? 'Creating…' : 'Create call'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
