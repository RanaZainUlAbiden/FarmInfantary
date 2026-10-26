# Phases

Each phase is gated. Nothing is migrated until there is a test that would catch
it being migrated wrongly. Durations are not estimated — phases 1 and 3 are the
large ones, 2 is mostly mechanical, 4 is new build rather than porting.

---

## Phase 0 · Baseline

Establish the regression net before changing anything.

- [x] Run all 29 scripts against the current desktop code — **29/29 green**, 4,454 checks, 15.6s
- [x] Build a repeatable runner — `scripts/verify/run-all.mjs`
- [x] Add a numeric-type assertion — `scripts/verify/verify_money_types.js`, 34 checks over 85 REAL columns
- [x] Build the oracle — `scripts/verify/oracle.mjs`, capture + `--compare`
- [x] ~~Capture a production-shaped database dump~~ — **dropped (D14: no data migration)**

**Gate:** all scripts green. **MET** — 33/33, ~4,535 checks.

### Running it

```bash
node scripts/verify/run-all.mjs              # whole suite, exit 0 = green
node scripts/verify/run-all.mjs -v           # full output from failures
node scripts/verify/run-all.mjs --only bank  # one script

node scripts/verify/oracle.mjs <db> -o before.json
node scripts/verify/oracle.mjs --compare before.json after.json
```

Oracle output is gitignored. The totals are a real business's financials —
decide deliberately before committing one.

### Blocked: no production data

The only database on the development machine is a QA scratch file
(`%APPDATA%/poultry-farm/sng_farm.db`, 460 KB, farms named `QA_Main_Stock` and
`a`, 1–11 rows per table). It exercises 24 of 55 tables and almost no money
paths — 11 non-zero totals out of 56.

That is enough to prove the tooling runs. It is **not** enough to prove a
migration preserved anything. A dump with real volume and real edge cases is
needed from a live installation before Phase 1 can be signed off, because the
defects this is built to catch — numeric-as-string, `CAST` rounding, lost rows
in a 60-table import — only appear at scale and on awkward values.

Note the QA file has **55 tables against the schema's 60**: it predates five,
which migrations would add on next launch. A production dump will likely be
older still. The import path must handle a database that is behind the schema.

---

## Phase 1 · Backend

- [x] Translate the 60-table schema to PostgreSQL DDL — **generated** by `db/generate-schema.mjs`
- [x] Verify `PRIMARY_KEY_MAP` against the real schema — `scripts/verify/verify_primary_keys.js`
- [x] **Execute the schema against PostgreSQL** — runs clean on 18.3; 60 tables, 555 columns, 86 double precision, 58 identity, 0 FKs
- [x] Prove money returns as JS numbers — `verify_money_types_pg.mjs`, 26 checks
- [x] Measure the dialect inventory — `verify_sql_dialect.mjs`; found 22 two-arg MAX/MIN the hand count missed
- [x] [Codex] Add numbered forward-only PostgreSQL migrations under an advisory lock — immutable final-schema baseline includes `alterStatements` and nullable vaccination parents; legacy desktop row conversions are omitted under D14. Existing manual setups require a validated `--baseline`.
- [x] Port `runQuery`, `getQuery`, `runBatch` and the transaction layer to `node-postgres` — `server/src/db/execute.js`
- [x] Reimplement `lastId` via `RETURNING` — keys read from the catalogue at startup, so there is no map to keep complete
- [x] Reimplement `$lastId` batch back-references, negative indexing included, with tests
- [x] Translate the dialect at the boundary — `server/src/db/dialect.js`, refuses what it cannot translate
- [x] Parse integer columns to JS numbers (D15) — 214 of 555 columns were arriving as strings
- [x] Build the `?` → `$n` placeholder rewrite at the boundary — `server/src/db/placeholders.js`
- [x] Stand up the database endpoints mirroring the IPC surface — `server/src/server.js`, 34 HTTP checks
- [ ] Remaining endpoints: settings, backup, entitlement (small; auth-dependent)
- [x] [Codex] Re-point all 29 inherited gates to the web target — **28 PostgreSQL,
  one unchanged source-only scanner**; coverage enforced by `verify_port_coverage.mjs`.

**Verification gate: MET [Codex] — 2026-10-26.** All 29 original gates pass on
the web target, with explicit storage adaptations below. Settings/backup/
entitlement endpoints remain auth-dependent backend work; this is not security
or deployment approval.

### Codex migration completion — 2026-10-25

- [x] [Codex] `npm run db:migrate` installs an immutable baseline of all 60
  tables and 49 indexes. `--baseline` validates an existing manual setup before
  recording it. Metadata stays in `farminfantary_meta`, outside business tables.
- [x] [Codex] Verified fresh/repeated installs, incompatible schemas, preservation
  of vaccination data, upgrades, checksum/missing-file rejection, atomic failure,
  concurrent deployment and lock timeout: **17 PostgreSQL scenarios**.
- [x] [Codex] Full suite **41/41 green** (~4,797 reported checks), backend tests
  **58/58**. Phase 1 remains open until the inherited business scripts are ported.

See `db/migrations/README.md`. The generated final schema already incorporates
desktop structural alterations. Under D14 the desktop-only data conversions are
intentionally not replayed, and vaccination tables are never rebuilt on startup.

### The gate: porting the verify suite

`scripts/verify/lib/pg-harness.mjs` does the two things that change, and
nothing else:

- the schema comes from `db/schema/` instead of `createTables()`
- `get`/`run`/`runBatch` go through `server/src/db/execute.js` instead of sql.js

The method bodies are still lifted verbatim out of `database.service.ts` and
run as the real shipping code, and the assertions are untouched. That is what
makes a green run mean something: same code, same checks, different database.

Each script gets its own PostgreSQL schema, dropped afterwards, so scripts
cannot see each other's rows.

**Coverage: all 29 inherited gates.** Categories and loans were already ported. The twenty-five
Codex ports below read method bodies and component queries from the current
`src/` application and run them through the server query layer on PostgreSQL:

- [x] [Codex] `verify_vouchers_pg.mjs` — 255 checks.
- [x] [Codex] `verify_internal_settlements_pg.mjs` — 211 checks.
- [x] [Codex] `verify_cash_and_bank_totals_pg.mjs` — 176 checks.
- [x] [Codex] `verify_no_negative_bank_pg.mjs` — 197 checks.
- [x] [Codex] `verify_bank_withdrawals_pg.mjs` — 1,615 checks.
- [x] [Codex] `verify_auto_settlement_on_sale_pg.mjs` — 217 checks.
- [x] [Codex] `verify_layer_sales_customers_pg.mjs` — 156 checks.
- [x] [Codex] `verify_overview_pg.mjs` — 9 asset balance/shape checks.
- [x] [Codex] `verify_distribution_outstanding_cards_pg.mjs` — 17 checks.
- [x] [Codex] `verify_supplier_tracking_pg.mjs` — 170 checks.
- [x] [Codex] `verify_supplier_accounts_screen_pg.mjs` — 161 checks.
- [x] [Codex] `verify_bill_bank_account_pg.mjs` — 152 checks, including actual
  Sales Orders save/delete methods using server transaction tokens.
- [x] [Codex] `verify_assets_pg.mjs` — 42 checks.
- [x] [Codex] `verify_product_delete_pg.mjs` — 52 checks, including failed-delete rollback.
- [x] [Codex] `verify_layer_ledger_pg.mjs` — 56 checks, including colliding flock/batch IDs.
- [x] [Codex] `verify_report_fcr_card_pg.mjs` — 103 checks.
- [x] [Codex] `verify_asset_settlement_pg.mjs` — 64 checks, including isolated
  historical fixtures without adding a production backfill/importer.
- [x] [Codex] `verify_opening_balance_pg.mjs` — 62 checks.
- [x] [Codex] `verify_ledger_payment_reversal_pg.mjs` — 76 checks.
- [x] [Codex] `verify_debt_records_pg.mjs` — 42 checks, with strict query failures.
- [x] [Codex] `verify_bank_screen_sql_pg.mjs` — 120 checks.
- [x] [Codex] `verify_egg_collection_cartons_pg.mjs` — 115 checks.
- [x] [Codex] `verify_expense_ledger_separation_pg.mjs` — 58 checks.
- [x] [Codex] `verify_own_farm_customers_pg.mjs` — 73 checks.
- [x] [Codex] `verify_product_opening_stock_pg.mjs` — 100 checks.
- [x] [Codex] `verify_legacy_migrations_pg.mjs` — original historical failure/exit
  conditions on PG fixtures; no production importer under D14.
- [x] [Codex] `verify_change_announcements_web.mjs` — the original scanner,
  unchanged, reads current web src/; 3 checks, inherently source-only.
- [x] [Codex] `verify_port_coverage.mjs` enforces all 29 mappings and requires
  DATABASE_URL; a skipped SQL suite cannot close this gate.
- [x] [Codex] Extended `verify_money_port_assertions.mjs` to verify preservation
  of 1,901 original assertion call expressions across twenty-five application ports.
  They execute 4,299 runtime checks. Normalizations cover async/await,
  parentheses, CRLF/LF, documented catalog SQL, a single-asset GROUP BY and the
  layer-sale/egg migration labels and explicit opening-stock storage contracts.
  Supplier filter and FCR every-predicates await their
  Boolean results; the guard rejects async callbacks passed to native filter/some/every
  and requires service adapters to preserve driver error result objects.
- [x] [Codex] Full suite on 2026-10-26: **72/72 green**, approximately
  **9,215 reported checks**; backend unit tests **70/70**. The last Angular build
  passed with dependency CommonJS optimization warnings; Angular code did not
  change in the server authentication batch.
- [x] [Codex] Fixed schema generation to retain unique indexes, NOCASE and partial
  predicates, including the category index installed after createTables. Immutable
  migration 002 restores all three unique indexes (50 non-primary indexes total).
  Nine PG scenarios verify duplicate rejection, NULL sources, scope and rollback
  without row deletion. Applied to the local development database at version 002.

The final verification batch adds 466 application checks, historical migration
fixtures and the three source-only checks. Opening stock replaces session-local
row-ID reads with the web boundary's explicit refusal and write-result guidance;
successful real PostgreSQL commits replace file-export counts. All business
values, failure/mutation scenarios and rollback expectations remain. Its unused
Electron twin is preserved only as a test fixture. Egg collection compares real
PG catalog types/defaults through equivalent metadata labels, uses collection_id
for deterministic ordering and repeats the actual numbered migration runner.
- [x] [Codex] Fixed product-batch soft deletion: PostgreSQL interpreted
  `"depleted"` as a column, leaving stock unchanged. The query uses `'depleted'`.
- [x] [Codex] Expanded SQL preflight to all JavaScript quote styles using a
  TypeScript AST: **507 static statements prepare**. Three unit tests cover
  escaped literals, dynamic SQL gaps and comment/ordinary-string exclusion.

The settlement/balance batch adds 244 checks. Its historical asset backfill
algorithms are lifted from frozen reference source into test-only asynchronous
fixtures (`scripts/verify/lib/reference-asset-backfills.mjs`), with three numeric
ROUND operand adaptations. The same current/legacy row values and all 64 original
checks run against the final PostgreSQL schema. SQLite legacy DDL is not replayed;
production migrations still perform no desktop data conversion under D14.

Opening balances exercise the complete current Overview and Farm Report classes.
Ledger payment reversals use the actual customer screen save/delete methods and
a PostgreSQL failure trigger to prove rollback. Debt-record snapshots now load
the complete Overview class and execute all fourteen query builders; missing
builders and SQL failures fail the script rather than becoming skipped queries
or equal error strings. The scratch harness sets search_path during connection
startup, before any parallel reads can borrow a new pooled connection.

The asset/stock/ledger/report batch adds 253 checks. Product deletion injects a
PostgreSQL trigger failure to prove rollback. Layer ledger Overview queries now
lift the complete builders, including GROUP BY, rather than the desktop
verifier's incomplete first fragment. Its fixture passes two NULL parameters
explicitly where sql.js implicitly left them unbound. The FCR predicate awaits
each result. Earlier service adapters were also corrected to return failed SQL
results directly; only fixture setup helpers throw. All affected ports were rerun.

The reporting/supplier batch adds 509 checks. PostgreSQL catalog reads replace
SQLite metadata functions while retaining the same columns and expected values.
Overview's verifier-only single-asset aggregate groups by the asset primary key;
the expected overpayment stays 30,000. Its desktop backfills ran on an empty
fixture before any data existed and are omitted under D14. The bill port threads
the real server transaction token through reads, writes, batches and commit/
rollback, preserving the app's transaction wrapper and result contract.

The layer-sale schema check now uses PostgreSQL catalog metadata and reruns the
real numbered migration runner instead of the desktop ALTER loop. Its before/
after comparison and all expected values are unchanged; only that assertion's
label describes the new mechanism. Baseline validation runs with the app's
registered type parsers, exposing a metadata bug fixed by comparing sequence
configuration as exact text rather than unsafe JavaScript numbers.

The automatic-settlement cascade also exposed a text CAST gap: a manual
`IS-HAND` settlement must not break the next generated number. Known text CAST
forms now preserve SQLite's integer-prefix behavior (`HAND` -> 0, `12tail` -> 12,
`1e3` -> 1); numeric arithmetic still truncates. Ten live prefix cases include
NULL, whitespace and signed values. No business API or money type changed.

The ports preserve fixture values, tolerances and expected results. Database
helpers and callbacks await PostgreSQL operations; fixture failures throw;
application methods retain their `{ success, error }` contract. Scratch schemas
are removed in `finally`. The negative-bank verifier casts its read-only ROUND
operands to numeric because PostgreSQL has no `round(double precision, integer)`;
production money columns remain double precision.

`scripts/verify/lib/port.mjs` transforms an original into a PostgreSQL port.
It is deliberately conservative: the assertion body is copied byte for byte
apart from the substitutions sql.js's *synchronous* API forces — awaited reads,
and the helper/arrow functions that must become async as a result. Nothing a
script checks, and no message it prints, is rewritten.

**The transform handles one of two shapes, and shape B is unresolved.**

Shape A (`svc` built inside `initSqlJs().then()`) ports cleanly. Shape B
(`svc` as a top-level literal with a `call()` helper) keeps helpers in its
preamble that close over the sql.js handle and are called from the body, so
the transformed region has to include them — and once it does, the async
cascade stops converging. The inline-arrow pass reports **0 matches at
transform time** while the same pattern matches the emitted file, which is
unexplained and was not worth more blind iteration.

**The four shape-B money scripts are now ported separately [Codex].** They are
reviewable files rather than an extension of the unresolved generic transform.
Do not regenerate them with `port.mjs`; its shape-B limitation still applies.

The money ports exposed a fourth silent engine difference: SQLite's negative
`substr()` starts count from the end; PostgreSQL's do not. The boundary now
translates the three app uses to `RIGHT`, preserving `DEP-0001`, `WD-0001` and
three-digit bill/settlement numbers. Before the fix the ports failed four
number-format assertions. Fourteen live numbering checks now cover both widths
and values through 10,000; the dialect inventory records the three source uses.

That first port immediately found `COLLATE NOCASE` — 7 occurrences the dialect
inventory had missed entirely, which PostgreSQL rejects outright. See below.

**Inherited verification backlog: closed.** Next critical work is real sessions,
server-derived identity, tenant isolation, SQL authorization and adversarial
tests, followed by user permissions and deployment operations. The settings,
backup and entitlement endpoints remain auth-dependent work.

### The schema is generated, not hand-written

`node db/generate-schema.mjs` derives `db/schema/001_tables.sql` and
`002_indexes.sql` from the desktop app's real `createTables` + `alterStatements`
+ the one structural migration. 60 tables, 555 columns, 86 `double precision`,
58 identity columns, 1 composite key, 49 indexes.

Hand-transcribing 60 tables is 60 chances to mistype a default or a
nullability, and each would surface only indirectly as a confusing failure
somewhere else. Generating it means the PostgreSQL schema cannot drift from the
schema the app actually builds. **The emitted `.sql` files are the schema of
record** — commit them, review them in diffs; the generator exists so they are
reproducible.

### What executing it found

The generated DDL ran clean first time, and PostgreSQL's catalogue matches the
generator's claims exactly: 60 tables, 555 columns, 86 `double precision`, 58
identity, **0 foreign key constraints**.

Two findings came out of actually running things:

**1. `numeric` is as dangerous as D4 says.** Proven in the same database rather
than assumed — `verify_money_types_pg.mjs` section D queries a `numeric` and a
`bigint` and shows what node-postgres returns:

```
numeric 1000.5 + numeric 300.25  ->  "1000.5300.25"
double  1000.5 + double  300.25  ->  1300.75
```

**2. The hand-counted dialect list was wrong.** It missed two-argument
`MAX(a, b)` entirely — **22 occurrences, all in money paths**, which PostgreSQL
rejects outright. The count was produced by a regex that could not see past
nested parentheses, and every real occurrence is wrapped in `COALESCE`, so the
only matches it found were in comments.

`verify_sql_dialect.mjs` now *measures* the inventory and fails the build when
a count moves, so the next missed construct is caught by the suite rather than
by a screen that stopped working. Three other counts were also wrong (julianday
11 vs 22 — lines counted as occurrences; CAST 19 vs 10 — every cast counted,
not just `AS INTEGER`; `date('now')` 5 vs 7).

Corrected table: `db/CLAUDE.md`.

---

## Phase 2 · Frontend

- [x] Copy `Talha Farm/src/app/` into `src/app/` — 121 TypeScript files, 57 screen folders
- [x] Define `PlatformApi` matching the `electronAPI` shape exactly
- [x] Implement it over `HttpClient`, preserving the `{ success, error }` result shape
- [x] Point `DatabaseService` at it — signatures unchanged, so no call site moved
- [x] Replace `printPdfBase64` in 19 components + `print-report.util.ts` with a browser print path
- [x] Remove the activation route and component, `getMachineId`, the licence system
- [x] Remove Electron build configuration from `package.json`
- [x] **The app builds** — `dist/farminfantary`, 6.0 MB, **zero `electronAPI` in the bundle**
- [x] Dev proxy so `ng serve` reaches the API
- [x] Seed a demo account — `db/seed.mjs`, 41 tables across all four modules
- [x] **Walk the app in a real browser** — login, all four module tabs, and the
      broiler screens, verified against the seeded figures
- [x] Walk every screen in all four modules — **690 queries, 12 failures in 4 classes** (below)
- [x] Fix the dialect gaps — all four, plus two more the walk could not reach
- [x] **`verify_app_sql_prepares.mjs`** — translates and `PREPARE`s all 345 static
      statements; **345/345 prepare cleanly**

**Gate:** every screen works in a browser with no Electron present.
**Status:** the app runs. Logged in through the real login screen and drove
Flock Health, Expenses, Feed, Sale, Report, Batch Management, Inventory and the
Overview dashboard against PostgreSQL. Figures match the seed exactly.

### Three real defects found by running it

Each was invisible to the build and to the verify suite.

**1. `<base href="./">` — every refresh and deep link was broken.**
The desktop loaded `index.html` from disk over `file://` and always opened at
the index, so a relative base was correct and deep URLs did not exist. On the
web, `./` resolves against the current path: at `/app/sale` the browser asks
for `/app/main.js`, gets a 404, and the app never boots — a white page with no
console error. Fixed in `src/index.html` and `angular.json` (`baseHref`).

**2. The dialect translator corrupted nested `MIN(MAX(..))`.**
Two Overview queries failed with `syntax error at or near ")"`. Collecting
overlapping edits in a single pass spliced the inner replacement into text the
outer one had already rewritten, leaving unbalanced parentheses. Now only the
outermost, non-overlapping edits apply per pass and the loop converges.
Regression test added.

These are money queries — the distribution outstanding totals. They would have
shipped silently.

**3. `friendlySqlError` only recognises SQLite messages.**
`sql-error.util.ts` matches `constraint failed|SQLITE_|no such table|...`.
PostgreSQL's wording matches none of it, so a real failure surfaced as
"unknown error" with the actual message discarded. The screen told the user
nothing and the server logged nothing. Mitigated by `LOG_SQL_ERRORS=1`, which
logs the failing statement server-side; the pattern itself still needs
PostgreSQL's error shapes adding.

### Verified in the browser

| Screen | Checked against the seed |
|---|---|
| Flock Health | 4,777 birds, 198 mortality, 18,600 bags |
| Expenses | Rs. 34,700 over 3 entries |
| Feed | Rs. 2,048,000 across three deliveries |
| Sale | 4,200 kg, Rs. 1,806,000, 1 vehicle |
| Report | income Rs. 24,000, expenses Rs. 34,700, 4,200 kg sold |
| Batch Management | Batch L-1, 3,000 birds, Lohmann Brown |
| Inventory | Broiler Starter 50kg, expiry 2026-09-30, low-stock flag |
| Overview | Cash Rs. 77,900, bank Rs. 500,000, loans 150,000 / 90,000 |

One note on method: the automation's synthetic clicks do not reach Angular's
handlers, so navigation was driven programmatically. That is a tooling quirk,
**not** an app defect — a dispatched `.click()` navigates correctly.

### Walking every screen: 4 more dialect gaps

Driving all four modules issued **690 queries and produced 12 failures in 4
classes**. None of them appear in the dialect inventory, because none is a
construct a text search was looking for — they are differences in what
PostgreSQL *accepts*, not in what the SQL *says*.

They were only visible because `LOG_SQL_ERRORS=1` records the failing
statement server-side. From the browser each was a blank card or a silent zero.

**A. `date(x, modifier)` — SQLite's date arithmetic.**

```sql
date(o.start_date, '+' || (fh.week_number - 1) || ' days') >= ?
```

PostgreSQL has no two-argument `date()`. Needs `(x::date + n)` with the
modifier parsed out of a concatenation, which is why the existing
`date('now')` rule does not reach it. **Breaks the per-unit flock-health
consolidation.**

**B. Multi-statement SQL in one call.**

```sql
UPDATE product_batches SET status = 'expired'  WHERE ...;
UPDATE product_batches SET status = 'depleted' WHERE ...;
UPDATE product_batches SET status = 'expiring' WHERE ...;
```

Three statements in one string. PostgreSQL permits that only without
parameters, and the guard in Phase 3 will reject multi-statement input
outright — so this has to be split into a batch regardless.

**C. `could not determine data type of parameter $N`.**

```sql
AND s.date <= COALESCE(?, '9999-12-31') AND (? IS NULL OR ...)
```

A parameter used only in `? IS NULL` has nothing for PostgreSQL to infer a
type from. SQLite does not care. The fix is an explicit cast, and deciding
*which* cast per placeholder is not mechanical — this is the hardest of the
four.

**D. `column "p.product_name" must appear in the GROUP BY clause`.**

```sql
SELECT po.*, p.product_name, s.supplier_name, COALESCE(SUM(pr.quantity),0) ...
GROUP BY po.purchase_id
```

SQLite allows bare columns alongside an aggregate and picks an arbitrary row.
PostgreSQL requires each one grouped, aggregated, or functionally dependent on
a grouped primary key. **Breaks the Purchase Orders screen.**

### All six fixed, and a better detector built

A, B and C are translated at the boundary; D and a sixth problem needed the
query itself changed, because PostgreSQL's rules there cannot be translated
away safely.

| | Problem | Fix |
|---|---|---|
| A | `date(x, modifier)` | translated to `to_char(x::date ± INTERVAL …)`; unrecognised modifiers are **refused**, not guessed |
| B | multi-statement SQL | split at the boundary, run in order in one transaction, params handed out by position |
| C | `? IS NULL` | `?::text IS NULL` — narrow by design; `COALESCE(?, …)` already infers from its sibling |
| D | bare columns with `GROUP BY` | query changed to group by the joined tables' primary keys |
| E | `date + bigint` | knock-on of D15: PostgreSQL has `date + integer` only, so the computed modifier casts `::int` |
| F | alias in `HAVING` | expression repeated; SQLite lets `HAVING` see a select-list alias, PostgreSQL does not |

### The detector that replaced clicking

Walking screens finds defects one blank card at a time, and only on the
screens you happen to reach. `scripts/verify/verify_app_sql_prepares.mjs`
extracts every self-contained SQL literal in the app, translates it, and
`PREPARE`s it against PostgreSQL — which parses, resolves and type-checks
without executing.

**507 statements, all preparing cleanly [Codex].** The AST collector now includes
single- and double-quoted JavaScript strings as well as template literals. The
earlier template-only checker covered 345 statements. It found the `HAVING` alias and
seven of the eight `GROUP BY` candidates that no amount of clicking had
reached.

It took two corrections of its own before it could be trusted, and both are
worth recording because they are the normal failure mode of a tool like this:

- it grabbed **fragments** of statements built by concatenating template
  literals, reporting a missing `GROUP BY` that existed in the next fragment —
  7 of the first 10 "failures" were this
- it numbered placeholders across a whole multi-statement string and then
  split it, leaving piece two holding `$2` with no `$1`

A checker that cries wolf gets ignored, so both were fixed before the real
failures were acted on.

**Scope, stated plainly:** 120 statements built with `${…}` interpolation are
skipped, plus 33 SQL fragments assembled by concatenation. Their final text is
not knowable without running the builders. The script reports both counts every
run rather than implying full coverage.

### Honest status

The app runs, every module loads, every screen checked matches the seed, and
every static statement in the app type-checks against PostgreSQL. What is not
proven: the 120 interpolated statements, 33 concatenated fragments, and screens
never opened. Business ports execute some builders dynamically but do not close
all those gaps.

### What changed, and what deliberately did not

`DatabaseService` keeps every method signature. The six core calls now go
through an injected `PlatformApi` instead of a `window` global. [Codex] One
soft-delete SQL literal also uses PostgreSQL-compatible single quotes; its
behavior is covered by the 52-check product-delete port. All 341 caller
signatures stay unchanged.

The `declare global { Window.electronAPI }` block is gone: the app no longer
reaches for a global at all.

Three things were stubbed rather than deleted, because deleting them would
have meant editing templates for no behavioural gain:

| Kept as | Why |
|---|---|
| `LicenseService` reporting "activated" | `layout.component.ts` renders licence state in its template. Phase 5 points the body at `GET /api/entitlement`. |
| `getMachineId()` returning `'web'` | A licensing artefact, but removing it changes `DatabaseService`'s frozen surface. |
| `getAutoBackupPath()` returning `null` | There is no local backup folder on a server. |

`delete-auth.service.ts` now goes through `PlatformApi`, and carries an
explicit Phase 3 note: **the PIN comparison must move server-side.** Fetching
the PIN to the browser and comparing it there was adequate on a machine the
owner controlled; it is not a control once staff accounts exist.

### Verified

- `ng build` succeeds; the bundle contains no reference to `electronAPI`
- the dialect inventory re-pointed itself at `src/app` and **all 17 construct
  counts still match**, confirming the copy is faithful
- the API answers the exact request shape `HttpPlatformApi` sends, including a
  login-shaped query with `?` placeholders

---

## Phase 3 · Security

- [x] [Codex] Migration 004 adds farm_id to 30 business tables, backfills parents,
  sets NOT NULL/positive checks and ownership triggers. Retired activation is excluded.
- [x] [Codex] ENABLE/FORCE RLS and indexed uniform policies on all 59 tenant tables.
- [~] [Codex] Restricted role provisioning, preflight and application pool wiring
  verified with fresh logins. Persistent local runtime provisioning is still pending.
- [x] [Codex] Seven-stage AST guard uses libpg-query; farm-admin HTTP pipe is wired
  to scoped transactions and an attested restricted pool. Staff are deny-by-default.
- [x] [Codex] Argon2id and browser cookie login use fresh server users under D14;
  no public signup, legacy hashes, raw auth SQL or stored browser identity.
- [x] [Codex] Server cookie sessions resolve user/farm/role from PostgreSQL;
  tenant SQL/transaction pipeline and guarded browser session initialization are wired.
- [ ] Move the delete-code PIN check server-side
- [x] [Codex] Auth throttles, bounded password work, SQL row caps and atomic
  authenticated SQL per-user/IP request limits are implemented and tested.
- [x] [Codex] Adversarial AST and HTTP tests cover cross-tenant reads/writes,
  multi-statement, DDL/context/catalog/function attacks, forged ownership,
  session transaction theft, revocation, row caps and startup policy/role drift.

**Gate:** no authenticated path reads or writes another account's data, proven
by tests that actively try.

### Server identity foundation — Codex, 2026-10-26

- [x] [Codex] Migration 003 adds users, hashed session verifiers, atomic throttle
  buckets, farm status and durable auth-version revocation. Applied locally;
  no real admin/account was created and no legacy credential was imported.
- [x] [Codex] Login, session lookup, logout and password-change endpoints use
  server-derived identity, exact-origin checks, HttpOnly/SameSite cookies, idle
  and absolute expiry, cookie rotation and all-device password revocation.
- [x] [Codex] Native Argon2id work and encoded hash costs are bounded. Generic
  login errors, sanitized DB failures, no-store responses and 4 KiB bodies are tested.
- [x] [Codex] One-time super-admin bootstrap serializes concurrent attempts and
  refuses an existing owner without overwriting credentials.
- [x] [Codex] Authentication verification: 28 real PG/HTTP scenarios and seven
  unit tests. Catalog key discovery now follows current_schema; the new private-
  schema fixture proves INSERT IDs do not depend on public metadata.

`AUTH_MODE=session` exposes the identity API and refuses every business SQL/
transaction request until the SQL guard/RLS exist (403 for platform admins,
503 for farm users, 401 without a session). Production and unspecified NODE_ENV
refuse startup; only explicit development is allowed. The existing browser demo
remains on `AUTH_MODE=development` until integration is ready. The full security
gate is open. Database tenant policies and restricted-role tooling are now implemented;
next: AST guard, runtime pool/transaction
integration, then browser sessions. See `AUTHENTICATION.md`.

### Session transaction executor — Codex, 2026-10-26

- [x] [Codex] Implemented device-session-bound opaque transaction tokens and
  immutable server actor binding, with one explicit transaction per session.
- [x] [Codex] Each operation uses a dedicated transaction and local farm/user
  context; batch/savepoint and lastId result contracts remain intact.
- [x] [Codex] Serialized operations/commit, admission limits, idle/absolute/
  statement deadlines, revocation and shutdown roll back abandoned work.
- [x] [Codex] Verified 28 PostgreSQL scenarios using a disposable non-owner,
  NOBYPASSRLS role and FORCE RLS fixture; added three unit tests. Auth hooks
  dispatch revocation after durable changes without exposing session verifiers.

This executor remains disabled in the application pending the AST guard and
restricted runtime pool integration. Full-schema tenant policies are now installed. Route and auth-hook
integration points exist; production wiring and admin-triggered invalidation
remain pending. Read `SESSION_TRANSACTIONS.md`. The full security gate stays open.
Latest validation: **73/73 verification scripts**, approximately **9,243 reported
checks**, **73/73 backend tests**; all inherited gates stay green. This batch
changes no Angular code and installs no persistent role or schema migration.

### Full-schema tenant boundary — Codex, 2026-10-26

- [x] [Codex] Applied immutable migration 004 locally: 30 new ownership columns,
  59 indexed FORCE policies and 58 business ownership triggers. No foreign keys,
  deleted rows or rewritten money/date types; unresolved owners abort atomically.
- [x] [Codex] Added explicit table/column grants, atomic fresh-role provisioning
  and direct-login runtime attestation. No owner/admin bypass policy exists.
- [x] [Codex] Private auth metadata lookup preserves farm-status checks without
  granting the SQL role credentials, session data or the metadata accessor.
- [x] [Codex] Verified 26 full-schema PostgreSQL tenancy scenarios with actual
  restricted logins, including FORCE on a non-superuser owner, orphan behavior,
  migration rollback and role/policy drift. Disposable logins/schemas were removed.

No persistent restricted login was created. Next is the real AST authorizer and
runtime/transaction wiring, followed by browser sessions and permissions. The
production gate remains open. Details and provisioning: `TENANT_ISOLATION.md`.
Latest validation: **74/74 scripts**, approximately **9,270 reported checks**,
**73/73 backend tests**. All 29 inherited gates remain green. Egg collection now
performs 116 checks because its column scanner also verifies the new farm_id;
the original 115 checks/values remain covered. No Angular code changed.

---

### AST guard / HTTP milestone — Codex, 2026-10-26

- [x] [Codex] Real PostgreSQL AST parsing, closed statement/function/type/table
  rules, nested scope rewriting, server farm stamping and safe parameter rebinding.
- [x] [Codex] Opaque prepared capabilities execute exactly the deparsed SQL;
  generated lastId, batch back-references and savepoint behavior are preserved.
- [x] [Codex] Farm-admin session HTTP uses an attested restricted pool, fresh
  cookie identity, matched-route authentication, scoped transactions, atomic
  user/IP request limits and row caps. Rotation/logout/password/stale-identity
  hooks and shutdown roll back outstanding transactions. Staff stay denied.
- [x] [Codex] 504 current static business statements compile and PREPARE after
  guard rewriting; seven exact legacy account queries remain denied. Dynamic
  inventory gaps (120 interpolated/33 concatenated) are reported, not claimed static.
- [x] [Codex] Nine grouped guard unit tests and 20 real cookie/HTTP/PostgreSQL
  scenarios cover hostile SQL, tenant attacks, token theft, limits and cleanup.
- [x] [Codex] Full suite **76/76**, approximately **9,795 reported checks**;
  backend **82/82**. Angular builds with existing CommonJS warnings. Both status
  update methods now use atomic batches with unchanged public signatures.

Migration stays at 004. No persistent runtime login or real account was created.
Production remains blocked; browser auth, staff permissions, PIN/admin/operations
and independent security review remain. Activation details: `SQL_GUARD.md`.

---

### Browser cookie sessions — Codex, 2026-10-26

- [x] [Codex] Cookie login, `/me` restore, guarded parent/child routes, safe deep
  links, role access page, logout and session-expiry handling replace legacy auth.
- [x] [Codex] Account changes clear private drafts/selections/transaction tokens;
  stale responses are dropped, cross-tab changes invalidate local identity, and
  offline logout remains pending until server revocation. Writes are never replayed.
- [x] [Codex] Dedicated farm-admin business-type endpoint and cookie/context
  preconditions prevent a stale tab from applying its operations to another identity.
- [x] [Codex] 17 browser source-state scenarios and 22 guarded HTTP/PG scenarios
  pass; 501 static business SQL statements compile/PREPARE with no auth exemptions.
- [x] [Codex] Built app verified in the in-app browser for owner sign-in,
  password reveal, requested inventory/reload, expiry, staff restriction and logout.
  Latest suite: **77/77 scripts (~9,811 checks)**, backend **82/82**, Angular build
  green with existing CommonJS warnings. UI/browser evidence is in qa-results.

Session-mode operator setup and fresh account provisioning are still needed for
normal local use. No real users or persistent runtime login were created, `.env`
is unchanged, and production startup is blocked. Next is Phase 4's derived
permissions/admin work, plus outstanding server delete authorization and operations.

---

## Phase 4 · Access control

- [~] [Codex] Users/roles/status and private permission tables are present;
  seat/delegation columns and admin provisioning remain pending.
- [x] [Codex] ~~Migrate existing farm logins~~ — cancelled by D14: fresh web users only.
- [x] [Codex] One-time super-admin bootstrap command implemented and tested;
  real provisioning waits for operator-supplied credentials.
- [x] [Codex] Generate and seed the 50-key current catalogue from four active menus;
  Add Batch shares its Batches key. The historical 47-key estimate is superseded.
- [x] [Codex] Private grant storage validates staff/farm/key/flags and revokes
  device sessions on changes; runtime grants exclude all permission metadata.
- [~] [Codex] Derive the permission → operation/table/module mapping by actual IO
  instrumentation. Four voucher create/delete scopes across 2/50 screens are
  observed; views, other screens, initialization/resolvers and module policy remain.
- [ ] Extend the guard to enforce that mapping per statement
- [ ] Add the seat-limit trigger with its `FOR UPDATE` row lock
- [ ] Build the super admin console on dedicated endpoints
- [ ] Filter sidebar and route guards by `can_view` — usability only, never the control
- [ ] Add the write audit log
- [ ] Test that permission X cannot reach permission Y's tables

**Gate:** a staff user reaches exactly their granted screens and tables, and no
more.

Latest Phase 4 foundation: migration 005 is applied locally. 16 permission PG
scenarios and 10 derivation/tracing scenarios pass; full suite **79/79 scripts**
(~9,837 reported checks), backend **82/82**. No Angular source changed in this
batch. Staff SQL remains denied, including with full grant rows. No real users
or persistent runtime login were created. Read `STAFF_PERMISSIONS.md` and the
generated `PERMISSION_TABLE_MAP.md`; do not mistake observed table sets for a
reviewed permission policy.

---

## Phase 5 · Operations

**Owner-only candidate update (2026-10-26):** the user deferred staff business
access. Admin/seat/audit controls, server delete authorization, owner export,
active-account entitlement, encrypted operator backup/restore, static shell,
restricted auth provisioning and deployment templates are implemented. Validation:
84/84 scripts (~9,892 checks), 83/83 backend tests, patched Angular 20 production
build; production dependency audits report zero vulnerabilities. The checklist
below describes the original full scope and is not a claim of deployment.
Per-farm import, actual scheduling/offsite backup activation, independent review,
Docker/Compose verification and hosting/HTTPS remain. See `OWNER_RELEASE.md`.

- [ ] Scheduled `pg_dump` with retention; download endpoint
- [ ] Per-farm export; per-farm import into a new empty farm (D10)
- [ ] Replace licensing with account entitlement on `farms.status`
- [ ] PWA shell, retry on transient failure, explicit unsaved state (D9)
- [ ] Deployment, monitoring, error reporting, backup verification
- [ ] Load-test the SQL endpoint against its rate limits

**Gate:** in production, with backups proven restorable.
