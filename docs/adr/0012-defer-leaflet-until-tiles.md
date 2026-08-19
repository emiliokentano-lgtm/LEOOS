# ADR-0012 — Defer Leaflet until the tile set exists; ship a canvas viewport now

**Status:** Accepted · 2026-08-19
**Amends:** [ADR-0005](0005-leaflet-crs-simple.md)

## Context

ADR-0005 chose Leaflet with `CRS.Simple` for the base map and sparse interactive
layers, plus a custom canvas overlay for live units. That decision stands. This
one is about *when* Leaflet arrives.

Leaflet's contribution to the design is entirely on the base-layer side: the tile
pyramid loader, pan/zoom around a raster, and layer switching. The unit overlay —
the part that has to be fast, and the part with all the interesting code — is
ours either way.

Two facts collided while building the map subsystem:

1. **There is no tile set.** `docs/architecture/05-map.md` §3 records it:
   *"[CONFIRM] The source map image must be licensed for our use. This is a legal
   blocker on Phase 6 and must be resolved before that phase starts."* Nothing
   has resolved it. There is no licensed GTA V raster pyramid to serve, and
   generating one from an unlicensed render, or shipping an approximation styled
   to look like Los Santos, is not an option we are willing to take.

2. **The map is needed now.** Unit tracking, filtering, clustering, follow mode,
   the detail panel and — most importantly — the per-viewer visibility rules all
   need a working map to be built and verified against.

Adding Leaflet today would mean adding a dependency whose only job is to render
tiles that do not exist. It would load, initialise, and display nothing, while
the canvas overlay did all the visible work. Engineering rule 29 asks that every
dependency be justified; "will be justified in a later phase" is not that.

## Decision

**Ship the map on a canvas viewport of our own, and add Leaflet when the licensed
tile pyramid does.**

Concretely:

- The base layer today is an explicitly-scaffolding coordinate grid, with a
  banner saying so in words. It is not styled to resemble a map.
- Pan, zoom, and the world↔screen projection live in
  `packages/contracts/src/map-viewport.ts` as pure functions — about 150 lines,
  fully unit-tested, no DOM.
- The unit overlay is the one ADR-0005 committed to, written against that
  projection.
- ADR-0005's `CRS.Simple` plane is already implemented: `worldToLatLng` /
  `latLngToWorld` in `packages/contracts/src/geo.ts` compose the same affine map
  the rest of the system uses, so the Leaflet integration will not re-derive a
  transform.

## Consequences

**Positive.** No dependency that does nothing. The projection is testable without
a browser, which is how the aspect-ratio bug below was caught. The tile blocker
is visible on screen rather than buried in a document.

**Negative.** We own pan and zoom — roughly 150 lines that Leaflet would have
provided. When tiles arrive there is integration work: mounting a Leaflet map
under the canvas and driving it from the same viewport state. That work is
bounded because the transform is already shared and already tested.

**Neutral.** Nothing about stored data changes. The database holds world
coordinates only, so the tile set can arrive, be replaced, or be re-calibrated
without touching a single stored position.

## What this decision already caught

Projecting through the normalised map plane — which is what the earlier
mock-backed screen did — scales x by 1/8500 and y by 1/13000. A square in the
world came out 1.53× taller than wide on screen: heading chevrons pointed in the
wrong direction and any distance read off the map was meaningless. Building the
projection as testable pure functions surfaced it immediately; the regression
test is `map-viewport.test.ts` → *"is isotropic: equal world distances are equal
screen distances on both axes"*.

That is the argument for this ADR in miniature: the part of the map that must be
correct is the part we were always going to write ourselves.

## When to revisit

When the tile licensing question in `05-map.md` §3 is resolved. At that point
Leaflet is added, the grid is replaced by a `TileLayer`, and the canvas overlay
moves on top of it — driven by the same viewport module, with the same tests
still passing.
