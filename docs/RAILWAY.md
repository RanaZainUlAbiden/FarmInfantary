# Railway — FarmInfantary (Talha Farm)

**Live and healthy, 2026-10-26.** PR #1 merged into main; Railway's app deployment
`211e035c-3ac9-4998-bfe7-153d7cad1397` was automatically triggered by merge commit
`3519ff33141e825b9dd9eef3a77c493d6b8b2a1e` and succeeded. Nine live HTTPS smoke
scenarios pass, including cookie flags, restoration, origin refusal, admin access,
platform business-SQL denial, logout, deep links and install assets. The in-app
browser confirms real administrator login. Credentials are held locally in ignored
`ops/railway-admin-credentials.env`; they are never part of Git or the app image.

Project: `ccd772bc-d2d0-49b4-85d8-bb7bff288fb8`.
Environment: `production` (`4db55201-561f-4a89-b482-a899ef97c561`).
App: `farminfantary-web` (`eb538aaa-64cc-469c-86cf-025319e48be3`).
Database: `Postgres` (`e6caf336-ea25-49a8-8635-acb87d5f58bd`).
Live URL: https://farminfantary-web-production-c687.up.railway.app

The app's GitHub source is `RanaZainUlAbiden/FarmInfantary`, branch `main`.
Committed changes pushed/merged to main trigger Railway deployments; local file
edits alone do not. PR #1 merged the owner-only release branch. Build settings
are stored in Railway and mirrored by `ops/railway-service-settings.json`.
Railway's deprecated Config as Code files are deliberately not used.

`ops/Dockerfile.railway` builds Angular, installs production API dependencies and
includes Caddy. Caddy serves static files and proxies `/api/*` over loopback.
Railway terminates HTTPS on the public address; the API binds only 127.0.0.1:3000
and trusts that loopback proxy only. Caddy does not receive database/session
secrets. It validates its configuration during the image build. Health checks
use `/api/ready`; one replica is configured. Do not scale replicas until shared
transaction ownership/revocation and distributed KDF limits are designed.

PostgreSQL 18 uses a persistent Railway volume and private networking. The
one-off setup job applied migrations through 007, created/attested separate auth
and business roles and rotated the operator credential. Its service was removed
after success so privileged variables are not left in a deployable job. Operator
material is in ignored `ops/railway-secrets.env` on the operator workstation;
never commit/upload that file or print its values. It is excluded from Docker.

The app uses NODE_ENV=production, AUTH_MODE=session, RELEASE_PROFILE=owner-only,
its exact HTTPS APP_ORIGIN, separate auth/runtime URLs and a random session
secret. It receives no migration/backup credentials. Review decision D17 records
the user's explicit assignment of the final review to Codex. The approval label
must say self-review; see `SELF_REVIEW.md`. Every covered source change requires
a new reviewed digest from `npm run release:info` before the new app can start.
GitHub triggers builds automatically; this gate deliberately refuses an
unreviewed source change rather than silently treating a previous digest as valid.

For later migrations use a separate private operator job with temporary
MIGRATION_DATABASE_URL, never the web runtime. The operator provisioning script
can attest existing roles but never resets their passwords. Remove privileged
job variables/service after completion. No database public TCP proxy is needed.

For incidents, inspect bounded Railway build/deploy logs and `/api/ready`; do not
print service variable values. Preserve the database volume. Roll back app code
only with a compatible migration state and its reviewed digest. Never roll back
by deleting production data or rewriting immutable migrations.

The current Railway plan refuses native snapshot schedules. A separate private
`farm-backups` cron service uses `ops/Dockerfile.backup` and a persistent `/backups`
volume. It runs at 02:00 UTC (07:00 PKT), retains seven AES-256-GCM archives, and
holds operator backup credentials/encryption key outside the web service. The
wrapper refuses to run unless `/backups` is an actual Linux mount. Confirm a
successful run and a persisted archive before relying on the schedule.

The encryption key is also retained in the ignored operator material file.
Archive copies outside this Railway project remain an operator responsibility;
a same-provider backup is not protection from loss of that account/provider.
The encrypted format and empty-database restore have real local PostgreSQL drill
coverage. Browser JSON export does not replace disaster-recovery backups.
