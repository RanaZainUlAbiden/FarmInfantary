# Codex release self-review â€” 2026-10-26

## Broiler + Distribution acceptance repairs - 2026-10-28

[Codex] Reviewed source digest
`101ba961a8ea98fff5be0038eeea69663fad1b5450878529282db63c65a1e6e5`
under the user's D17 self-review authorization. Statement-derived purchase
settlement is read-only, supplier-scoped and uses integer paisa; original
payment flags/cash/bank writers are preserved. Purchase date corrections keep
statement claims aligned. Overview per-farm chick costs now agree with headline
and farm-report attribution for Broiler and Layer. Existing native code modal
guards purchase/sales edits and sales returns; the backend grant and guard/RLS
remain authoritative. Purchase edits block duplicate saves. Purchase-return
header/stock/history/status/supplier legs use one transaction, check all failures
and refuse insufficient stock without partial credit. Frozen DatabaseService
signatures, schema and staff profile are unchanged.

Evidence: 95/95 scripts (~10,002 reported checks), targeted 8-scenario final
correction gate/busy-state rerun, 83 backend tests, production build and CSP
shell checks; 36 populated browser menu contexts and actual-source/live-HTTP
synthetic farm lifecycle, including 42 health days, closed flock, vouchers,
returns, broker receipts, internal elimination, assets and loans. Purchase and
internal-sale corrections leave all measured cash/bank/stock balances unchanged.
Permission observations were regenerated; 51 keys and inactive staff policy
remain unchanged. No independent reviewer is claimed. Browser transport failed
before final visual release checks; those and the shared artifact sync remain
pending, as documented in BROILER_DISTRIBUTION_AUDIT.md. Live build/API evidence
is recorded separately after deployment. Concurrency and every PDF permutation
are not certified by this audit.

Screen reliability follow-up: reviewed source digest
`e4d91ede9d913e7c1d180757cf422aadafec2a8bd7e2c7fd8383b40b270907ca`.
The browser bridge bounds report bursts, captures payloads before queuing,
cancels old-identity waiting work, rejects stale results and never retries writes.
The server's admission/auth/guard/RLS/transaction boundaries are unchanged.
Reviewed native navigation semantics, narrow drawer geometry and shared Income
empty wording. Permission metadata refresh changes no keys or active policy.
Validation: 86/86 scripts (~9,899 checks), 83 backend tests, production build,
50 slow-PostgreSQL browser navigation contexts, a persisted browser income save,
and 561px/390px Inventory/keyboard checks. See `SCREEN_FIXES.md`.
This remains the user-authorized Codex self-review under D17.

Branding/CSP follow-up: reviewed source digest
`52d248cec5dade12ae4707109a3323e29643acfe2369077e374d072ab466d303`.
The production CSS loader incompatibility is resolved by the Angular build setting,
not by relaxing CSP. Supplied image bytes, versioned cache behavior and report
PNG/header changes were reviewed; receipt handling, auth and SQL are unchanged.
Production output checks plus the full suite and public HTTPS/browser checks pass.
See `BRANDING_FIX.md` and current `HANDOFF.md` evidence; the earlier release digest
below is historical.

The user explicitly assigned the final review to Codex after being informed of
the repository's second-reviewer rule. This is a self-review of Codex-authored
work, not an independent security review. See decision D17 and PR #1.

Reviewed boundaries: cookie identity/origin/expiry/revocation, Argon2 work limits,
private admin operations and quotas, device-bound delete grants, AST allowlists
and tenant rewrite, session-owned transactions, FORCE RLS and role attestation,
export isolation/limits, authenticated operator recovery, container secrets and
proxy/readiness configuration. Staff SQL remains denied.

Findings resolved before release:

- Delete configuration advertised eight-character codes but invoked the account
  password hasher's fifteen-character validator. Dedicated delete-code validation
  and hashing now accept the documented range; an actual PG/HTTP regression
  covers eight characters, verification, and refusal below the minimum.
- Export size was checked after rows reached Node memory. PostgreSQL now computes
  bounded snapshot row count/serialized byte size before transferring rows, with
  the existing final size check retained for serialization overhead.
- Linux cloud builds found an inherited Feed template filename-case mismatch.
  Both template and spec imports are corrected; the new casing gate inspects
  relative imports/templates/styles before deployment.
- A database operator password appeared in command output during setup. It was
  rotated inside PostgreSQL, Railway's corresponding variable was updated and
  the one-off job's privileged credentials were removed. Secret values are not
  stored in Git. The app receives distinct restricted auth/business credentials.
- Railway's Caddy process receives only its required non-secret environment.
  The API listens on loopback and trusts only the in-container loopback proxy;
  arbitrary forwarded client addresses are not trusted. Railway ingress may
  aggregate IP-based limits; authenticated per-user limits remain enforced.

Limits: this review does not prove the absence of vulnerabilities. Dynamic SQL
inventory gaps remain covered by runtime guard/RLS rather than static coverage.
Legacy business-screen accessibility is not fully certified. Staff access and
per-farm import are deferred. No external independent review is claimed.

Release approval must record the actual reviewed source digest with reviewer
label `Codex self-review (user-authorized D17)`. Later covered source changes
invalidate it. Railway build/runtime/HTTPS evidence is recorded separately.

Final evidence: 85/85 verification scripts (~9,894 checks), 83/83 backend tests,
production build, both production dependency audits clean and nine live HTTPS
scenarios. Railway built/deployed main successfully. Backup cron runs verified
the actual mounted volume and persistence across separate containers. The
approved source digest is
`27eec29ef6a87a75a13adb02bad4b1e4b57991ada8ddc794f8f2aa40b59bac42`.

## Super-admin module assignment follow-up — 2026-10-27

[Codex] Self-review under D17: remove the owner Account Modules card and its
mutation UI/state; the retired owner PATCH route always refuses authenticated
callers after origin/context checks, and its mutation store function is removed.
Platform account create/edit still requires super_admin and validates the three
canonical bundles. Raw SQL cannot write farms. Module changes revoke all tenant
device sessions through the existing post-commit callbacks, including outstanding
transaction cleanup; no-op/settings-only changes retain existing behavior.
No schema/RLS/guard policy change or staff enablement is included. Physical-site
management is distinct from platform account provisioning and is preserved.

Reviewed direct and spoofed owner requests, platform-route refusal, SQL single
and batch refusal, super-admin positive changes and fresh sign-in navigation.
90/90 scripts (~9,965 checks), 83 backend tests and production build pass. The
51-key catalogue is unchanged except source metadata; regenerated voucher
observations remain inactive evidence. See MODULE_COMBINATIONS.md for browser
checks and the static audit limitation. Live deployment is verified separately.
