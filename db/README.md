# db/

PostgreSQL schema, forward-only migrations and demo data. D14 specifies a fresh
application: existing desktop databases are not imported.

Rules that cause silent data corruption if broken are in `CLAUDE.md` in this
directory — read it before touching the schema.

```
schema/      generated inherited-business reference: 000_collations · 001_tables · 002_indexes
migrations/  immutable numbered SQL + usage instructions
migrate.mjs  deploy command; uses a DDL-capable role
seeds/       generated current permission catalogue
seed.mjs     inherited parity/business fixtures, not server login credentials
```

Run `npm run db:migrate` before the API. Existing manually initialized databases
use `npm run db:migrate -- --baseline` once, which validates structure before
adopting it. See [migration instructions](migrations/README.md).

[Codex] Migration 002 restores the original unique-index rules and preserves
duplicate rows by refusing the upgrade if they conflict. It is applied locally.
The immutable 001 baseline stays unchanged; the generated business schema has
50 non-primary indexes, including all three unique indexes.

[Codex] Migration 003 adds the server authentication foundation: three platform
tables, farm status and durable auth-version revocation. No accounts were
imported or created. Authentication does not yet enable the business SQL pipe.

[Codex] Migration 004 is applied locally: 30 new business farm_id columns,
59 indexed ENABLE/FORCE policies and 58 stamping triggers. Role provisioning
and attestation are tested with disposable restricted logins; no persistent
runtime login was created. The AST guard and runtime wiring now enable the
farm-admin session HTTP path with verified credentials; browser cookie integration
is complete. Staff access remains. Read [SQL guard status](../docs/SQL_GUARD.md) and
[tenant isolation](../docs/TENANT_ISOLATION.md).
RLS changes are security-critical and need a second reviewer before production.

[Codex] Migration 005 is applied locally: a generated 50-key permission catalogue,
private integer grant flags, staff/farm/key validation and durable grant-change
revocation. Identity changes clear stale grants. No real grants/accounts were
created; staff SQL remains denied pending the reviewed operation/module map.
See [staff permission status](../docs/STAFF_PERMISSIONS.md).
