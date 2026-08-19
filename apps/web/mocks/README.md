# Mock data — NOT PRODUCTION DATA

Everything in this directory is fabricated fixture data for the design-system
phase. It exists so the UI can be built and reviewed against realistic shapes
before the API exists.

Per engineering rules 34, 35 and 45:

- Every export in this directory is prefixed `MOCK_`.
- Nothing here is presented in the UI as live data. Screens backed by mocks show
  a "Demo data" indicator in the top bar.
- `apps/web/lib/mock-flag.ts` gates this: the flag is only true while
  `NEXT_PUBLIC_LEOOS_DEMO` is set, and it is never set in a production build.
- None of this is a database seed. Real seeds live in `packages/db` (Phase 1+)
  and demo seeds there are suffixed `_demo`.

When the API lands, these modules are deleted, not adapted.

**Progress:** `session.ts` has been DELETED — authentication is real now, and
`apps/web/lib/session.ts` reads the live session from the API. The remaining
files back screens whose modules are not built yet (persons, vehicles, dispatch,
map); each goes the same way as its module lands.
