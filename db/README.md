# db/

PostgreSQL schema, migrations, seeds and the one-time SQLite import.

Rules that cause silent data corruption if broken are in `CLAUDE.md` in this
directory — read it before touching the schema.

```
schema/      001_tables · 002_indexes · 003_rls · 004_roles · 005_auth
migrations/  numbered, forward-only, advisory-locked
seeds/       permissions.sql — the 47-key catalogue
import/      sqlite-to-postgres — existing sng_farm.db files
```

`003_rls.sql` is security-critical. Changes need a second reviewer.
