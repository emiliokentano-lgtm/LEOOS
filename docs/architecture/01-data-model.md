# 01 — Data Model

PostgreSQL 16. All tables use `uuid` v7 primary keys (time-sortable, index-friendly),
`timestamptz` for all times, and `citext` for case-insensitive natural keys.

Notation: `PK` primary key, `FK` foreign key, `U` unique, `IX` index,
`CK` check constraint, `→` references.

---

## 1. Conceptual separation

The brief's most important modelling rule is that three things are distinct:

```
   user_account          person                organization_member
   ───────────           ──────                ───────────────────
   "who logs in"    ≠    "who exists in     ≠  "the employment relationship
                          the game world"        between the two and an org"
```

A dispatcher may have an account and no person record. A wanted criminal has a
person record and no account. An officer has all three. Merging any two of these
would make the system unable to represent perfectly normal situations, so they
stay separate and are joined explicitly.

---

## 2. Identity & access

### `user_account`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| email | citext | U, NOT NULL |
| username | citext | U, NOT NULL |
| password_hash | text | Argon2id, NOT NULL |
| status | enum | `pending_verification` \| `active` \| `suspended` \| `disabled` |
| email_verified_at | timestamptz | null until verified |
| totp_secret_enc | bytea | null unless 2FA enabled; encrypted at rest |
| totp_enabled_at | timestamptz | |
| failed_login_count | int | default 0 |
| locked_until | timestamptz | progressive lockout |
| password_changed_at | timestamptz | invalidates older sessions |
| last_login_at | timestamptz | |
| created_at / updated_at | timestamptz | |

`CK`: `status <> 'active' OR email_verified_at IS NOT NULL`.

### `user_global_role`
Global capabilities, deliberately separate from org roles so no organization-level
edit can ever produce a global privilege.

| Column | Type | Notes |
| --- | --- | --- |
| user_id | uuid | FK → user_account, PK part |
| capability | enum | `global_admin` \| `user_admin` \| `org_admin` \| `audit_viewer` \| `support` |
| granted_by | uuid | FK → user_account |
| granted_at | timestamptz | |

PK `(user_id, capability)`.

### `session`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| user_id | uuid | FK → user_account, IX |
| token_hash | bytea | U — SHA-256 of the opaque token; the raw token is never stored |
| ip | inet | |
| user_agent | text | |
| created_at / last_seen_at | timestamptz | |
| expires_at | timestamptz | absolute cap |
| revoked_at | timestamptz | null = live |
| revoked_reason | text | `logout` \| `admin` \| `password_change` \| `privilege_change` |

`IX` partial on `(user_id) WHERE revoked_at IS NULL`.

### `auth_token`
One table for both verification and reset flows — same shape, same lifecycle rules.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| user_id | uuid | FK |
| purpose | enum | `email_verification` \| `password_reset` \| `email_change` |
| token_hash | bytea | U |
| new_email | citext | only for `email_change` |
| expires_at | timestamptz | 24 h verification, 1 h reset |
| consumed_at | timestamptz | single use |
| created_ip | inet | |

### `game_identity`
The bridge between a FiveM player and LEOOS. **The only trusted mapping.**

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| provider | enum | `license` \| `license2` \| `steam` \| `discord` \| `fivem` |
| identifier | text | raw FiveM identifier |
| user_id | uuid | FK → user_account, nullable |
| person_id | uuid | FK → person, nullable |
| verified_at | timestamptz | null until the link is proven (in-game claim code) |
| first_seen_at / last_seen_at | timestamptz | |

`U (provider, identifier)`. `CK`: `user_id IS NOT NULL OR person_id IS NOT NULL`.

---

## 3. Organizations, roles, permissions

### `organization`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| key | citext | U — `PD`, `MD`, `FIB`, `ARMY`, `ICE`, `MECHANIC`, … |
| name | text | "Los Santos Police Department" |
| short_name | text | "LSPD" |
| category | enum | `law_enforcement` \| `medical` \| `federal` \| `military` \| `civil_service` \| `other` |
| color | text | hex, used for map/unit colouring |
| logo_url | text | |
| settings | jsonb | per-org toggles (e.g. `hideUnitsFromSharedMap`) |
| is_active | boolean | default true |
| created_at / updated_at | timestamptz | |

`category` exists so cross-org behaviour can be expressed as data ("medical
category orgs may view medical records") rather than as `if (key === 'MD')`.

### `permission`
A seeded catalogue table so that `role_permission` can carry a real foreign key
and a typo becomes a constraint violation rather than a silent no-op.

| Column | Type | Notes |
| --- | --- | --- |
| key | text | PK — `personnel.promote` |
| category | text | `personnel`, `roles`, `persons`, `vehicles`, `dispatch`, `map`, `admin` |
| label / description | text | rendered in the role editor |
| scope | enum | `organization` \| `global` |
| risk | enum | `low` \| `medium` \| `high` — drives extra confirmation and alerting |
| created_at | timestamptz | |

Seeded from `packages/contracts`. `scope = 'global'` permissions can never be
attached to an organization-scoped role (enforced by trigger, see §8).

### `role`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| organization_id | uuid | FK → organization, **nullable** (null = global role) |
| key | citext | machine name |
| name | text | display name |
| description | text | |
| hierarchy_level | int | 1–100, higher = more senior. `CK BETWEEN 1 AND 100` |
| is_default | boolean | auto-assigned on hire |
| is_system | boolean | cannot be deleted or renamed |
| color | text | |
| created_by | uuid | FK |
| created_at / updated_at | timestamptz | |

`U (organization_id, key)`. Partial `U` on `(organization_id) WHERE is_default`
— exactly one default role per organization.

An open integer level rather than a strict tree: it is simple, orderable, and
matches how real rank structures are described. Gaps between levels (10, 20, 30…)
are seeded so ranks can be inserted later without renumbering.

### `role_permission`
`(role_id FK, permission_key FK)` — PK `(role_id, permission_key)`.

### `organization_member`
The employment relationship.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| user_id | uuid | FK → user_account |
| organization_id | uuid | FK → organization |
| person_id | uuid | FK → person, nullable — the in-game character |
| status | enum | `active` \| `on_leave` \| `suspended` \| `terminated` |
| callsign | citext | nullable |
| badge_number | text | nullable |
| hired_at | timestamptz | |
| hired_by | uuid | FK |
| terminated_at | timestamptz | |
| terminated_by | uuid | FK |
| termination_reason | text | |
| notes | text | |

`U (user_id, organization_id)` — one membership per user per org.
Partial `U (organization_id, callsign) WHERE status = 'active' AND callsign IS NOT NULL`
— callsigns are unique among active members only, so retired callsigns are reusable.
Same pattern for `badge_number`.

A user may belong to several organizations. Each membership carries independent
roles and permissions.

### `member_role`
| Column | Type | Notes |
| --- | --- | --- |
| member_id | uuid | FK → organization_member |
| role_id | uuid | FK → role |
| assigned_by | uuid | FK |
| assigned_at | timestamptz | |

PK `(member_id, role_id)`. Multiple roles allowed; the member's **effective
hierarchy level is the maximum** across their roles.

A trigger enforces that `role.organization_id` matches the member's
`organization_id` (or is null for global roles) — a cross-org role assignment must
be impossible even by direct SQL.

### `member_permission_override`
Targeted exceptions without inventing a one-off role.

| Column | Type | Notes |
| --- | --- | --- |
| member_id | uuid | FK |
| permission_key | text | FK → permission |
| effect | enum | `grant` \| `deny` |
| reason | text | required |
| granted_by | uuid | FK |
| expires_at | timestamptz | nullable |

PK `(member_id, permission_key)`. **Deny always wins** over role grants.

### `organization_lead`
The Organization Lead capability. Its own table, granted only by a global admin,
so it is structurally impossible to obtain by editing org roles.

| Column | Type | Notes |
| --- | --- | --- |
| user_id | uuid | FK, PK part |
| organization_id | uuid | FK, PK part |
| granted_by | uuid | FK → user_account |
| granted_at | timestamptz | |
| revoked_at | timestamptz | nullable |

An Organization Lead is treated as level ∞ **within that organization only** and
receives no global capability whatsoever.

---

## 4. Person & vehicle records

### `person`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| first_name / last_name | text | IX trigram for search |
| date_of_birth | date | |
| gender | text | |
| address | text | |
| phone_number | text | IX |
| image_url | text | |
| height_cm / weight_kg | int | |
| notes | text | |
| is_deceased | boolean | |
| created_by / updated_by | uuid | FK |
| created_at / updated_at | timestamptz | |

### `person_flag`
| person_id FK · type enum(`wanted`, `armed_dangerous`, `bolo`, `mental_health`, `no_contact`, `informant`) · severity enum(`info`,`caution`,`critical`) · note · created_by · expires_at |

Flags drive the red banners on person detail pages and map popups.

### `warrant`
| person_id FK · organization_id FK · type enum(`arrest`,`search`,`bench`) · status enum(`active`,`served`,`expired`,`revoked`) · reason · issued_by · issued_at · expires_at · served_by · served_at |

### `criminal_charge`
| person_id FK · incident_id FK nullable · statute_code · title · severity enum(`infraction`,`misdemeanor`,`felony`) · fine_amount · jail_time_minutes · points · status enum(`pending`,`convicted`,`dismissed`) · filed_by · filed_at |

### `statute`
Seeded penal-code catalogue: `code PK · title · description · severity · default_fine · default_jail_minutes · category · is_active`. Charges reference it so the
penal code is editable without a deploy.

### `license`
| person_id FK · type enum(`driver`,`weapon`,`pilot`,`boat`,`medical`,`business`) · status enum(`valid`,`suspended`,`revoked`,`expired`) · issued_at · expires_at · issued_by · suspended_reason |

### `medical_record`
MD-scoped, field-level visibility enforced in the API.
| person_id FK U · blood_type · allergies text[] · conditions text[] · medications text[] · emergency_contact · notes · updated_by · updated_at |

### `vehicle`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| plate | citext | U |
| model | text | GTA model name |
| display_name | text | |
| color | text | |
| vehicle_class | text | |
| owner_person_id | uuid | FK → person, nullable |
| owner_organization_id | uuid | FK → organization, nullable — fleet vehicles |
| registration_status | enum | `registered` \| `expired` \| `unregistered` |
| insurance_status | enum | `insured` \| `uninsured` \| `expired` |
| is_fleet | boolean | |
| notes | text | |

`CK`: not both `owner_person_id` and `owner_organization_id` set.

### `vehicle_flag`
| vehicle_id FK · type enum(`stolen`,`impounded`,`bolo`,`wanted`) · note · created_by · created_at · resolved_at |

---

## 5. Dispatch & operations

### `duty_status`
Current operational state of a member. One row per member, updated in place;
history goes to `duty_status_history`.

| member_id | uuid | PK, FK |
| status | enum | `off_duty` \| `available` \| `busy` \| `on_scene` \| `in_operation` \| `at_hq` \| `transporting` \| `panic` |
| unit_id | uuid | FK → unit, nullable |
| since | timestamptz | |
| updated_at | timestamptz | |

Status values are seeded in a `duty_status_type` table (key, label, color,
is_available, sort_order, org_scope) so organizations can extend the list —
the enum above is the seeded default set, not a hardcoded ceiling.

### `unit`
A patrol.
| id PK · organization_id FK · callsign citext · name · status enum(`active`,`disbanded`) · unit_type enum(`patrol`,`supervisor`,`k9`,`air`,`swat`,`ems`,`fire`,`investigation`) · created_by FK · created_at · disbanded_at |

Partial `U (organization_id, callsign) WHERE status = 'active'`.

### `unit_member`
| unit_id FK · member_id FK · is_leader bool · joined_at · left_at |

Partial `U (member_id) WHERE left_at IS NULL` — **a member can be in at most one
active unit**, enforced by the database rather than by application logic.

### `incident`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| number | text | U — human callable, e.g. `2026-08-000431`, from a sequence |
| organization_id | uuid | FK — owning org, nullable for multi-agency |
| type_key | text | FK → incident_type |
| priority | int | `CK BETWEEN 1 AND 5`, 1 = highest |
| status | enum | `pending` \| `dispatched` \| `on_scene` \| `on_hold` \| `closed` \| `cancelled` |
| title / description | text | |
| location_text | text | street/postal description |
| pos_x / pos_y / pos_z | double precision | GTA world coordinates |
| caller_person_id | uuid | FK, nullable |
| caller_phone | text | |
| source | enum | `manual` \| `fivem` \| `panic` \| `automatic` |
| created_by | uuid | FK, nullable for system-created |
| created_at | timestamptz | IX |
| closed_by / closed_at | | |
| closing_notes | text | |

`incident_type`: `key PK · label · category · default_priority · color · icon · organization_id nullable · is_active`.

### `incident_assignment`
| incident_id FK · unit_id FK · assigned_by FK · assigned_at · released_at · role text |
Partial `U (incident_id, unit_id) WHERE released_at IS NULL`.

### `incident_log`
Append-only operational timeline — the legal record of the call.
| id PK · incident_id FK · actor_user_id FK nullable · actor_type enum · entry_type enum(`note`,`status_change`,`assignment`,`arrival`,`clear`,`attachment`,`system`) · body text · metadata jsonb · created_at |

No update or delete path exists in the API.

### `incident_link`
Attaches persons and vehicles to a call.
| incident_id FK · entity_type enum(`person`,`vehicle`) · entity_id uuid · relation enum(`suspect`,`victim`,`witness`,`involved`,`patient`) · added_by · added_at |

### `panic_event`
| id PK · member_id FK · unit_id FK nullable · organization_id FK · pos_x/y/z · source enum(`web`,`fivem`) · created_at · acknowledged_by FK · acknowledged_at · resolved_at · incident_id FK nullable |

### `map_marker`
Operator-placed markers.
| id PK · organization_id FK nullable · type enum(`hazard`,`roadblock`,`staging`,`command_post`,`poi`,`custom`) · label · description · pos_x/y/z · color · created_by · created_at · expires_at |

---

## 6. FiveM integration

### `game_server`
| id PK · key citext U · name · description · is_active · created_at · notes |

### `game_server_credential`
| id PK · game_server_id FK · key_id text U (public, sent in header) · secret_hash bytea (Argon2id) · scopes text[] · created_by · created_at · last_used_at · expires_at · revoked_at |

Two live credentials per server are permitted so keys can be rotated without
downtime.

### `game_server_state`
| game_server_id PK FK · last_heartbeat_at · player_count · resource_version · is_online (derived) · last_ingest_seq bigint |

`last_ingest_seq` gives monotonic replay protection per server.

---

## 7. Audit

### `audit_log`
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| occurred_at | timestamptz | IX, partition key |
| actor_type | enum | `user` \| `system` \| `game_server` \| `job` |
| actor_user_id | uuid | FK, nullable |
| actor_label | text | denormalised — survives account deletion |
| organization_id | uuid | FK, nullable, IX |
| action | text | `personnel.promote`, `person.view`, IX |
| entity_type / entity_id | text / uuid | IX |
| outcome | enum | `success` \| `denied` \| `error` |
| before / after | jsonb | field-level diff |
| metadata | jsonb | reason strings, target rank levels |
| ip | inet | |
| user_agent | text | |
| request_id | text | correlates with application logs |

Partitioned monthly by `occurred_at`. The application's database role is granted
`INSERT` and `SELECT` only — **no `UPDATE` or `DELETE`** — so tampering requires
database superuser access, not an application bug.

Denied authorization attempts are logged with `outcome = 'denied'`. A user
repeatedly attempting to promote above their rank is exactly the signal an
operations lead needs to see.

---

## 8. Database-level invariants

These are enforced in Postgres, not only in TypeScript, because the brief requires
database constraints and because a bug in one code path must not corrupt the model.

| # | Invariant | Mechanism |
| --- | --- | --- |
| 1 | One active unit membership per member | partial unique index |
| 2 | Callsign unique among active members / units | partial unique index |
| 3 | Exactly one default role per organization | partial unique index |
| 4 | `hierarchy_level` within 1–100 | CHECK |
| 5 | Incident priority within 1–5 | CHECK |
| 6 | A member's roles belong to the member's org (or are global) | trigger |
| 7 | Global-scope permissions never on org-scoped roles | trigger |
| 8 | Vehicle has at most one owner kind | CHECK |
| 9 | Active accounts are verified | CHECK |
| 10 | Audit log is append-only | table privileges |
| 11 | Closed incidents have `closed_at` and `closed_by` | CHECK |
| 12 | An `organization_lead` row requires an active membership | trigger |

Constraint 6 deserves emphasis: without it, a crafted request that slipped past
validation could attach a PD Chief role to an ICE membership, producing a rank the
authorization kernel would then honour.

---

## 9. Storage strategy: what does *not* go in Postgres

Live unit positions arrive at roughly 1 Hz per online player. With 150 players
that is ~13 million rows per day of data that is stale within seconds. Writing
that to Postgres would dominate the write load and the vacuum burden for no
benefit.

| Data | Store | Shape | Lifetime |
| --- | --- | --- | --- |
| Live unit position/status | Redis hash `unit:live:{serverId}:{identifier}` | last known snapshot | TTL 45 s |
| Online index per org | Redis sorted set by `last_update` | membership | rolling |
| Position history | Postgres `position_history`, monthly partitions, **downsampled to 1 sample / 10 s** | append-only | 7 days (configurable) |
| Rate-limit counters | Redis | token bucket | seconds |
| Pub/sub events | Redis channels | fire and forget | none |

Position history exists only to support incident playback ("where was unit 3-Adam
when the call came in"). If playback is dropped from scope, the table goes with it.
