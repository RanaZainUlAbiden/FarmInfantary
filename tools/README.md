# tools/

## Permission catalogue and observed table map — Codex

`node tools/permission-catalogue.mjs --write` derives the catalogue from the four
active sidebar arrays and registered component routes. Without --write it checks
for drift. There are 50 current keys: 14 broiler, 15 layer, 15 distribution and 6
owner; Add Batch is a shortcut, not another grant. The historical 47-key estimate
was stale. The generated JSON is in `db/seeds/permission-catalogue.json`; migration
005 contains its immutable initial SQL snapshot. Future menu changes require a
reviewed catalogue update/new migration, never editing the applied snapshot.

`node tools/collect-voucher-permissions.mjs` runs the real 255-check voucher
regression in a disposable PostgreSQL schema. Explicit scopes bind real app
entry points to permission/action intent. The IO wrapper observes every nested
get/run/batch; fixture setup and unrelated assertions are excluded. The SQL AST
analyzer derives reads, mutation targets and upsert dependencies. No table set
is hand-written. Results, including refusals, preserve the original IO contract.

`node tools/permission-report.mjs` generates `docs/PERMISSION_TABLE_MAP.md` from
the evidence. Four create/delete scopes across 2/50 screens are currently observed;
this is incomplete and **not imported by the server**. Views, other screens,
module initialization/resolvers and unsupported-action decisions still need
coverage. Run both tools with `--check` to check source/report drift.

The trace stores query hashes, table/verb sets, action/scenario labels and counts.
It never saves SQL text, parameter values, rows or error details. Context follows
async work and rejects nested relabeling. Actual SQL is analyzed in a bounded
local subprocess; this Windows Node 24 runtime needs baseline Wasm compilation
to avoid an optimizing-compiler Zone crash. Those flags affect the offline tool
only. Repeated SQL analyses are cached; unresolved analysis blocks capture success.

Staff SQL remains denied, even with grants in the private metadata tables. The
final reviewed operation/module policy will produce the server guard mapping;
this draft does not implement it. A create workflow can UPDATE stock/ledgers,
so SQL verbs cannot be used directly as UI permission flags. Shared broiler/layer
tables also require server module restrictions, not a table-name union alone.

**Do not hand-write that map.** Write sets are wider than they look — recording
a sale touches `bank_ledger` and `customer_ledger` — and a missed table means
either a broken screen or a permission hole.

Two properties the output must have:

- **Complete.** A table in no permission's set is unreachable by every
  non-admin. That is the correct default, and a test should assert every tenant
  table appears in at least one mapping.
- **Reviewed as a security artefact.** It decides what staff can reach.
