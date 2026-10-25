# Phases

Each phase is gated. Nothing is migrated until there is a test that would catch
it being migrated wrongly. Durations are not estimated — phases 1 and 3 are the
large ones, 2 is mostly mechanical, 4 is new build rather than porting.

---

## Phase 0 · Baseline

Establish the regression net before changing anything.

- [ ] Run all 29 scripts in `scripts/verify/` against the current desktop code; fix or document every failure
- [ ] Add a numeric-type assertion to the suite — the test that catches D4 later
- [ ] Record current totals for a representative farm: the oracle for comparing post-migration output
- [ ] Capture a production-shaped database dump as migration test data

**Gate:** all 29 scripts green, and a known-good set of reference totals.

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
