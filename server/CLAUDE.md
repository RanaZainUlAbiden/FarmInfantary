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

argon2id. Sessions in `httpOnly` + `Secure` + `SameSite=Strict` cookies, never
`localStorage`. `farm_id`, `user_id` and `role` resolved from the session on
every request.

The desktop hash was 32-bit `String.hashCode` — rehash on next successful login,
verifying against the old hash once.

## Admin routes

`routes/admin/` serves the super admin: farms, users, permissions, seat quotas.
It **never touches the SQL pipe** and needs no access to business tables. That
is what lets the tenant policy stay absolute, with no RLS bypass anywhere.
