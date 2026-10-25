# FarmInfantary

Web version of **Talha Farm**, a poultry farm management system. It replaces an
Angular 19 + Electron desktop app that stored data in a local SQLite file, with
the same application served over the web against a shared PostgreSQL database.

The business logic is **not** being rewritten. The desktop app's entire native
coupling was one object with ~20 methods (`window.electronAPI`), and all 341
database call sites already funnel through a single Angular service. We replace
what sits behind that service; the ~73,000 lines of Angular, every SQL statement
and every business rule carry over unchanged.

---

## Status

Pre-development. The repository is the agreed structure; no phase has started.

Full plan, including the schema translation, tenancy map, guard design and risk
register: **[Conversion Plan](https://claude.ai/artifact/Q6j4fjcuH4m8kiuUcTGfH5)**

---

## What the app does

Four business modules, selected per account by `farms.business_type`. Each one
scopes its data by a **different key** — this is the thing most likely to be got
wrong:

| Module       | Scope key               | Core tables                                                     |
|--------------|-------------------------|-----------------------------------------------------------------|
| Broiler      | `flock_id` (`flocks`)   | expenses, ledgers, sales, income, balance, flock_health, brokers |
| Layer        | `batch_id` (`batches`)  | egg_collection, egg_sales, hen_sales, layer_health, vaccinations |
| Distribution | `farm_id`               | products, purchase/sales orders, bills, customers, suppliers     |
| Owner        | `farm_id`               | dashboard, assets, personal expenses, loans, debt records        |

Two naming traps that run through the whole codebase:

- **`farms` is the login account, not a physical farm.** The physical site level
  is `farm_units`, which the client calls "Farms" in the interface.
- **Shared tables reuse the `flock_id` column to hold a `batch_id`** when
  `module_type = 'layer'`. Filtering on `flock_id` alone silently mixes broiler
  and layer rows. Always pair it with `module_type` — on `DELETE` as much as on
  `SELECT`.

---

## Layout

```
src/                 Angular 19 SPA — same paths as the desktop app
  app/
    admin/           super admin console (new)
    shared/
      platform/      PlatformApi — the only thing that knows about transport
      guards/        auth + permission route guards (new)
      services/      database.service.ts signatures are FROZEN
server/              Node + Fastify API (replaces electron/)
  src/db/            pool, execute, batch, transactions, placeholders
  src/guard/         the SQL guard — security critical
  src/auth/          argon2id, sessions
  src/routes/        /api/db/*, auth, settings, backup, admin/
  test/              tenancy, permissions, batch semantics
db/
  schema/            PostgreSQL DDL
  migrations/        numbered, forward-only
  seeds/             permission catalogue
  import/            one-time SQLite → PostgreSQL migration
scripts/verify/      the 29 verification scripts — the regression net
tools/               derives the permission → table map
docs/                architecture, conventions, decisions, phases
Talha Farm/          the frozen desktop app (reference + test input)
```

`Talha Farm/` is committed deliberately. It is not documentation: the Phase 0
and Phase 1 verify scripts read `Talha Farm/electron/database.js` as **text** to
build their test schema, so it is a build input. Do not edit it.

---

## Getting started

Nothing is runnable yet. When Phase 1 lands:

```bash
npm install                 # Angular app (root)
npm --prefix server install # API

createdb farminfantary
npm --prefix server run db:migrate
npm --prefix server run db:seed

npm --prefix server run dev # API  → http://localhost:3000
npm start                   # SPA  → http://localhost:4200
```

Copy `.env.example` to `.env` first. Never commit `.env`.

---

## How the work is sequenced

Each phase is gated by a test suite. Nothing is migrated until there is a test
that would catch it being migrated wrongly.

| Phase | What | Gate |
|-------|------|------|
| 0 | Baseline — get all 29 verify scripts green on current code | 29 scripts green |
| 1 | Backend — schema + `database.js` to PostgreSQL behind HTTP | Same scripts green on PostgreSQL |
| 2 | Frontend — `PlatformApi`, swap in HTTP, remove Electron | Every screen works in a browser |
| 3 | Security — sessions, argon2id, denormalised `farm_id`, guard, RLS | Cross-tenant tests pass |
| 4 | Access control — users, roles, permissions, seat quotas, audit | Permission and seat tests pass |
| 5 | Operations — backup, restore, printing, entitlement, deploy | Backups proven restorable |

Detail per phase: [`docs/PHASES.md`](docs/PHASES.md)

---

## Rules that are not negotiable

These exist because breaking them causes silent data corruption rather than an
error. Reasoning for each is in [`docs/DECISIONS.md`](docs/DECISIONS.md).

1. **`DatabaseService` method signatures are frozen.** 341 call sites depend on
   them. Change the body, never the shape.
2. **Money columns are `double precision`, never `numeric`.** `node-postgres`
   returns `numeric` as a **string**, and the app does plain JS arithmetic on
   these values — `numeric` turns every addition into string concatenation, with
   no error.
3. **Dates stay `TEXT`.** They are `'YYYY-MM-DD'` and compare lexicographically.
   A real `date` type changes timezone semantics; that bug has already been
   fought once.
4. **No foreign key constraints.** They are declared but never enforced today;
   the app depends on orphan rows and manual delete ordering.
5. **`farm_id` comes from the server session. Never from the client.**
6. **Every SQL value goes through a placeholder.** Never string-interpolate.
7. **Hiding a menu item is not access control.** Permissions are enforced in the
   SQL guard, by table. The sidebar is a convenience.

---

## Contributing

- Branch from `main`, open a PR. Direct pushes to `main` are discouraged.
- A phase's gate must pass before the next phase's work merges.
- `server/src/guard/` and `db/schema/003_rls.sql` are security-critical. Changes
  there need a second reviewer.
- Run the verify scripts before pushing anything that touches SQL or schema.

---

## Licence

Proprietary — DevInfantary.
