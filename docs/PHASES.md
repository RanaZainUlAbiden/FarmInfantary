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
- [ ] **Capture a production-shaped database dump** — blocked, see below

**Gate:** all scripts green, and a known-good set of reference totals.
**Status:** suite is green at 30/30. Gate is **not** met — the oracle has no
production data to describe.

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

- [ ] Translate the 60-table schema to PostgreSQL DDL — no FK constraints, `REAL` → `double precision`, dates as `TEXT`
- [ ] Convert `alterStatements` and the guarded migrations into numbered forward-only migrations under an advisory lock
- [ ] Port `runQuery`, `getQuery`, `runBatch` and the transaction layer to `node-postgres`
- [ ] Reimplement `lastId` via `RETURNING`, keeping the primary-key map complete
- [ ] Reimplement `$lastId` batch back-references, negative indexing included, with tests
- [ ] Translate the ~20 dialect lines (`db/CLAUDE.md` has the table)
- [ ] Build the `?` → `$n` placeholder rewrite at the boundary
- [ ] Stand up the 11 endpoints mirroring the IPC surface
- [ ] Re-point all 29 verify scripts at the new schema module
- [ ] Build `db/import/` — SQLite → PostgreSQL for existing customer data

**Gate:** the same 29 scripts green against PostgreSQL, and reference totals
matching Phase 0 exactly.

---

## Phase 2 · Frontend

- [ ] Copy `Talha Farm/src/app/` into `src/app/`
- [ ] Define `PlatformApi` matching the `electronAPI` shape exactly
- [ ] Implement it over `HttpClient`, preserving `{ success, error }` results and the `sql-error.util.ts` mapping
- [ ] Point `DatabaseService` at it — signatures unchanged, so no call site moves
- [ ] Replace `printPdfBase64` in 21 components with a browser print path
- [ ] Remove the activation route, splash licensing checks, `getMachineId`, `license.service.ts`
- [ ] Remove Electron build configuration from `package.json`
- [ ] Walk all 60 screens against the Phase 0 reference data

**Gate:** every screen works in a browser with no Electron present.

**Blocked on:** confirming farm connectivity with the client (D9).

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
