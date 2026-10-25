# Verify scripts

The 29 scripts that are **the only regression net for this project**. There is
no unit test suite — `.spec.ts` files exist from the CLI scaffold and are empty.

They work by lifting method bodies out of the real source **as text** and running
them against a schema built from the real `createTables`/migrations. That is why
`Talha Farm/` is committed: these scripts read it as a build input.

## Phase 0

Copy them from `Talha Farm/scripts/verify/` and get all 29 green against the
desktop code, unchanged. That is the baseline everything else is compared to.

## Phase 1

Re-point them at `db/schema/` and the new server modules. **A broken verify
suite is a build failure, not cleanup to do later** — it is the precondition for
trusting any part of the migration.

## Caution

Their extractor finds a method body by its first brace. An inline object return
type would be mistaken for the body, which is why several interfaces in
`database.service.ts` are named rather than written inline. Keep that convention.

No verify script sees an HTML template: a column added to SQL is checked, a
column added to a template is not.
