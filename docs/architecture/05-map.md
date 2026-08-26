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
| **Areas & routes** | **canvas, below the operational layers** | drawn cordons and hand-drawn approach lines | on event (§10) |
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

The subsystem was built around a seam rather than around what was behind it at
the time. **That seam is now carrying real traffic**: the `leoos_bridge` FiveM
resource ships (see [04-fivem-integration](04-fivem-integration.md)) and
`FiveMPositionSource` is a second implementation of the same interface. The mock
remains, selected by `POSITION_SOURCE`, because a deployment with no game server
still needs a map that says so.

```
   FiveM server ──HMAC──▶ ingest ─▶ ┌─────────────────────┐
   (leoos_bridge)                   │  PositionSource     │
                                    │  .start() .stop()   │
   MockPositionSource ─────────────▶│  .status()          │
   (POSITION_SOURCE=mock)           └──────────┬──────────┘
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

There are two implementations. `FiveMPositionSource` is fed by the signed ingest
endpoints and reports what it actually has — "1 game server(s) — … reporting,
with 9 player(s) online", or "No game server is reporting" when nothing is.
`MockPositionSource` is, per engineering rules 34, 35 and 45, named as a mock,
refuses to register in production without `ALLOW_MOCK_ADAPTERS`, logs a warning
at boot, and reports `kind: 'mock'` — which the map screen renders as "Simulated
map", never as a green light. Neither source can report a state it has not
earned; that is the whole reason `status()` exists.

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

---

## 9. Live units on the map

Connecting the FiveM feed to the screen turned out to be less about drawing and
more about **what may re-render when a unit moves**. Positions arrive once a
second; callsigns, crews, vehicles and assignments change a handful of times a
shift. Holding both in one piece of React state means every position sample
re-renders the whole screen — 150 unit rows, the filter bar, the detail panel —
to move some pixels on a canvas that was going to repaint anyway.

### 9.1 One store, three granularities

`MapUnitStore` (`apps/web/lib/map/unit-store.ts`) splits the state by how often
each part changes:

| | What it is | Where it lives | Changes |
| --- | --- | --- | --- |
| **Roster** | who exists, and what they are | React state, via `useSyncExternalStore` | a few times a shift |
| **Positions** | where they are | a plain `Map`, **not** React state | 1 Hz |
| **Freshness** | whether a position can still be trusted | derived, published only on a **threshold crossing** | twice in a unit's life |

The canvas subscribes to positions directly and reads them inside its own
animation frame, which is the only place they are needed sixty times a second.
React never sees a position unless a component asks for one specific unit — the
detail panel and the panic bar do, the 150-row list deliberately does not.

Three hooks expose it (`lib/map/use-unit-store.ts`): `useRoster`,
`useUnitPosition` (one unit, ~1 Hz) and `useUnitFreshness`. `useUnitPosition`
returns the *same object* when a sample is identical, so a resync redelivering
unchanged coordinates does not wake anything.

Positions are never written onto the `MapUnit` objects React renders from.
Mutating those would make a memoised row comparing `prev.unit === next.unit`
never update — the version of this optimisation that silently breaks a screen
months later.

The walkthrough measures the result rather than asserting it: with the feed at
10 Hz, the unit list records **zero DOM mutations over eight seconds**.

### 9.2 The freshness lifecycle

A position has an age, and past two thresholds it stops meaning what it says:

```
   reported ──15 s──▶ stale ──45 s──▶ offline        (never reported: "no fix")
     live             faded            hollow ring, no heading
```

- `UNIT_STALE_AFTER_MS` = 15 s — roughly a city block at speed. The marker
  desaturates and the row reads **Stale**; the position is where the unit *was*.
- `UNIT_OFFLINE_AFTER_MS` = `FIVEM_POSITION_TTL_MS` = 45 s. Deliberately the
  *same constant* as the ingest layer's TTL rather than a round number: past that
  point the server has stopped broadcasting the unit, so a client still drawing
  it as tracked would be asserting something the feed no longer says. Tying them
  together means they cannot drift into a window where the client believes it is
  tracking a unit the server already dropped.

**Offline is not deletion.** The unit stays in the roster, stays selectable, and
its last known position and last-update time stay readable — "we do not know
where this unit is" and "this unit never existed" are different facts, and only
the first is true (engineering rules 24, 25). `unknown` ("no fix") is kept
separate from `offline` for the same reason: one has never reported, the other
was being tracked a minute ago.

Freshness is recomputed on a **one-second sweep** but published only when a level
actually changes. A unit's age changes every second; its level changes twice in
its whole life, so that is what React is told about.

### 9.3 Filtering

`MapFilterState` gained a `freshness` axis, kept deliberately apart from
`statusKeys` in both the model and the filter bar. A unit's operational status is
what the officer says they are doing; its freshness is whether we still know
where they are. A unit can perfectly well be *Available* and *offline* — which is
precisely the combination a dispatcher most needs to be able to find.

`matchesUnitFilter` takes an already-computed `LocationFreshness` rather than a
clock. That keeps the predicate pure — a `Date.now()` inside a function called
during render is an impure read React's compiler rightly rejects — and it means
the canvas and the side list filter on the *same* value, so two views of one
fleet cannot disagree about which units are in it.

### 9.4 Panic, without relying on animation

A blinking marker is invisible for half its duty cycle, unreadable to a
colour-blind operator, disabled outright by `prefers-reduced-motion`, and useless
when the unit is off-screen. So there are **three static mechanisms, each of
which works on its own** (`app/(app)/map/panic-locator.tsx`):

1. **A standing bar** across the top of the map — `role="alert"`, one row per
   unit in panic, with callsign, organization, crew, live position and a
   **Locate** button that takes the camera there. It is **not filterable**: a
   panic an operator has filtered away is a panic they will not answer.
2. **An off-screen bearing arrow** clamped to the map edge, positioned where the
   line from the centre crosses it — so its place on the border encodes the
   direction — labelled with the callsign and the distance. "Obvious without
   relying on flashing" means an operator must be able to *find* the location,
   and a marker they cannot see does not help them.
3. **The marker itself**: filled halo, two concentric rings, four crosshair ticks
   and a permanently drawn label. All static.

The list row is marked structurally too — a left rule, not only a colour — so it
survives a monochrome display.

### 9.5 From the map to the board

The unit detail panel's **View unit** action links to `/dispatch?unit=<id>`. The
dispatch page reads that parameter server-side and passes it to `UnitBoard`,
which scrolls the row into view and highlights it. It is *scrolled to*, not
*filtered to*: an operator who came to look at one unit still needs the rest of
the board around it to do anything useful with what they find.

The parameter cannot widen anything — the board contains what the API already
decided to send, so an id belonging to another organization simply matches
nothing.

### 9.6 What was actually tested

`apps/web/scripts/live-map-check.mjs` drives a real browser against a real API
while `apps/web/scripts/fivem-simulator.mjs` pushes positions through the genuine
signed ingest path. Everything between the two is production code. It covers
multiple units across agencies, a 10 Hz burst, a dropped and restored browser
connection, a fleet going quiet through stale into offline, both filter axes,
panic in all three of its forms, and organization isolation — checked while FIB
units are actively transmitting, against a session that does not hold
`map.track_all_orgs` and one that does.

That walkthrough is what found the game-server restart defect described in
[04-fivem-integration §The restart problem](04-fivem-integration.md).

---

## 10. Areas and routes

Operators draw two things on the map: **areas** — a cordon, a search grid, a
perimeter — and **routes**, a line indicating an approach or a corridor.

### 10.0 A route is not navigation

**This repository has no road graph.** There is no routing engine, no navigation
mesh, and nothing that knows a road from a field. A route in LEOOS is *a polyline
a human drew*, and every name in the schema, the contracts, the API and the UI
says so. The detail panel states it in words:

> A line drawn by hand. It is not a navigated route and does not follow roads.

A route's size is reported as its **drawn length**, never as a distance to travel
and never as a time. That is engineering rule 45 applied to a feature name:
calling it navigation would be a claim the software cannot make, and an operator
who believed it would follow a line nothing ever checked against a map.

### 10.1 A separate table, and not a parallel model

`map_shape` is its own table rather than a nullable geometry column on
`map_marker`. A marker is a point; a shape is a sequence of them. One table would
mean every marker row carrying two unused arrays and every query filtering on
kind.

What *should* be shared is shared, and shared as the same code rather than a
copy:

| Concern | Shared with markers |
| --- | --- |
| Permission | `map.markers.manage` — the same one |
| Which organization it may be pinned to | `resolveOverlayOrganization()` |
| Whether the caller may change it | `assertOverlayScope()` |
| Visibility clause | the same org / global / `track_all_orgs` rule |
| Expiry | filtered in SQL on read, no cleanup job required |
| Deletion | soft, per [ADR-0008](../adr/0008-soft-deletion.md) |

A separate `map.shapes.manage` permission was considered and rejected: it would
give every installation a second switch to forget to set, guarding a capability
nobody has ever wanted to grant separately. Drawing a cordon and dropping a
roadblock pin are the same job.

### 10.2 Geometry, and the three places the ceiling lives

Points are stored as **two parallel `double precision[]` columns**, not PostGIS
and not `jsonb`. PostGIS answers spatial *queries* — "which shapes contain this
point", "which routes cross this area" — and this product asks none of them:
shapes are drawn, listed and rendered, never intersected. Adding the extension to
store a coordinate list would be a dependency with no second use (rule 29).
Arrays rather than a blob because the **database** can then constrain the point
count, which `jsonb` cannot.

A shape's geometry is an array whose size the sender chooses, which is the one
way it differs from a marker in kind rather than degree. So the 500-point ceiling
exists in three places that cannot disagree:

| Where | What it stops |
| --- | --- |
| `z.array(...).max(MAP_SHAPE_MAX_POINTS)` in the route schema | A 100 000-point array, *before* it is parsed into objects |
| `validateShapeGeometry()` in the service | The same, if a future caller bypasses the route |
| `CHECK (array_length(points_x, 1) <= 500)` | The same, if a script bypasses the service |

The same three-layer treatment covers the minimum (3 for an area, 2 for a route)
and the pairing invariant — the two arrays are one geometry, and a pair that
disagreed in length would produce a point with an undefined coordinate.
Coordinates are bounded to the world at the schema edge: a shape reaching to
(1e9, 1e9) is not a rendering nuisance, it destroys the auto-fit for every other
operator on the map.

**The kind cannot change.** An update re-validates against the *stored* kind, so a
two-point route cannot become an "area" enclosing nothing. The field is absent
from the update schema rather than present and refused.

### 10.3 What it costs to draw them

Shapes are slow-changing data and are kept out of the fast path entirely.
Positions never enter React state (§9.1); shapes are the opposite case — they are
a prop, because they change a handful of times an hour — and the work that would
otherwise land in the draw loop is hoisted out of it:

- **Bounding boxes and label anchors are computed once per change**, in a
  `useMemo` keyed on the filtered shape array — so they are recomputed when a
  shape is drawn, edited or removed, or when the filter changes, and never per
  frame. A position tick does not touch it: ticks go straight into the unit
  store and never call `setState` (§9.1), so the snapshot object the memo
  depends on is stable between them. An off-screen shape then costs four
  comparisons per frame instead of a projection per point.
- **One path per shape**, stroked once, rather than a `beginPath`/`stroke` pair
  per segment.
- **A vertex stride at low zoom.** Zoomed out, adjacent points land on the same
  pixel; the polyline is decimated to roughly one point per two screen pixels.
  The stored shape is untouched — this is a drawing decision, not an edit — and
  at any zoom where the detail is visible the stride is 1. The last point always
  lands whatever the stride, because a route that stops short of where it was
  drawn to is a wrong route.

The cull and the stride live in `shapeRenderPlan()` in `@leoos/contracts`, so the
benchmark measures **the same function the canvas calls**. A performance claim
about code the benchmark does not run is not a measurement.

`pnpm --filter @leoos/contracts bench` (600 frames, 1600×900, panning across the
world; "whole map" is the scale at which the world fits the viewport, where the
cull can discard nothing, and "street" is `MAX_SCALE`):

| Case | prep ms | ms/frame | drawn | projections/frame |
| --- | --- | --- | --- | --- |
| 10 hand-drawn shapes (12 pts), whole map | 0.09 | 0.016 | 8.6 | 112 |
| 50 hand-drawn shapes (12 pts), whole map | 0.03 | 0.004 | 42.1 | 548 |
| 50 hand-drawn shapes (12 pts), street zoom | 0.01 | 0.001 | 3.2 | 42 |
| 200 hand-drawn shapes (12 pts), whole map | 0.08 | 0.011 | 168.1 | 2 185 |
| 50 shapes at the 500-point ceiling, whole map | 0.14 | 0.006 | 41.2 | 1 071 |
| **200 shapes at the 500-point ceiling, whole map** | **0.60** | **0.033** | **170.4** | **4 708** |
| 200 shapes at the 500-point ceiling, street zoom | 0.57 | 0.016 | 13.3 | 4 543 |

The worst case constructed — 200 shapes each at the ceiling, a hundred thousand
points, far more than any real board carries — costs **0.033 ms per frame**, or
0.2% of a 60 Hz budget. The stride is what makes that true: 100 000 stored points
become 4 708 projections. The script fails at 1 ms, which is 6% of a frame.

**What the benchmark does not measure is canvas rasterisation.** Filling and
stroking is the browser's work, proportional to pixels rather than to shapes, and
a Node process has no GPU to measure it on. Frame behaviour on the real page is
covered by `live-map-check.mjs`, which measures DOM mutations under a live feed.
Reporting the number above *as a frame time* would be a claim this benchmark
cannot make.

### 10.4 Selection, and why an area does not swallow clicks

There is deliberately **no polygon hit-testing**. An area covering half the map
would intercept every click meant for the units inside it — which is exactly
backwards, since those units are the reason the cordon was drawn. The **label is
the handle**: a shape is selected by clicking the thing that names it, and every
shape carries a permanent label, drawn with no hover and no animation.

Shapes are drawn **under** markers, incidents and units. A cordon is context; a
unit standing in it is the subject, and the context must never be drawn over the
subject. A route is dashed and an area is solid, so the two are distinguishable
without colour and without a legend; an area is filled at 10% opacity — a wash,
not a fill, because it must never hide what is standing in it.

### 10.5 The drawing tool

Drawing is **modal**. While the tool is open a click places a point and nothing on
the map is selectable, because a tool where clicking sometimes draws and
sometimes selects will draw when you meant to select. The mode is visible — a
toolbar naming what is being drawn, a crosshair cursor — and dragging still pans,
so a shape that runs off the screen does not force a restart.

`Esc` leaves the tool, `Backspace` removes the last point, `Enter` finishes.
Escape leaves the *tool* before it clears a selection, because the tool is what
the operator is inside; every other map shortcut is suppressed while drawing, so
`F` cannot start following a unit halfway through a cordon. **Finish** is disabled
below the minimum with the reason on the button rather than enabled and then
refused, and the point count and what is still needed are stated in the toolbar.

The dialog that names a finished shape shows how many points it has and how big
it is, and does not show the geometry as numbers: a cordon typed as coordinates
is a cordon nobody meant.

### 10.6 What was actually tested

`apps/api/test/map.test.ts` covers the marker questions again for shapes — a
shape pinned to another organization, a shape another organization tries to edit
or delete, a global shape scoped down, expiry without a cleanup job, soft
deletion with both audit rows — plus the ones that are new because geometry is a
list:

- an area with two points, and a route with one, are refused
- 501 points is refused; **500 exactly is accepted**, so the cap is not off by one
- a point outside the world is refused
- a point carrying an extra key is refused, so nothing can be smuggled into one
- a route cannot be turned into an area
- the database refuses an oversized array and a mismatched pair *directly*, with
  the schema and the service bypassed
- the audit row records the point count, not the geometry

Each guard was verified by breaking it: with `assertOverlayScope`,
`resolveOverlayOrganization` and `assertDrawable` disabled for shapes, **nine of
these tests fail**.

`apps/web/scripts/live-map-check.mjs` adds the two questions a unit test cannot
answer: whether the modal drawing tool places points where they are clicked, and
whether a shape stays inside its organization once it is in a live payload. It
draws a four-point cordon through the real tool, reads it back from the server,
and then opens a session in another organization and searches its **raw snapshot
text** for the label and the id — a shape that reached the browser at all has
already leaked, whatever the screen chooses to draw.

**It earned its keep immediately.** The cordon came back as `undefined`: the
scope dropdown offered "organizations that can appear on this caller's map",
which includes agencies that merely share on the public map, and defaulted to the
first of them — LSMD, for a PD sergeant. The API refused the save, correctly,
*after* the shape had been drawn. Two things came out of that: a caller without
`map.track_all_orgs` is now offered no scope field at all, since the organization
they are acting in is the only value that would be accepted; and the marker
dialog, which the shape dialog had inherited the pattern from, had the same
defect and was fixed with it. The walkthrough now asserts the cordon belongs to
the agency that drew it.
