# 06 — Design System & UI Architecture

The brief asks for something that reads as a professional emergency operations
platform. That is a specific visual tradition — CAD systems, air traffic consoles,
NOC walls — and it has rules. It is not "a dark admin template".

---

## 1. Principles

1. **Information density is a feature.** A dispatcher needs 30 rows visible, not 8
   generously padded cards. Default row height 32 px, base font 13 px.
2. **Colour means status, and nothing else.** Chrome is neutral greys. Colour is
   reserved for operational state — priority, duty status, flags, org identity.
   A decorative accent colour anywhere in the chrome dilutes the signal.
3. **Hierarchy through weight and spacing, not boxes.** Few borders, minimal
   shadows, no nested card-in-card.
4. **Motion is feedback, never decoration.** 120–180 ms transitions on state
   change. The only looping animation in the entire product is the panic pulse,
   because it must be seen from across a room.
5. **Keyboard first.** Every primary action has a shortcut; the command palette
   (`Ctrl+K`) reaches every screen and every search.
6. **Nothing important is hidden behind a hover.** Operators use this under
   pressure and sometimes on touch screens.

Explicitly rejected: neon glows, gradient backgrounds, glassmorphism, oversized
rounded cards, emoji as iconography, animated counters, decorative illustrations.

---

## 2. Tokens

Dark-first. A light theme is out of scope for v1 but tokens are structured so it
remains possible.

```css
:root {
  /* surfaces — five steps, tight range, no pure black */
  --bg-base:      #0b0e14;   /* app background        */
  --bg-surface:   #12161f;   /* panels, sidebar       */
  --bg-raised:    #171c27;   /* cards, table headers  */
  --bg-overlay:   #1d2330;   /* dialogs, popovers     */
  --bg-hover:     #232a3a;

  --border-subtle: #1e2532;
  --border:        #2a3242;
  --border-strong: #3a4459;

  /* text — 4 steps */
  --text-primary:   #e6eaf2;
  --text-secondary: #9aa5b8;
  --text-tertiary:  #6b7686;
  --text-disabled:  #4a5260;

  /* status — the only saturated colours in the system */
  --status-available: #2ea86b;
  --status-busy:      #d99a2b;
  --status-onscene:   #3b82d9;
  --status-emergency: #d94141;
  --status-offline:   #5a6474;
  --status-panic:     #ff3b3b;

  /* priority */
  --priority-1: #ff3b3b;  --priority-2: #ff7a2f;
  --priority-3: #d99a2b;  --priority-4: #3b82d9;
  --priority-5: #6b7686;

  --focus-ring: #4d8ee8;
}
```

Organization colours live in the `organization` table, not in CSS. Adding an
organization must not require a stylesheet edit.

**Typography.** `Inter` (or system UI stack) for interface text; `JetBrains Mono`
for callsigns, plates, incident numbers, coordinates, and timestamps — anything
that gets read aloud over radio or compared character by character. Tabular
figures everywhere numbers align in columns.

**Radii.** 2 px on inputs and buttons, 4 px on panels. Nothing larger. Rounded
corners past 4 px read as consumer software.

---

## 3. Layout

```
┌────────────┬───────────────────────────────────────────────────┐
│            │  Top bar: breadcrumb · global search · status ·   │
│            │           panic · user menu              (48 px)  │
│  Sidebar   ├───────────────────────────────────────────────────┤
│  (240 px,  │                                                   │
│  collapses │  Page content                                     │
│  to 56 px) │                                                   │
│            │                                                   │
│            ├───────────────────────────────────────────────────┤
│            │  Status bar: org · unit · duty status · live feed  │
│            │              indicator · clock          (28 px)   │
└────────────┴───────────────────────────────────────────────────┘
```

**Sidebar** — persistent, two sections:

- *Operations* (always visible): Dashboard, Search, Map, Dispatch.
- *Management* (permission-driven): Persons, Vehicles, Personnel, Organization,
  Roles, Administration, Audit Logs.

Navigation items are declared with their required permission and filtered on the
**server** in a Server Component. Items the user cannot access are not rendered
and their existence is not disclosed in the HTML payload:

```ts
const NAV = [
  { href: '/dashboard',  label: 'Dashboard', icon: Gauge,   permission: null },
  { href: '/search',     label: 'Search',    icon: Search,  permission: null },
  { href: '/map',        label: 'Map',       icon: Map,     permission: 'map.view' },
  { href: '/dispatch',   label: 'Dispatch',  icon: Radio,   permission: 'dispatch.view' },
  { href: '/persons',    label: 'Persons',   icon: Users,   permission: 'persons.view' },
  { href: '/vehicles',   label: 'Vehicles',  icon: Car,     permission: 'vehicles.view' },
  { href: '/personnel',  label: 'Personnel', icon: IdCard,  permission: 'personnel.view' },
  { href: '/organization', label: 'Organization', icon: Building, permission: 'organization.view' },
  { href: '/roles',      label: 'Roles',     icon: Shield,  permission: 'roles.view' },
  { href: '/admin',      label: 'Administration', icon: Settings, permission: 'admin.users' },
  { href: '/audit',      label: 'Audit Logs', icon: ScrollText, permission: 'admin.audit_logs' },
] as const;
```

An **organization switcher** sits at the top of the sidebar for users with more
than one membership. Switching changes the active organization context for the
whole session — permissions, dispatch, and personnel views are all scoped to it.
The active org is part of the URL context so links are shareable and unambiguous.

The **status bar** is always visible and always shows: current organization,
current unit/patrol, current duty status (click to change), live-feed connection
state, and a 24-hour clock. An operator must never have to navigate to find out
whether the system still thinks they are on duty.

---

## 4. Component inventory

Built once in `apps/web/components/ui`, then used everywhere:

| Component | Notes |
| --- | --- |
| `DataTable` | virtualised, sortable, column-configurable, sticky header, keyboard row navigation, density toggle, URL-persisted state |
| `StatusChip` | duty/incident/unit status with dot + label; colour from tokens |
| `PriorityBadge` | P1–P5, colour-coded, monospace |
| `OrgBadge` | short name in the org's colour, from data |
| `Panel` | titled surface with optional actions; the only "card" |
| `SplitLayout` | list + detail, resizable, persisted |
| `Timeline` | append-only incident log |
| `PersonCard` / `VehicleCard` | compact result rows with flag indicators |
| `CommandPalette` | `Ctrl+K` — navigation, search, actions |
| `PermissionGate` | hides UI; explicitly documented as cosmetic |
| `ConfirmDialog` | required for `risk: high` actions, with typed confirmation for destructive ones |
| `EmptyState` | one line, one action, no illustration |
| `AsyncBoundary` | wraps loading / error / empty for any async region — see §4a |
| `ErrorState` | message, retry action, and a request id for support |
| `Skeleton` | shape-matched loading placeholder, never a spinner in a table |
| `LiveIndicator` | connected / reconnecting / offline |

`DataTable` deserves emphasis: persons, vehicles, personnel, incidents, units,
audit logs, and search results are all the same interaction. Building it once and
well is the single highest-leverage UI investment in the project.

---

## 4a. Async state convention (rule 26)

Every region that loads data has four visual states, and all four are the
component author's responsibility — not something added later when a screen looks
wrong. This is an operational system: an ambiguous blank panel during an incident
is a failure, because the operator cannot tell whether there is nothing to show or
whether the system is broken.

```tsx
<AsyncBoundary
  query={incidentsQuery}
  loading={<Skeleton rows={8} />}
  error={(e, retry) => <ErrorState error={e} onRetry={retry} />}
  empty={<EmptyState title="No active incidents" action={createIncident} />}
>
  {(incidents) => <IncidentTable data={incidents} />}
</AsyncBoundary>
```

| State | Rule |
| --- | --- |
| **Loading** | Shape-matched skeletons, not spinners — a table loads as grey rows so the layout does not jump. Spinners only for actions under 1 s. |
| **Error** | What failed, a retry control, and the request id. Never a bare "Something went wrong". A failed live feed degrades to the last REST data with a visible `LiveIndicator`, rather than blanking the screen. |
| **Empty** | Distinguishes "no results for this filter" from "nothing exists yet" — different text, different action. |
| **Stale** | Data older than its refresh interval is dimmed with a timestamp. On a dispatch board, silently showing stale unit status is worse than showing none. |

`AsyncBoundary` is a lint-enforced requirement: a component calling `useQuery`
without rendering all four states fails review. The distinction between *empty*
and *stale* is the one most often skipped and the one that matters most here.

---

## 5. Screen sketches

**Dashboard** — three columns: active incidents by priority (left, primary), unit
board grouped by status (centre), alerts and statistics (right). Above the fold:
the user's own status, unit, and current assignment. Nothing requires scrolling to
find out whether something needs attention.

**Dispatch / Leitstelle** — the densest screen. Left: incident queue, sorted by
priority then age, with an age colour ramp. Centre: selected incident detail plus
its timeline and assignment controls. Right: unit board, drag-to-assign, with
availability counts per org. A collapsible map strip along the bottom. Designed to
be usable on a single 1920×1080 display without scrolling.

**Map** — full-bleed map, floating filter panel, collapsible unit list, selection
side panel. Chrome overlays the map rather than shrinking it.

**Personnel** — roster table with rank, callsign, status, last seen. Row actions
(promote, demote, transfer, terminate) render **only** where the hierarchy rule
permits them for that specific row, computed server-side per row — so an operator
never sees an action that would be refused.

---

## 6. Accessibility

Not optional, and not expensive if done from the start:

- WCAG AA contrast for all text; status colours verified against their backgrounds
  (the greens and ambers above are chosen for this, which is why they are muted).
- **Colour is never the only signal** — every status chip carries a label, every
  priority a number, every map unit a shape difference. Around 8% of men have some
  colour vision deficiency, and red/green status is the classic failure.
- Full keyboard operation, visible focus rings, logical tab order.
- `aria-live` regions for incoming incidents and panic alerts.
- Respects `prefers-reduced-motion` — including the panic pulse, which becomes a
  static high-contrast ring.
