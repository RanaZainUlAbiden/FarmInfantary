# Tenant database boundary — Codex

Migration `004_tenant_isolation.sql` is applied to the local development database.
All 59 tenant tables have ENABLE/FORCE RLS, an indexed non-null positive farm ID
and one uniform USING/WITH CHECK policy. The 58 business tables have insert/update
ownership triggers. The remaining table, `farms`, is the tenant root; runtime
access is limited to five metadata columns. The retired `activation` store has
FORCE RLS with no policy and receives no runtime grants. Three authentication
tables are platform-only and also receive no runtime grants. Migration 005 adds
two private permission metadata tables, also excluded from runtime grants and
required by startup attestation. Their presence does not enable staff SQL.

This completes the database schema boundary, **not application activation**.
The real AST guard and runtime/session wiring now enable farm-admin SQL in
session mode when a restricted pool passes startup attestation. Missing runtime
setup returns 503; staff SQL and production startup remain blocked. The role
provisioner/attestation are tested with disposable roles; no persistent runtime
login was created locally. Browser cookie integration is now implemented; permissions,
admin provisioning and deployment work remain. RLS changes are security-critical and require a second reviewer
before production under the repository working agreement.

## Ownership and preservation

`db/tenant-tables.mjs` explicitly lists the 59 tenant tables, 58 writable business
tables, excluded platform/license stores and safe root metadata columns. Grants
are never generated from every table found in the schema.

There were 31 inherited tables without farm_id: 30 business tables plus retired
activation. Migration 004 adds ownership to those 30 business tables, backfilling
before enabling policies. Eleven shared tables use flocks for NULL/broiler module
rows and batches for strict layer rows, even though both use `flock_id`. Four
other tables use flocks, six use layer batches, and `batch_transactions` uses
**product_batches**, not layer batches. Seven money/detail tables use their
bank, bill, customer, sales-return or supplier parent. Vaccinations can use either
nullable flock/batch parent; different resolved owners are rejected.

Unresolved owners, nonpositive IDs or conflicting vaccination parents abort the
entire migration, including all newly added columns/history. No row is deleted,
quarantined or assigned to a guessed tenant. This is not a desktop data importer
under D14. Money/date/flag types and existing values remain intact.

For new writes the trusted transaction's `app.farm_id` is authoritative. The
trigger fills omitted farm_id, rejects a conflicting supplied farm, and refuses
ownership changes on UPDATE. It applies even to privileged maintenance writes;
maintenance/seed tools must set a transaction-local context explicitly.

No foreign keys, cascades or parent-existence requirements were introduced.
After a parent is deleted, its child retains ownership and remains editable.
New orphan rows also remain supported. A reference ID does not grant access to
the referenced row: that row's policy still applies independently. These policies
do not enforce complete business referential consistency; the existing manual
delete and module predicates remain necessary.

## Runtime role and preflight

`npm run db:provision-runtime` consumes `MIGRATION_DATABASE_URL`, a new
`RUNTIME_DATABASE_URL`, and optional `DATABASE_SCHEMA` (default public). Both URLs
must name the same server/database. Runtime URL startup-option overrides are
rejected. Use a fresh lower-case role name and a random 32–128 character base64url
password; keep credentials in the ignored local/environment secret configuration,
never command-line arguments or source. No password or URL is printed.

The provisioner refuses an existing role rather than changing its credentials or
inheriting old grants. In one transaction it creates a LOGIN role with no
superuser/BYPASSRLS/CREATEDB/CREATEROLE/replication privileges or memberships,
grants schema USAGE, business SELECT/INSERT/UPDATE/DELETE and identity sequence
USAGE, and column-only SELECT on farms:

`farm_id, farm_name, business_type, created_at, status`

There are no runtime grants for farm credentials, root mutations, auth data,
license data, TRUNCATE, permanent-schema DDL, privileged metadata functions or sequence resets.
Explicit primary-key inserts through the executor fail when sequence resync is
refused; the eventual AST guard must reject them before execution. Normal inserts
retain generated numeric lastId results.

The role has a fixed search path with pg_temp last, connection limit 12,
10-second statement/lock timeouts and a 65-second idle-transaction timeout.
`attestRoleBeforeCommit` verifies complete policies, stamps, indexes, column
grants and function/sequence restrictions before COMMIT; failure removes the new
role and all grants atomically. The CLI then connects using the runtime URL and
`attestRuntimeRole` additionally requires a direct login and expected search path/
row_security setting. It refuses owners, privileged/member roles, policy drift,
missing protection and leaked platform/sequence/function grants. PUBLIC schema
CREATE must be removed by an operator if inherited database ACLs allow it;
provisioning refuses that database rather than changing unrelated global ACLs.

The final API must use this restricted pool for business SQL and keep auth/admin
queries on a separate privileged metadata path. It must run runtime attestation
before accepting business requests. Startup checks do not replace controlled
migrations and change review; they do not continuously monitor later DBA changes.

Custom PostgreSQL settings are trusted server context, not credentials. A SQL
client can otherwise call set_config or SET to change them. Therefore the real
AST guard must reject context-changing statements/functions, catalogs, privileged
function access and other non-allowlisted constructs. RLS alone does not secure
a raw SQL endpoint; the current fixture authorizers must never reach production.
Database-wide PUBLIC TEMP privilege may still permit temporary objects; this
provisioner does not change unrelated database ACLs. The AST guard must also
reject temporary-object DDL. Runtime schemas themselves are not writable.

## Authentication metadata

Auth must check farm status/name before a farm session exists. Instead of adding
an owner/admin bypass policy, the private `auth_farm_metadata(bigint)` accessor
sets the requested farm context, returns four metadata fields from one qualified
farms row and restores the prior context. It uses SECURITY DEFINER with a fixed
pg_catalog search path; relations are schema-qualified and PUBLIC EXECUTE is
revoked. The runtime role cannot call it. Auth-store joins now use this accessor;
it never returns password hashes or other business data. Dedicated farm/admin
mutations still need explicit target context and authorization when implemented.

The explicit development demo uses its validated server-side DEV_FARM_ID as a
connection default, solely for compatibility while business session wiring is
pending. Session mode uses no such default. Development remains unsafe to expose
and refuses production startup. Real session execution already uses local context
and device-owned transactions; see `SESSION_TRANSACTIONS.md`.

## Verification

`verify_tenancy_pg.mjs` runs 26 real PostgreSQL scenarios with disposable schemas
and actual fresh restricted logins. It checks every tenant table and insert
trigger, both accounts, colliding module parent IDs, product-batch ancestry,
vaccination preservation/conflicts, joins/CTEs/subqueries/UNION, forged ownership,
known foreign IDs, parent deletion/orphan edits, missing context, forbidden
platform/credential/DDL access, sequence controls and runtime preflight drift.
An ordinary table owner is also tested to prove FORCE RLS applies without an
owner bypass policy. A permissive policy causes provisioning to roll back the
new login before it becomes usable. Test roles and schemas are removed afterward.

Existing layer-sale and egg metadata fixtures now supply an explicit farm context
after applying the real migrations. The unique-index verifier uses separate
contexts for account-scoped writes; public money/SQL transport fixtures also set
their trusted test farm. Original business values/assertions are retained. Egg
column scanning now checks one additional metadata column, farm_id. These are
fixture adaptations, not a claim that all inherited business ports run under RLS.

Validation on 2026-10-26: **74/74 verification scripts** (~9,270 reported checks),
**73/73 backend tests**; all 29 inherited gates remain green. Local logs are
`qa-results/verify-tenant-isolation-all.log` and
`qa-results/backend-tenant-isolation.log` (ignored verification output).
