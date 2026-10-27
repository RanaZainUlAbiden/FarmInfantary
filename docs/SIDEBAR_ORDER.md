# Personal sidebar ordering — Codex, 2026-10-27

Expanded Broiler, Layers and Distribution navigation rows have six-dot handles.
Drag vertically to rearrange, use ArrowUp/ArrowDown on the handle, or click it for
Move up/down buttons. Changes save immediately after each completed move. The
active screen stays open. Escape, pointer cancellation and drops outside the
sidebar list cancel a drag. A bounded scroll loop supports long menus.

Each user has an independent order per module, persisted on the server and loaded
again after sign-in, reload or a device change. Add Batch and Batches are distinct
presentation entries. Unknown/deleted stored links are ignored, duplicates collapse,
and newly added current links append. Fixed actions and Overview are not reordered.
Collapsed navigation remains usable; expand it to rearrange.

Migration 013 adds a bounded API-owned JSONB presentation field to private users.
The existing auth metadata role already owns access to that table; no new grants,
tables, security definers or business-runtime access are introduced. Dedicated
GET /api/account/sidebar-order and PUT /api/account/sidebar-order/:module require
the current farm owner identity, trusted origin/context, rate limits, allowed
module/current route keys and matching live user/farm/auth version. Client IDs
cannot select another user. Atomic jsonb_set preserves concurrent changes in
different modules. For concurrent edits to the same module, the last saved order
wins. These preferences do not grant staff permissions or alter tenant SQL policy.

Saving disables duplicate moves. Failure retains the visible arrangement with an
explicit retry, without automatically replaying the write. Failed loading leaves
navigation operational and disables reordering until the user retries. Responses
from prior identities are discarded. Personal order is never an identity source.

Verification executes actual frontend methods for restoration, new/removed links,
keyboard/pointer movement, cancellation, pending/failure/retry and stale identity;
restricted auth/runtime PostgreSQL tests exercise personal/module isolation,
re-login/second device persistence, validation, concurrent module saves, revocation
and denied browser SQL. Browser proof uses disposable accounts, not production
financial records. Staff business access remains a separate unfinished draft.
