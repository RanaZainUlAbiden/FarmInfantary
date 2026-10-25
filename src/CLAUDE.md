# src/ — Angular 19 SPA

Same paths as the desktop app on purpose: `src/app/shared/services/database.service.ts`
is that path in both. Keeps `docs/LANDMINES.md` references and the verify scripts valid.

Populated in **Phase 2** by copying `Talha Farm/src/app/` across. Until then the
screen folders are absent by design — don't scaffold fake ones.

## The swap point

`shared/platform/` is the only code that knows data arrives over HTTP.

```
platform-api.ts        interface — mirrors window.electronAPI exactly
http-platform-api.ts   the implementation
platform.token.ts      DI token
```

`DatabaseService` depends on the interface, nothing else. **Its public method
signatures are frozen** — 341 call sites depend on them, and keeping them means
no screen changes during the port.

## Preserve these exactly

- **Errors never throw.** `get()`/`run()` return `{ success: false, error }`.
  Every call site checks `.success`. If HTTP rejects on a 500, error handling
  across the whole app silently changes shape. Catch transport and SQL errors
  and translate them into the same result objects, keeping the friendly-error
  mapping from `sql-error.util.ts`.
- **`lastId`** comes from the write itself, via `RETURNING` server-side.
- **`$lastId` batch back-references.** `{ $lastId: n }` in a params array is
  replaced with the id inserted by operation `n` of the same batch; negative `n`
  counts back, so `{ $lastId: -1 }` is "the row the previous statement inserted".
  54 call sites rely on this, negative indexing included.

`NgZone.run()` wrappers in `DatabaseService` are redundant once calls go through
`HttpClient`, which already runs in the zone. **Leave them.** Removing plumbing
across 5,638 lines during a platform migration adds risk for no benefit.

## What changes in Phase 2

| File | Change |
|------|--------|
| `shared/services/database.service.ts` | Body swapped to `PlatformApi`; signatures untouched |
| `shared/services/auth.service.ts` | Rewritten for server sessions |
| `shared/services/license.service.ts` | **Deleted** |
| `shared/utils/print-report.util.ts` | Browser print; `doc.save()` fallback already exists |
| `app.routes.ts` | Activation route removed, guards added |
| `app.config.ts` | `provideHttpClient` + interceptors |
| everything else | untouched |

21 components call `electronAPI.printPdfBase64` directly. That is the only
component-level edit the port needs.

## New in Phase 3/4

- `shared/guards/` — auth and permission route guards.
- `shared/services/permission.service.ts` — the user's grants.
- `app/admin/` — super admin console. Talks to `/api/admin/*`, **never** the SQL
  pipe.

Sidebar filtering and route guards are **usability, not security**. A staff
member can still issue any statement the endpoint accepts; the SQL guard is the
control.

## Client state

`localStorage` (64 uses) and `sessionStorage` (11) work unchanged, but are now
per-browser rather than per-machine. `AuthService.logout()` clears eleven
specific keys and resets `FlockService` and `FarmUnitService` deliberately —
those are root providers that survive navigation. Review that list against the
new user model: stale ids now leak between *users*, not just accounts.

## Splitting database.service.ts

5,638 lines makes every session that touches it expensive. Splitting it into
domain modules behind the same facade is worth doing — but the verify scripts
**lift method bodies out of it as text**, so the split must re-point them in the
same change. Phase 1 task, coordinated, not opportunistic.
