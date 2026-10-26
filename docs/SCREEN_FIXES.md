# Screen reliability repairs — 2026-10-26

[Codex] Addresses the three findings in `FARM_SCREEN_AUDIT.md`.

The shared HTTP bridge now admits four active database posts and up to 128
waiting operations. This prevents the Overview dashboard's 39 simultaneous
reads from overflowing the server's eight-operation boundary. The queue captures
the original payload, cancels waiting operations when identity changes, discards
late old-session results and never retries a mutation. Active transports have a
45-second deadline. Server capacity, SQL authorization, tenant policies and
transaction contracts remain in force; this is not an offline queue.

At widths up to 768px, the sidebar starts as a 60px rail. Its named native button
expands a drawer and choosing a screen closes it. Menu, sign-out and export
controls have accessible names; Inventory header actions wrap and its search
field can shrink. The Layer/Broiler shared Income empty state now asks for a
flock or batch without changing the SQL module discriminator.

Validation:

- 86/86 verification scripts, approximately 9,899 reported checks; 83/83 backend
  tests; production build and generated-shell checks pass.
- Five new scheduling regressions execute actual frontend source: the 39-query
  Overview under latency, immutable queued mutation values/order, identity reset,
  failure/slot recovery without retries, and bounded queue cancellation.
- All 50 business menu contexts opened against disposable PostgreSQL with an
  added 20ms delay on each runtime query. No failed business API results or
  visible capacity/guard errors were recorded in those navigation checks.
- The slow-database dashboard shows the seeded 1,300 income/cash and 10,000 bank
  balance without warnings. A new 25 income entry survives refresh, total 525.
- Inventory has no document overflow at measured widths 561 and 390; both header
  actions fit. Keyboard Enter expands navigation and choosing Purchase closes it.
- Generated permission metadata/observations were refreshed after the navigation
  source changed. The same 50 keys remain; staff SQL is still disabled.

Reviewed source digest:
`e4d91ede9d913e7c1d180757cf422aadafec2a8bd7e2c7fd8383b40b270907ca`.
Review: Codex self-review under the user's D17 instruction. This is not an
independent security review. Railway/live verification is recorded below when
completed. Local evidence: `qa-results/screen-fixes-20261026/` and
`qa-results/screen-fixes-*` logs.

The existing full business regressions cover more financial permutations than
the browser samples; these checks still do not certify every possible record,
device, simultaneous-user load or create/edit/delete/print combination. Staff
business access and per-farm import remain outside the approved first release.
