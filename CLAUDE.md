# FarmInfantary

Web conversion of **Talha Farm**, an Angular 19 + Electron poultry farm app that
used SQLite via sql.js. Target: same Angular SPA, Node + Fastify API, shared
PostgreSQL with row-level security.

**The strategy:** the desktop app's whole native surface was `window.electronAPI`
(~20 methods). All 341 DB call sites go through `DatabaseService`. Replace what
sits behind it; the Angular app and every SQL statement carry over unchanged.

## Finding things without reading everything

This repo contains a full copy of the desktop app. Most of it you never need.

| Need | Read |
|------|------|
| Architecture, phases, decisions | `docs/` — start with `ARCHITECTURE.md` |
| Angular-side rules | `src/CLAUDE.md` |
| API / guard rules | `server/CLAUDE.md` |
| Schema & migration rules | `db/CLAUDE.md` |
| Why a desktop query looks odd | `docs/LANDMINES.md` (index into the big file) |

**Do not read these whole — they are huge and rarely needed in full:**

- `Talha Farm/CLAUDE.md` — 115 KB. Grep it; never read it end to end.
- `Talha Farm/src/app/shared/services/database.service.ts` — 5,638 lines.
- `Talha Farm/electron/database.js` — 4,268 lines.

Grep for the symbol you need and read the surrounding 50 lines. Reading one of
these in full costs more context than the task usually warrants.

`Talha Farm/` is **frozen reference**. Never edit it. It is a build input: the
verify scripts read it as text.

## Module scoping — get this right or data silently mixes

`farms` is the **login account**, not a physical farm. The physical site level is
`farm_units` (the client calls those "Farms"). Nearly every table carries
`farm_id`; every query must filter by it.

| Module | Scope key | Notes |
|--------|-----------|-------|
| Broiler | `flock_id` | `COALESCE(module_type,'broiler') = 'broiler'` |
| Layer | `batch_id` | strict `module_type = 'layer'` |
| Distribution | `farm_id` | |
| Owner | `farm_id` | |

Shared tables (`feed_*`, `medicine_*`, `labour_payments`, `income`, `expenses`,
`balance`, `sales`) carry `module_type` and **reuse the `flock_id` column to hold
a `batch_id` when `module_type = 'layer'`**. Filtering by `flock_id` alone mixes
broiler and layer rows — including on `DELETE`, which is what was actually
destroying data in the desktop app.

Broiler reads must `COALESCE`, not use a strict `= 'broiler'` — a strict test
drops legacy NULL-module rows and makes screens disagree with the reporting
services.

## Non-negotiable rules

Breaking these causes **silent wrong data**, not an error. Rationale in
`docs/DECISIONS.md`.

1. `DatabaseService` method signatures are **frozen**. 341 call sites depend on
   them. Change bodies, never shapes.
2. Money is `double precision`, **never** `numeric`. `node-postgres` returns
   `numeric` as a *string*; the app does plain JS arithmetic, so `numeric` turns
   every addition into string concatenation with no error.
3. Dates stay `TEXT` (`'YYYY-MM-DD'`, lexicographic). A real `date` type changes
   timezone semantics; that bug was already fought once (PKT/UTC day shift).
4. **No foreign key constraints.** Declared but never enforced today; the app
   depends on orphan rows and manual delete ordering.
5. `farm_id` comes from the **server session**, never from the client.
6. Every SQL value goes through a placeholder. Never string-interpolate.
7. Hiding a menu item is **not** access control. Permissions are enforced in the
   SQL guard, by table.
8. `CAST(x AS INTEGER)`: SQLite truncates, PostgreSQL **rounds**. Use
   `trunc(x)::int`.

## Conventions

- Standalone components, lazy-loaded via `loadComponent` in `app.routes.ts`; all
  screens are children of `/app`.
- `db.get()` returns `{ success, data: rows[] }`; `db.run()` returns
  `{ success, lastId }`. **Errors do not throw** — check `.success`.
- Take an insert's id from the `run()` result, never from a follow-up
  `SELECT last_insert_rowid()`.
- Prefer `runBatch` over explicit transactions: one request, one connection, one
  transaction, no cross-request state.
- A screen and its resolver must run the **identical** query, or the same screen
  reports different totals depending on how you reached it.

## Working agreements

- Run the relevant verify scripts before finishing anything that touches SQL or
  schema. They are the only regression net — there is no unit test suite.
- Don't refactor during migration. Port first, verify, then improve.
- `server/src/guard/` and `db/schema/003_rls.sql` are security-critical: say so
  in the PR and get a second reviewer.
- Never invent a number, total or date in docs. If it isn't measured, say so.
