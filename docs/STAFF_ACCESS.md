# Staff access development — Codex, 2026-10-27

The user selected **per-screen View/Create/Edit/Delete controls**. This branch
implements owner management of prepared staff grants. It does not enable staff
business access and has not been deployed. Production remains the owner release.

## Implemented and verified

The existing Team screen now lets a farm administrator manage their own staff:
read and replace the four flags for each of the 50 catalogue entries, suspend or
reactivate an account, and reset its password. Selecting a mutation selects View;
clearing View clears the other flags. Broiler and Layer entries remain separate.
The screen explicitly calls these permissions prepared until enforcement ships.

Dedicated `/api/account/permissions` and `/api/account/staff/:userId/permissions`,
`/status`, and `/password` endpoints use the private metadata store. They derive
the farm from the current session, reject extra identity fields, and restrict
targets to staff in that farm. Owners cannot manage another farm, themselves,
other farm administrators, or platform administrators. Platform APIs retain their
root-only checks. Delegated account creation and seat quotas retain their prior
rules; creation delegation does not control management of existing staff.

Mutations lock the farm and target, recheck the target role after locking, check
the expected auth version, audit atomically and revalidate the actor before
commit. Actual permission changes, status changes and password resets revoke
staff sessions and outstanding transactions. No-op permission saves retain
sessions; stale editors cannot overwrite newer changes. Passwords/hashes are
excluded from audit details. No migration or runtime privilege expansion is needed.

## Source inventory and remaining enforcement

`node tools/staff-workflow-inventory.mjs` produces a review checklist covering
50 module-specific screen keys, 697 event/initialization roots and 147 candidate
mutation roots. It follows component/self/constructor-service method calls down
to DatabaseService primitives and records source references and SQL hashes.
Free functions, resolver wiring and runtime-selected calls need separate review.
It is neither execution evidence nor an authorization policy; candidates may
represent unsupported actions. `--check` detects source/producer drift.

The measured runtime evidence remains four voucher action scopes across two
screens. Do not import either evidence file as executable staff policy.

Remaining work before enabling staff:

1. Classify actual supported View/Create/Edit/Delete workflows, their reads,
   initialization/resolver dependencies, module scopes and side effects. Exercise
   successful and refused paths against disposable PostgreSQL data.
2. Add trusted server operation enforcement for each supported workflow. A Create
   sale may update stock and ledgers without granting arbitrary Edit authority on
   those tables. Browser screen/action labels and SQL verbs cannot establish that
   authority. Derive tenant/module scope server-side and validate operation inputs.
3. Add permission-aware staff landing, navigation, routes and action controls;
   enforce the same decisions on the server. Preserve grant revocation and device
   delete authorization. Test hostile raw SQL, cross-action and cross-module calls,
   including shared Broiler/Layer rows with colliding scope IDs.
4. Review the completed security boundary, refresh the exact production release
   attestation, deploy and verify real staff sessions. Codex review is self-review
   under D17, never independent approval.

The current raw SQL guard and business route guard still deny staff even when
all prepared flags are selected. This is intentional until the above is complete.

## Validation

- Production Angular build passes; backend tests: 83/83.
- Full regression: 87/87 scripts, approximately 9,908 reported checks.
- Restricted-role PostgreSQL/HTTP administration suite: 22 scenarios, including
  owner boundaries, malformed grants, stale versions, revocation and audit safety.
- Source inventory suite: five checks for coverage, traversal, drift and privacy.
- In-app browser: disposable owner can open staff management, save Broiler Income
  View/Create, reopen it and see the persisted flags. No production grants changed.

Logs: `qa-results/staff-owner-regression.log`, `staff-owner-api-tests.log`,
`staff-owner-management-tests.log`, `staff-owner-build.log`.
Screenshots: `qa-results/staff-access-20261027/owner-permission-grid.png`.
