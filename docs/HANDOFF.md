# Handoff

## FarmInfantary branding / production CSS fix — 2026-10-26

Commit `352be8965f0ed97bc8588e4e9b7cb424b949d2f3` deployed successfully through
GitHub main. Current reviewed source digest:
`52d248cec5dade12ae4707109a3323e29643acfe2369077e374d072ab466d303`.
The user-reported unstyled login was reproduced: Angular's inline stylesheet
onload handler was blocked by CSP. Critical-CSS inlining is now disabled, without
weakening CSP, and a production-output gate is part of the local/Docker builds.

FarmInfantary and supplied logo/favicon replace the old product/report identity,
including PWA and splash. Public logo/favicon bytes match the supplied originals.
Versioned asset URLs avoid stale old-logo cache hits. The Railway project display
name is FarmInfantary. Historical desktop reference/source paths stay unchanged.

Validation: 85/85 scripts (~9,894 checks), 83 backend tests, production build/gate,
nine live auth/HTTPS cases and four live branding/CSS checks pass. Browser evidence
shows public sign-in layout `flex`, card width 420px, green action and loaded
1254px supplied logo. The local production-CSP fixture also passes at 390px with
358px card/no horizontal overflow. Disposable QA was cleaned up. Read
`BRANDING_FIX.md`; screenshots/logs are in `qa-results/branding-*` and
`qa-results/farminfantary-live-*`. The current approval is the user-authorized
Codex self-review under D17, not an independent review.

## Deployed owner-only release — 2026-10-26

Live: https://farminfantary-web-production-c687.up.railway.app

PR #1 is merged into main (`3519ff33141e825b9dd9eef3a77c493d6b8b2a1e`).
Railway automatically built/deployed that exact commit; app and database are
healthy. **85/85 scripts (~9,894 checks), 83/83 backend tests, production build,
clean production dependency audits and nine live HTTPS smoke scenarios pass.**
The in-app browser confirms administrator sign-in and restoration after deploy.
The reviewed source digest is
`27eec29ef6a87a75a13adb02bad4b1e4b57991ada8ddc794f8f2aa40b59bac42`.
Review was Codex self-review at the user's explicit request (D17), not independent.

The private backup cron runs daily at 07:00 PKT and retains seven encrypted
archives on its own volume. A real run verified the mount and found an earlier
archive after a new container/image started (`previousArchives=1`,
`archivesAfter=2`). Native Railway backup schedules were refused by the current
plan; no plan upgrade was performed. External archive copies remain an operator
responsibility. One-off setup/bootstrap services and privileged variables are gone.

Administrator credentials are in ignored `ops/railway-admin-credentials.env`.
Full operator/recovery material is separately in ignored `ops/railway-secrets.env`.
No farms/business data were invented in production; the administrator can create
the first farm in the live Administration screen. Staff business SQL and per-farm
import remain deferred. See `RAILWAY.md` for operations, review gates and recovery.

Evidence: `qa-results/live-railway-smoke.log`, `verify-railway-approved.log`,
`backend-railway-final.log`, `angular-railway-final.log`, live/admin screenshots
and `railway-backup-persistence.log`. Earlier blocks below describe prior states.

## Railway deployment update — 2026-10-26

The user selected Railway, requested a new **FarmInfantary (Talha Farm)** project
and GitHub automatic deployment, and assigned the final review to Codex. D17
records this as self-review, not independent approval. PR #1 contains the release
branch. The Railway app is connected to GitHub `main`; merging the reviewed
release will trigger its build. Private PostgreSQL 18 is online, migration 007
and both restricted roles are applied/attested by the successful one-off job.
The operator password was rotated and the privileged setup job removed. App
runtime credentials are distinct and migration credentials are not passed to it.

Linux builds found a Feed template/import filename-case mismatch, now fixed.
Final self-review fixed eight-character delete-code hashing and moved export
size screening into PostgreSQL before row transfer. Updated tests and Railway
web startup/HTTPS validation are in progress. Current actual status and recovery
steps belong in `RAILWAY.md`; older counts/requirements below are historical.

## Owner-only release candidate — 2026-10-26

This block supersedes earlier milestone status below. The user chose an
owner-only first release, without parallel agents. **84/84 verification scripts,
approximately 9,892 reported checks, 83/83 backend tests and the Angular 20.3.34
production build pass.** Frontend/backend production dependency audits report
zero vulnerabilities. All 29 inherited gates remain green. Migration 007 is
applied locally. Existing PDF dependencies still produce CommonJS warnings.

- [x] [Codex] Dedicated farm/owner provisioning, seat quotas, delegated staff
  administration, optimistic versions and audit; 18 PG scenarios use a real
  restricted auth login and verify privilege denial.
- [x] [Codex] Server delete authorization, owner code configuration, device-bound
  sixty-second grants, default-deny guard integration and native dialog flow.
- [x] [Codex] Active-account entitlement and isolated owner JSON export; 14
  delete/export scenarios verify identity, bypass refusal, limits and isolation.
- [x] [Codex] Authenticated encrypted operator backups and empty-target restore;
  six actual PG dump/restore scenarios, retention and session revocation pass.
- [x] [Codex] Narrow private auth role provisioning/attestation, production
  profile/source digest gate and eight owner-release security scenarios.
- [x] [Codex] Docker/Caddy/Compose package, readiness and backup service/timer
  templates; manifest/static-shell privacy checks (six scenarios) pass.
- [x] [Codex] Upgraded inherited Angular 19 to patched Angular 20.3.34, compatible
  CLI/build 20.3.41 and TypeScript 5.9.3. Locked dependencies audit clean.

**Next:** use `OWNER_RELEASE.md` on the chosen host. Docker is unavailable here:
images, Compose startup and public HTTPS have not been exercised. Independent
review approval, hosting/domain/secrets and monitored/offsite backup activation
remain outstanding. No production approval, actual deployment, real account or
persistent auth/runtime login was created. Staff business SQL remains denied;
mapping four voucher action scopes on 2/50 screens is incomplete and deferred.
Per-farm JSON import is deferred. Operator full-database restore is tested.

Evidence: `qa-results/verify-owner-final.log`, `backend-owner-final.log`,
`angular-owner-final-build.log`, `audit-frontend-final.json`,
`audit-server-final.json` and the dedicated owner/admin/backup test logs.

## Codex continuation — 2026-10-26

Latest validation: **79/79 verification scripts**, approximately **9,837 reported
checks**, and **82/82 backend tests**. All 29 inherited gates remain green.
Angular builds successfully (existing CommonJS dependency warnings); two multi-
statement status methods now use atomic batches with unchanged signatures and
predicates. This supersedes earlier counts below. Migration 005 is applied; no persistent
restricted login or real account was created. Disposable roles/schemas were removed.

- [x] [Codex] Derived and seeded 50 current screen permission keys from the
  active menus/routes (14 broiler, 15 layer, 15 distribution, 6 owner). The older
  47-key estimate was stale; Add Batch is a shortcut onto Batches.
- [x] [Codex] Added private integer grant flags, staff/farm/key validation,
  durable grant-change revocation and identity-change cleanup in migration 005.
  Current-user snapshots reject stale/mismatched/suspended actors. The runtime
  role cannot access permission metadata or its trigger functions.
- [x] [Codex] Built offline SQL instrumentation and captured actual create/delete
  voucher workflows, including ledger/bank side effects, refusals, source digests
  and no persisted SQL/parameter data. See `STAFF_PERMISSIONS.md` and generated
  `PERMISSION_TABLE_MAP.md`: **4 action scopes / 2 of 50 screens**, not a complete
  or active guard policy. All staff SQL stays denied even with full grant rows.
- [x] [Codex] Verified 16 real PostgreSQL permission scenarios and 10 derivation/
  tracing scenarios; the 255-check voucher regression retains all assertions.
  The complete suite is green. Offline parser subprocesses use baseline Wasm
  compilation to avoid a local Windows Node 24 compiler crash; API flags are unchanged.

- [x] [Codex] Replaced browser legacy hash/SQL/localStorage authentication with
  cookie login and `/me` restoration before protected parent/child routes. Added
  stale-response/transaction-token rejection, safe internal return URLs, central
  private-cache resets, cross-tab invalidation and retryable offline sign-out.
- [x] [Codex] Added server-validated request-context preconditions and a dedicated
  cookie-owned business-type endpoint. Browser auth contains zero raw SQL; all
  501 remaining static business statements compile/PREPARE without exemptions.
  Verified 17 browser state scenarios and 22 guarded cookie/HTTP/PG scenarios.
- [x] [Codex] Verified the built app in the in-app browser: owner sign-in,
  password reveal/hide, deep-link/reload, expiry, restricted staff access and
  logout/reload. Existing auth identity is preserved; DESIGN.md/UX-CONTRACT.md
  describe shared behavior and scope. Read `AUTHENTICATION.md` and local evidence
  `BROWSER_SESSION_QA.md`.

**Next:** finish instrumented staff screen/action/module mappings, review and
enforce the derived policy, then implement dedicated admin
provisioning/seat controls, server-side delete authorization, audit and deployment
operations. Browser sign-in requires session-mode configuration and fresh users;
legacy demo credentials do not work. No persistent runtime credentials or real
users were created. Production startup remains blocked. Earlier milestone notes
below describe their state at the time; this current block supersedes them.

- [x] [Codex] Implemented the seven-stage libpg-query AST guard with explicit
  tenant rewrite, closed syntax/function/table allowlists, safe server INSERT
  stamping, parameter rebinding and opaque prepared execution. Wired real cookie
  HTTP -> guard -> owned transaction -> attested restricted pool -> FORCE RLS.
  Farm admins can use session SQL only with configured/verified runtime credentials;
  missing runtime setup returns 503, staff/platform access is denied, production
  startup remains blocked. Matched-route auth and a no-raw-fallback route boundary
  protect encoded URL variants. Login/logout/password/status cleanup is connected.
- [x] [Codex] Verified 504 guarded static business statements in PostgreSQL;
  seven exact retired account queries stay denied. Added nine grouped unit tests
  and 20 real guarded HTTP/PG scenarios. Atomic user/IP SQL limits and row caps
  are enabled. Read `SQL_GUARD.md`. Next: browser cookie authentication, dedicated
  account/admin operations, derived staff permissions, PIN and deployment work.

- [x] [Codex] Installed 30 business ownership columns, 59 indexed FORCE tenant
  policies and 58 stamping triggers, preserving money/date types and manual
  orphan behavior. Unresolved/ambiguous pre-upgrade owners abort atomically.
- [x] [Codex] Added atomic narrow runtime-role provisioning and startup attestation,
  plus private auth farm metadata lookup without an owner bypass policy. Verified
  26 full-schema PG scenarios with actual restricted logins, drift rejection,
  non-superuser owner FORCE behavior and migration rollback. Read
  `TENANT_ISOLATION.md`. Next: AST guard, runtime pool/transaction wiring and
  browser sessions. Real-session business routes and production startup stay blocked.

- [x] [Codex] Added isolated session transaction execution: opaque tokens bound
  to a device's server identity, dedicated local-context transactions, serialized
  queues/commit, bounded capacity, deadlines, revocation and shutdown rollback.
  Verified 28 PG scenarios with a disposable restricted role and FORCE RLS table,
  plus three unit tests. Fixed BEGIN lease leakage and aborted COMMIT reporting.
  Auth session keys stay internal; revocation callbacks are tested. Application
  activation still waits for full tenant RLS/runtime role/AST guard. Read
  `SESSION_TRANSACTIONS.md` before wiring it; current production/session SQL
  startup protections remain in place.

- [x] [Codex] Server authentication foundation implemented: Argon2id, opaque
  HttpOnly cookies, idle/absolute expiry, server-derived identities, rotation,
  password changes, durable user/farm revocation, atomic throttles and one-time
  super-admin bootstrap. Migration 003 is applied locally; no accounts created.
- [x] [Codex] Verified 28 real authentication scenarios and seven new unit tests.
  In session mode all SQL/transaction routes fail closed pending guard/RLS.
  Production/unspecified NODE_ENV startup remains blocked. Browser AuthService
  integration is still pending; read `AUTHENTICATION.md` for mode/config details.

- [x] [Codex] Implemented `db/migrate.mjs` and an immutable numbered baseline,
  advisory lock, transaction rollback, checksum history and validated adoption
  of existing manual PostgreSQL setups through `--baseline`.
- [x] [Codex] Validated and baselined the existing local development database
  at version 001; the subsequent normal migration run applies nothing.
- [x] [Codex] Verified 17 real PostgreSQL migration scenarios, including schema
  drift, money types, indexes, vaccination preservation and concurrent deploys.
- [x] [Codex] Ported vouchers (255 checks), internal settlements (211), cash
  and bank totals (176), and negative-bank protection (197) to PostgreSQL.
  These 839 checks run current web source through the real server query layer.
- [x] [Codex] Ported bank withdrawals (1,615 checks), automatic sale settlement
  (217), and layer-sale customer receivables (156): another 1,988 PostgreSQL checks.
- [x] [Codex] Ported Overview assets (9 checks), Distribution outstanding cards
  (17), supplier tracking (170), Supplier Accounts (161), and bill/bank payments
  (152), adding 509 checks. Bill writes use real server transactions.
- [x] [Codex] Ported assets (42 checks), product deletion (52), layer ledgers
  (56), and FCR reporting (103), adding 253 PostgreSQL checks.
- [x] [Codex] Ported asset settlements (64 checks), opening balances (62),
  ledger-payment reversals (76), and debt records (42), adding 244 checks.
  All asset-sale expectations are retained, including isolated test-only
  historical backfills; no production importer was added under D14.
- [x] [Codex] Strengthened debt snapshots to run all fourteen actual Overview
  builders and fail on query errors. Scratch schemas set search_path during
  connection startup, avoiding a connect-event query race on parallel reads.
- [x] [Codex] Closed all 29 inherited gates: bank screen SQL (120), egg cartons
  (115), expense/ledger separation (58), own-farm customers (73), opening stock
  (100), historical migration fixtures and the unchanged current-source scanner
  (3). The final five application ports add 466 checks. The full target coverage
  is 28 PostgreSQL scripts and one source-only check.
- [x] [Codex] Fixed a schema-generator defect that discarded uniqueness,
  collations and partial predicates. Migration 002 restores the three unique
  indexes without editing 001 or deleting rows. Nine upgrade/rollback scenarios
  pass; local development is at migration 002 with 50 non-primary indexes.
- [x] [Codex] Extended assertion-preservation verification to 1,901 expressions
  across twenty-five application ports, with documented storage adaptations and an async-predicate
  guard. These ports execute 4,299 runtime checks. Service IO
  adapters return the driver's result object; fixture setup failures throw.
- [x] [Codex] Fixed the batch soft-delete SQL literal: `"depleted"` was treated
  as a PostgreSQL column and left stock unchanged. It now uses `'depleted'`.
- [x] [Codex] Expanded SQL preflight with a tested TypeScript AST collector:
  507 static statements prepare; 120 interpolated statements and 33 concatenated
  SQL fragments remain explicit coverage gaps.
- [x] [Codex] Fixed negative-substr number padding at the SQL boundary. Three
  app uses now translate to RIGHT; 14 live checks cover widths 3/4 through 10,000.
- [x] [Codex] Preserved integer-prefix casts of known text forms, so a manual
  `IS-HAND` number no longer breaks the next automatic settlement. Added ten
  live prefix cases; numeric arithmetic still truncates.
- [x] [Codex] Fixed migration metadata comparisons with application parsers
  enabled: exact sequence limits are read as text, outside the JS integer range.
- [x] [Codex] Full verification suite: **72/72 green**, approximately 9,215
  reported checks; backend unit tests: **70/70**. The last Angular build passed
  with dependency CommonJS optimization warnings; this batch changes verification
  code, authentication, schema generation, migrations and documentation.
- [x] [Codex] Updated the shared Claude artifact in the in-app browser; each
  completed item is checked with `[Codex]` at the start of its label. The full
  inherited 29-script verification gate is now checked.

The new commands are in `db/migrations/README.md`. Migration metadata is stored
outside the business schema. No legacy desktop row conversion is replayed (D14).
The old handoff below is retained for context; its migration backlog and test
counts are superseded by this update. **All 29 inherited gates pass.** Opening
stock explicitly tests refused SQLite IDs and successful PG commits instead of
file exports; historical helpers remain test-only under D14. The server identity
foundation now exists. Next: tenant RLS, restricted database role, AST SQL guard,
transaction ownership and browser session integration, then permissions and
operations. Settings/backup/entitlement endpoints remain auth-dependent work.
The API is still development-only. The twenty-five Codex application ports are maintained separately from the
unresolved shape-B transform in `lib/port.mjs`; do not regenerate them with it.

---

Written for whoever picks this up next. It assumes no memory of the previous
sessions and points at the files that hold the detail.

Everything below was verified at the time of writing by running it. Where
something is unproven, it says so.

---

## What this project is

A web conversion of **Talha Farm**, an Angular 19 + Electron poultry farm
management app that stored data in a local SQLite file via sql.js. ~73,000
lines, 60 tables, ~60 screens, four business modules.

**The strategy, and the single thing to understand first:** the desktop app's
entire native surface was one object — `window.electronAPI`, about 20 methods —
and all 341 database call sites already funnel through one Angular service.
So the conversion replaces what sits *behind* `DatabaseService`, and the
Angular app plus every SQL statement carry over unchanged.

That is why `DatabaseService`'s method signatures are frozen, and why the SQL
is translated at the server boundary rather than rewritten in 341 places.

Full plan, with diagrams and the risk register:
<https://claude.ai/artifact/Q6j4fjcuH4m8kiuUcTGfH5>

---

## Current state

| | |
|---|---|
| Verify suite | **40/40 green**, ~4,780 checks, ~30s |
| Unit tests | **53/53** (`npm --prefix server test`) |
| Angular build | clean |
| Branch | `main`, pushed, working tree clean |

**Phase 0 (baseline)** — done. **Phase 1 (backend)** — done except migrations
and the verify-suite port. **Phase 2 (frontend)** — the app runs in a browser
against PostgreSQL; gaps listed below. **Phases 3–5** — not started.

Read `docs/PHASES.md` for the per-task detail. It is kept current and is the
authoritative task list.

---

## Running it

```bash
# one-time
npm install
npm --prefix server install
createdb farminfantary_dev
psql -d farminfantary_dev -f db/schema/000_collations.sql
psql -d farminfantary_dev -f db/schema/001_tables.sql
psql -d farminfantary_dev -f db/schema/002_indexes.sql
node db/seed.mjs --reset        # demo account + data across all four modules

# every time
npm --prefix server run dev     # API  -> http://127.0.0.1:3000
npm start                       # SPA  -> http://localhost:4200  (proxies /api)
```

Login: **`demo` / `demo123`**. The account is `business_type = 'all'`, so all
four module tabs appear.

`.env` is gitignored and holds `DATABASE_URL`. Copy `.env.example` and fill it
in — you will need the local PostgreSQL password from the project owner.

Set **`LOG_SQL_ERRORS=1`** on the API. Failures are returned as result objects
rather than thrown, so without it a broken query is invisible from both ends:
the screen shows a generic message and the server logs nothing. This flag is
how most of the defects below were found.

### Checks

```bash
node scripts/verify/run-all.mjs           # whole suite; exit 0 = green
node scripts/verify/run-all.mjs --only x  # one script
npm --prefix server test                  # unit tests
npx ng build                              # must be clean
```

---

## What exists

```
src/                      Angular 19 SPA — same paths as the desktop app
  app/shared/platform/    PlatformApi: the ONLY thing that knows about transport
  app/shared/services/    database.service.ts — signatures FROZEN
server/src/db/
  scan.js                 SQL lexer: code vs literal vs comment; the base of everything
  dialect.js              SQLite -> PostgreSQL translation
  placeholders.js         ? -> $1..$n
  primary-keys.js         RETURNING, from the catalogue (no hand-maintained map)
  batch.js                $lastId back-references
  types.js                bigint/numeric -> JS number  (see D15)
  execute.js              get/run/batch/transactions; result shapes are contractual
server/src/routes/        /api/db/* mirroring the old IPC surface
db/
  generate-schema.mjs     regenerates the DDL from the desktop source
  schema/                 000_collations, 001_tables, 002_indexes
  seed.mjs                demo account
scripts/verify/           the regression net — 40 scripts
Talha Farm/               FROZEN desktop app. Never edit. It is a build input.
```

---

## The rules that matter

`CLAUDE.md` at the repo root has the full list and is loaded automatically.
The three worth repeating, because breaking them produces **silently wrong
money** rather than an error:

1. **Money is `double precision`, never `numeric`.** `node-postgres` returns
   `numeric` as a *string*; the app does plain JS arithmetic, so `numeric`
   turns every addition into string concatenation.
2. **Integer columns are parsed to JS numbers** (D15). 214 of 555 columns are
   `bigint`, which the driver also returns as strings. Every id and every
   count. `server/src/db/types.js`.
3. **Dates stay `TEXT`.** `'YYYY-MM-DD'`, compared lexicographically. A real
   `date` type changes timezone semantics; that bug was fought once already.

Also: `farm_id` comes from the server session, never the client. And hiding a
sidebar item is **not** access control — the client ships SQL, so permissions
must be enforced in the guard, by table.

---

## What to do next, in order

### 1. Finish Phase 1 — migrations

Not started. The desktop ran migrations on **every launch**, looping
`alterStatements` in `try { } catch { }` where a duplicate-column error *was*
the "already applied" detection. On a server, launch is a shared deploy across
instances. Needs numbered, forward-only migrations under an advisory lock with
a schema-version table. `db/CLAUDE.md` has the detail, including a warning
about `migrateVaccinationsNullableBatchId()`, which has destroyed data once.

### 2. Finish Phase 1 — port the verify suite (**this is the Phase 1 gate**)

**2 of 29 ported.** This is the largest remaining piece of Phase 1 and the
thing that proves the business logic still produces identical answers.

`scripts/verify/lib/port.mjs` transforms an inherited script into a PostgreSQL
port, copying the assertion body byte for byte apart from the substitutions
sql.js's synchronous API forces. It **works for "shape A" and not "shape B"**;
the file's header explains both shapes and exactly where shape B stalls.

Recommendation, already written into `docs/PHASES.md`: **hand-port the four
shape-B money scripts** (`verify_vouchers`, `verify_internal_settlements`,
`verify_cash_and_bank_totals`, `verify_no_negative_bank`) rather than extend
the transform further. A hand port is a known quantity; another transform layer
is not, and a subtly wrong test is worse than no test.

### 3. Close the Phase 2 gaps

- **120 SQL statements built with `${…}` interpolation are unverified.**
  `scripts/verify/verify_app_sql_prepares.mjs` checks all 345 *static*
  statements by `PREPARE`-ing them against PostgreSQL (parse + type-check, no
  execution) and they are all clean — but it skips interpolated ones and says
  so every run. Catching those needs either runtime capture or a way to
  enumerate the interpolations.
- Screens never opened. The walk covered all four modules but not every screen.

### 4. Phase 3 — security

Nothing started, and it is the largest phase. Sessions, argon2id, denormalising
`farm_id` onto the 30 tables that lack one, row-level security, and the SQL
guard. `docs/ARCHITECTURE.md` and `server/CLAUDE.md` carry the design.

Two things in the current code are deliberately temporary and **must not reach
production**:

- `server/src/session.js` authenticates nobody. It serves one fixed
  `DEV_FARM_ID` and refuses to boot unless `NODE_ENV=development`.
- `src/app/shared/services/delete-auth.service.ts` compares the delete PIN **in
  the browser**. It carries a comment saying so. Fine on a desktop the owner
  controlled; not a control once staff accounts exist.

### 5. Phases 4 and 5

Access control (super admin / farm admin / staff, seat quotas, the permission →
table map) and operations. See `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`.

---

## Things that cost time to learn

Each of these was a real defect found by running the system, not by reading it.
They are written up in `docs/PHASES.md` and `docs/DECISIONS.md`; this is the
short list so they are not rediscovered.

- **`numeric` and `bigint` arrive as strings** (D4, D15). The second affects
  214 columns — every id. `row.flock_id === currentFlock.flock_id` is silently
  `false` when one side is `"3"`.
- **SQLite's `MAX(a,b)` is scalar; PostgreSQL's is aggregate-only.** 22
  occurrences, all in money paths. A search that is not parenthesis-aware
  misses every one, because they are all wrapped in `COALESCE`.
- **`CAST(x AS INTEGER)`: SQLite truncates, PostgreSQL rounds.** Does not
  error. Shifts expiry buckets by one month.
- **SQLite has a built-in `NOCASE` collation; PostgreSQL does not.** Defined in
  `db/schema/000_collations.sql` so the app's SQL works unchanged. Its failure
  mode was a duplicate-name check that silently *allowed* a duplicate.
- **PostgreSQL rejects bare columns with `GROUP BY`**, and cannot see a
  select-list alias in `HAVING`. Both needed the query changed, not translated.
- **`<base href="./">`** was correct for `file://` and breaks every refresh and
  deep link on the web. White page, no console error.
- **Explicit-id inserts do not advance a PostgreSQL identity sequence**, where
  SQLite's `AUTOINCREMENT` does. Handled in `execute.js`.

### Working notes

- **Stale Node processes survive `pkill` on Windows.** Several confusing
  sessions came from an old API server still holding port 3000 and serving
  pre-fix code. Kill via PowerShell by command line, and verify the port is
  free before restarting.
- **Browser automation's synthetic clicks do not reach Angular's handlers.**
  Driving the app needs programmatic `.click()` dispatch. This is a tooling
  quirk, not an app defect.
- **A checker that cries wolf gets ignored.** `verify_app_sql_prepares.mjs`
  needed two corrections before its output could be trusted — 7 of its first 10
  "failures" were artifacts of its own extraction. Fix the tool before acting
  on its findings.

---

## Open questions for the project owner

- **Connectivity at the farm office** was confirmed available, which is what
  D9 (online only, no offline mode) depends on. Worth re-confirming before
  launch, because the whole architecture assumes it.
- **Seat-quota policy** (D12) is decided: a suspended staff member frees their
  seat, and a quota may be lowered below current usage. Phase 4 implements it.
- **Who holds the first super admin account** (D11) — seeded out of band at
  first deploy, expected to be DevInfantary.
