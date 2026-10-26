# db/ — PostgreSQL schema and migrations

60 tables ported from `Talha Farm/electron/database.js` (`createTables`).
Source of truth for the tenancy classification: `docs/ARCHITECTURE.md`.

```
schema/      001_tables · 002_indexes · 003_rls · 004_roles · 005_auth
migrations/  numbered, forward-only, advisory-locked
seeds/       permission-catalogue.json — 50 current menu-derived keys
(no import/ — D14: fresh app, no data migration)
```

## Type mapping — the two that corrupt silently

[Codex] Migration 005 adds private permission_catalogue/user_permissions tables,
integer flags, validation and durable grant revocation. Runtime attestation now
requires these tables and denies all access to them. No staff SQL policy is active;
do not turn the incomplete observations into grants. Read `../docs/STAFF_PERMISSIONS.md`.

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
schema as declared breaks dozens of working delete paths.

Omit them, or create them `NOT VALID` and deferrable. Real referential integrity
is a worthwhile later project with its own data cleanup.

## Dialect translation

Roughly 20 lines total, nearly all in product-batch expiry/FIFO logic.

Counts are **measured** by `scripts/verify/verify_sql_dialect.mjs`, which fails
the build when one moves. They are not estimates: the first hand-counted list
had four of these wrong.

| SQLite | Count | PostgreSQL |
|--------|-------|------------|
| `MAX(a, b)` / `MIN(a, b)` two-arg | 22 | `GREATEST(a,b)` / `LEAST(a,b)` |
| `julianday(a) - julianday('now')` | 22 | `(a::date - CURRENT_DATE)` |
| `CAST(x AS INTEGER)` | 10 | `trunc(x)::int` — **SQLite truncates, PG rounds** |
| `date('now')` | 7 | `CURRENT_DATE` |
| `GROUP_CONCAT(x, ', ')` | 2 | `STRING_AGG(x, ', ')` |
| `INSERT OR IGNORE` | 1 | `ON CONFLICT DO NOTHING` |
| `substr(x, -n)` with literal negative start | 3 | `RIGHT(x, n)` — [Codex] found by money verification ports |
| `?` placeholders | all | `$1..$n`, rewritten once at the boundary |

`strftime`, `datetime`, `INSERT OR REPLACE`, `printf`, `RANDOM()`,
`last_insert_rowid`, `PRAGMA`, `sqlite_master`: zero uses.

### Two-argument MAX/MIN is the one that was missed

SQLite's `MAX(a, b)` is a **scalar** function. PostgreSQL's `MAX()` is
aggregate-only, so two-argument form is an error:

```
ERROR: function max(double precision, integer) does not exist
```

All 22 occurrences are in money paths — they implement the app's debt
definition, and several are nested clamps:

```sql
-- SQLite
MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))
-- PostgreSQL
LEAST(GREATEST(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))
```

It is dangerous precisely because `MAX(x)` with ONE argument is valid in both
and means something completely different. A search that is not
parenthesis-aware misses it: every real occurrence is wrapped in `COALESCE`,
so a `MAX\([^()]*,[^()]*\)` regex matches only the comments.

The `CAST` difference is the other sneaky one — it doesn't error, it shifts
expiry buckets by one month.

[Codex] Text casts have another difference: SQLite accepts integer prefixes and
returns zero without one (`IS-HAND`'s suffix -> 0). The translator preserves this
for known text forms: complete `substr(...)` results, literal strings and the
text `reference_id` column. Numeric arithmetic keeps the truncation path; it
must not be converted to text first (a tiny real such as 1e-8 must become 0).

## Tenancy

31 of the 60 inherited tables had no `farm_id`: 15 reach it via `flocks`, 7 via
`batches`, 1 (`vaccinations`) via either, and **8 have no tenancy key at all** —
`bank_ledger`, `bill_items`, `customer_ledger`, `customer_payments`,
`internal_transfers`, `sales_return_items`, `supplier_ledger`, `activation`.
Several of those hold money.

[Codex] Migration 004 is applied: farm_id was added to the 30 business tables
above; activation is retired and denied entirely. All 59 tenant tables including
farms have indexed ENABLE/FORCE policies; all 58 non-root business tables stamp
session ownership. Backfill understands module_type and product_batches ancestry.
No parent-existence constraints were added; owned orphans remain valid. Private
auth metadata access uses no owner-policy exception. Read `../docs/TENANT_ISOLATION.md`
before changing policies, functions, role grants or runtime attestation. The SQL
pipe now uses the real AST guard and attested runtime pool for farm admins in
session mode when configured. Browser integration/staff access and production
remain blocked; read `../docs/SQL_GUARD.md` before activation.

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

[Codex] Index generation must preserve `unique`, column collations and partial
predicates from SQLite `index_xinfo`/`sqlite_master`, and include unique indexes
installed after createTables. Dropping those properties permits duplicate money
categories and duplicate mortality-derived health rows. Migration 002 repairs
the three original unique indexes; 001 is immutable. Never delete conflicting
rows automatically: the unique-index upgrade must abort and roll back. The
corrected final schema has 50 non-primary indexes. The nine scenarios in
`verify_unique_indexes_pg.mjs` cover this contract.

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

## No importer

D14: this is a fresh application. Existing desktop data does not come across, so
there is no SQLite-to-PostgreSQL importer and no id-remapping problem.

The type rules above still apply in full. They are properties of the target, not
of a migration: `numeric` would turn addition into concatenation on data typed
fresh today, and two-argument `MAX` is a syntax error regardless of where the
rows came from.
