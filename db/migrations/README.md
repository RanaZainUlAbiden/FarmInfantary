# Forward-only migrations

Run `npm run db:migrate` from the repository root before starting the API.
The server package also exposes `npm --prefix server run db:migrate`.

Use `MIGRATION_DATABASE_URL` for a role that owns the schema and can run DDL.
For local development it falls back to `DATABASE_URL`. Production API roles
must not own tables or run migrations; this is a separate deploy command.

## First install

Create an empty PostgreSQL database and set the connection URL in `.env`, then:

```sh
npm run db:migrate
node db/seed.mjs
```

Migration `001_initial_schema.sql` is an immutable snapshot of the three
existing files in `db/schema/`: collations, final tables and indexes. It includes
all desktop `alterStatements` and the final nullable vaccination parent columns.
It does not rebuild any existing table. D14 specifies fresh web accounts, so
the desktop-only data conversions (old stock, expense mirrors, category
deduplication, mortality and own-farm customer conversion) are not replayed.

[Codex] `002_preserve_unique_indexes.sql` repairs uniqueness lost by the old
schema generator: case-insensitive expense category names, one layer-health
row per non-NULL mortality source, and category names scoped by account/type.
It restores three unique indexes and the partial predicate without deleting
rows. Existing duplicates abort the transaction; resolve them deliberately
before retrying. Migration 001 remains unchanged. The local development
database is now at 004. Generated `db/schema/` files describe the inherited
business shape, including 50 non-primary indexes; they are not a replacement for
the numbered migrations or the platform identity additions.

[Codex] `003_authentication.sql` adds three platform tables (`users`,
`auth_sessions`, `auth_login_limits`), farm suspension status and auth-version
revocation triggers. It does not import accounts, change existing passwords or
create an admin. Bootstrap is a separate explicit command. See
[`docs/AUTHENTICATION.md`](../../docs/AUTHENTICATION.md).

[Codex] `004_tenant_isolation.sql` adds 30 missing business ownership columns,
backfills module-aware parents, and installs non-null/positive/indexed farm IDs,
59 ENABLE/FORCE policies and 58 ownership triggers. Retired activation is denied
without tenant attribution. Unresolved owners or conflicting vaccination parents
abort atomically without deleting rows. Existing orphans whose ownership cannot
be derived need deliberate attribution before upgrade; new orphans retain their
stamped owner. Private auth metadata access replaces an RLS bypass exception.
Applied locally. Provisioning and limitations: [`TENANT_ISOLATION.md`](../../docs/TENANT_ISOLATION.md).

[Codex] `005_staff_permissions.sql` installs the generated 50-key current sidebar
catalogue and private staff grant storage. Flags remain integer 0/1, mutation
flags require view, and validation checks staff/farm/key without foreign keys.
Grant changes revoke sessions; identity changes clear old grants. Runtime roles
cannot access this metadata. Applied locally. Staff SQL stays denied until the
instrumented operation/module map is complete and reviewed. See
[`STAFF_PERMISSIONS.md`](../../docs/STAFF_PERMISSIONS.md).

## Existing manual development setup

If the database was installed with the old three `psql -f` commands, run:

```sh
npm run db:migrate -- --baseline
```

This is explicit adoption, not repair. The runner builds migration 001 in a
temporary reference schema and compares tables, columns, defaults, identity
properties, constraints, indexes, triggers, RLS flags and sequence settings.
It also checks the shared `public.nocase` collation. A mismatch aborts without
recording history. Business rows and sequence positions are never rewritten.
Close/review unexpected schema differences rather than suppressing the error.
Subsequent deploys run without `--baseline`.

## Adding a migration

The next migration is `005_description.sql`, followed consecutively. Never
edit, rename or remove an applied migration. SQL checksums normalize CRLF/LF
so Windows and Linux deployments agree. Do not regenerate migration 001 when
the schema generator changes; add the next migration instead.

The runner holds a transaction advisory lock before creating its history
table, validates the complete installed prefix, then applies all pending SQL
and history records in one transaction. Failed deploys roll back all pending
versions, including their DDL. Another deploy waits for the first; lock waits
default to 15 seconds and each statement to 60 seconds. SQL files must not
contain transaction-control statements. Operations such as `CREATE INDEX
CONCURRENTLY`, which cannot run inside a transaction, need a separately
designed deployment procedure rather than bypassing this runner.

History lives in `farminfantary_meta.schema_migrations`, outside the 60-table
business schema. Versions, filenames, SHA-256 hashes, application time and
whether version 001 was baselined are recorded. API startup does not migrate.

## Verification

```sh
node --test server/test/migrations.test.js
node scripts/verify/verify_migrations_pg.mjs
node scripts/verify/verify_unique_indexes_pg.mjs
node scripts/verify/verify_authentication_pg.mjs
node scripts/verify/verify_tenancy_pg.mjs
node scripts/verify/run-all.mjs
```

The PostgreSQL scenarios create isolated schemas and remove only those schemas.
They exercise fresh setup, baseline data preservation, incompatible schemas,
upgrades, history tampering, failures, concurrent deploys and lock timeouts.
The PostgreSQL script reports a skip when no database URL is configured; a
skip does not prove the migration behavior.
The full coverage gate requires DATABASE_URL so skipped SQL checks cannot close it.
