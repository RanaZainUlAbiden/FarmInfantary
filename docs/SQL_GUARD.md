# Guarded session SQL — Codex

Current deployment review: the user assigned the final review to Codex (D17).
`SELF_REVIEW.md` records the findings/fixes and explicitly does not claim
independence. The owner-only Railway candidate passes readiness with its reviewed
digest and attested roles. Staff business access remains denied.

The farm-admin HTTP SQL path now connects cookie authentication, the AST guard,
session-owned transactions, a separately attested restricted pool and FORCE RLS.
It runs in explicit development, or the owner-only production profile after
independent review of the exact release digest and privilege attestation.
Staff SQL remains denied. Actual production review is still outstanding.
The repository marks this guard and the tenant policies security-critical.

## Activation and trust boundary

Use `AUTH_MODE=session`, the existing session secret/origin configuration,
`DATABASE_URL` for the private auth/metadata path, and `RUNTIME_DATABASE_URL` for
a separately provisioned business login. Apply migration 004 first and use
`npm run db:provision-runtime`; see `TENANT_ISOLATION.md`. No persistent runtime
login or real account has been created locally by this guard implementation.

When runtime credentials are absent, authenticated farm users still receive 503
on business routes. When present, startup verifies privileges, all 59 policies,
ownership triggers/indexes, path/row-security settings and absence of default
farm/user context. Auth/runtime pools must resolve to the same database, server
and tenant schema. A failed check refuses startup; there is no owner-role fallback.
Only the runtime pool executes business SQL. Staff receive 403 until their
derived permission mapping is implemented; platform admins never use this pipe.

Every database route requires exact Origin and a fresh server session. Identity
is cached on the server request, never copied from a body/header. Authentication
uses the matched Fastify route, so encoded URL spelling cannot skip it. Route
execution also explicitly refuses raw fallback when session mode lacks its scoped
executor. Session resolution of a stale/suspended/expired cookie dispatches
transaction cleanup. Rotation/logout/password changes connect to device/user
rollback hooks; app shutdown drains and rolls back outstanding transactions.
Other devices/admin status changes are recognized on the next authenticated
request, with the transaction deadline as the abandonment backstop.

The Angular AuthService now uses the cookie identity API and guarded routes.
The browser requires session-mode setup and fresh server accounts. The existing
`AUTH_MODE=development` fixed-farm compatibility path remains for parity tests;
it has no browser authentication API and refuses production startup.

## The seven stages

1. The SQL dialect adapter and positional values are normalized, then parsed by
   PostgreSQL's actual grammar using pinned `pgsql-parser@16.1.1`, backed by
   `libpg-query@16.6.0`. See the [parser API](https://github.com/constructive-io/pgsql-parser/tree/main/packages/parser)
   and [libpg-query implementation](https://github.com/constructive-io/libpg-query-node).
   Regex is used for identifier/ID limits, never to authorize SQL structure.
2. Exactly one parsed statement is required. Comments, literals and CTEs cannot
   hide a second command. The two existing multi-update status methods now use
   atomic runBatch with the same predicates, ordering and frozen signatures.
3. get accepts SELECT; run/batch accept INSERT/UPDATE/DELETE. Read-only subqueries
   and non-recursive SELECT CTEs are supported; write CTEs, SELECT INTO, locks,
   utility/DDL/transaction commands and unrecognized nodes/fields are rejected.
4. A reviewed allowlist covers scalar/aggregate functions, operators, casts,
   date values and NOCASE. Functions and casts are emitted with builtin schemas.
   Context-changing/file/network/sleep functions, catalogs, qualified input
   relations/functions, custom types/collations and unsupported syntax are refused.
5. Every actual relation in joins, derived tables, scalar subqueries, CTEs and
   set operations is checked against the explicit business catalog. Farm admins
   have the business set; staff currently have none. CTEs cannot shadow business
   or platform names. Root farm reads are limited to safe metadata; credentials,
   auth/license stores, root mutations and client identity changes are refused.
6. Every actual table reference gets a server-bound farm predicate in its own
   SELECT/write scope. Outer-join nullable sides use an own-farm-or-null condition
   so unmatched owned rows survive. GROUP BY primary-key dependencies retain
   base table references. CTE definitions and both set-operation branches are
   scoped independently. INSERT columns/SELECT projections are stamped with the
   server farm; client farm expressions are discarded only after validation.
   UPDATE/upsert cannot change ownership or generated identities. Surviving
   placeholders are rebound after rewrite, preserving batch lastId markers.
7. Only the deparsed statement is executed as the restricted role on the
   session's transaction-local farm/user connection. RLS independently filters
   every table. A WeakMap-backed opaque prepared capability prevents HTTP JSON
   from claiming already-validated SQL and prevents a second translation pass
   from changing the approved statement. Generated RETURNING is added by the
   guard; client RETURNING and explicit identity inserts are refused.

Unknown grammar fails closed. The guard does not enforce every business
relationship, replace existing module predicates, or add foreign-key semantics.
The application must retain manual delete ordering and broiler/layer scoping.

## Limits and errors

Defaults: SQL size 64 KiB, 2,000 parameters, 12,000 visited AST nodes, SELECT
result cap 50,000 rows, statement/lock timeout 10 seconds and the existing
session transaction limits. Root SELECT fetches at most cap+1; exceeding the
cap returns failure with no partial data. Client LIMIT 0 and smaller limits are
preserved. Subquery aggregates are not silently truncated.

Authenticated database requests use atomic PostgreSQL counters per IP and user,
default 600 per minute (`RATE_LIMIT_PER_MINUTE`). A blocked request receives 429
and Retry-After; no statement executes. Login and password buckets remain separate.
`MAX_ROWS_PER_QUERY` is validated at startup (1–100,000). SQL/authorization and
driver failures preserve result-object contracts and do not expose driver detail,
compiled SQL or session verifiers. Authentication/origin/grant failures use 4xx.

Row caps do not impose a byte cap on a large aggregate or large text result.
Global/anonymous ingress protection and deployment resource limits still belong
to production operations. Runtime custom GUCs remain trusted server context;
they are safe here because client SET/set_config and unapproved functions cannot
enter this execution path. The fixture authorizers used by older infrastructure
tests are never connected by buildServer.

## Verification and remaining work

`server/test/sql-guard.test.js` adds nine grouped adversarial tests. They cover
opaque-capability forgery, utility/multi-statement/context attacks, nested table
access, CTE shadow/write/recursive variants, functions, casts, operators, catalog
and credential access, authority, identity stamping, scope rewriting and limits.

`verify_guard_inventory_pg.mjs` compiles and PREPAREs **501 current static business
statements** after rewriting, and requires browser auth screens/services to contain
**no raw SQL**. Retired account-query exemptions have been removed. The scanner reports
120 interpolated and 33 concatenated SQL gaps; this gate does not claim they are
static coverage. Existing business ports exercise dynamic builders separately,
and the hostile HTTP suite exercises representative dynamic query forms.

`verify_guard_http_pg.mjs` adds **22 real cookie/HTTP/PostgreSQL scenarios** with
an actual disposable runtime login and full migration 004 schema. It verifies
startup refusal, auth/origin/grants, impersonation, missing farm predicates,
known foreign IDs, CTEs/subqueries/UNION, outer joins and GROUP BY, independent
AST isolation on a privileged test connection, stamping/lastId/back-references,
atomic/nested rollback, device transaction ownership, row limits, hostile SQL,
encoded routes, rotation/logout/status cleanup, throttles, context reuse and
shutdown. It also checks stale browser identity preconditions and cookie-owned
business-type updates. Test schemas/logins are removed afterward.

Browser cookie authentication, dedicated admin operations, private delete
authorization and deployment preparation are integrated. DELETE, UPDATE of
is_deleted/deleted_at and corresponding upsert mutations require a trusted
server callback checking a current device-session grant. The callback defaults
to deny. Client flags never grant delete access. Offline SQL inventory explicitly
uses a fixture confirmation; it is syntax coverage, not authorization evidence.
See `OWNER_RELEASE.md` for production gates and deferred staff business access.

Validation on 2026-10-26: **77/77 verification scripts** (~9,811 reported checks),
**82/82 backend tests**, Angular production build passed with existing CommonJS
dependency warnings. Local logs: `qa-results/verify-browser-session-all.log`,
`qa-results/backend-browser-session.log`, `qa-results/angular-browser-session-build.log`.
