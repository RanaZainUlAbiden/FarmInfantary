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

---

## Running the suite

```bash
node scripts/verify/run-all.mjs              # whole suite; exit 0 = green
node scripts/verify/run-all.mjs -v           # full output from failures
node scripts/verify/run-all.mjs --only bank  # scripts matching a substring
node scripts/verify/run-all.mjs --dir <d>    # a different script directory
```

The runner scans two directories: this one (scripts written for the conversion)
and `Talha Farm/scripts/verify/` (the 29 inherited ones). Phase 1 re-points the
second at the ported suite.

**Exit code is the contract, not the check count.** The scripts do not share an
output format — some print `PASS`, some `OK`, `verify_migrations` asserts by
throwing — so the counts in the summary are indicative only.

## The oracle

```bash
node scripts/verify/oracle.mjs <path-to.db> -o before.json
node scripts/verify/oracle.mjs --compare before.json after.json
```

The verify scripts prove the **logic** still behaves. The oracle proves the
**numbers** did not move: capture before the migration, capture after, diff.
Any difference is a defect until explained.

It is also where the app's canonical aggregate definitions live — the debt
definition `SUM(MAX(total_amount - amount_paid, 0))`, the broiler `COALESCE`
test and the strict layer test. Phase 1 must reproduce them exactly.

Output is gitignored. The totals are a real business's financials; decide
deliberately before committing one.

## verify_money_types.js

The tripwire for the highest-impact risk in the conversion (`docs/DECISIONS.md`
D4). It asserts every money value reaches JavaScript as a **number** and that
arithmetic on it is arithmetic.

It passes trivially against sql.js. In Phase 1 it is re-pointed at PostgreSQL,
where it fails loudly if a money column is mapped to `numeric` — which
`node-postgres` returns as a **string**, silently turning `1000.5 + 300.25`
into `"1000.5300.25"`.
