# Architecture Decision Records

Short records of decisions that were not obvious, so that a future reader can tell
the difference between a considered choice and an accident.

Format: context → decision → consequences. One file per decision, numbered,
never edited after acceptance — superseded records get a new ADR that references
the old one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-split-web-and-api.md) | Split Next.js web tier from a Fastify API | Accepted |
| [0002](0002-drizzle-over-prisma.md) | Drizzle ORM rather than Prisma | Accepted |
| [0003](0003-websocket-over-socketio.md) | Native WebSocket rather than Socket.IO | Accepted |
| [0004](0004-opaque-sessions.md) | Opaque server-side sessions rather than JWT | Accepted |
| [0005](0005-leaflet-crs-simple.md) | Leaflet `CRS.Simple` rather than MapLibre | Accepted |
| [0006](0006-post-commit-publish.md) | Post-commit publish rather than a transactional outbox | Accepted |
| [0007](0007-hierarchy-as-integer-level.md) | Integer rank levels rather than a role tree | Accepted |
| [0008](0008-soft-deletion.md) | Soft deletion for operational records | Accepted |
| [0009](0009-uuid-v7-primary-keys.md) | UUID v7 primary keys | Accepted |
| [0010](0010-web-tier-holds-cookie-api-holds-truth.md) | Web tier holds the cookie; the API holds the truth | Accepted |
| [0011](0011-organization-lead-is-not-delegable.md) | Organization Lead is a capability, and it is not delegable | Accepted |
| [0012](0012-defer-leaflet-until-tiles.md) | Defer Leaflet until the licensed tile set exists | Accepted, amends 0005 |
