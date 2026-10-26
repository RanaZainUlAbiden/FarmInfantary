# server/ — Node + Fastify API

Replaces `Talha Farm/electron/main.js` (IPC handlers) and `database.js` (sql.js,
schema, query layer). Port that logic — don't redesign it. The comments in those
files are the only record of why several queries look the way they do.

**JavaScript/TypeScript deliberately:** `database.js` is 4,268 lines that port
mechanically. Another language means re-deriving every landmine.

## Layout

```
src/db/          pool · session-context · execute · batch · transactions
                 placeholders · primary-keys · errors
src/guard/       parse · rules/ · permission-tables.ts   ← SECURITY CRITICAL
src/auth/        password (argon2id) · session · login
src/routes/      db · auth · settings · backup · admin/
src/audit/       write log: who changed what, when
src/middleware/  rate limit, statement timeout, error shape
test/            tenancy/ · permissions/ · batch/
```

## Endpoints — mirror the IPC surface 1:1

| `electronAPI` | Endpoint |
|---------------|----------|
| `dbGet` / `dbRun` / `dbRunBatch` | `POST /api/db/get` · `/run` · `/batch` |
| `dbBegin/Commit/RollbackTransaction` | `POST /api/db/tx/begin` · `/commit` · `/rollback` |
| `get/setAppSetting` | `GET` / `PUT /api/settings/:key` |
| `backupDatabase` / `restoreDatabase` | `POST /api/backup` · `/restore` |
| `license.*` | `GET /api/entitlement` |
| `getMachineId`, auto-update, backup paths | dropped |

Twenty methods in, eleven endpoints out. `printPdfBase64` is client-side only.

## Result shapes are contractual

`get` → `{ success, data: rows[] }`. `run` → `{ success, lastId }`. Failures are
`{ success: false, error }` — **never a rejected promise**, never a bare 500. 341
call sites check `.success`.

`lastId` uses `RETURNING <pk>`, with the primary-key lookup ported from
`PRIMARY_KEY_MAP`. A table missing from that map returns `lastId: null`.

`$lastId` back-references in batches: `{ $lastId: n }` resolves to the id
inserted by operation `n` of the same batch; negative `n` counts back from the
current operation. Reimplement exactly — `test/batch/` exists for this.

## Transactions

The desktop used module-global state (`inTransaction`, `savepointCounter`,
`poisonedConnection`) on one shared connection, with a 60s watchdog and a
poison flag. **None of that survives concurrent users.** Replace with:

- `tx/begin` checks out a dedicated pooled connection, opens a transaction, sets
  `app.farm_id`, returns an opaque session-bound token.
- Calls carrying that token route to that connection. One open transaction per
  session. Timeout rolls back and releases.

Only **2** call sites use explicit transactions; 54 use `runBatch`, which is
self-contained. Prefer batches for new work.

[Codex] `db/session-execute.js` now implements this ownership boundary behind
a mandatory trusted authorize callback. buildServer now supplies the real AST
compiler after restricted-role attestation in session mode. Read
`../docs/SESSION_TRANSACTIONS.md`; its 28 PG scenarios use a disposable restricted
role/FORCE RLS fixture. Auth hooks, scoped routes and shutdown are connected;
future admin routes still need proactive invalidation. Never use a permissive
fixture authorizer in the app. The original executor remains the dev/parity path.

Keep the nested-batch behaviour: a batch inside an open transaction uses
`SAVEPOINT`, not a nested `BEGIN`. PostgreSQL requires this too.

The `db.export()` + `writeFileSync` cost model is gone. So is the watchdog and
the poison machinery.

## The guard — read before touching

Raw SQL arrives from the browser, and the browser is under the user's control.
Seven stages, all mandatory:

1. Parse to AST with `libpg-query`. **Never regex** — comments, whitespace and
   string literals defeat regex guards, and a near-miss looks like success.
2. Reject multiple statements.
3. Allowlist `SELECT`/`INSERT`/`UPDATE`/`DELETE`. Everything else refused.
4. Reject non-allowlisted functions (`pg_read_file`, `pg_sleep`, `dblink`,
   `lo_import`), `pg_catalog`, `information_schema`, `SELECT INTO`.
5. Walk every table reference — joins, subqueries, CTEs, set operations — and
   check it against the caller's grants.
6. Verify tenancy: every reference constrained to the session's `farm_id`.
7. Execute as a low-privilege role, in a per-request transaction, with
   `app.farm_id` / `app.user_id` set server-side.

`permission-tables.ts` maps each permission key to its read/write tables. It is
a **security artefact**, not configuration — it decides what staff can reach.
Derive it with `tools/`, by tracing what screens actually write. Don't hand-write
it, and don't edit it casually alongside menu changes.

Write sets are wider than they look: recording a sale touches the bank ledger
and customer ledger. Permissions therefore cannot be arbitrarily fine-grained
without breaking the app's own money flows.

RLS is the backstop, not the belt. The guard will have bugs; RLS means a bug
returns zero rows instead of leaking data. The app role must **not own the
tables** and must not have `BYPASSRLS`.

## Auth

[Codex] Migration 004 now installs full-schema FORCE RLS and stamping triggers.
`db/runtime-role.mjs` and `src/db/runtime-role.js` provision/attest narrow fresh
logins; no persistent runtime login is installed locally yet. Private auth farm
metadata access preserves policies without an owner bypass exception. Read
`../docs/TENANT_ISOLATION.md` before wiring pools or changing grants/policies.
Business SQL must use an attested runtime pool, never the auth/migration pool.
The real AST guard and pool/session path are now verified for farm admins in
development when runtime credentials are configured. Missing setup returns 503;
staff business SQL remains denied in the owner-only first release. Dedicated
admin/seat/audit/delete/export operations are implemented. Production requires
the reviewed exact release digest and separate attested auth/runtime roles;
actual independent approval remains outstanding. Read `../docs/OWNER_RELEASE.md`.

[Codex] Server identity foundation is implemented in `src/auth/` with migration
003, 28 PostgreSQL/HTTP scenarios and seven unit tests. Read
`../docs/AUTHENTICATION.md` before extending it. `AUTH_MODE=session` registers
real auth routes. Business SQL additionally requires an attested runtime pool;
it never falls back to the privileged auth pool. `AUTH_MODE=development` retains only the legacy local demo
stub; development must be explicit. Production uses only the reviewed owner-only
session profile. Never fabricate reviewer approval to bypass the startup gate.

D14 means fresh `users` with Argon2id hashes: the new server path never verifies
the old 32-bit `farms.password_hash`. The Angular AuthService now uses cookie
login/restore, guarded routes and central session cleanup. See `../docs/AUTHENTICATION.md`.

[Codex] Migration 005 adds private permission catalogue/grant metadata and
revocation. Runtime attestation requires those tables and denies access. The
50-key catalogue is generated; four observed voucher scopes across 2/50 screens
are a draft only. Staff SQL remains denied pending reviewed operation/module
enforcement. Never import observations as policy. Read `../docs/STAFF_PERMISSIONS.md`.

argon2id. Sessions in `httpOnly` + `Secure` + `SameSite=Strict` cookies, never
`localStorage`. `farm_id`, `user_id` and `role` resolved from the session on
every request.

The desktop hash was 32-bit `String.hashCode`. Its import/rehash requirement is
superseded by D14; do not reintroduce legacy credential acceptance.

## Admin routes

`routes/admin/` serves the super admin: farms, users, permissions, seat quotas.
It **never touches the SQL pipe** and needs no access to business tables. That
is what lets the tenant policy stay absolute, with no RLS bypass anywhere.
