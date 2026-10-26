# Browser session verification — Codex, 2026-10-26

The built Angular app was tested in the in-app browser against the real Fastify
session API, migration 004 schema and an attested restricted PostgreSQL login.
All accounts/data were fictional and disposable. The server bound loopback only.
The test server is stopped; a separate database check confirms no browser-QA
schema or role remains. The normal local `.env` and real accounts were unchanged.

## Automated evidence

| Check | Result | Local log |
|---|---|---|
| Full regression suite | 77/77 scripts, approximately 9,811 reported checks | qa-results/verify-browser-session-all.log |
| Backend unit tests | 82/82 | qa-results/backend-browser-session.log |
| Angular build | Passed; existing CommonJS warnings | qa-results/angular-browser-session-build.log |
| Browser source-state tests | 17/17 scenarios; also rerun after UI fixes | scripts/verify/verify_browser_sessions.mjs |
| Guarded HTTP/PostgreSQL | 22/22 scenarios | scripts/verify/verify_guard_http_pg.mjs |
| Static guarded SQL | 501 statements prepared, zero browser-auth SQL | scripts/verify/verify_guard_inventory_pg.mjs |
| Whitespace check | git diff --check passed | terminal |

The full regression count includes inherited/reference checks, source inventory
checks and grouped scenarios. It is not a count of independent end-to-end flows.
The source-state harness transpiles actual services/guards/interceptors with
minimal DI/storage stubs; browser tests separately cover Angular rendering.

## Observed browser flows

- Anonymous `/app/inventory` navigation redirects to login with an internal return URL.
- Empty submission shows associated inline validation and focuses username.
- Wrong credentials show generic failure, retain the visible username and clear
  password. The sign-in action retains its document position and 46px height
  between idle and validation states; focus can scroll the short viewport.
- Password reveal/hide works by click and keyboard, with matching type/pressed
  state; explicit local rendering fixes unreliable deferred updates in this browser.
- Keyboard Enter signs the farm owner in to inventory. The seeded product appears
  through the actual guarded/RLS query path, and reload restores the cookie identity.
- Advancing only the disposable server clock expires the session; the next data
  action clears the business screen and returns to login with the reason/return route.
- Staff reach `/access`, showing a signed-in account and restricted-access guidance.
  No completed staff permissions or admin console is implied.
- Business-layout Logout and access-page Sign out return to login. Reload stays
  signed out. Check sign-in again invokes a new server session check.
- The 546px available document width has no horizontal overflow on login. Short
  viewport content scrolls vertically; the global computed scrollbar colors match
  runtime tokens. Wider business-screen responsive behavior is outside this change.
- Final browser console error inspection returned no entries.

Screenshots: `qa-results/codex-browser-cookie-inventory.png`,
`codex-browser-session-expired.png`, `codex-browser-staff-access.png`,
`codex-browser-signed-out.png` and `codex-artifact-browser-sessions.png`.
The expiry/staff screenshots precede final spacing/busy-render polish; the final
build repeats owner sign-in/reload, reveal/hide, credential failure, staff entry
and both logout paths. Offline logout, cross-tab changes and stale races are
automated source-state checks, not claimed as manual browser coverage.

## Static design tools

Official `designmd lint DESIGN.md`: **0 errors, 6 warnings, 1 informational**.
The six warnings are orphaned color tokens: component declarations use empty
frontmatter maps with their runtime mapping defined in prose. The colors are
actually consumed by shared auth CSS; this is not a zero-warning lint result.

The premium strict audit exits 1 with four `affordance.actionless-button`
findings. Its handler detector does not recognize Angular `(click)` bindings.
All four are reviewed false positives; the raw JSON is preserved at
`qa-results/browser-auth-premium-audit.json`, rather than rewritten as a pass.

| Flagged button | Actual Angular action | Verification |
|---|---|---|
| Access Sign out | `(click)="logout()"` | Actual browser server logout/reload |
| Retry sign-out | `(click)="retryLogout()"` | Handler awaits AuthService.logout; offline/retry state covered by source-state test |
| Check sign-in again | `(click)="restore(true)"` | Actual browser session-check retry |
| Password reveal | `(click)="toggleVisibility()"` | Actual browser click/keyboard type and pressed-state checks |

This review covers the changed authentication surfaces only. It does not certify
legacy native dialogs, business-screen layout/accessibility, device/zoom coverage
or the outstanding staff/admin/operations controls. Production startup stays blocked.
