# Farm screen audit — 2026-10-26

Follow-up: the three findings below have been repaired and passed local checks;
read `SCREEN_FIXES.md` for current rollout/verification evidence. The original
audit observations are retained as the before-state.

[Codex] Checked all 50 business menu contexts in the signed-in production farm account, plus Staff & Security. **The app is not fully cleared: the owner dashboard fails under production database latency.** The other 49 menu contexts render their observed empty/prerequisite states; this is not a claim that all operations on those screens have passed.

Production: https://farminfantary-web-production-c687.up.railway.app . Baseline main: cdd22b5. No application code or deployment was changed during this audit. No production business records, credentials, module settings or permissions were saved or deleted. The live account has no physical farms, flocks or batches, so dependent entry screens cannot be fully exercised there.

## Findings, in repair order

1. **P1 — Owner dashboard returns incomplete totals.** Reproduced twice in the live UI: repeated “Consolidation query failed: Database capacity is unavailable.” The first capture also includes failures deriving cash/bank figures. Zero values displayed alongside these warnings must not be treated as validated balances. Source launches 39 reads together in OverviewService.getSummary; the session executor admits at most eight active operations and rejects overflow immediately. An isolated diagnostic executing the actual frontend service against a simulated eight-slot database produced 39 requests, eight active, 31 rejected, 31 warnings. This supports burst concurrency as the cause; it is not a measurement of production's exact request timing. A fast local PostgreSQL fixture succeeds, explaining why parity checks missed the production failure. **Next action:** add bounded request scheduling/backpressure, preserve session-change cancellation and transaction/result contracts, then rerun latency/concurrency tests and the live dashboard before deploying the repair. Do not simply remove the server capacity boundary.
2. **P2 — Narrow pane clips actions.** At the measured 561px in-app viewport, Inventory's fixed sidebar leaves insufficient room and the Add Product action is partly clipped. The same page at measured 1280px shows the header actions correctly. Provide usable responsive navigation/header wrapping and check at narrow widths. This audit did not certify every mobile breakpoint.
3. **P3 — Layer Income asks for a flock when no batch is selected.** The empty screen uses Broiler wording because its module getter defaults to Broiler without a selection. With an actual Layer batch, the correct Layer income loads and excludes Broiler income with the same numeric scope ID. This is a confirmed wording issue, not evidence of module data mixing.

Follow-up usability observation: Broiler/Layer Labour permits opening Add Payment without a scope while the body asks for a selection. The draft was cancelled; no unscoped save was attempted, so a data-integrity defect is not claimed. Keyboard-only navigation, contrast and screen-reader behavior are not certified by this visual audit.

## Additional functional evidence — disposable local farm only

The isolated stack uses actual migrations 001–007, cookie sessions, the SQL guard, tenant RLS and a restricted PostgreSQL runtime role. Synthetic data and diagnostic logging are confined to the disposable stack at 127.0.0.1:4301. Production data was never copied into it.

- Broiler income: created 125, edited it to 150, refreshed, and verified the persisted total changed from 500 to 650.
- Layer batch ID 1 shows its own 800 income while Broiler flock ID 1 shows 650. The colliding IDs remain separated.
- Saved 100 eggs, all medium, and confirmed Layer Report shows one record/100 eggs and Layer income 800.
- Inventory rejects a product without a category. Created a category, then a product with stock 2, cost 100, selling price 120 and one automatic expiry batch.
- Saved a customer bill for two QA Feed units at 550 each: total 1,100, received 500, outstanding 600. Inventory fell from 12 to 10 units and Account Ledger showed 600 outstanding.
- Saved cash receipt RV-001 for 200. The voucher list showed 200 and Account Ledger outstanding fell to 400.
- Owner debt memo saved for 50; Got back filter correctly excluded the still-owed record. This module is explicitly reference-only.
- Local Overview initially showed Broiler 500 + Layer 800 = 1,300 and the seeded owner bank 10,000. After income edits and receipts, its observed cash was 2,150 and profit 1,150 under the app's existing collected-revenue/COGS rules. Fast-local success does not resolve the live capacity failure.

Fresh regression evidence: **85/85 verification scripts passed**, approximately 9,894 reported checks, 113.6 seconds. No failed business API result was recorded by the disposable fixture across the sampled browser workflows; cleanup verification is recorded separately in the local evidence folder. These tests do not cover every screen's full create/edit/delete/return/print combinations. Destructive confirmations, staff access, all report PDFs and all bank/purchase/settlement permutations were not exercised in this audit. Staff being disabled matches the approved owner-only first release.

## Screen-by-screen live result

“Loads” means the screenshot and visible DOM reached the recorded state after loading. It does not establish complete write/financial correctness. Each numbered item has a local screenshot in the evidence gallery. There are 14 Broiler, 15 Layer, 15 Distribution and six Overview contexts.

1. **broiler — Flock Health:** LOADS — observed empty/prerequisite state. Expected scope prerequisite: select or create a flock. No live records changed. Evidence: `01-broiler-flock-health.png`.

2. **broiler — Expenses:** LOADS — observed empty/prerequisite state. Check the no-flock prerequisite and navigation. Evidence: `02-broiler-expenses.png`.

3. **broiler — Ledger Accounts:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; no financial writes attempted. Evidence: `03-broiler-ledger.png`.

4. **broiler — Medicine:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; navigation works. Evidence: `04-broiler-medicine.png`.

5. **broiler — Feed:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; navigation works. Evidence: `05-broiler-feed.png`.

6. **broiler — Chicks:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; navigation works. Evidence: `06-broiler-chicks.png`.

7. **broiler — Labour:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; navigation works. Add Payment opens a form despite the missing scope; cancelled without saving (prerequisite affordance risk). Evidence: `07-broiler-labour.png`.

8. **broiler — Vaccination Schedule:** LOADS — observed empty/prerequisite state. Check empty state and creation affordance without a selected flock. Evidence: `08-broiler-vaccination.png`.

9. **broiler — Sale:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; no sale submitted. Evidence: `09-broiler-sale.png`.

10. **broiler — Income:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; no financial writes attempted. Evidence: `10-broiler-income.png`.

11. **broiler — Report:** LOADS — observed empty/prerequisite state. Expected no-flock prerequisite; report totals require disposable populated coverage. Evidence: `11-broiler-report.png`.

12. **broiler — Farm Report:** LOADS — observed empty/prerequisite state. Report loading completed; empty account report and generation controls inspected. Evidence: `12-broiler-farm-report.png`.

13. **broiler — Flock Management:** LOADS — observed empty/prerequisite state. Check empty flock list and creation entry point without creating production records. Add Flock correctly refuses until a physical farm is created and displays guidance. Evidence: `13-broiler-flocks.png`.

14. **broiler — Farms:** LOADS — observed empty/prerequisite state. Farm list finishes loading; account module selector is All Modules. No settings were saved. Add Farm exposes name/location/notes/opening-balance fields and cancels cleanly. Evidence: `14-broiler-farms.png`.

15. **layer — Batch Management:** LOADS — observed empty/prerequisite state. Layer switch completes at Batch Management; correct Layer-specific farm prerequisite is shown. Add Batch shortcut correctly gives the missing-Layer-farm prerequisite. Evidence: `15-layer-batches.png`.

16. **layer — Daily Egg Collection:** LOADS — observed empty/prerequisite state. Expected no-batch prerequisite; navigation works. Evidence: `16-layer-egg-collection.png`.

17. **layer — Egg Sales:** LOADS — observed empty/prerequisite state. Expected no-batch prerequisite; no sale submitted. Evidence: `17-layer-egg-sales.png`.

18. **layer — Hen Sales:** LOADS — observed empty/prerequisite state. Expected no-batch prerequisite; no sale submitted. Evidence: `18-layer-hen-sales.png`.

19. **layer — Medicine:** LOADS — observed empty/prerequisite state. Shared medicine screen correctly requires a Layer batch. Evidence: `19-layer-medicine.png`.

20. **layer — Feed:** LOADS — observed empty/prerequisite state. Shared feed screen correctly requires a Layer batch. Evidence: `20-layer-feed.png`.

21. **layer — Vaccination Schedule:** LOADS — observed empty/prerequisite state. Check Layer vaccination batch prerequisite and correct module context. Evidence: `21-layer-vaccination.png`.

22. **layer — Labour:** LOADS — observed empty/prerequisite state. Layer labour empty state; Add Payment is available without a batch (same prerequisite-affordance issue as Broiler). Evidence: `22-layer-labour.png`.

23. **layer — Flock Health:** LOADS — observed empty/prerequisite state. Correct Layer health screen and missing-batch prerequisite. Evidence: `23-layer-flock-health.png`.

24. **layer — Layer Expenses:** LOADS — observed empty/prerequisite state. Layer-specific expenses route shows the expected batch prerequisite. Evidence: `24-layer-expenses.png`.

25. **layer — Ledger Accounts:** LOADS — observed empty/prerequisite state. Layer ledger route mounts and requires a batch; no financial writes. Evidence: `25-layer-ledger.png`.

26. **layer — Income:** LOADS — incorrect empty-state wording. Layer Income mounts, but its empty-state copy incorrectly asks for a flock rather than a batch. Evidence: `26-layer-income.png`.

27. **layer — Layer Report:** LOADS — observed empty/prerequisite state. Layer Report renders an empty section-selection summary with zero records; populated PDF behavior remains to be tested. Evidence: `27-layer-report.png`.

28. **layer — Farm Report:** LOADS — observed empty/prerequisite state. Check the Layer-specific whole-farm report, loading and empty totals. Evidence: `28-layer-farm-report.png`.

29. **layer — Farms:** LOADS — observed empty/prerequisite state. Shared physical-farm page identifies the Layer module and lists its empty state. Evidence: `29-layer-farms.png`.

30. **distribution — Inventory Management:** LOADS — narrow-pane clipping. Inventory finishes loading with an empty product list, search and add controls. At the 561px in-app pane, the fixed sidebar leaves Add Product partly clipped; desktop verification follows. Evidence: `30-distribution-inventory.png`.

31. **distribution — Purchase Orders:** LOADS — observed empty/prerequisite state. Purchase list loads; creation controls present; no production record saved. Evidence: `31-distribution-purchase.png`.

32. **distribution — Purchase Returns:** LOADS — observed empty/prerequisite state. Purchase Returns renders zero purchases and returns, with a usable empty table. Evidence: `32-distribution-purchase-returns.png`.

33. **distribution — Sales Orders:** LOADS — observed empty/prerequisite state. Sales Orders empty list loads; New Bill is enabled. Evidence: `33-distribution-sales-orders.png`.

34. **distribution — Sales Returns:** LOADS — observed empty/prerequisite state. Sales Returns renders the empty returns list. Evidence: `34-distribution-returns.png`.

35. **distribution — Customer Management:** LOADS — observed empty/prerequisite state. Customer list and Add Customer control load. Evidence: `35-distribution-customers.png`.

36. **distribution — Supplier Management:** LOADS — observed empty/prerequisite state. Supplier list loads; no production data saved. Evidence: `36-distribution-suppliers.png`.

37. **distribution — Labour Management:** LOADS — observed empty/prerequisite state. Labour management empty list and add control load. Evidence: `37-distribution-labour.png`.

38. **distribution — 📊 Account Ledger:** LOADS — observed empty/prerequisite state. Account Ledger loads zero customer/supplier/bank totals and navigation cards. Evidence: `38-distribution-account-ledger.png`.

39. **distribution — 🏭 Supplier Accounts:** LOADS — observed empty/prerequisite state. Supplier Accounts empty balances and account view inspected. Evidence: `39-distribution-supplier-accounts.png`.

40. **distribution — 💳 Expense Ledger:** LOADS — observed empty/prerequisite state. Expense Ledger loads zero totals, date filters and categories; print correctly disabled for no entries. Evidence: `40-distribution-expense-ledger.png`.

41. **distribution — 🗂️ Distribution Report:** LOADS — observed empty/prerequisite state. Distribution report loads its financial summaries, section choices and PDF controls. Evidence: `41-distribution-report.png`.

42. **distribution — Receive Voucher:** LOADS — observed empty/prerequisite state. Receive Voucher screen load and validation controls inspected without saving. Evidence: `42-distribution-receive-voucher.png`.

43. **distribution — Payment Voucher:** LOADS — observed empty/prerequisite state. Payment Voucher loads; new voucher disabled until suppliers or labour exist. Evidence: `43-distribution-payment-voucher.png`.

44. **distribution — Internal Settlement:** LOADS — observed empty/prerequisite state. Internal Settlement loads empty-state guidance; New Settlement disabled until an own-farm customer exists. Evidence: `44-distribution-internal-settlement.png`.

45. **owner — Overview Dashboard:** FAIL — capacity errors. FAIL: repeated Database capacity is unavailable warnings; totals are incomplete. Reproduced on a second visit. Evidence: `45-owner-dashboard.png`.

46. **owner — Assets:** LOADS — observed empty/prerequisite state. Assets renders an empty list; Print disabled and Add Asset available. Evidence: `46-owner-assets.png`.

47. **owner — Personal Expenses:** LOADS — observed empty/prerequisite state. Personal Expenses loads date filters; Add Entry disabled until a category exists. Evidence: `47-owner-personal-expenses.png`.

48. **owner — Loans & Advances:** LOADS — observed empty/prerequisite state. Loans & Advances loads zero balances and Money Received/Loan Given controls. Evidence: `48-owner-loans.png`.

49. **owner — Debt Payment:** LOADS — observed empty/prerequisite state. Debt Payment loads memo guidance and status/search filters. Evidence: `49-owner-debt-payment.png`.

50. **owner — Bank Accounts:** LOADS — observed empty/prerequisite state. Bank Ledger renders no bank accounts; Add Bank Account available. Evidence: `50-owner-bank.png`.

51. **Staff & Security:** loads; zero active staff/zero seats, staff creation/access disabled, delete-code setup shown. No security setting was changed. Evidence: `51-staff-security.png`.

## Local evidence and scope

Evidence gallery: `qa-results/farm-screen-audit-20261026/index.html`. It contains all 50 live screenshots, the Staff & Security screen, a second live dashboard failure, the desktop Inventory comparison, and 14 populated workflow captures. JSON journals retain visible headings, body text, URLs and viewport measurements. The folder is ignored by Git and includes the farm's display name; it is not uploaded to the shared progress artifact.

Only this audit's captures support these findings. Transient loading captures were replaced before accepting final screen evidence. Switching module tabs can briefly show the previous component while navigation/data refresh finishes; that transient state is not counted as a final data-mixing failure.
