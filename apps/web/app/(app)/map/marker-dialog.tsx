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
 * ────────────────────────────────────────────────────────────────────────────
 * SCOPE IS ONLY A CHOICE FOR SOMEBODY CLEARED TO MAKE IT
 *
 * The organization list on this screen is *organizations that can appear on
 * this caller's map*, which includes other agencies that share on the public
 * map. Offering that list to everybody meant a PD sergeant could pick LSMD —
 * and be refused by the API, correctly, after placing the marker. The live-map
 * walkthrough found this on the shape dialog, which had inherited it from here.
 *
 * So a caller without `map.track_all_orgs` gets no field at all: they place for
 * the organization they are acting in, which is the only value the API would
 * accept. An option that can only fail is worse than no option.
 *
 * The API still decides (engineering rule 11) — this is a convenience, not the
 * decision.
 * ────────────────────────────────────────────────────────────────────────────
 */

const TYPE_OPTIONS = (Object.keys(MAP_MARKER_TYPES) as MapMarkerType[]).map((key) => ({
  value: key,
  label: MAP_MARKER_TYPES[key].label,
}));

/** Radix Select reserves the empty string for "nothing selected". */
const GLOBAL_SCOPE = '__global__';

export function MarkerDialog({
  position, organizations, actingOrganizationId, canPlaceGlobal, onClose, onPlaced,
}: {
  position: WorldPosition;
  organizations: MapOrganizationRef[];
  /** The organization the caller is acting in. The only one they may place for. */
  actingOrganizationId: string | null;
  canPlaceGlobal: boolean;
  onClose: () => void;
  onPlaced: () => void;
}) {
  const scopeOptions = canPlaceGlobal
    ? [
      ...organizations.map((org) => ({ value: org.id, label: org.shortName })),
      { value: GLOBAL_SCOPE, label: 'All organizations' },
    ]
    : organizations
      .filter((org) => org.id === actingOrganizationId)
      .map((org) => ({ value: org.id, label: org.shortName }));

  const [type, setType] = React.useState<MapMarkerType>('hazard');
  const [label, setLabel] = React.useState('');
  const [description, setDescription] = React.useState('');
  /**
   * An administrator with no active organization defaults to the SHARED scope,
   * not to whichever agency happens to sort first — they belong to none of them.
   */
  const [scope, setScope] = React.useState<string>(
    actingOrganizationId
    ?? (canPlaceGlobal ? GLOBAL_SCOPE : scopeOptions[0]?.value ?? GLOBAL_SCOPE),
  );
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
