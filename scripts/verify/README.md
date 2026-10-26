# Verify scripts

## Staff permission foundation — Codex

`verify_staff_permissions_pg.mjs` covers 16 real PostgreSQL scenarios for private
grant validation, durable revocation, snapshots/cleanup, runtime denial and
fully granted staff still denied by HTTP. `verify_permission_derivation.mjs`
covers 10 catalogue/AST/context/privacy/drift scenarios. Voucher tracing retains
all 255 original assertions and records four action scopes across two screens;
the final staff operation/module policy is not active. Migration 005 is applied.
Latest suite: **79/79 scripts (~9,837 reported checks)**, backend **82/82**.
See `docs/STAFF_PERMISSIONS.md`; counts in older milestone notes below are historical.

## Guarded session SQL — Codex

`verify_guard_inventory_pg.mjs` compiles/scopes and PREPAREs 501 current static
business statements with the real AST guard. Browser authentication must contain
zero raw SQL; no legacy account exemptions remain. It reports dynamic SQL gaps.
`verify_guard_http_pg.mjs` adds 22 real cookie/HTTP/PG scenarios through an actual
restricted login and full-schema RLS, including hostile SQL, tenant isolation,
lastId/transactions, caps/throttles, revocation and shutdown. Nine backend guard
unit tests cover syntax/capability attacks. `verify_browser_sessions.mjs` adds
17 browser source-state scenarios: restoration, storage forgery, races, cache
ownership, offline sign-out, cross-tab invalidation, guards and interceptors.
These do not replace rendered UI testing; see docs/BROWSER_SESSION_QA.md.
Latest full suite: 77/77 scripts,
~9,811 reported checks; backend tests 82/82; Angular build passes with existing
CommonJS warnings. See `docs/SQL_GUARD.md`; staff and production remain blocked.

## Full-schema tenancy — Codex

`verify_tenancy_pg.mjs` adds 26 PostgreSQL scenarios covering migration 004,
all 59 policies/58 ownership triggers and actual restricted logins. It tests
module/product ancestry, ownership forgery, joins/CTEs/UNION, orphan preservation,
private metadata access, forbidden platform/DDL/sequence operations, FORCE on
an ordinary owner, atomic role provisioning and startup/policy/grant drift.
All schemas and roles are disposable. Read `docs/TENANT_ISOLATION.md` for scope
and remaining AST guard/application activation work. Latest full suite:
74/74 scripts, ~9,270 reported checks; backend tests 73/73. Migration 004 is
applied locally; no persistent runtime login was created.

## Session transactions — Codex

`verify_session_transactions_pg.mjs` adds 28 real PostgreSQL scenarios with a
disposable non-owner NOBYPASSRLS role and FORCE RLS fixture: session/device token
ownership, pooled context cleanup, batch/savepoint contracts, concurrent begins,
queue/commit ordering, revocation races, deadlines, capacity and shutdown cleanup.
The authorizer is fixture-only; full-schema production RLS and the AST guard are
still pending. See `docs/SESSION_TRANSACTIONS.md` for activation requirements.
Latest full run: 73/73 scripts, ~9,243 reported checks; backend tests 73/73.

## PostgreSQL business ports — Codex

All 29 inherited gates pass on the web target: 28 PostgreSQL scripts and one
source-only scanner. Twenty-five Codex application ports run against
**current `src/` method bodies and component SQL**:

| Script | Runtime checks |
|---|---:|
| `verify_vouchers_pg.mjs` | 255 |
| `verify_internal_settlements_pg.mjs` | 211 |
| `verify_cash_and_bank_totals_pg.mjs` | 176 |
| `verify_no_negative_bank_pg.mjs` | 197 |
| `verify_bank_withdrawals_pg.mjs` | 1,615 |
| `verify_auto_settlement_on_sale_pg.mjs` | 217 |
| `verify_layer_sales_customers_pg.mjs` | 156 |
| `verify_overview_pg.mjs` | 9 |
| `verify_distribution_outstanding_cards_pg.mjs` | 17 |
| `verify_supplier_tracking_pg.mjs` | 170 |
| `verify_supplier_accounts_screen_pg.mjs` | 161 |
| `verify_bill_bank_account_pg.mjs` | 152 |
| `verify_assets_pg.mjs` | 42 |
| `verify_product_delete_pg.mjs` | 52 |
| `verify_layer_ledger_pg.mjs` | 56 |
| `verify_report_fcr_card_pg.mjs` | 103 |
| `verify_asset_settlement_pg.mjs` | 64 |
| `verify_opening_balance_pg.mjs` | 62 |
| `verify_ledger_payment_reversal_pg.mjs` | 76 |
| `verify_debt_records_pg.mjs` | 42 |
| `verify_bank_screen_sql_pg.mjs` | 120 |
| `verify_egg_collection_cartons_pg.mjs` | 115 |
| `verify_expense_ledger_separation_pg.mjs` | 58 |
| `verify_own_farm_customers_pg.mjs` | 73 |
| `verify_product_opening_stock_pg.mjs` | 100 |
| `verify_legacy_migrations_pg.mjs` | Original failure/exit conditions |
| `verify_change_announcements_web.mjs` | 3 source-only checks |

Each uses the real server query layer in an isolated schema and cleans up in
`finally`. These files are maintained separately; `lib/port.mjs` still cannot
regenerate shape-B scripts. `verify_money_port_assertions.mjs` compares all 1,901
original assertion call expressions. Documented normalizations cover async/
await, parentheses, CRLF/LF, catalog metadata SQL, Overview's single-asset
GROUP BY, and the layer-sale migration label. Expected values and tolerances
are unchanged. Supplier filtering and the FCR every-predicate await their Boolean
results; native filter/some/every with async callbacks is rejected. Dropped or
changed assertions fail. The guard also requires service IO adapters to return
the driver's result object directly; fixture-only SQL helpers intentionally throw.

The twenty-five Codex application ports execute 4,299 runtime checks. Product deletion uses a
PostgreSQL failure trigger to verify rollback.
Layer ledger fixtures explicitly pass the two NULLs SQLite implicitly supplied;
Overview ledger queries use the full real builders, including GROUP BY. Asset
fixture backfills acted on an empty database and are omitted under D14.

The product-delete port found and fixed `status = "depleted"` in the app's
soft-delete query: PostgreSQL treats double quotes as an identifier. The query
now uses a single-quoted value. `verify_app_sql_prepares.mjs` uses a TypeScript
AST collector for all three JavaScript quote styles, covering 507 static SQL
statements and reporting 120 interpolated statements plus 33 concatenated
fragments as gaps. Three backend tests cover the collector.

The settlement/balance batch adds 244 checks. Asset-sale scenarios retain all
64 checks, including historical backfill expectations. Test-only algorithms
lifted from the frozen desktop source live in `lib/reference-asset-backfills.mjs`;
they adapt IO and three ROUND operands, never production migrations. Legacy row
values are seeded into the final PostgreSQL schema rather than replaying SQLite
DDL. D14 still excludes desktop data import. Four scratch schemas are cleaned up.

Opening balances load the complete current Overview/Farm Report classes. Ledger
payment reversals drive the actual customer screen and inject a PostgreSQL
trigger failure to prove rollback. Debt-record snapshots now execute every one
of their fourteen actual Overview builders; query failures throw instead of
silently comparing equal error strings. Its catalog query retains column order.
The scratch harness sets search_path in startup options before a connection is
borrowed, avoiding an unawaited connect-event SET during parallel service reads.

The final batch ports the five remaining application scenarios (466 checks),
the historical migration exit contract, and the unchanged source scanner.
Opening-stock storage adaptations are explicit: SQLite last_insert_rowid is
refused with guidance to use run().lastId; successful PostgreSQL commits replace
file-export counts. Failure and mutation cases still leave zero half-written
rows. The unused Electron batch twin is lifted into a test-only IO adapter.
Egg metadata maps the real PG types/defaults to the original SQLite labels and
repeats the actual numbered runner. Only two engine-specific assertion labels
change. Row ordering uses collection_id instead of rowid. Historical data
conversions remain test-only under D14.

The legacy category fixture exposed lost UNIQUE/collation/partial-index rules in
the schema generator. It now reads index_xinfo, uniqueness and predicates and
includes the later-created category unique index. Migration 002 repairs the
installed schema while leaving 001 immutable. `verify_unique_indexes_pg.mjs`
tests nine upgrade/duplicate-rejection/rollback cases. No conflicting rows are
discarded. The local database is at 002.

`verify_port_coverage.mjs` maps all 29 originals to their target checks, retains
the original source scanner exactly, and requires a configured database.
Current full suite: **72/72 green**, approximately **9,215 reported checks**;
backend unit tests **70/70**. The inherited verification gate stays closed.
`verify_authentication_pg.mjs` adds 28 real cookie/session/bootstrap/throttle and
adversarial HTTP scenarios; these verify the server identity foundation, not the
unfinished tenant isolation or browser session integration.

The bill/bank port drives Sales Orders' actual save and delete methods and the
real server transaction layer. Its adapter carries the transaction token on
reads, writes and batches, then clears it at commit/rollback. Overview's
desktop-only backfills acted on an empty fixture and are omitted under D14.

The bank verifiers' own reconciliation queries use PostgreSQL's numeric
ROUND overload; this does not change production column types or expected values.
The money ports found a negative-substr compatibility bug in generated bank and
bill numbers, now fixed by boundary translation to RIGHT. Live numbering cases
in `verify_translated_sql_pg.mjs` cover padding boundaries and overflow widths.
Further cases preserve integer-prefix casts of manual number suffixes, found by
the automatic-settlement cascade. The layer-sale port uses the actual migration
runner for its repeat-application check, with catalog fields mapped to the
original `name`/`notnull`/`dflt_value` assertions.

Run all checks with `node scripts/verify/run-all.mjs`. The older background notes
below describe the original baseline; `docs/PHASES.md` has current remaining
work. Authentication, tenancy and deployment readiness are separate gates.

The 29 scripts that are **the only regression net for this project**. There is
no unit test suite — `.spec.ts` files exist from the CLI scaffold and are empty.

They work by lifting method bodies out of the real source **as text** and running
them against a schema built from the real `createTables`/migrations. That is why
`Talha Farm/` is committed: these scripts read it as a build input.

## Phase 0

Copy them from `Talha Farm/scripts/verify/` and get all 29 green against the
desktop code, unchanged. That is the baseline everything else is compared to.

## Phase 1

Re-point them at `db/schema/` and the new server modules. **A broken verify
suite is a build failure, not cleanup to do later** — it is the precondition for
trusting any part of the migration.

## Caution

Their extractor finds a method body by its first brace. An inline object return
type would be mistaken for the body, which is why several interfaces in
`database.service.ts` are named rather than written inline. Keep that convention.

No verify script sees an HTML template: a column added to SQL is checked, a
column added to a template is not.

---

## Running the suite

```bash
node scripts/verify/run-all.mjs              # whole suite; exit 0 = green
node scripts/verify/run-all.mjs -v           # full output from failures
node scripts/verify/run-all.mjs --only bank  # scripts matching a substring
node scripts/verify/run-all.mjs --dir <d>    # a different script directory
```

The runner scans two directories: this one (scripts written for the conversion)
and `Talha Farm/scripts/verify/` (the 29 inherited ones). Phase 1 re-points the
second at the ported suite.

**Exit code is the contract, not the check count.** The scripts do not share an
output format — some print `PASS`, some `OK`, `verify_migrations` asserts by
throwing — so the counts in the summary are indicative only.

## The oracle

```bash
node scripts/verify/oracle.mjs <path-to.db> -o before.json
node scripts/verify/oracle.mjs --compare before.json after.json
```

The verify scripts prove the **logic** still behaves. The oracle proves the
**numbers** did not move: capture before the migration, capture after, diff.
Any difference is a defect until explained.

It is also where the app's canonical aggregate definitions live — the debt
definition `SUM(MAX(total_amount - amount_paid, 0))`, the broiler `COALESCE`
test and the strict layer test. Phase 1 must reproduce them exactly.

Output is gitignored. The totals are a real business's financials; decide
deliberately before committing one.

## verify_money_types.js

The tripwire for the highest-impact risk in the conversion (`docs/DECISIONS.md`
D4). It asserts every money value reaches JavaScript as a **number** and that
arithmetic on it is arithmetic.

It passes trivially against sql.js. In Phase 1 it is re-pointed at PostgreSQL,
where it fails loudly if a money column is mapped to `numeric` — which
`node-postgres` returns as a **string**, silently turning `1000.5 + 300.25`
into `"1000.5300.25"`.
