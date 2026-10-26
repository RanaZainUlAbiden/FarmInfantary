# Codex release self-review — 2026-10-26

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
