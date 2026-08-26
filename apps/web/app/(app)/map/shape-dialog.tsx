'use client';

import * as React from 'react';
import {
  MAP_SHAPE_KINDS, drawnLength, enclosedArea, validateShapeGeometry,
  type MapOrganizationRef, type MapShapeKind, type MapShapePoint,
} from '@leoos/contracts';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { drawMapShape } from '@/lib/map-actions';

/**
 * Names a shape that has just been drawn.
 *
 * The GEOMETRY is not editable here and is not shown as numbers: a cordon typed
 * as coordinates is a cordon nobody meant. What is shown is the fact the
 * operator can check at a glance — how many points, and how big it is — so a
 * mis-click that produced a two-metre area is obvious before it is saved.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SCOPE IS ONLY A CHOICE FOR SOMEBODY CLEARED TO MAKE IT
 *
 * The organization list on this screen is *organizations that can appear on
 * this caller's map*, which includes other agencies that share on the public
 * map. Offering that list to everybody meant a PD sergeant could pick LSMD —
 * and be refused by the API, correctly, having already drawn the shape. The
 * live-map walkthrough found exactly that, by drawing a cordon and getting
 * nothing back.
 *
 * So a caller without `map.track_all_orgs` gets no field at all: they draw for
 * the organization they are acting in, which is the only value the API would
 * accept. An option that can only fail is worse than no option.
 *
 * The API still decides (engineering rule 11) — this is a convenience, not the
 * decision.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Radix Select reserves the empty string for "nothing selected". */
const GLOBAL_SCOPE = '__global__';

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
}

function squareMetres(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)} km²`
    : `${Math.round(value)} m²`;
}

export function ShapeDialog({
  kind, points, organizations, actingOrganizationId, canDrawGlobal, onClose, onDrawn,
}: {
  kind: MapShapeKind;
  points: MapShapePoint[];
  organizations: MapOrganizationRef[];
  /** The organization the caller is acting in. The only one they may draw for. */
  actingOrganizationId: string | null;
  canDrawGlobal: boolean;
  onClose: () => void;
  onDrawn: () => void;
}) {
  /**
   * What this caller may actually pick.
   *
   * Cleared to see every organization → every organization, plus a shape shared
   * with all of them. Everybody else → the one they are acting in, and the
   * field below then does not render at all.
   */
  const scopeOptions = canDrawGlobal
    ? [
      ...organizations.map((org) => ({ value: org.id, label: org.shortName })),
      { value: GLOBAL_SCOPE, label: 'All organizations' },
    ]
    : organizations
      .filter((org) => org.id === actingOrganizationId)
      .map((org) => ({ value: org.id, label: org.shortName }));

  const [label, setLabel] = React.useState('');
  const [description, setDescription] = React.useState('');
  /**
   * An administrator with no active organization defaults to the SHARED scope,
   * not to whichever agency happens to sort first — they belong to none of them.
   */
  const [scope, setScope] = React.useState<string>(
    actingOrganizationId
    ?? (canDrawGlobal ? GLOBAL_SCOPE : scopeOptions[0]?.value ?? GLOBAL_SCOPE),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const toast = useToast();

  const meta = MAP_SHAPE_KINDS[kind];
  // The SAME function the API runs. Checked here so a shape that cannot be
  // saved says so before the round trip, not because this is the check that
  // counts — that one is server-side.
  const geometryProblem = validateShapeGeometry(kind, points);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (label.trim() === '') {
      setError('Give it a label so it means something to whoever sees it.');
      return;
    }
    if (geometryProblem !== null) {
      setError(geometryProblem);
      return;
    }

    setSaving(true);
    setError(null);

    const result = await drawMapShape({
      kind,
      label: label.trim(),
      description: description.trim() === '' ? null : description.trim(),
      points,
      organizationId: scope === GLOBAL_SCOPE ? null : scope,
    });

    setSaving(false);

    if (!result.ok) {
      // The typed values survive a refusal — and so does the geometry, which
      // would otherwise have to be drawn all over again.
      setError(result.error ?? 'The shape could not be saved.');
      return;
    }

    toast.push({ tone: 'success', title: `${meta.label} saved` });
    onDrawn();
  }

  return (
    <Modal
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Save this ${meta.label.toLowerCase()}`}
    >
      <form onSubmit={(e) => { void submit(e); }} className="flex flex-col gap-3">
        <p className="text-xs text-text-tertiary">
          {points.length} point{points.length === 1 ? '' : 's'}
          {' · '}
          <span className="font-mono text-text-secondary">
            {kind === 'area'
              ? squareMetres(enclosedArea(points))
              : metres(drawnLength(points))}
          </span>
          {kind === 'route' ? ' drawn length' : ' enclosed'}
        </p>

        {/*
          Said here, on the screen, and not only in a source comment. A route is
          a line somebody drew; the software has no road graph and cannot claim
          otherwise (engineering rule 45).
        */}
        <p className="text-2xs text-text-tertiary">{meta.hint}</p>

        <Field label="Label" htmlFor="shape-label" required>
          <Input
            id="shape-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            placeholder={kind === 'area' ? 'Vinewood cordon' : 'Approach from the canal'}
            autoFocus
          />
        </Field>

        <Field label="Description" htmlFor="shape-description" hint="Optional.">
          <Textarea
            id="shape-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="What should whoever arrives know?"
          />
        </Field>

        {scopeOptions.length > 1 ? (
          <Field label="Visible to" htmlFor="shape-scope">
            <Select
              id="shape-scope"
              value={scope}
              onValueChange={setScope}
              options={scopeOptions}
            />
          </Field>
        ) : null}

        {geometryProblem !== null ? (
          <p className="text-xs text-danger">{geometryProblem}</p>
        ) : null}
        {error !== null ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>Discard</Button>
          <Button type="submit" size="sm" disabled={saving || geometryProblem !== null}>
            {saving ? 'Saving…' : `Save ${meta.label.toLowerCase()}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
