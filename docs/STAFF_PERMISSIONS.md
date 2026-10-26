# Staff permission foundation — Codex

**Current development update (2026-10-27):** owner management of prepared
per-screen View/Create/Edit/Delete grants is implemented on `codex/staff-access`.
See [STAFF_ACCESS.md](STAFF_ACCESS.md) for current validation and remaining trusted
operation enforcement. Staff business access is still denied. The historical
foundation notes below describe the earlier batch, not current deployment status.

Migration 005 is applied locally. It adds private catalogue/grant metadata,
validation and durable session revocation. **Staff SQL remains denied.** Neither
these rows nor the generated observation report authorizes a business query.
Production startup remains blocked; the guard/policy needs independent review.

## Catalogue and private storage

`tools/permission-catalogue.mjs` derives 50 keys from current active menus and
registered component routes: 14 broiler, 15 layer, 15 distribution and 6 owner.
Shared screens have separate module keys. Add Batch is a query-string shortcut
onto Batches. The older 47-key plan was stale. The generated catalogue is
`db/seeds/permission-catalogue.json`; its immutable initial seed is in migration
005. Later menu changes need a reviewed catalogue update and new migration.

`user_permissions` stores user/farm/key and integer 0/1 view/create/edit/delete
flags. Mutation flags require view. Validation locks and checks the target staff
user, its farm and the known catalogue key; grant identity is immutable. No FKs
or business money/date changes were introduced. These are platform tables, not
tenant business tables; the restricted SQL role receives no table/column grants
and cannot invoke their functions. Attestation requires these tables too, so
apply all current migrations before provisioning/starting a restricted runtime.

Actual grant changes increment `users.auth_version`, invalidating every device
session even after re-grant. A no-op flag save does not revoke. Rollback restores
both flags and session validity. Farm/role changes clear old grants, and deleting
a user removes its grant metadata. Suspension preserves grants but prevents
session/snapshot use. Re-enabling a farm/user cannot revive old cookies.

`server/src/auth/permissions.js` loads immutable snapshots only for a current,
active, farm-matching staff identity/version and active farm. It uses the private
auth/metadata pool. It is not a public API or an alternative authentication path.
No admin grant endpoint exists yet. Future admin writes must invoke existing
user-revocation callbacks to close outstanding transactions proactively; direct
metadata edits are recognized on next session resolution, with transaction
deadlines bounding abandoned work.

## Instrumentation and remaining mapping

`tools/permission-trace.mjs` labels the real application workflow before
observing nested get/run/batch IO. Async scopes stay separate and cannot relabel
a nested action. Table access is derived from SQL ASTs, including source reads,
joins, CTEs, subqueries, upserts and mutation targets. Unknown/unparsed accesses
remain unresolved and block a successful evidence capture. This diagnostic
analyzer is not the security SQL guard.

`node tools/collect-voucher-permissions.mjs` runs the unchanged-assertion 255-check
voucher PostgreSQL regression and stores four create/delete scopes across two
screens. Receive vouchers also write bills, customers, customer ledger and bank
tables; payment vouchers write supplier ledger and bank tables. Setup and test
assertion queries are outside the labeled scopes. Workflow refusals are counted.
No SQL text, parameters, returned rows or database error details are persisted.
Source digests invalidate observations after Angular source changes.

The offline analyzer runs in a bounded subprocess with baseline Wasm compilation:
the local Windows Node 24 optimizing compiler crashed when loading libpg-query.
Parser failures stay unresolved; the workaround does not modify API runtime flags.
Crashed disposable voucher schemas were explicitly identified and removed.

`node tools/permission-report.mjs` generates `PERMISSION_TABLE_MAP.md`. Current
coverage is **4 action scopes / 2 of 50 screens**; this is a review worksheet,
not an executable policy. No server module imports it. Complete the remaining
screens/actions, resolver/module initialization and dependent routes, and record
unsupported actions explicitly. Check every tenant table is accounted for.

Creating a sale may UPDATE several ledgers. Therefore SQL verbs alone cannot
choose the UI action grant. Likewise table grants cannot distinguish broiler
and layer rows in shared tables. The future guard must enforce reviewed module
and operation constraints without letting a client manufacture authority via a
screen/action label. Test hostile cross-action queries and dependencies before
enabling staff. Admin provisioning, seat quotas and sidebar/route usability
filtering remain separate unfinished work.

## Verification

- `verify_staff_permissions_pg.mjs`: 16 real PG scenarios, including session
  revocation, grant validation, rollback, identity cleanup, snapshot isolation,
  actual runtime denial and full-grant staff still denied by HTTP.
- `verify_permission_derivation.mjs`: 10 catalogue/AST/context/privacy/drift and
  actual voucher evidence scenarios.
- Catalogue, evidence and report `--check` commands pass.
- Full regression: **79/79 scripts**, approximately **9,837 reported checks**.
  Backend tests: **82/82**. All 29 inherited gates remain green.
- No Angular source changed in this batch. No persistent runtime login, real
  user or real grant was created; test schemas/logins were removed.

Logs: `qa-results/verify-permissions-all.log`, `staff-permissions-pg.log`,
`backend-permissions.log` and `voucher-permission-trace.log`.
