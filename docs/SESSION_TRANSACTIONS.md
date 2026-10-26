# Session transaction execution — Codex

`server/src/db/session-execute.js` implements the connection and transaction
boundary for the guarded SQL endpoint. buildServer now supplies the real AST
compiler after runtime attestation in session mode. With configured verified
runtime credentials, farm admins can use it; without those credentials the
business routes return 503. Staff remain denied and production startup is blocked.
Read `SQL_GUARD.md` for activation and remaining work.

## Ownership and execution

Create the executor with a restricted runtime pool and a mandatory trusted
`authorize({actor, method, sql, params})` callback. A missing callback refuses
construction; only an explicit `true` authorizes a statement. This callback is
an integration contract, not an implementation of the seven-stage AST guard.
Never substitute a permissive callback in application wiring. Staff grants must
be enforced by the eventual authorizer.

`forActor(serverActor)` captures immutable user, farm, role, auth version and
session identity. `auth/store.js` returns the internal HMAC session verifier as
`sessionKey`; auth responses explicitly omit it. Client fields cannot supply
these values. A public transaction token is 32 cryptographically random bytes,
bound to that exact identity and device session. A second device belonging to
the same user cannot read, mutate, commit or roll back the transaction.

Every short get/run/batch opens a dedicated transaction, sets parameterized
transaction-local `app.farm_id` and `app.user_id` on that connection, then commits
or rolls back before releasing it. No pool-level BEGIN/SET/query sequence is
used. Context disappears after commit or rollback, as documented by PostgreSQL's
[SET LOCAL behavior](https://www.postgresql.org/docs/current/sql-set.html).

Explicit transactions reserve one slot per session before asynchronous BEGIN.
Defaults bound total active leases to eight, explicit transactions per user to
four, queued operations per transaction to sixteen and batch operations to 500.
The production pool also needs a finite connection-acquisition timeout and must
leave capacity for auth/admin queries. Invalid/unauthorized batches are refused
before execution. The existing executor preserves lastId references and nested
SAVEPOINT rollback. All work on one transaction is serialized, including commit
and rollback, so concurrent requests cannot interleave savepoints.

Idle expiry defaults to 30 seconds, absolute lifetime to 60 seconds, and statement
and lock timeouts to 10 seconds. Closing admissions is synchronous. Expiry or
revocation cancels queued mutations, drains the bounded active statement and
rolls back; a commit waiting behind work cannot escape the absolute deadline.
SQL errors on ordinary statements close the failed transaction. Failed batches
restore their savepoint and leave the outer transaction usable. Errors retain
`{success:false,error}` and optional `failedIndex`, without driver detail/SQL.
PostgreSQL returning ROLLBACK in response to COMMIT is explicitly a failure.

`revokeSession(key)`, `revokeUser(id)` and `close()` perform rollback/cleanup.
Auth-store callbacks `onRevokeSession` (rotation/logout) and `onRevokeUser`
(password change) run after durable revocation and connection release. Server
wiring now connects these callbacks and shutdown. Stale/expired/suspended cookie
resolution also dispatches device cleanup. Future dedicated admin identity/status
routes still need proactive all-device invalidation. Session
resolution still must run on every HTTP request; a captured actor is not a
substitute for checking the current session. Expiry remains the bounded backstop.

`registerDbRoutes` accepts an optional `sessionDb` and resolves the actor from
the server for all six routes. buildServer now supplies it after attestation;
guarded routes cannot fall back to the raw auth-pool executor.
The legacy development executor and frozen DatabaseService signatures remain.

## Verification

`verify_session_transactions_pg.mjs` runs 28 scenarios in a disposable schema
with a temporary NOLOGIN, non-owner, NOBYPASSRLS role and a FORCE RLS fixture
table. The test uses an exact-query fixture authorizer, including a deliberate
sleep query for concurrency/timeout tests; it is never imported by production.
Role and schema are removed afterward. These tests prove the executor against
an actual RLS boundary, not deployment-wide policies on the inherited tables.

Coverage includes cross-device/farm token theft, forged identities, context
leakage after pooled reuse, atomic batches, nested savepoints, simultaneous
begins, queued commits, revocation races, idle/absolute/statement expiry, capacity,
shutdown during BEGIN, and aborted-commit detection. Three unit tests cover
failed-BEGIN lease destruction, constructor limits and fail-closed authorization.
The authentication suite also verifies the internal session identity is omitted
from JSON and that rotation/logout/password revocation dispatch the right hooks.

Validation on 2026-10-26: full suite 73/73 scripts (~9,243 reported checks),
backend tests 73/73. Logs: `qa-results/verify-session-transactions-all.log` and
`qa-results/backend-session-transactions.log` (ignored local verification output).
