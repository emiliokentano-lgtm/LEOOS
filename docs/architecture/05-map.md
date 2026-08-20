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

The transform is a single affine map, defined **once** in
`packages/contracts/src/geo.ts` and used by every consumer. There are three
coordinate spaces, and separating them is load-bearing:

```ts
export const MAP = {
  worldMinX: -4000, worldMaxX: 4500,
  worldMinY: -4500, worldMaxY: 8500,
  tileSize: 256,
  minZoom: 0,
  maxZoom: 5,
  nativeZoom: 5,
} as const;

// 1. WORLD (metres) ↔ MAP PLANE (normalised u,v ∈ [0,1], v flipped) — tile space.
export function worldToMap(pos: WorldPosition): MapPosition;
export function mapToWorld(pos: MapPosition): WorldPosition;

// 2. WORLD ↔ Leaflet CRS.Simple plane, composed from the above. Used when the
//    tile pyramid lands (ADR-0005) so Leaflet re-derives nothing.
export function worldToLatLng(pos: WorldPosition): [number, number];
export function latLngToWorld(lat: number, lng: number): WorldPosition;

// 3. WORLD ↔ SCREEN pixels — packages/contracts/src/map-viewport.ts.
export function projectToScreen(viewport: Viewport, pos: WorldPosition): ScreenPoint;
export function screenToWorld(viewport: Viewport, point: ScreenPoint): WorldPosition;
```

Three properties matter:

- The functions are **pure and shared**, so a marker placed by clicking the map and
  a marker placed from an in-game coordinate land in the same place. Divergent
  client and server transforms are the classic bug here.
- `mapToWorld` is used when an operator drops an incident at a location, so the
  stored `pos_x/pos_y` are always GTA world coordinates. **The database stores
  world coordinates only**; map-space values are never persisted. This means
  re-calibrating or replacing the tile set never invalidates stored data.
- **Screen projection is built from world metres, not from the normalised
  plane.** The plane normalises each axis independently, so the world rectangle
  (8500 m across, 13000 m tall) becomes a unit square; rendering through it with
  one scale factor stretches the picture by 1.53× vertically — circles become
  ellipses, a 45° heading draws at 33°, and any distance read off the map is
  meaningless. The normalised plane keeps its job, addressing tiles, and stays
  out of the render path. Regression test: `map-viewport.test.ts` → *"is
  isotropic"*.

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

**[CONFIRM] — STILL OPEN.** The source map image must be licensed for our use.
This is a legal blocker and it has not been resolved.

Until it is, the map ships with an **explicitly-scaffolding coordinate grid** as
its base layer, with a banner on screen saying so. It is deliberately not styled
to resemble Los Santos: an approximation that looked like the real map would be
the map claiming to be something it is not (engineering rules 34, 35, 45).

Leaflet itself is therefore not yet a dependency — its only job here is loading a
pyramid that does not exist. See [ADR-0012](../adr/0012-defer-leaflet-until-tiles.md);
pan, zoom and projection are pure functions in
`packages/contracts/src/map-viewport.ts` in the meantime.

---

## 4. Rendering layers

| Layer | Renderer | Contents | Update rate |
| --- | --- | --- | --- |
| Base tiles | Leaflet `TileLayer` *(blocked — placeholder grid on canvas today)* | GTA map pyramid | static |
| Overlays | Leaflet `TileLayer` *(blocked)* | postal codes, districts | static |
| **Units** | **custom canvas overlay** | live units, org-coloured, heading arrows | 1 Hz, interpolated |
| Incidents | Leaflet layer group | priority-coloured pins, pulse on new | on event |
| Markers | Leaflet layer group | hazards, roadblocks, staging | on event |
| Selection | canvas | highlight ring, follow-mode | per frame |

**Unit rendering detail.** Each unit is drawn as a rounded chevron oriented to its
heading, filled with the organization colour, with the callsign beside it. State
is conveyed by shape and outline, not by animation:

- solid fill = available · hollow = busy
- red ring = panic
- dashed ring = covert (only ever drawn for a viewer cleared to see one)
- desaturated = stale (no update in >15 s)
- callsign labels are drawn only above the clustering threshold, plus always for
  the selected unit: zoomed out they collide into a smear that obscures the very
  markers they annotate, and the side panel already lists every unit by callsign

Markers that bunch up — a shift parked at the station, four cars converging on
one call — are collapsed by a **screen-space grid clusterer**
(`packages/contracts/src/map-cluster.ts`). Screen space rather than world space
because overlap is a property of what the eye sees at the current zoom; a fixed
grid rather than a hierarchy because the input set changes every tick and grid
membership is stable between frames.

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

Live unit visibility is computed **server-side, per subscriber**. It is
implemented once, as SQL, in `apps/api/src/modules/map/map.read.ts`, and every
unit query in that module applies it — there is no read path that does not:

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

Note that the FIRST clause carries no covert exclusion, deliberately: a
dispatcher who cannot see their own covert units cannot dispatch them. Covertness
lives on the **unit**, not the organization, because an agency runs marked and
unmarked units simultaneously.

`map.history` (position playback) is a separate, higher-risk permission: reviewing
where a unit was over the past hours is a surveillance capability, and every
playback query is audited. The permission and its audit action
(`map.history_viewed`) exist; the playback UI does not yet.

Coverage: `apps/api/test/map.test.ts` asserts each clause, and asserts absence
against the serialised body rather than a parsed field — anything a browser
receives is readable regardless of what the UI draws with it.

---

## 6. Interaction

- Click a unit → side panel with crew, org, callsign, status, vehicle, position,
  heading, speed, freshness, and an "assign to incident" action gated on
  `dispatch.assign` *(disabled until the dispatch module ships)*.
- Click an incident → its timeline and assigned units, with the same panel.
- Right-click the map → place marker / create incident here (each permission gated).
- **Follow mode** locks the viewport to a unit; used constantly during pursuits.
- Filter chips per organization and per unit type, persisted per user.
- Keyboard: `F` follow, `Esc` deselect, `1`–`9` toggle org filters in filter-bar
  order. Dispatchers work by keyboard, not by mouse.

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

---

## 8. Where positions come from

The map must eventually consume live FiveM data. No bridge exists yet, so the
subsystem is built around a seam rather than around what is behind it today.

```
   FiveM server                    ┌─────────────────────┐
   (not connected)  ─ ─ ─ ─ ─ ─ ─▶ │  PositionSource     │
                                   │  .start() .stop()   │
   MockPositionSource ────────────▶│  .status()          │
   (what ships today)              └──────────┬──────────┘
                                              │ pushes samples
                                              ▼
                                   ┌─────────────────────┐
                                   │ LivePositionStore   │  in-process Map today,
                                   │ (Redis stand-in)    │  Redis when provisioned
                                   └──────────┬──────────┘
                                              │ overlaid onto unit metadata
                                              ▼
                                   GET /api/v1/map/snapshot   ← full state
                                   POST /api/v1/map/tick      ← positions only
                                              │
                                              ▼
                                   ┌─────────────────────┐
                                   │  MapDataSource      │  RealtimeMapSource,
                                   │  (browser)          │  HttpMapSource fallback
                                   └──────────┬──────────┘
                                              ▼
                                   MapView → MapCanvas
```

**Server side.** `PositionSource` (`modules/map/sources/position-source.ts`) is
what the FiveM bridge will implement. It is deliberately PUSH-based — a source
fills the store, it is never polled — because a pull interface would force the
real bridge to buffer and would put per-request latency on the game server.

`MockPositionSource` is the only implementation today. Per engineering rules 34,
35 and 45 it is named as a mock, it refuses to register in production without
`ALLOW_MOCK_ADAPTERS`, it logs a warning at boot, and its `status()` reports
`kind: 'mock'` — which the map screen renders as "Simulated map", never as a
green light.

**Why a store between them.** Positions arrive at 1 Hz. Writing that to Postgres
is the ~13M rows/day that engineering rules 21 and 22 exist to prevent, so the
tick rate and the write rate are deliberately different numbers: every tick
updates the store, and the `unit.pos_*` columns — documented as a low-rate cache,
not a telemetry log — are flushed at a fraction of that. The store is an
in-process `Map` until Redis is provisioned; that is stated in the file rather
than discovered later, along with what it costs (no restart survival, single
node).

**Client side.** `MapDataSource` (`apps/web/lib/map/map-source.ts`) is the
browser-side seam, shaped for the WebSocket rather than for the poller that first
implemented it — `subscribe`-with-callbacks, not `getPositions()`.

**That seam has now been used, which is the test it was built for.**
`RealtimeMapSource` (`apps/web/lib/map/realtime-map-source.ts`) takes batched
positions off the `map:units` topic (§3 of
[03-realtime](03-realtime.md)) and is a second implementation of the same
interface. The renderer, the filters, the detail panel and the follow-mode camera
were not touched.

It COMPOSES with `HttpMapSource` rather than replacing it. Snapshots still come
over HTTP — a snapshot is a large authorized read the socket has no business
carrying — and the tick poll resumes automatically if the socket drops, so a
console on a network that blocks WebSockets keeps working with no special case
anywhere in the UI.

A position batch deliberately does not repeat a unit's status or assignment,
which would otherwise be resent for every unit every second. The source keeps a
small metadata cache from the last snapshot and refetches on `unit.status.updated`
and the incident events. A unit it has never seen sets `resyncRequired` — it never
draws a marker with a guessed status.

The wire shapes (`MapSnapshot`, `MapTick`, `UnitPositionDelta`) were already the
ones the socket carries. Both transports recompute visibility per delivery rather
than caching it per connection, which is what makes a mid-session permission
change take effect immediately with no revocation machinery.

**What the client is told about the units it holds.** The tick accepts a
`knownUnitIds` list, used only to compute removals and to detect that a resync is
needed. It can never widen what comes back — the server re-derives the visible
set from the caller's permissions on every tick — so a forged list gains a caller
nothing.
