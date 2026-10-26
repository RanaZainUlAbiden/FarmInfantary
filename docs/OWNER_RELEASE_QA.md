# Owner release verification — 2026-10-26

All 84 verification scripts pass (approximately 9,892 reported checks), with
83/83 backend tests. The production Angular build passes on Node 24.14.0.
Angular core/framework is 20.3.34; CLI/build is 20.3.41; TypeScript is 5.9.3.
Both `npm audit --omit=dev` reports contain zero vulnerabilities. Existing PDF
CommonJS optimization warnings remain. The local database is at migration 007.

The inherited Angular 19 line has reached end of support. Angular's published
[version compatibility](https://angular.dev/reference/versions) supports the
selected Node/TypeScript combination. The maintainer's
[HTTP-client advisory](https://github.com/angular/angular/security/advisories/GHSA-jfgx-762w-99vr)
identifies 20.3.34 as patched. This upgrade changes the web target only; the
frozen desktop reference remains unchanged.

## Browser evidence

The built application was tested in the in-app browser using a disposable
PostgreSQL schema and temporary runtime login. Owner cookie sign-in, team page,
back-to-farm navigation, active account status and the owner export download work.
The export shows an explicit downloaded filename in the status region. Admin
farm/seat/staff/audit flows and delete-dialog wrong-code, correct-code transition,
Escape, focus restoration and tab wrapping were exercised in the prior fixture.
No final destructive confirmation was submitted through the browser.

The team screen was inspected with an actual 561 CSS-pixel viewport (the browser
did not honor the requested 390 override). Page width was 546 pixels with no
horizontal document overflow. This is narrow-layout evidence, not phone/200%
zoom certification. Screenshot evidence is in `qa-results/codex-team-narrow.png`
and `codex-owner-export.png`, with earlier admin/delete screenshots alongside.

## Static design tooling limitations

The final strict premium audit returns nonzero with 16 actionless-button findings.
The raw JSON is retained in `qa-results/owner-premium-audit.json`; it is NOT a
passing audit. Each finding was inspected against its source: Angular `(click)`
bindings implement the reported actions. The shared password button's handler is
on the following source line. The scanner does not recognize Angular event syntax.
Browser and source-state/HTTP tests provide the actual behavioral evidence; no
fake onclick attributes or scanner exemptions were added. The design-context lint
reports zero errors, six orphan-token warnings and one informational summary.

Compose YAML parses as three services. Docker is absent here; no image build,
Compose startup, public-domain HTTPS or production migration execution is claimed.
Default local release preflight correctly refuses production approval. Tests use
synthetic reviewer metadata only; there is no actual independent review approval.
The startup gate remains effective until the operator supplies a genuinely
reviewed digest and appropriate deployment environment.

## Logs

- `qa-results/verify-owner-final.log`: 84/84, approximately 9,892 checks.
- `qa-results/backend-owner-final.log`: 83/83 tests.
- `qa-results/angular-owner-final-build.log`: successful production build.
- `qa-results/audit-frontend-final.json`, `audit-server-final.json`: zero issues.
- `qa-results/owner-release-security-pg.log`: eight owner-release security cases.
- `qa-results/admin-private-auth-pg.log` or `verify-owner-final.log`: eighteen
  administration cases with restricted private-auth privileges.
- `qa-results/owner-data-delete-pg.log`: fourteen delete/export cases.
- `qa-results/ops-backup-pg.log`: six encrypted backup/restore cases.
- `qa-results/owner-premium-audit.json`: sixteen reviewed scanner false positives.
- `qa-results/design-context-lint-final.log`: zero errors, six warnings.
