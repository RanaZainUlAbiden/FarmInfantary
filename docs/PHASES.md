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
- [ ] Convert `alterStatements` and the guarded migrations into numbered forward-only migrations under an advisory lock
- [x] Port `runQuery`, `getQuery`, `runBatch` and the transaction layer to `node-postgres` — `server/src/db/execute.js`
- [x] Reimplement `lastId` via `RETURNING` — keys read from the catalogue at startup, so there is no map to keep complete
- [x] Reimplement `$lastId` batch back-references, negative indexing included, with tests
- [x] Translate the dialect at the boundary — `server/src/db/dialect.js`, refuses what it cannot translate
- [x] Parse integer columns to JS numbers (D15) — 214 of 555 columns were arriving as strings
- [x] Build the `?` → `$n` placeholder rewrite at the boundary — `server/src/db/placeholders.js`
- [x] Stand up the database endpoints mirroring the IPC surface — `server/src/server.js`, 34 HTTP checks
- [ ] Remaining endpoints: settings, backup, entitlement (small; auth-dependent)
- [~] Re-point the 29 verify scripts at PostgreSQL — **harness built, 1 of 29 ported** (see below)

**Gate:** the same 29 scripts green against PostgreSQL.

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

**Ported so far: 2 of 29.** `verify_categories_pg.mjs` (20 checks) and
`verify_loans_pg.mjs` (133 checks) are green on PostgreSQL, running the real
method bodies.

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

**Recommendation: hand-port the four shape-B money scripts** (vouchers,
internal_settlements, cash_and_bank_totals, no_negative_bank). A hand port is
a known quantity; another transform layer is not, and a subtly wrong test is
worse than no test.

Realistic estimate: shape-A scripts port in minutes each; shape-B ones need
hand work. Expect each batch to surface engine differences — three have turned
up in two scripts so far, and all three were real.

That first port immediately found `COLLATE NOCASE` — 7 occurrences the dialect
inventory had missed entirely, which PostgreSQL rejects outright. See below.

Remaining work is mechanical but not small: 23 of the 29 extract TypeScript
method bodies and need the same treatment; 6 are pure-SQL and are simpler.
Expect roughly one working session per handful, and expect each batch to
surface dialect or semantic differences the way the first one did — that is
the point of the exercise, not a sign it is going badly.
**Status:** schema executes against real PostgreSQL and matches the generator
exactly. Query layer and endpoints not started.

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
- [ ] Fix the 4 dialect gaps the walk found

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

### Honest status

Phase 2's gate is **not met**. The app runs, every module loads, and the
screens checked against the seed are correct — but four query classes fail,
and two of them (A and D) break a screen outright.

A and B are mechanical. C and D need judgement per query, and D in particular
cannot be auto-rewritten safely: adding columns to `GROUP BY` changes results
when they are not functionally dependent.

### What changed, and what deliberately did not

`DatabaseService` keeps every method signature. The only edits inside it are
the six core calls, which now go through an injected `PlatformApi` instead of
a `window` global — so **all 341 call sites are untouched**, which was the
entire premise of the conversion.

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

- [ ] Add `farm_id` to the 30 tables lacking it; backfill from parents; insert triggers; `NOT NULL`
- [ ] Enable `ROW LEVEL SECURITY` and `FORCE` on all 59 tenant tables with the uniform policy
- [ ] Create a non-owner application role without `BYPASSRLS`; verify policies actually apply
- [ ] Build the seven-stage guard on `libpg-query`
- [ ] Replace `hashPassword()` with argon2id; rehash on next successful login
- [ ] Move sessions to `httpOnly` cookies; resolve `farm_id` server-side per request
- [ ] Move the delete-code PIN check server-side
- [ ] Add `statement_timeout`, row caps, per-session rate limits
- [ ] Write the adversarial suite: cross-tenant reads and writes, DDL attempts, multi-statement attempts, catalogue reads

**Gate:** no authenticated path reads or writes another account's data, proven
by tests that actively try.

---

## Phase 4 · Access control

- [ ] Create `users`, `permissions`, `user_permissions`; add seat and delegation columns to `farms`
- [ ] Migrate existing `farms` logins to `farm_admin` users (D11)
- [ ] Bootstrap command for the first super admin
- [ ] Seed the 47-key permission catalogue from the five sidebar menus
- [ ] Derive the permission → table mapping with `tools/`, by instrumenting what screens write
- [ ] Extend the guard to enforce that mapping per statement
- [ ] Add the seat-limit trigger with its `FOR UPDATE` row lock
- [ ] Build the super admin console on dedicated endpoints
- [ ] Filter sidebar and route guards by `can_view` — usability only, never the control
- [ ] Add the write audit log
- [ ] Test that permission X cannot reach permission Y's tables

**Gate:** a staff user reaches exactly their granted screens and tables, and no
more.

---

## Phase 5 · Operations

- [ ] Scheduled `pg_dump` with retention; download endpoint
- [ ] Per-farm export; per-farm import into a new empty farm (D10)
- [ ] Replace licensing with account entitlement on `farms.status`
- [ ] PWA shell, retry on transient failure, explicit unsaved state (D9)
- [ ] Deployment, monitoring, error reporting, backup verification
- [ ] Load-test the SQL endpoint against its rate limits

**Gate:** in production, with backups proven restorable.
