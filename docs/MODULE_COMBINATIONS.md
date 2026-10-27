# Account module combinations — Codex, 2026-10-27

New and edited farm accounts offer only:

- Broiler + Distribution (`broiler_distribution`)
- Layers + Distribution (`layer_distribution`)
- All three modules (`all`)

Only the super administrator selects these choices in platform account creation
and editing. Farm owners do not see an Account Modules control and cannot create
platform accounts or change their assigned bundle. The retired owner PATCH route
returns 403 (including requests from older open clients); raw SQL writes to farms
remain forbidden. The server validates platform provisioning/edit against the
three values. Changing a bundle revokes the farm's existing device sessions, so
the next sign-in restores the administrator-assigned navigation. All combinations
retain the owner Overview tools, including banks.
Module navigation, selected-farm context, vaccination and farm reports use one
active-module helper; saved tabs fall back to a module in the selected bundle.
Existing per-module sidebar orders are preserved.

No data migration is required. Existing saved `broiler` and `layer` values open
the corresponding pair; legacy `distribution` opens All three. Legacy values are
accepted when reading existing session metadata, but no longer offered or accepted
by account mutation APIs. This keeps old farm records and sessions readable during
rollout without copying, dropping or relabeling business records. Account module
selection is workspace configuration; existing owner/tenant SQL authorization and
the disabled staff release profile remain unchanged.

Regression coverage includes all three provisioned values, refusal of owner
self-assignment and self-provisioning, super-admin editing/session revocation,
re-login, refusal of standalone choices, paired navigation and legacy fallback.
Live acceptance uses explicitly named Codex QA farms and sample records; test
credentials stay in ignored local operator files and out of the shared artifact.

The owner Farms page still manages physical sites (`farm_units`) within the
assigned account. This is distinct from super-admin farm account creation.

Super-admin-only follow-up validation (2026-10-27): all 90 regression scripts
(~9,965 reported checks), 83 backend tests, 20 administration scenarios, 22
guarded HTTP/PostgreSQL scenarios, 21 browser-session scenarios and 12 actual
sidebar/module-source scenarios pass. Production build passes. The in-app
disposable browser verifies no owner selector, all three super-admin create/edit
options, a saved Layers + Distribution assignment and owner re-login with only
those tabs. No production module assignments are changed by this repair.

The premium static audit reports 33 existing actionless-button findings; all
33 have Angular click handlers (one on the following line). This is a checker
limitation, not a passing static-audit claim. Browser/runtime checks cover the
changed workflow; the audit JSON stays in ignored qa-results.
