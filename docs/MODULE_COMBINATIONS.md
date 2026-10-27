# Account module combinations — Codex, 2026-10-27

New and edited farm accounts offer only:

- Broiler + Distribution (`broiler_distribution`)
- Layers + Distribution (`layer_distribution`)
- All three modules (`all`)

Platform administration and the account's Farms selector share these choices.
The server validates both provisioning/edit and owner updates against the same
three values. All combinations retain the owner Overview tools, including banks.
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

Regression coverage includes all three provisioned values, owner changes and
re-login, refusal of standalone choices, paired navigation and legacy fallback.
Live acceptance uses explicitly named Codex QA farms and sample records; test
credentials stay in ignored local operator files and out of the shared artifact.
