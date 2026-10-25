# Landmines — index

`Talha Farm/CLAUDE.md` holds 42 documented landmines across ~115 KB. Each one is
a rule someone learned by breaking something, and most explain why a query looks
the way it does.

**Read it by line, never whole.** Find your topic below, then:

```bash
sed -n '451,470p' "Talha Farm/CLAUDE.md"     # read one landmine
grep -n "bank_ledger" "Talha Farm/CLAUDE.md" # find by symbol
```

Reading the file end to end costs more context than almost any task justifies.

---

## Platform & data integrity

| Line | Rule |
|------|------|
| 102 | Migrations run on **every launch** — anything added must be idempotent |
| 106 | The `vaccinations` rebuild is **FIXED** — do not re-diagnose it as live |
| 126 | A separate `SELECT last_insert_rowid()` **always returns 0** — use `run()`'s `lastId` |
| 145 | Foreign keys are declared but **not enforced** (~50 clauses) |
| 151 | `flock_id` and `batch_id` **collide** — every cascade needs a `module_type` guard |
| 190 | Transactions do exist — use one for any multi-step write |
| 273 | Dates: the renderer is converted to local time, the main process is not |
| 287 | Cross-screen invalidation: three entities must `announce()` |
| 1037 | A read that names its columns can silently drop one |

## Broiler

| Line | Rule |
|------|------|
| 221 | Expenses and ledgers are **independent books** — do not reconnect them |
| 341 | Deleting a worker keeps their `labour_payments` — never INNER JOIN |
| 350 | `flock_health.week_number` is misnamed — it holds a 1-based **day** index |
| 353 | FCR has exactly one implementation: `latestFlockFcr()` |
| 1154 | Chicks are their own table and screen, like feed and medicine |

## Layer

| Line | Rule |
|------|------|
| 388 | `layer_mortality` is **frozen, not live** |
| 394 | `egg_collection.total_eggs` always holds the true egg count, never cartons |

## Money, banking, settlement

| Line | Rule |
|------|------|
| 423 | Own-farm sales are real sales; elimination lives in exactly one place |
| 442 | `bank_accounts.customer_id` is the house/customer split, nullable on purpose |
| 451 | Anything paid by bank **must** write a `bank_ledger` entry — and un-making it must remove it |
| 469 | Twelve tables are bank-sourced; ten go through `BANK_SOURCES` |
| 588 | A personal expense is editable; its withdrawal is reversed-and-re-posted |
| 601 | Selling an asset brings money in, and it now lands somewhere |
| 629 | The settlement a sale writes needs an **explicit** payment source |
| 639 | A customer's balance derives from `bills`, **not** `customer_ledger` |
| 675 | The settlement has exactly one implementation in each direction |
| 699 | Receive/Payment Vouchers are shortcuts — never a second book |
| 727 | An internal settlement can write **zero** bank entries, and that is the point |
| 798 | No save may take a bank account below zero — tested as a **net delta per account** |
| 860 | Cash in hand is derived; `bills.amount_paid` counted once, bank part taken back |
| 1086 | A loan is never income and never an expense |
| 1301 | A bank sale can clear own-farm debt, and the bank still moves by the sale alone |

## Distribution

| Line | Rule |
|------|------|
| 1008 | The from/to filter on the two ledger statements narrows rows and nothing else |
| 1050 | A purchase order **requires** a supplier |
| 1139 | The two outstanding cards on the Distribution Report reuse one definition each |
| 1200 | A stock batch number is **typed by the client**, not generated |
| 1230 | A product that has been traded **cannot** be deleted |
| 1251 | Supplier Ledger and Supplier Accounts are siblings — do not merge |
| 1287 | `supplier_ledger` has a `notes` column, and `description` is not it |

## Other

| Line | Rule |
|------|------|
| 574 | No verify script sees a template — a column added to SQL is checked, one added to a template is not |
| 1059 | `debt_records` is a notebook connected to nothing — do not wire it in |
| 1188 | An "Add …" sidebar item is a shortcut onto an existing screen |
| 1217 | Every drill-down under Account Ledger has a back link at its list level |

---

## Which of these survive the conversion

Most describe business rules and carry over untouched. These change:

| Line | Change |
|------|--------|
| 102 | Migrations become numbered, forward-only, advisory-locked — not per-launch |
| 106 | Becomes a one-time numbered migration |
| 126 | `lastId` comes from `RETURNING` instead |
| 145 | Stays true — we deliberately create **no** FK constraints (`db/CLAUDE.md`) |
| 190 | Transaction mechanism replaced; `runBatch` preferred (`server/CLAUDE.md`) |
| 273 | Resolved — one process, dates stay `TEXT` |

Line numbers are against `Talha Farm/CLAUDE.md` as committed. That file is
frozen, so they stay valid.
