# 05 — Map Subsystem

The map is the operational centre of the product, not a widget. It gets its own
document because its constraints (non-geographic projection, hundreds of moving
markers, per-viewer visibility filtering) are unlike anything else in the system.

---

## 1. Library choice

**Leaflet with `L.CRS.Simple`.**

The GTA V map is a flat raster image, not a globe. `CRS.Simple` maps pixel
coordinates directly to map coordinates with no projection maths, which is exactly
what we need. MapLibre GL and Mapbox GL assume a Web Mercator sphere; using them
here means either fighting the projection or generating vector tiles we do not
have.

The usual objection to Leaflet is marker performance — and it is valid: Leaflet's
default marker is a DOM element, and 300 of them animating at 1 Hz will not hold
60 fps. The answer is not a different library, it is a different rendering
strategy: **units render on a single canvas overlay**, not as DOM markers. Static,
sparse things (operator markers, incident pins) stay as normal Leaflet layers
where their interactivity is worth the DOM cost.

See [ADR-0005](../adr/0005-leaflet-crs-simple.md).

---

## 2. Coordinate transform

GTA V world coordinates are a right-handed system in metres with the origin near
central Los Santos; the playable area spans roughly:

```
x ∈ [−4000, 4500]      y ∈ [−4500, 8500]      z ∈ [−500, 1500]
```

Leaflet `CRS.Simple` works in an unprojected `(lat = y, lng = x)` plane with the
tile pyramid anchored at some zoom level. The transform is a single affine map,
defined **once** in `packages/contracts/src/geo.ts` and used by every consumer:

```ts
// Calibrated against two known landmarks; see calibration note below.
export const MAP = {
  worldMinX: -4000, worldMaxX: 4500,
  worldMinY: -4500, worldMaxY: 8500,
  tileSize: 256,
  minZoom: 0,
  maxZoom: 5,
  nativeZoom: 5,
} as const;

export function worldToMap(x: number, y: number): [number, number];  // → [lat, lng]
export function mapToWorld(lat: number, lng: number): [number, number];
```

Two properties matter:
- The functions are **pure and shared**, so a marker placed by clicking the map and
  a marker placed from an in-game coordinate land in the same place. Divergent
  client and server transforms are the classic bug here.
- `mapToWorld` is used when an operator drops an incident at a location, so the
  stored `pos_x/pos_y` are always GTA world coordinates. **The database stores
  world coordinates only**; map-space values are never persisted. This means
  re-calibrating or replacing the tile set never invalidates stored data.

**Calibration:** the exact constants must be derived by placing two known
in-game landmarks (e.g. Legion Square, Sandy Shores airfield) and solving the
affine transform. This is a 30-minute task in Phase 6, not a guess, and the
resulting constants get a unit test with the landmark coordinates as fixtures.

---

## 3. Tile pipeline

A pre-rendered raster pyramid, served as static files.

```
map source image (single large GTA map render)
        │  scripts/tiles.ts  (sharp)
        ▼
public/map/tiles/{z}/{x}/{y}.webp     +  .png fallback
        │
        ▼
served by nginx / CDN with long cache headers (immutable, 1 year)
```

- Zoom 0–5, 256 px tiles, WebP with PNG fallback.
- Generated once by a script committed to the repo, not at runtime.
- Tiles are **not** in the API's request path — they are static assets. The API
  never serves an image.
- Optional overlay layers as separate pyramids: satellite/atlas/road styling, plus
  an interior/postal overlay. Layer switching is a Leaflet `layerControl`.

**[CONFIRM]** The source map image must be licensed for our use. This is a legal
blocker on Phase 6 and must be resolved before that phase starts.

---

## 4. Rendering layers

| Layer | Renderer | Contents | Update rate |
| --- | --- | --- | --- |
| Base tiles | Leaflet `TileLayer` | GTA map pyramid | static |
| Overlays | Leaflet `TileLayer` | postal codes, districts | static |
| **Units** | **custom canvas overlay** | live units, org-coloured, heading arrows | 1 Hz, interpolated |
| Incidents | Leaflet layer group | priority-coloured pins, pulse on new | on event |
| Markers | Leaflet layer group | hazards, roadblocks, staging | on event |
| Selection | canvas | highlight ring, follow-mode | per frame |

**Unit rendering detail.** Each unit is drawn as a rounded chevron oriented to its
heading, filled with the organization colour, with the callsign beside it. State
is conveyed by shape and outline, not by animation:

- solid fill = available · hollow = busy · doubled outline = on scene
- red pulsing ring = panic
- desaturated = stale (no update in >15 s)

Between the 1 Hz position updates, positions are **interpolated** across the tick
with `requestAnimationFrame`. Without it, units visibly jump once per second,
which reads as broken. With it, movement looks continuous while the data rate
stays at 1 Hz. Interpolation is capped: if the gap between samples exceeds 3 s the
unit snaps rather than sliding across half the map.

Rendering is skipped entirely when the tab is hidden (`visibilitychange`), and the
subscription is dropped after 5 minutes hidden — a background map tab should not
consume a live feed slot.

---

## 5. Visibility rules

Live unit visibility is computed **server-side, per subscriber**:

```
visible(viewer, unit) =
     unit.organizationId ∈ viewer.organizations
  or viewer has map.track_all_orgs
  or ( unit.organization.settings.shareOnPublicMap
       and viewer has map.track_units
       and not unit.covert )
```

Rationale: covert federal or ICE units must not be visible to every officer, and
the enforcement cannot be a client-side filter — anything sent to the browser is
readable. Filtering happens before serialisation.

`map.history` (position playback) is a separate, higher-risk permission: reviewing
where a unit was over the past hours is a surveillance capability, and every
playback query is audited.

---

## 6. Interaction

- Click a unit → side panel with member, org, rank, callsign, unit, status,
  vehicle, and a "assign to incident" action gated on `dispatch.assign`.
- Click an incident → its timeline and assigned units, with the same panel.
- Right-click the map → place marker / create incident here (each permission gated).
- **Follow mode** locks the viewport to a unit; used constantly during pursuits.
- Filter chips per organization and per unit type, persisted per user.
- Keyboard: `F` follow, `Esc` deselect, `1–6` toggle org filters. Dispatchers work
  by keyboard, not by mouse.

---

## 7. Performance targets

| Metric | Target |
| --- | --- |
| Units rendered at 60 fps | 300 |
| Map tick payload | < 5 KB |
| Time to first interactive map | < 1.5 s on a warm cache |
| Memory growth over an 8 h shift | < 50 MB |

The 8-hour figure is deliberate: dispatchers leave this tab open for entire
sessions. A slow leak that is invisible in a 5-minute test will take down a shift.
The unit overlay therefore uses fixed-size structures keyed by identifier and
prunes on expiry rather than accumulating history in the browser.
