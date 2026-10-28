# Broiler + Distribution + Overview acceptance — 2026-10-28

[Codex] Dedicated live QA account: farm 7, `Codex QA - Full Broiler Distribution Audit - 2026-10-27`.
Its assigned bundle is `broiler_distribution`; Overview is included and Layer is
absent. Writes in this audit are confined to this synthetic account. Credentials
are in the ignored local `ops/broiler-audit-account.env`, never in Git or the
shared progress artifact. The physical site is Audit Broiler Site (unit 3), and
the flock is Audit Flock - 100 Birds (flock 2).

## Coverage and expected balances

The in-app browser visited all 36 menu contexts: 14 Broiler, 16 Distribution and
6 Overview. Their populated DOM state showed no visible error notices; captured
browser console errors were empty. Some screenshots caught the loading frame,
so their later populated DOM observations, rather than those images, are the
completion evidence. This is not a claim that every visual state is certified.

Actual checked-in Angular components/services also executed against the live
cookie API, SQL guard, tenant RLS and transaction boundary. This tests real
business methods and persisted results; it does not replace a DOM check of every
button. Ignored local evidence is in
`qa-results/broiler-distribution-audit-20261027/` and the reusable audit harness
is `qa-results/live-audit-lib.mjs`.

| Workflow | Measured result (Rs. unless stated) |
|---|---|
| Unpaid purchase without supplier | Refused; draft retained |
| First unpaid purchase | 20 bags × 1,000 = 20,000; supplier vouchers 6,000 + 14,000 settle payable to zero |
| Broiler inputs | Chicks 10,000; manual feed 3,000; medicine 500; vaccination 300; bank expense 200; bank labour 1,000; independent ledger debit 50 |
| Complete flock | 42 daily health rows; 100 initial birds, 1 mortality, 99 remaining; 5 feed bags; final weight 198 kg; closed 2026-10-27, starting 2026-09-16 |
| Farm-first internal transfer | 2 feed bags × 1,200 = 2,400; only selected farm's flock offered; feed mirror saved on that flock |
| External customer sale | 3 bags × 1,200 = 3,600; initial cash 1,000 + bank voucher 2,600; bill fully settled |
| Broker sale | 39,600; bank receipt 10,000 + direct supplier payment 5,000 + cash receipt 24,600; broker due zero |
| Internal settlement | 2,400 from/to the same house bank clears internal bill without changing bank or cash |
| Other entries | Manual income 300; distribution rent 500; personal bank expense 300; memo debt 700 does not affect cash/profit |
| Assets | 10,000 paid in three installments (2,000 + 3,000 + 5,000); sale 12,000; gain 2,000 |
| Loans | Received 5,000 less 1,000 repayment = 4,000 payable; given 2,000 less 500 recovery = 1,500 receivable |
| Supplier return and reused credit | One bag worth 1,000 returned; supplier credit consumed by a subsequent 1,000 purchase; no fictional cash refund |
| Customer return | One bag returned, 1,200 refunded in cash; external bill now 2,400 total/paid, zero due |
| Final position | Cash **41,700**, own bank **478,100**, stock **21 bags** valued at **21,000** |
| Supplier statement | Purchased 26,000; paid 25,000; returned 1,000; payable **0** |
| Customer statements | Own-farm and external customer cached balance, statement net and bill receivable all **0** |
| Broiler farm report | Revenue **39,900**; costs **17,450**; profit **22,450** |
| Overview | Company profit **24,450**; internal revenue/cost elimination 2,400 each; no calculation warnings |

The client's existing live-weight-per-feed-bag FCR convention is retained: 39.6
for this fixture. Canonical inventory quantity is the sum of batches, not the
legacy `products.current_stock` field. Closing the flock preserved its 42 rows,
cash/bank totals and profit on an independent readback.

## Defects repaired

1. **Current purchase settlement:** Purchase, Supplier Accounts and Distribution
   Report now derive Paid/Part paid/Unpaid/Returned/Settled and paid/returned/due
   amounts from the supplier statement. Unassigned payments consume oldest
   claims by statement date and ledger ID, scoped per supplier. Explicit upfront
   payment settles its own order; other charges, advances, returns, released
   overpayments and broker direct payments are considered. Calculations use
   integer paisa. This is a read-only allocation convention, not a new payment
   linkage. Original `payment_type` remains unchanged so cash/bank is not posted
   twice. Edit selectors say Paid/Unpaid **at purchase**.
2. **Overview per-farm costs:** Broiler and Layer chick costs are now included in
   their per-farm expense grouping. The QA Broiler row previously overstated
   profit by 10,000 while the headline already included that cost.
3. **Correction authorization:** Purchase edits, sales edits (including Save &
   Print), and sales returns now request the existing delete code before invoking
   workflows that replace protected stock/ledger rows. Cancel preserves the
   draft. Stale purchase/bill callbacks are refused. The server's existing
   60-second, session-bound authorization still owns enforcement.
4. **Atomic purchase returns:** Return header, stock deduction/history, purchase
   status and supplier credit now commit together. Every database failure is
   checked. Insufficient linked or legacy FIFO stock rolls back rather than
   silently clamping inventory and over-crediting the supplier. Return success
   feedback is retained after reload.
5. **Supplier statement dates:** New purchase claims use the entered purchase
   date. Date edits update the existing claim and description; changing the
   supplier preserves that date. Previously these paths used today's date.

No schema migration, SQL guard/RLS policy change, DatabaseService signature
change or staff enablement is included. Staff PR #2 remains separate.

## Verification and release record

Meaningful added checks cover purchase allocation (18 scenarios), Overview
Broiler/Layer/tenant/date attribution (11 assertions), actual UI correction
gates and duplicate-save/error recovery (8 scenarios), real PostgreSQL purchase-return rollback/stock behavior
(8 scenarios), and purchase-date corrections (3 scenarios). The existing
Supplier Accounts PostgreSQL screen checks (161) also pass with current status.

The first full run passed 93 of 94 scripts; the remaining new script resolved
its fixture path relative to the runner's working directory. That test harness
path was corrected and its six cases passed. A later run was interrupted by
local memory exhaustion and is not accepted as a release gate. Final successful
suite/build/HTTPS evidence is recorded below.

Final release gate: **95/95 scripts**, approximately **10,002 reported checks**,
237.0 seconds. The final purchase duplicate-save/error-recovery additions also
passed their targeted 8-scenario rerun. Backend **83/83**, final production
build and production CSP shell checks pass. Both permission evidence freshness
checks pass. Authorized purchase and internal-sale corrections against QA farm7
preserved cash 41,700, bank 478,100, stock 21 and supplier payable zero; the
corrected purchase claim date reads 2026-10-27. There were no API errors in that
correction run. Schema remains 013; no operator migration is required.

Limits: one synthetic account/flock, normal sequential writes and targeted
rollback/refusal cases. This does not prove all concurrent financial interleavings,
all report export/print permutations, every keyboard/mobile state, or absence
of defects. The in-app browser connection dropped during the final checks;
post-deployment visual checks and shared Claude artifact synchronization must
be explicitly recorded as pending until the connection is restored.
