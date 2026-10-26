# Owner-only release candidate

The user selected an owner-only first release on 2026-10-26. Farm owners can
use business screens; platform administrators manage account metadata. Staff
business SQL stays denied, including for staff with grant rows. The derived
staff map covers four voucher action scopes on two of fifty screens and is
deferred. Do not enable it as a complete authorization policy.

## Implemented and verified locally

- [x] [Codex] Seven immutable migrations, tenant FORCE RLS, separate restricted
  business and private auth roles, server sessions and guarded SQL execution.
- [x] [Codex] Platform farm/owner provisioning, bounded metadata lists, seat
  quotas, delegated staff administration, optimistic version checks and audit.
- [x] [Codex] Owner-configured Argon2 delete code. No inherited/default code or
  plaintext disclosure. Verification authorizes only the current device session
  for sixty seconds; expiry, logout and code changes invalidate authorization.
  DELETE and recognized soft-delete mutations require the server confirmation.
- [x] [Codex] Active-account entitlement and an owner JSON data download under
  tenant RLS. Exports exclude private/platform tables, use a consistent snapshot,
  are rate limited and fail as a whole when row/size/time limits are exceeded.
- [x] [Codex] AES-256-GCM operator backups, retention and restoration into a new
  empty database. Authentication completes before SQL restoration. Restored
  sessions and delete grants are revoked. Real PostgreSQL restore drills pass.
- [x] [Codex] Install manifest and static shell service worker. API responses,
  financial exports and writes are never cached or replayed. Connection loss
  does not permit offline business writes.
- [x] [Codex] Production profile/digest gate, readiness probes, proxy boundaries,
  non-root API Dockerfile, HTTPS Caddy configuration and daily backup unit files.

These checks do not constitute independent security approval or a deployment.
Docker is unavailable on this workstation: image build, Compose execution and
public-domain HTTPS still require verification on the deployment host. No real
account, persistent restricted login, timer or public service was created.

## Prepare the deployment host

Use Node 24, PostgreSQL 18 client tools, Docker Engine with Compose, a domain
pointing to the host and ports 80/443 available. Keep migration, auth and business
credentials separate. Review `ops/compose.yaml` subnet/resource limits for the
host. Database access is published only to loopback for operator tasks.

1. Copy `ops/runtime.env.example` to `ops/runtime.env`; supply random credentials,
   domain and a session secret. Keep review fields empty until actual approval.
   Never commit this file. Start only the database initially:
   `docker compose --env-file ops/runtime.env -f ops/compose.yaml up -d db`.
2. On the host, install root/server locked dependencies with `npm ci` and
   `npm --prefix server ci`. Set `MIGRATION_DATABASE_URL` to the loopback database
   connection using the migration login; run `npm run db:migrate`. New installs
   use all seven migrations. Never edit migration history or checksums.
3. Set `DATABASE_URL` to a NEW auth login URL on the same loopback host/database;
   run `npm run db:provision-auth`. Set `RUNTIME_DATABASE_URL` to a DIFFERENT NEW
   login URL and run `npm run db:provision-runtime`. Both commands attest their
   privileges. Compose uses the same roles/passwords with hostname `db`, while
   host commands use `127.0.0.1` and the configured backup port.
4. Bootstrap the first platform administrator with `npm run auth:bootstrap` and
   operator-supplied fresh credentials. Remove bootstrap variables afterwards.
   This is an explicit operator step; no demo/desktop credentials are accepted.
5. Run `npm run verify`, `npm run api:test`, `npm run build` and dependency audits.
   Build both images with Compose. Inspect the built UI and readiness on the host.
6. An independent reviewer must inspect auth, RLS, AST guard, delete proof,
   admin operations, exports, restore and deployment configuration. Run
   `npm run release:info`; record the actual reviewer and approved source digest
   in the runtime env. Any covered source/config change invalidates that digest.
   Synthetic reviewer values in tests are not production approval.
7. Remove migration credentials from the API environment. Compose passes only
   selected runtime variables. Run `node scripts/ops/preflight.mjs` with the
   production API environment and then start API/web through Compose. Verify
   public HTTPS, login/logout, `/api/ready`, owner isolation and staff denial.

Production startup refuses unreviewed builds. The digest gate records operator
attestation; it does not replace the independent review required by this repo.

## Backups and recovery

Copy `ops/backup.env.example` into a private operator environment. Set
`BACKUP_DATABASE_URL` to a backup-capable loopback login and generate a separate
32-byte base64 `BACKUP_ENCRYPTION_KEY`. Keep a recoverable copy of that key apart
from the backup files. `npm run backup:create` writes encrypted `.fibak` archives
and reports their SHA-256; retention removes only its own exact filename pattern.
The API never receives backup/migration credentials or this encryption key.

Adapt the paths/user in `ops/farminfantary-backup.service` and `.timer` before
installing them. They are provided, not enabled. Arrange encrypted offsite copies
and failure monitoring on the chosen host; test recovery regularly.

For a drill or disaster recovery, create a NEW EMPTY database. Set its complete
`RESTORE_DATABASE_URL` and the original encryption key, then run
`node scripts/ops/backup.mjs restore <encrypted-file>`. Existing databases and
the default PostgreSQL maintenance/template databases are refused. Use only a
trusted operator archive. Reprovision/attest auth/runtime roles for the restored
database and verify it before switching traffic. No browser upload/restore route
exists. Owner JSON download is a readable data export; per-farm import with safe
ID remapping is deferred and must not be promised as a supported restore format.

## Remaining release gates

Independent security review, image/Compose verification, hosting/domain/secrets,
public HTTPS smoke tests and activation of monitored/offsite backups remain.
Staff business access and per-farm import belong to a later release.
