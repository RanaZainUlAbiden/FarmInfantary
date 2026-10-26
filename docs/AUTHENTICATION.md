# Cookie authentication — Codex

Implemented and verified on 2026-10-26, including browser AuthService integration.
Dedicated admin provisioning, seat controls, audit and delete authorization are
implemented. Staff business access is deferred for the owner-only first release.
The session SQL pipeline is now wired to the real AST guard, scoped transactions
and an attested restricted runtime pool. Read `SQL_GUARD.md` for activation.
Migration 004 now installs full-schema tenant policies and private auth metadata
lookup; restricted-role provisioning/attestation is tested. No persistent local
runtime login has been created. See `TENANT_ISOLATION.md`.

## Current operating modes

Development requires explicit `NODE_ENV=development`. Production requires the
owner-only session profile, HTTPS, separate attested auth/runtime logins and an
independent review of the exact release digest. Missing configuration refuses
startup. Actual approval remains outstanding. See `OWNER_RELEASE.md`.

- `AUTH_MODE=development` (current compatibility default): the existing local
  demo and regression endpoints use the fixed development farm. This mode does
  not register real authentication routes or authenticate users.
- `AUTH_MODE=session`: real authentication routes below. Business endpoints
  require same origin and a valid server session. With verified runtime credentials,
  farm admins use guarded tenant SQL; staff/platform admins receive 403. Without
  runtime setup farm users receive 503. SQL never falls back to the auth pool.
  No configuration flag can turn unfinished tenant security into production mode.

The Angular login now requires session mode. Development compatibility mode has
no sign-in API and cannot serve the migrated login workflow. Local `.env` has
not been switched or supplied persistent runtime credentials. Legacy demo seed
hashes cannot authenticate; fresh farm/staff provisioning remains pending.

## Browser behavior

AuthService restores `/api/auth/me` before protected parent/child routes mount.
Only a validated server response establishes an in-memory user/farm/role; neither
localStorage nor sessionStorage can authenticate. Public registration, account
enumeration, legacy hashes and raw SQL were removed from browser auth. Farm
admins enter their requested internal business route; staff/platform users land
on `/access` until their dedicated workflows are implemented. This route is a
placeholder, not a completed admin console or staff permission implementation.

The same-origin interceptor sends cookies and a user/farm context precondition.
The server compares that precondition with its cookie identity, returning 409
`SESSION_CHANGED` on mismatch; the header never selects an identity. A 401 or
context mismatch clears private UI and redirects to sign-in. No write is replayed.
Epoch checks discard older successful responses and late transaction BEGIN tokens.
Cross-tab login/logout events invalidate local state without importing an identity.

Logout clears selected units/flocks, pending drafts and transaction tokens before
server revocation. A failed/offline logout leaves a pending intent in sessionStorage;
automatic restoration and another login remain blocked until revocation succeeds.
Same-user reload may retain UI preferences only after a fresh server lookup.
Passwords are masked initially, support a labeled reveal button and current-password
autocomplete, and are cleared after an attempt. Username remains available for retry.
Return URLs are restricted to internal `/app` routes.

## Configuration and provisioning

Run `npm run db:migrate`; migration 003 creates `users`, `auth_sessions` and
`auth_login_limits`, adds `farms.status`, and installs revocation triggers.
The 60 inherited business tables remain; these are three platform tables.
No desktop accounts/hashes are imported (D14). The local database is now at 005,
which also adds private permission catalogue/grant tables and grant revocation.
See `STAFF_PERMISSIONS.md`; staff SQL remains denied.

Session mode requires `APP_ORIGIN` as an exact origin without a trailing slash
and a random `SESSION_SECRET` of at least 32 characters. HTTPS is required;
localhost HTTP is permitted only in development. Generate a secret locally:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The one-time `npm run auth:bootstrap` command reads
`BOOTSTRAP_SUPERADMIN_USERNAME` and `BOOTSTRAP_SUPERADMIN_PASSWORD` from the
environment, using `MIGRATION_DATABASE_URL` or `DATABASE_URL`. It accepts no
credential defaults and prints no password/hash. Concurrent executions serialize
under an advisory lock; an existing super admin causes refusal without resetting
credentials or adding another owner. Remove bootstrap credentials afterward.
The implementation is tested in disposable schemas; no real admin was created.

Usernames use 3–64 ASCII letters/digits/dots/underscores/hyphens, starting with a
letter/digit, and are case-insensitive. New passwords use 15–128 Unicode code
points, at most 1,024 UTF-8 bytes. Whitespace remains part of the password.
Farm/staff provisioning and seat limits belong to the dedicated admin path.

## HTTP routes

| Route | Behavior |
|---|---|
| `POST /api/auth/login` | `{username,password}`; rotates the existing cookie and returns a sanitized server-derived user/farm |
| `GET /api/auth/me` | Resolves the cookie against current user, version and farm status; no localStorage trust |
| `POST /api/auth/logout` | Revokes the server session and clears the cookie |
| `POST /api/auth/password` | Verifies `{currentPassword,newPassword}`, changes the hash, revokes every device session and requires sign-in |
| `PATCH /api/account/business-type` | Farm-admin-only `{businessType}` enum; updates the cookie-owned farm and returns fresh safe metadata; body farm/user claims cannot select ownership |

Mutations require the exact configured Origin. Cross-site Fetch Metadata is
refused. Responses use `Cache-Control: no-store`; bodies are capped at 4 KiB.
Unknown users and wrong passwords have the same generic response, with dummy
Argon2 verification for unknown users. Driver/constraint failures never return
credential rows or schema details. Authentication logs contain error codes only.

## Passwords and sessions

- `node-argon2` hashes with Argon2id, 64 MiB, three passes, one lane, random salt.
  Encoded verification costs are bounded even if a stored hash is damaged.
  At most four native password operations run concurrently; extra work is refused.
- Cookies carry 32 random bytes as base64url. PostgreSQL stores only an HMAC-SHA256
  verifier. Tokens are accepted only from one valid cookie, never body/URL/header
  bearer credentials. Duplicate/malformed cookies are rejected.
- Cookies are HttpOnly, SameSite=Strict and Path=/ with no Domain. HTTPS config
  adds Secure and the `__Host-` prefix. Local HTTP uses `fi_session`; it is not a
  production cookie configuration.
- Sessions expire after eight hours absolutely or 30 minutes idle. Role, user
  and farm identity are re-read server-side. User identity/security changes and
  farm status changes increment auth versions. Old sessions remain invalid after
  reactivation. Password changes explicitly delete all device sessions.
- PostgreSQL atomic counters limit each IP to 30 and each username to 10 attempts
  per 15-minute window. Password-change buckets are separate. Bucket identifiers
  are HMACs, not raw IPs/usernames. Expired records are cleaned periodically.

The SQL guard must permanently exclude all three platform tables from browser
SQL. The eventual app role must not own business tables or bypass RLS. Dedicated
auth/admin queries need appropriate narrowly scoped privileges. Nothing here
signs off those unfinished controls.

Session resolution now also supplies an internal `sessionKey` (the HMAC verifier)
for device-specific transaction ownership. JSON responses omit both sessionKey
and authVersion. Optional auth-store `onRevokeSession`/`onRevokeUser` callbacks
run after durable rotation/logout/password revocation and connection release;
they are connected to scoped transaction cleanup by buildServer. Invalid/stale
session resolution dispatches device cleanup too. Their dispatch, rollback and
JSON exclusion are covered by authentication and guarded HTTP/PG suites.

## Verification

`node scripts/verify/verify_authentication_pg.mjs` runs 28 real PostgreSQL/HTTP
scenarios, including bootstrap refusal, impersonation, cookie forgery, revocation,
expiry, password changes, concurrent throttling, SQL denial, private-schema key
discovery and sanitized DB failures. `server/test/auth.test.js` adds seven unit
tests. `verify_browser_sessions.mjs` adds 17 source-state scenarios for restore,
forgery, races, offline logout, cache ownership, cross-tab events and interceptor/
route behavior. `verify_guard_http_pg.mjs` now covers 22 scenarios, including
stale-context rejection and the dedicated business-type endpoint. The static
inventory enforces zero raw SQL in browser authentication.

Latest full suite: **79/79 scripts (~9,837 reported checks)**, backend **82/82**,
Angular build green with existing CommonJS warnings. In-app browser testing used
the built Angular app, real cookie API, full RLS schema and a disposable restricted
login: owner sign-in/deep-link/reload, password reveal/hide, validation/failure,
expiry, restricted staff access and logout/reload. Test accounts/schemas/roles are
disposable; no real credentials were created. Evidence: `BROWSER_SESSION_QA.md`.

Design references: [node-argon2](https://github.com/ranisalt/node-argon2),
[OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
