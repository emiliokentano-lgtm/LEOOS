'use client';

import * as React from 'react';
import {
  MAP_MARKER_TYPES, formatWorldPosition,
  type MapMarkerType, type MapOrganizationRef, type WorldPosition,
} from '@leoos/contracts';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { placeMapMarker } from '@/lib/map-actions';

/**
 * Places a marker at a right-clicked position.
 *
 * The position is fixed by the click and shown but not editable: a marker that
 * can be typed to arbitrary coordinates is a marker that ends up somewhere
 * nobody meant. Moving one is a drag on the map, which is the gesture that
 * matches the intent.
 *
 * Scope is a genuine choice only for a caller cleared to see every organization.
 * Everyone else places for the organization they are acting in, and the API
 * enforces exactly that — the field below is a convenience, not the decision
 * (engineering rule 11).
 */

const TYPE_OPTIONS = (Object.keys(MAP_MARKER_TYPES) as MapMarkerType[]).map((key) => ({
  value: key,
  label: MAP_MARKER_TYPES[key].label,
}));

/** Radix Select reserves the empty string for "nothing selected". */
const GLOBAL_SCOPE = '__global__';

export function MarkerDialog({
  position, organizations, canPlaceGlobal, onClose, onPlaced,
}: {
  position: WorldPosition;
  organizations: MapOrganizationRef[];
  canPlaceGlobal: boolean;
  onClose: () => void;
  onPlaced: () => void;
}) {
  const [type, setType] = React.useState<MapMarkerType>('hazard');
  const [label, setLabel] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [scope, setScope] = React.useState<string>(organizations[0]?.id ?? GLOBAL_SCOPE);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const toast = useToast();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (label.trim() === '') {
      setError('Give the marker a label so it means something to whoever sees it.');
      return;
    }

    setSaving(true);
    setError(null);

    const result = await placeMapMarker({
      type,
      label: label.trim(),
      description: description.trim() === '' ? null : description.trim(),
      x: position.x,
      y: position.y,
      organizationId: scope === GLOBAL_SCOPE ? null : scope,
    });

    setSaving(false);

    if (!result.ok) {
      // The typed values survive a refusal — losing them is infuriating when the
      // only problem was a scope the caller was not allowed to pick.
      setError(result.error ?? 'The marker could not be placed.');
      return;
    }

    toast.push({ tone: 'success', title: 'Marker placed' });
    onPlaced();
  }

  const scopeOptions = [
    ...organizations.map((org) => ({ value: org.id, label: org.shortName })),
    ...(canPlaceGlobal ? [{ value: GLOBAL_SCOPE, label: 'All organizations' }] : []),
  ];

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Place a marker">
      <form onSubmit={(e) => { void submit(e); }} className="flex flex-col gap-3">
        <p className="text-xs text-text-tertiary">
          At <span className="font-mono text-text-secondary">{formatWorldPosition(position)}</span>
        </p>

        <Field label="Type" htmlFor="marker-type">
          <Select
            id="marker-type"
            value={type}
            onValueChange={(value) => setType(value as MapMarkerType)}
            options={TYPE_OPTIONS}
          />
        </Field>

        <Field label="Label" htmlFor="marker-label" required>
          <Input
            id="marker-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            placeholder="Route 68 closure"
            autoFocus
          />
        </Field>

        <Field label="Description" htmlFor="marker-description" hint="Optional.">
          <Textarea
            id="marker-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="What should whoever arrives know?"
          />
        </Field>

        {scopeOptions.length > 1 ? (
          <Field label="Visible to" htmlFor="marker-scope">
            <Select
              id="marker-scope"
              value={scope}
              onValueChange={setScope}
              options={scopeOptions}
            />
          </Field>
        ) : null}

        {error !== null ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Placing…' : 'Place marker'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
