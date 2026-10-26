# Architecture

Full plan with diagrams, risk register and the complete tenancy analysis:
**[Conversion Plan](https://claude.ai/artifact/Q6j4fjcuH4m8kiuUcTGfH5)**

This file is the working summary.

## Where we came from

Angular 19 (standalone, no NgModules) inside Electron 34, persisting to a local
SQLite file through sql.js. ~73,000 lines, 60 tables, ~60 screens.

```
electron/main.js       616 lines    lifecycle, every ipcMain handler, licensing,
                                    auto-backup, backup/restore, PDF print
electron/database.js   4,268 lines  sql.js init, schema, migrations, query layer
electron/preload.js    51 lines     contextBridge → window.electronAPI
database.service.ts    5,638 lines  Angular wrapper, NgZone-resolved
```

## Why this is tractable

`contextIsolation` forced every native capability through one object. Measured:

| Measure | Count |
|---------|-------|
| `db.get()` / `db.run()` call sites | 287 |
| `runBatch()` call sites | 54 |
| `beginTransaction()` call sites | 2 |
| Direct `electronAPI` uses outside `DatabaseService` | 26 |

341 database call sites change **zero lines** if `DatabaseService` keeps its
signatures. Of the 26 direct uses, 21 are `printPdfBase64` — which already falls
back to `doc.save()`, so it works in a browser untouched.

## Where we are going

```
Browser   Angular SPA → DatabaseService (frozen) → PlatformApi (HTTP)
                                                   Admin console ─┐
Server    Session/auth → SQL guard → Query layer                  │
                                                   Admin endpoints┘
Data      PostgreSQL — RLS FORCE, app.farm_id per connection,
                       app role is not the table owner
```

The admin path is deliberately separate: it never sends SQL, so the tenant
policy needs no exception and there is no RLS bypass anywhere.

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Angular 19, unchanged | 341 call sites stay untouched |
| Server | Node + Fastify | `database.js` ports mechanically; another language means re-deriving every landmine |
| Database | PostgreSQL 16+, shared | Chosen for concurrent staff access |
| Isolation | RLS, `FORCE`, per-connection `app.farm_id` | Contains any guard bug |
| Auth | argon2id, `httpOnly` cookie | Replaces a 32-bit hash and `localStorage` trust |
| Parser | `libpg-query` | Real grammar; regex guards are defeatable |

## Tenancy classification

All 60 tables, by how a row reaches its owning account:

| Class | Count | Reaches `farm_id` by |
|-------|-------|----------------------|
| Direct | 28 | own `farm_id` column |
| Via `flocks` | 15 | `flock_id` → `flocks.farm_id` |
| Via `batches` | 7 | `batch_id` → `batches.farm_id` |
| Either parent | 1 | `vaccinations` — nullable `flock_id` **and** `batch_id` |
| **No tenancy key** | 8 | only through a grandparent |
| Root | 1 | `farms` |

The 8 with no key: `bank_ledger`, `bill_items`, `customer_ledger`,
`customer_payments`, `internal_transfers`, `sales_return_items`,
`supplier_ledger`, `activation`. Several hold money.

**Migration 004 denormalises `farm_id` onto 30 business tables that lack one.**
There were 31 unscoped tables including retired activation, which is denied
entirely. All 59 tenant tables now have indexed ENABLE/FORCE policies and the
58 writable business tables stamp server context. One uniform
policy instead of five variants, index-backed rather than per-row subqueries,
and real protection on the eight money tables that have none today. Details and
policy SQL in `db/CLAUDE.md`. Restricted-role provisioning/attestation is tested
with actual fresh logins. The AST guard, runtime/session pool wiring and browser
cookie integration are implemented for configured farm-admin development use.
Staff permissions, admin provisioning and production operations remain. See
`TENANT_ISOLATION.md` and `AUTHENTICATION.md`.

## Access control

Three roles. `farms` stops being the login and becomes the tenant record; a new
`users` table holds logins.

| Role | Scope | Can do |
|------|-------|--------|
| `super_admin` | Platform | Create farms and users, set staff permissions and seat quotas, grant a farm admin the right to create staff. No access to business tables. |
| `farm_admin` | One farm | Full access to that farm; creates staff only if granted, within quota |
| `staff` | One farm | Only granted permissions, enforced at the SQL guard |

Permissions mirror the current sidebar: 50 generated keys (14 broiler, 15 layer, 15 distribution,
6 owner) with view/create/edit/delete flags. Screens shared between modules get
**one key per module** — the rows are separated by `module_type`, so a shared
key would grant layer access to anyone with broiler access. Migration 005 installs
private catalogue/grant metadata and revocation; the final operation/module map
and staff guard activation are still pending. See `STAFF_PERMISSIONS.md`.

Seat quotas are enforced by a database trigger taking `FOR UPDATE` on the farm
row, so concurrent creation cannot exceed the limit.

## Decisions taken

| Question | Answer |
|----------|--------|
| Concurrency | Multiple staff per account, concurrently |
| SQL boundary | Keep raw SQL over the wire, with a hard guard |
| Database | PostgreSQL, single shared instance |
| Suspended staff | Frees a seat |
| Lowering quota below usage | Allowed; blocks new creation until usage falls |
| Offline support | **Not supported** — online only |
| Restore | Per-farm, into a new empty farm, never overwriting |
| First super admin | Seeded out of band at first deploy |
| Existing accounts | Become `farm_admin` users, `must_change_password = true`, 0 seats |

Rationale for each: `docs/DECISIONS.md`.
