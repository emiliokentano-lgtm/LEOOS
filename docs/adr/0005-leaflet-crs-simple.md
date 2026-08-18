# ADR-0005 — Leaflet with `CRS.Simple` rather than MapLibre GL

**Status:** Accepted · 2026-08-18

## Context

The GTA V map is a flat raster image in a metre-based Cartesian coordinate system.
It is not a projection of a sphere, and it has no relationship to WGS 84.

MapLibre GL and Mapbox GL are built around Web Mercator. Using them for a flat
non-geographic image means either pretending the game world is a slice of Earth —
introducing a distortion that varies with latitude and quietly corrupts distance
calculations — or fighting the library's projection assumptions. Their real
strength, GPU-rendered vector tiles, is irrelevant to us: we have a raster image,
not vector data.

Leaflet's `L.CRS.Simple` maps coordinates linearly to the map plane. It is
precisely the abstraction this problem needs.

The known objection is marker performance. Leaflet markers are DOM elements, and
300 of them updating at 1 Hz will not hold frame rate.

## Decision

Leaflet with `CRS.Simple` for the base map and sparse interactive layers, plus a
**custom canvas overlay** for live units.

## Consequences

**Positive.** The coordinate transform is one affine function, shared between
client and server, easily unit-tested against landmark fixtures. Small library,
simple raster tile pyramid, no vector tile pipeline. Incident pins and operator
markers remain ordinary interactive Leaflet layers where their DOM cost is
negligible.

**Negative.** We write the unit overlay ourselves: hit-testing, interpolation,
z-ordering, and label placement are all ours. That is perhaps 400 lines, and it is
the part of the map that must be fast, so writing it deliberately is not a bad
outcome.

**Mitigated risk.** Marker performance is addressed by design from day one rather
than discovered during load testing.

## Alternatives considered

*MapLibre GL with a custom non-geographic source* — achievable, but every
contributor then has to understand why the map lies about the projection.

*PixiJS or a bare canvas with no map library* — maximum performance, but we would
rebuild panning, zooming, tile loading, and layer management from scratch.
