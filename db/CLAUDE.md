# db/ — PostgreSQL schema, migrations, data import

60 tables ported from `Talha Farm/electron/database.js` (`createTables`).
Source of truth for the tenancy classification: `docs/ARCHITECTURE.md`.

```
schema/      001_tables · 002_indexes · 003_rls · 004_roles · 005_auth
migrations/  numbered, forward-only, advisory-locked
seeds/       permissions.sql — the 47-key catalogue
import/      sqlite-to-postgres — existing sng_farm.db files
```

## Type mapping — the two that corrupt silently

**Money → `double precision`, never `numeric`.** `node-postgres` returns
`numeric` and `bigint` as **strings**. The app does `row.amount + x` in hundreds
of places, so `numeric` turns addition into string concatenation — wrong totals,
no error, no stack trace. `double precision` reproduces SQLite `REAL` exactly.
Exact decimal money is a separate project needing a custom type parser and an
audit of every arithmetic site.

**Dates → `TEXT`.** They are `'YYYY-MM-DD'` and compare lexicographically;
PostgreSQL `TEXT` does the same. A real `date` type changes comparison and
timezone semantics, and that bug has already been fought — `toISOString()` once
pushed local times before 05:00 onto the previous day, filing records a day early
in PKT.

Other mappings: `AUTOINCREMENT` → `BIGSERIAL`; flags like `done INTEGER DEFAULT 0`
stay integers, **not** `BOOLEAN`.

## No foreign key constraints

`PRAGMA foreign_keys` is never enabled in the desktop app, so nothing has ever
cascaded. The app deletes child rows manually in a deliberate order, and orphan
rows legitimately exist. **PostgreSQL enforces FKs by default** — creating the
schema as declared breaks dozens of working delete paths and may block the
initial import entirely.

Omit them, or create them `NOT VALID` and deferrable. Real referential integrity
is a worthwhile later project with its own data cleanup.

## Dialect translation

Roughly 20 lines total, nearly all in product-batch expiry/FIFO logic.

| SQLite | Count | PostgreSQL |
|--------|-------|------------|
| `julianday(a) - julianday('now')` | 11 | `(a::date - CURRENT_DATE)` |
| `date('now')` | 5 | `CURRENT_DATE` |
| `CAST(x AS INTEGER)` | 19 | `trunc(x)::int` — **SQLite truncates, PG rounds** |
| `GROUP_CONCAT(x, ', ')` | 2 | `STRING_AGG(x, ', ')` |
| `INSERT OR IGNORE` | 1 | `ON CONFLICT DO NOTHING` |
| `ON CONFLICT … excluded` | 1 | unchanged |
| `?` placeholders | all | `$1..$n`, rewritten once at the boundary |

`strftime`, `datetime`, `INSERT OR REPLACE`, `printf`, `RANDOM()`: zero uses.

The `CAST` difference is the sneaky one — it doesn't error, it shifts expiry
buckets by one month.

## Tenancy

30 of the 60 tables have no `farm_id`: 15 reach it via `flocks`, 7 via
`batches`, 1 (`vaccinations`) via either, and **8 have no tenancy key at all** —
`bank_ledger`, `bill_items`, `customer_ledger`, `customer_payments`,
`internal_transfers`, `sales_return_items`, `supplier_ledger`, `activation`.
Several of those hold money.

**Denormalise `farm_id` onto every table** (Phase 3), backfilled from parents,
`NOT NULL`, populated by an insert trigger. One uniform policy instead of five
variants, index-backed instead of per-row subqueries, and defence in depth on
the eight money tables that currently have none.

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;   -- applies to the owner too

CREATE POLICY tenant_isolation ON <t>
  USING      (farm_id = current_setting('app.farm_id')::bigint)
  WITH CHECK (farm_id = current_setting('app.farm_id')::bigint);
```

`USING` filters reads and the old rows of updates; `WITH CHECK` validates new
rows — that is what stops a tenant writing a row stamped with another
`farm_id`. Both required. `FORCE` matters because policies are otherwise
bypassed for the table owner, so the app role must not be the owner.

## Migrations

The desktop ran migrations on **every launch**, looping `alterStatements` in
`try { } catch { }` — duplicate-column errors *were* the "already applied"
detection. On a server, launch is a shared deploy across instances.

Numbered, forward-only, under an advisory lock, with a schema-version table.
Re-verify every statement against PostgreSQL: its error codes differ from
sql.js, so the old error-swallowing detection does not work at all.

**`vaccinations` warning.** `migrateVaccinationsNullableBatchId()` rebuilds that
table and has already destroyed data once — an unguarded version re-ran every
launch with a hardcoded 7-column `INSERT...SELECT` that dropped `flock_id`,
`cost`, `bill_id` and `bill_number` each time. Convert it to a one-time numbered
migration. Do not carry the launch-time rebuild pattern forward.

## Import

`import/` moves existing customers' `sng_farm.db` files into PostgreSQL. It is
how real data arrives, and it needs the same numeric-type care as everything
else. Validate totals against the source file after each import.
