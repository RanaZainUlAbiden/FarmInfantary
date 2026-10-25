# Talha Farm

Poultry farm management desktop app. Angular 19 (standalone components, no NgModules) rendered
inside Electron 34, persisting to a SQLite file via **sql.js** (SQLite compiled to WASM).

## Build & run

```bash
ng build                      # Angular -> dist/Poultry-Farm/browser
npm run electron              # ng build && electron .
npm run electron:dev          # electron . only (reuses existing dist/)
npm run electron:build:win    # build + electron-builder --win --x64 -> release/
```

`main.js` loads `dist/Poultry-Farm/browser/index.html` from disk — there is no dev-server wiring,
so **the Angular build must be current before launching Electron**. `ng serve` alone gives you a
renderer with no `window.electronAPI`, so nothing loads.

The DB file lives at `app.getPath('userData')/sng_farm.db`, not in the repo.

## Architecture

```
electron/main.js       owns the app lifecycle + every ipcMain handler; also holds
                       licensing, auto-backup-on-quit, backup/restore, PDF print
electron/database.js   sql.js init, full schema (createTables), migrations,
                       runQuery/getQuery, plus a large set of helper query functions
electron/preload.js    contextBridge -> window.electronAPI  (the ONLY renderer<->main bridge)
src/app/shared/services/database.service.ts
                       Angular wrapper over window.electronAPI; every call is
                       resolved inside NgZone.run() so change detection fires
```

The main process owns the database. The renderer has no direct DB access; `contextIsolation: true`
and `nodeIntegration: false`. Anything new the renderer needs must be added in **all three** places:
an `ipcMain.handle` in `main.js`, a method on the `contextBridge` object in `preload.js`, and a
wrapper in `database.service.ts` (plus the `Window.electronAPI` interface declared at its top).

### SQL goes over the wire

There is no ORM and no repository layer. The renderer builds **raw SQL strings** and ships them to
`db-run` / `db-get`. Components call `this.db.run(sql, params)` and `this.db.get(sql, params)`
directly, all over the app.

- Always use `?` placeholders and pass values in the params array. Never string-interpolate values
  into SQL — the renderer is fully trusted by the main process, so an interpolated value is a real
  injection into the user's data.
- `get()` returns `{ success, data: rows[] }`; `run()` returns `{ success, lastId }`. Check
  `.success` — errors come back as `{ success: false, error }`, they do not throw.
- Every `runQuery` writes the whole DB back to disk with `db.export()` + `writeFileSync`. Writes are
  therefore expensive; avoid per-row loops of `run()` where one statement will do.
- `lastId` for INSERTs uses `last_insert_rowid()` with a `MAX(pk)` fallback driven by
  `PRIMARY_KEY_MAP` in `database.js`. Add new tables to that map or `lastId` comes back `null`.
  **Take the id from the `run()` result and never from a separate
  `SELECT last_insert_rowid()`** — see the landmine below; that round trip always returns 0.

## Multi-tenancy and module scoping

`farms` is the **login account**, not a physical farm. Login is farm_name + password against
`farms` (`auth.service.ts`), and the row is cached in `localStorage.currentFarm`. Nearly every table
carries a `farm_id` — **every query must filter by it**, or one account sees another's data.

`farms.business_type` is `'broiler' | 'layer' | 'distribution' | 'all'`. It drives which sidebar menu
`layout.component.ts` renders; when it is `'all'`, the layout shows business tabs and switches
menus off `activeBusinessTab` (both persisted in `localStorage`).

Scoping differs per module — this is the main thing to get right:

| Module       | Scope key                          | Core tables                                                  |
|--------------|------------------------------------|--------------------------------------------------------------|
| Broiler      | `currentFlock.flock_id` (`flocks`) | expenses, ledgers, sales, income, balance, flock_health, brokers |
| Layer        | `batch_id` (`batches`)             | egg_collection, egg_sales, hen_sales, layer_health, layer_ledgers, vaccinations |
| Distribution | `farm_id`                          | products, product_batches, purchase_orders, sales_orders, bills, customers, suppliers, *_ledger |

`FlockService` (`currentFlock$`, backed by `localStorage.currentFlock`) holds the active
flock **or** batch; a batch is distinguished by the presence of `batch_id` on the object.

Shared tables (`feed_*`, `medicine_*`, `labour_payments`, `income`, `expenses`, `balance`, `sales`)
all carry a `module_type` column, and they reuse the **`flock_id` column to hold a `batch_id` when
`module_type = 'layer'`**. (Layer actually writes the first five; `balance` and `sales` are
broiler-only in practice but carry the column.) Filtering by `flock_id` alone silently mixes broiler
and layer rows — always pair it with `module_type`. See `shared/resolvers/medicine.resolver.ts` for
the pattern.
**This applies to `DELETE` exactly as much as to `SELECT`** — see the landmine below, which is the
one that was actually destroying data.

On reads the two sides use the same complementary tests as the deletes: broiler is
`COALESCE(module_type,'broiler') = 'broiler'`, layer is a strict `module_type = 'layer'`. A strict
`= 'broiler'` is wrong — it drops the legacy NULL-module rows the backfill cannot resolve (exactly
the colliding ids) and makes that screen disagree with `overview.service.ts` /
`farm-report.service.ts`, which both COALESCE.

**A screen and its resolver must run the identical query.** They are two code paths onto one screen
— resolver on arrival, the component's own `loadData()` on a flock switch — so any drift between
them shows up as the same screen reporting two different sets of totals depending on how you got
there. That is what the Report screen was doing, and why it now has **no resolver at all**: it
loads through `loadData()` in `ngOnInit` like every other path. Prefer that shape for any screen
whose totals matter.

## Known landmines — do not repeat these

- **Migrations run on every launch.** `initializeDatabase()` in `electron/database.js` loops an
  `alterStatements` array with `try { db.run(sql) } catch(e) {}`. Duplicate-column errors are how it
  detects "already applied". Any statement added there **must be idempotent and safe to re-run**,
  because it will execute on every single app start.
- **The `vaccinations` rebuild is FIXED — do not re-diagnose it as live.** It once sat unguarded in
  `alterStatements`, re-running on every launch with a hardcoded 7-column `INSERT...SELECT` that
  dropped `flock_id`, `cost`, `bill_id` and `bill_number` each time. It now lives in
  `migrateVaccinationsNullableBatchId()` (`electron/database.js`), and three things hold it down:
  an `app_settings` flag (`migration_vaccinations_nullable_batch_v1`) that returns early once set; a
  `PRAGMA table_info` check so it only rebuilds a table whose `batch_id` is still `NOT NULL` (on a
  current schema it just sets the flag); and an `INSERT...SELECT` whose column list is computed from
  PRAGMA and intersected with all 11 columns, so a future column cannot be forgotten. It also folds
  a leftover `vaccinations_old` back in, for a run that died between the RENAME and the DROP.
  **`vaccinations.flock_id` is therefore reliable, and queries may filter on it.**

  One remnant survives: a database that ran the OLD rebuild still holds rows stripped back then,
  with **both `flock_id` and `batch_id` NULL**. Nothing reaches them — not the broiler flock delete
  (`WHERE flock_id = ?`), not the layer batch delete (`WHERE batch_id = ?`), and no screen lists
  them. Count them with
  `SELECT COUNT(*) FROM vaccinations WHERE flock_id IS NULL AND batch_id IS NULL`. They are
  unattributable, so there is nothing to restore them from; clean-up would be a deliberate one-shot.

  The general lesson stands: never put a RENAME → CREATE → `INSERT...SELECT` → DROP rebuild in
  `alterStatements`. Only ALTER-style statements survive running on every launch.
- **A SEPARATE `SELECT last_insert_rowid()` ALWAYS RETURNS 0. Use the `run()` result's `lastId`.**
  `runQuery()` finishes by writing the file through `saveDatabase()` → `db.export()`, and
  `db.export()` closes and re-opens the sql.js connection (the same property `saveDatabase()`
  already documents as the reason it must not run mid-transaction). `last_insert_rowid()` is
  connection state, so on the re-opened connection it is 0 — and a *separate* `db-get` IPC call is
  always on that re-opened connection. `run()` is safe because `executeStatement()` reads the id
  *before* the export, inside the same call.

  Zero is the worst possible wrong answer, because it is falsy: Inventory's new-product save read
  the id that way and guarded the rest on `if (productId)`, so entering 5 units wrote the `products`
  row, silently skipped the `product_batches` and `batch_transactions` writes, and reported success.
  The product read back at zero stock with no batches and nothing on screen to explain it. Present
  since v1.0.0; `scripts/verify/verify_product_opening_stock.js` pins the mechanism and the fix.

  The round trip is now gone from `src/` — the only remaining mentions are that comment and a note
  in `sales-orders.component.ts`, which already worked around it by re-reading the row by a natural
  key. Inside an open transaction the export is skipped, so the round trip would *happen* to work
  there; do not rely on that. `run().lastId` is correct either way, and `{ $lastId: n }` in a
  `runBatch` needs no read at all.
- **Foreign keys are declared but not enforced.** ~50 `FOREIGN KEY` clauses exist in the schema, but
  `PRAGMA foreign_keys = ON` is never issued, so SQLite leaves them off. Nothing cascades, including
  the `ON DELETE CASCADE` on `bill_items`. Deleting a parent row leaves orphans — child rows must be
  deleted explicitly in code (`flock-management.component.ts` and `batch-management.component.ts`
  both do this by hand, in one `runBatch` each).

- **`flock_id` and `batch_id` COLLIDE, so every hand-written cascade needs a `module_type` guard.**
  This is the one that was destroying real data. `flocks.flock_id` and `batches.batch_id` are
  separate `AUTOINCREMENT` sequences that both start at 1, and the ids are **database-wide, not
  per account** — so broiler flock N and layer batch N collide from #1, and need not even belong to
  the same login. Because the shared tables above hold a `batch_id` in their `flock_id` column, an
  unguarded `DELETE FROM expenses WHERE flock_id = ?` while deleting a flock wiped the colliding
  **layer batch's** expenses, income, feed, medicine and labour — across accounts. The same trap
  runs in reverse when deleting a batch.

  The rule: on the shared tables, a delete that scopes by `flock_id` must also test `module_type`.
  The two sides use deliberately **complementary** tests, so every row is claimed by exactly one:

  - broiler side (`flock-management.component.ts`): `COALESCE(module_type,'broiler') = 'broiler'`
  - layer side (`batch-management.component.ts`): `module_type = 'layer'` — strict, NULL excluded

  NULL counts as broiler because that is how the whole app already reads it (`overview.service.ts`,
  `farm-report.service.ts`, `report.component.ts` all use the same `COALESCE`, while every layer
  query demands `'layer'` outright). The backfill in `database.js` can only resolve a NULL when the
  id exists in exactly one of `flocks`/`batches`, so it leaves NULLs behind **precisely on the
  colliding ids** — the very rows at issue. Treating them as broiler deletes what the user actually
  saw on that flock; the alternative strands a row no screen can reach again, on an id that is never
  reissued.

  Which tables actually need the guard, as of now:

  - **Layer writes them today — the guard is load-bearing:** `expenses`, `income`,
    `medicine_traders`, `medicine_entries`, `feed_traders`, `feed_entries`, `labour_payments`.
  - **Carry `module_type` but only broiler writes them:** `sales`, `balance`. Guarded anyway — it
    costs nothing and stops the next layer screen from quietly reintroducing the bug.
  - **No `module_type` column, broiler-only:** `flock_health`, `ledgers`, `ledger_entries`,
    `brokers`. No guard possible or needed.
  - **No `module_type` column, layer-only and keyed on `batch_id`:** `egg_collection`, `egg_sales`,
    `hen_sales`, `layer_health`, `layer_mortality`, `layer_ledgers`, `layer_ledger_entries`. Never
    reachable from a `flock_id` delete.
  - `vaccinations` carries both keys and is told apart by which one is set.

  When adding a screen that writes to a shared table, add its table to **both** deletes. Several
  were missing entirely and silently orphaned rows for years: `brokers` and `labour_payments` on the
  broiler side, `hen_sales` plus all seven shared tables on the layer side.
- **Transactions DO exist — use one for any multi-step write.** Two mechanisms, both real
  `BEGIN`/`COMMIT` in the main process:
  - `db.runBatch([{ sql, params }, …])` (`db-run-batch` IPC → `runBatch()` in `database.js`) runs an
    ordered list atomically and writes the file **once**, not once per statement. A param of
    `{ $lastId: n }` is replaced with the id inserted by operation `n` of the same batch (negative
    counts back from the current one), so chained inserts need no round trip. Use it when no reads
    come in between.
  - `db.transaction(async () => { … })` spans several IPC calls, for a save whose next statement
    depends on reading back what the earlier ones wrote; reads inside it see its own uncommitted
    writes. It rolls back when `work` throws — but `run()`/`get()` report failure in `.success`
    rather than throwing, so **check every result and throw yourself**, or the transaction commits
    happily around a failed write. `sales-orders`, `sales-returns` and `purchase-orders` do exactly
    that through their `assertOk()` helpers. A transaction left open is rolled back by a watchdog
    after a minute, which poisons the connection so the owning flow is told its save was discarded
    instead of silently losing it.

  `runBatch` issued inside an open transaction becomes a `SAVEPOINT` rather than a nested `BEGIN`
  (SQLite rejects those), so the two compose. Already covered: the bill save and bill delete
  (`sales-orders.component.ts`), sales returns, purchase orders, the asset add/sell/delete paths in
  `database.service.ts`, layer flock health, the flock delete (`flock-management.component.ts`) and
  batch delete (`batch-management.component.ts`), the customer-ledger settlement
  (`customer-ledger.component.ts` — bills, ledger entries and the outstanding-balance recompute in
  one batch), and `addBankLedgerEntry()`.

  `sale.component.ts` is covered too, as of the bank-selector change: its save, edit and delete each
  run inside a `db.transaction()` wrapping one `runBatch` of the sale rows plus their bank entries,
  with the `income` mirror rebuilt inside the same transaction through `assertOk`/`mustRun`. It
  needed the transaction rather than a bare batch because `syncIncomeForDate()` reads the day's SUM
  back after the sales land. The same change gave that function the `COALESCE(module_type,'broiler')`
  guard it had always lacked — `income` is a shared table and `source = 'sale'` was keeping broiler
  and layer apart only by accident.
- **Expenses and ledgers are INDEPENDENT books. Nothing links them — do not reconnect them.**
  An expense is a row in `expenses` with a `category`, and it touches no ledger. A ledger entry
  lives in `ledger_entries` and touches no expense. No mirror rows, no `ledger_id`, no
  `ledger_entry_id`, no ledger picker, no auto-created "Other" ledger. The Expenses screen lists
  rows from `expenses` and nothing else and writes rows to `expenses` and nothing else; the Ledger
  screen owns every `ledger_entries` row and every row on it is freely editable. Both directions of
  merge have been tried and undone deliberately — the screen briefly listed ledger debits so its
  total matched the Report's, and it separately wrote a `source = 'expense'` mirror of every
  expense. Neither comes back.

  The costs still partition, each row claimed by exactly one side, which is what holds every report
  together:

  - expense side: every row of `expenses`
  - ledger side: `ledger_entries` debits with `COALESCE(source,'manual') <> 'expense'`

  **The `<> 'expense'` guard is now a no-op, and it stays anyway.** Nothing writes that source, and
  `migrateDropExpenseLedgerMirrors()` in `database.js` deletes every row that carries it — a
  one-shot flagged on `migration_drop_expense_ledger_mirrors_v1`, ordered deliberately **after**
  `migrateExpenseLedgerSource()` so a mirror that backfill marks is then deleted in the same launch
  rather than surviving forever, excluded from every total but still on screen. The guard costs
  nothing on a migrated database and is the only thing between a database whose migration has not
  landed (it threw and is retrying, or a pre-change backup was restored) and counting every legacy
  expense twice. `report.component.ts` (`totalLedgerDebit`), `overview.service.ts` (`qLedgerDebits`)
  and `farm-report.service.ts` (`specLedgerDebits`) all carry it; keep it in any new consumer.

  Deleting the mirrors moved **no** figure, because every total already excluded them: the cost was
  counted once, on the expense side, before and after. What changed is the Ledger screen, which
  stops listing rows that now have no reason to exist. The Report's `Total Expenses` equals the
  Expenses screen's total and `Ledger Debit` is a separate line on top of it — the qualifier
  "(excl. Expenses)" is gone from every label because there is nothing left to exclude.

  `expenses.ledger_id` / `ledger_entry_id` are **kept as columns and keep their existing values** —
  the table is not rebuilt and the migration does not blank them. Nothing reads either one, and
  `ledger_entries.entry_id` is `AUTOINCREMENT` so a leftover pointer can never resolve to some other
  row. They are the only surviving trace of which ledger a legacy expense was once filed under. Do
  not start writing them again.

  The save is one `runBatch` of plain `INSERT INTO expenses` rows (atomic, one file write for the
  lot); the edit and the delete are each a single checked statement. An expense with no category of
  its own reads and saves as **"Other"** — free text, there is no category table for farm expenses,
  and the layer Expenses screen uses the same column the same way.
  `scripts/verify/verify_expense_ledger_separation.js` asserts the partition, that the migration is
  one-shot and idempotent, that a save/edit/delete touches no ledger row, and that no P&L figure
  moved; run it if you touch any of this.

  **The layer module now has the same two independent books**, and inherits this whole rule: the
  layer Expenses screen writes `expenses` and nothing else, the layer Ledger screen owns every
  `layer_ledger_entries` row, and nothing auto-files between them — no "Other" ledger, no mirrors.
  The layer partition is therefore simply *different tables*: expense side is `expenses` with
  `module_type = 'layer'`, ledger side is `layer_ledger_entries` debits, with no `source` guard
  needed because that kind of row was never written there. See the `layer_ledgers` note further down.
- **Dates: the renderer is converted, the main process is not.** `toISOString()` converts to UTC, so
  for PKT (UTC+5) any local time before 05:00 lands on the **previous day** and files the record
  under the wrong date. `src/` is done — ~125 call sites now use `toLocalDateString()` from
  `shared/utils/date.util.ts`, and no renderer code stores a date through `toISOString()` any more.
  Use that helper, plus `daysBetween()` / `addDays()` for date arithmetic (both anchored on
  `Date.UTC` so a DST boundary cannot knock them off by one).

  `electron/database.js` is converted too: it now has its own module-scope `toLocalDateString()`
  (top of the file, mirroring `date.util.ts` — the main process cannot import from `src/`), used by
  the `addBatchTransaction` date, the product-batch manufacturing/expiry defaults and both
  `transaction_date` values. Use it for any new date the main process stores; the batch expiry in
  particular feeds FIFO picking and the expiry warnings, so a day out is visible. `main.js` still
  uses `toISOString()` for backup filenames and log lines, which is harmless — those are timestamps,
  not records filed under a day.
- **Cross-screen invalidation: three entities must `announce()`, everything else rides on
  navigation.** Every screen is a lazy standalone component destroyed on navigation, so it re-reads
  in its own `ngOnInit`/resolver — for ordinary tables **navigation IS the invalidation** and no
  notification is needed or wanted. Three entities are the exception, because they are displayed by
  `layout.component.ts`, which mounts once per login at `/app` and is **never destroyed**, and
  because they are cached in root services every screen reads:

  | Entity | Writer | Scope to announce |
  |--------|--------|-------------------|
  | `farm_units` | `farm-units.component.ts` | `'units'` |
  | `flocks` | `flock-management.component.ts` | `'flocks'` |
  | `batches` | `batch-management.component.ts` | `'batches'` |

  The rule: **after writing one of those three, call `this.dataChange.announce(<scope>)` — on
  create, edit AND delete.** Delete is the one that hurts most: an unannounced delete leaves
  `FlockService` holding a row that no longer exists, so every screen goes on querying
  `WHERE flock_id = <deleted>` and shows empty tables instead of the empty state.
  `scripts/verify/verify_change_announcements.js` checks every writer statically — run it if you
  touch any of this, and add to its `HELPERS` map if a new writer goes through a
  `database.service.ts` wrapper rather than inline SQL.

  This replaced three hand-wired Subjects (`unitsChanged$`, `batchesChanged$`, and nothing at all
  for flocks) that had been added one per bug. Because flocks had no channel, creating the first
  flock on a fresh account left `currentFlock` null and the layout's "Create your first flock"
  banner — which sits above the `<router-outlet>` and is gated only on `!currentFlock` — covering
  **every** screen until a business-tab round trip happened to re-read flocks. The same defect was
  silent on the second flock and deafening on the first, which is why it kept being rediagnosed as a
  fresh-install bug and fixed narrowly four times.

  Two structural rules hold it down, and both matter more than the channel itself:

  - **`LayoutComponent` holds no copy of shared selection state.** `flocks`/`batches`/`currentFlock`/
    `units`/`currentUnit` are `toSignal()` views onto `FlockService`/`FarmUnitService`, not fields.
    A never-destroyed component has no moment at which a local copy is naturally rebuilt, so every
    past bug here was "the layout forgot to reassign". There is now nothing to reassign. Do not
    reintroduce a field — and note the services are injected with `inject()` rather than constructor
    params, because with `target: ES2022` the signal field initializers run *before* constructor
    parameter properties are assigned.
  - **Selection reconciliation lives in the services, not the layout.** `FlockService.refreshFlocks`/
    `refreshBatches` and `FarmUnitService.refreshUnits` each re-read, publish the list, and
    reconcile "current" in one place: keep the selection but **swap in the freshly-read row** (so a
    rename propagates), else the module's remembered `last*Id`, else the first row, else null. It
    used to live in three near-identical blocks inside the layout, which meant only a navigation or
    a tab switch could run it and a writer had no way to correct shared state.

  `currentFlock$`/`currentUnit$` dedupe on **row content**, not on id. The old id-only guard made
  "same row, new values" unrepresentable, so both re-read paths bypassed it with a raw `.next()`.
  The dedup itself is still load-bearing and must not be removed: every `currentFlock$` subscriber
  reads an emission as "the user switched flock" and clears its unsaved draft rows (see
  `expenses.component.ts`), so a spurious emission destroys the user's work.

  `moduleChanged$` on `FarmUnitService` is deliberately NOT part of this channel — it means "the
  active module changed", not "data changed", and nothing was written when it fires.

- **Deleting a worker keeps their `labour_payments` — never INNER JOIN `labour` to list payments.**
  `labour-management.component.ts` removes the roster row only; the payments stay, because the money
  really left the farm and deleting them would silently rewrite past profit (the roster has an
  inactive toggle for retiring someone without touching history). `overview.service.ts` and
  `farm-report.service.ts` never join `labour` at all, so they always counted those orphans while
  every listing screen INNER JOINed them away — Overview and the Report drifted apart permanently
  with nothing on screen to explain it. Every payment listing now `LEFT JOIN`s and shows an orphan as
  `COALESCE(l.labour_name, 'Deleted Worker')`: `labour.component.ts`, `labour.resolver.ts`,
  `report.component.ts`, `layer-report.component.ts`. Add a new one and it follows the same shape.
- **`flock_health.week_number` is misnamed.** It holds a 1-based **day** index (the UI labels it
  "Day"), not a week. A row's real calendar date is `flock.start_date + (week_number - 1) days` —
  derivable despite the table having no date column of its own.
- **FCR IS PRINTED ON TWO SCREENS AND HAS EXACTLY ONE IMPLEMENTATION: `latestFlockFcr()` in
  `shared/utils/fcr.util.ts`.** The Flock Health screen's "Latest FCR" card and the broiler
  Report's "FCR" card (last in the top row) both call it, over the same
  `SELECT * FROM flock_health WHERE flock_id = ? ORDER BY week_number ASC` rows — the Report
  already loaded them for its Flock Health PDF section, so the card added **no query**. Do not
  derive FCR a second time: the two cards are reconciled by the client against each other, and a
  private copy on either screen would agree the day it was written and drift the first time the
  chosen row or the rounding moved.

  **The formula is the client's own and reads the opposite way to the textbook one:**
  `[(remaining birds / 1000) x avg_weight in grams] / CUMULATIVE bags` — kilograms of live weight
  per bag, so **higher is better**. Anything that needs it calls `computeAutoFcr`/`displayFcr`.

  The figure is already cumulative without summing anything: `avg_weight` is life-to-date and the
  denominator is every bag from day 1, so the **highest qualifying day's** FCR *is* the flock's
  life-to-date ratio. "Qualifying" is the highest DAY INDEX with both a weight and some cumulative
  feed — never the last element of the array, since days are entered out of order and a later day
  often has no weight yet. `latestFlockFcr(rows, denominatorRows?)` takes the pool separately
  because Flock Health passes saved rows as candidates and saved-plus-editing-plus-pending as the
  denominator, so its card moves as a row is typed; the Report has only saved rows and passes one
  list.

  It returns **null, never 0**, when no row qualifies, and both templates render the identical
  expression `{{ latestFcr !== null ? (latestFcr | number:'1.2-3') : '—' }}` — keep them
  byte-identical or the two cards disagree in a digit. The one case that is deliberately **not** a
  dash is a flock whose birds are all dead: the row qualifies and `computeAutoFcr` returns 0 for
  `remaining <= 0`. Both screens say 0 there; making it a dash would mean changing Flock Health's
  existing card.

  **The layer side has no FCR and must not get this one** — layer FCR means feed per egg, a
  different quantity, and `layer-report.component.ts` deliberately has no FCR at all.
  `scripts/verify/verify_report_fcr_card.js` asserts the single implementation, the two cards'
  byte-identical strings, every empty case, the cumulative denominator against the old single-day
  bug, that no other Report getter reads `this.health`, and the card counts in the template; run it
  if you touch any of this.
- **`layer_mortality` is frozen, not live.** The layer Mortality screen became a full Flock Health
  screen writing to **`layer_health`** (`batch_id`, `day_number`, real `date`). Every consumer —
  hen-sales, layer-report, farm-report — reads `layer_health` now. `layer_mortality` is kept
  untouched as the migration's recoverable original and receives no writes; reading it gives you
  only pre-migration data. `migrateLayerMortalityToHealth()` copied it across once.

- **`egg_collection.total_eggs` ALWAYS holds the true egg count, never the carton count.** Both egg
  screens can be worked in two modes — Egg Sales prices per egg or per carton (`sale_mode`,
  `carton_count`, `eggs_per_carton`), Egg Collection now *records* the same way
  (`collection_mode`, `carton_count`, `eggs_per_carton`, all added by ALTER with no backfill, so
  existing rows read as `'per_egg'` with a NULL `carton_count`). In both tables the mode is a
  *recording* convenience and the count column is the fact: the derivation happens **at save time**,
  `carton_count × eggs_per_carton` for a carton row, so nothing downstream ever needs to know a mode
  exists.

  That is load-bearing on the collection side in a way it is not on the sales side, because
  `total_eggs` *is* the production figure. `egg-sales.component.ts` reads
  `SUM(total_eggs - broken_eggs)` for egg stock, `layer-flock-health.component.ts` reads
  `SUM(total_eggs)` per day for cumulative production, and `layer-report.component.ts` sums
  `e.total_eggs`. A carton-mode save that wrote the carton count there would divide every one of
  those by 360 — silently, since no screen would say why. (`overview.service.ts` and
  `farm-report.service.ts` read `egg_sales`, not `egg_collection`, so they have no egg-collection
  figure at all.)

  `eggs_per_carton` is stored **per row** and read back per row, so a batch recorded at 180 keeps
  recomputing at 180; the `|| 360` in `computeTotalEggs()` is a null fallback, not the carton size.
  Only `total_eggs` is derived — `broken_eggs` and the four grade columns are plain egg counts in
  both modes, which is what lets `validateEggRow()` compare egg counts to egg counts either way
  (broken + graded is bounded by the **derived** total: 720 on a 2-carton row, not 2). The mode is
  chosen per screen and locked while rows are pending, and an existing row edits in the mode it was
  recorded in. `scripts/verify/verify_egg_collection_cartons.js` lifts both statements and the real
  `computeTotalEggs`/`validateEggRow` out of the component and asserts all of it, including that
  every downstream figure is identical for a per_egg collection written before and after the change;
  run it if you touch any of this.

- **Own-farm sales are real sales, and the elimination lives in exactly one place.** Distribution is
  its own business; the owner's farms are its customers. An own-farm bill (`payment_type =
  'internal'`) carries a real `customers` row — `customer_type = 'own_farm'`, keyed on
  `unit_id` (the `farm_units` row, NOT the flock/batch, which is deleted when the flock closes) —
  and a real `amount_paid`, so the farm carries the debt in `customer_ledger` until it settles.
  `distribution-report.component.ts` counts these as revenue on the collected basis, like any
  customer. `overview.service.ts` does NOT, and must not: it drops the whole bill from revenue AND
  the matching selling-price cost row from the broiler/layer module, so the two cancel and the owner
  cannot manufacture profit by billing himself. Both sides eliminate on `total_amount`, never on
  `amount_paid`, so a partial settlement cannot unbalance them. What survives at account level is the
  purchase cost via `qDistributionCogs()` — the only part the owner is really out of pocket for.
  `scripts/verify/verify_own_farm_customers.js` asserts Overview is identical unsettled, part-settled
  and fully settled; run it if you touch any of this.
  Own-farm customers are filtered OUT of the Sales Orders "Regular" dropdown, Customer Management
  (they are app-owned; renaming or deleting one orphans the debt) and the Bank Ledger customer
  picker; they are deliberately INCLUDED on the Customer Ledger screen (where they are settled), the
  Account Ledger dashboard and the Distribution report's outstanding total. Add a
  `COALESCE(customer_type,'external') <> 'own_farm'` filter to any new customer-picking query.

- **`bank_accounts.customer_id` is the house/customer split, and it is nullable on purpose.**
  `customer_id IS NOT NULL` is a customer's account (Distribution > Bank Ledger, route
  `bank-ledger`); `customer_id IS NULL` is one of the owner's OWN house accounts (Overview > Bank,
  route `overview-bank-ledger`). Both routes load the **same** `BankLedgerComponent`, told apart by
  `data: { bankScope }` in `app.routes.ts` — do not fork it. `getBankAccounts(farmId, scope?)` takes
  the filter; a caller that omits `scope` gets both, which is almost never what a screen wants.
  Anything the owner actually pays out of a bank (asset payments, personal expenses) must draw from
  `getHouseBankAccounts()` — paying for a tractor out of a customer's account records it as that
  customer's withdrawal.
- **Anything paid by bank MUST write a `bank_ledger` entry, and un-making it must remove that entry.**
  This was the live defect: `payment_source = 'bank'` and `bank_id` were written and nothing else
  happened, so the recorded balance climbed while the real one fell, and the figure was pulled off
  the Overview dashboard rather than shown wrong. Two tables can be bank-sourced — `asset_payments`
  and `personal_expenses` — and the invariant covers both: **for every such row with
  `payment_source = 'bank'` there is exactly one `bank_ledger` row carrying that table's
  `reference_type` (`'asset_payment'` / `'personal_expense'`) and that row's id in `reference_id`**,
  and every `bank_accounts.current_balance` equals `SUM(debit - credit)` over its own ledger. Both
  sides go in one `runBatch` on every path — `addAsset`, `addAssetPayment`, `sellAsset`,
  `deleteAssetPayment`, `deleteAsset`, `addPersonalExpense`, `updatePersonalExpense`,
  `deletePersonalExpense` — see the block above `ASSET_PAYMENT_REF` in `database.service.ts`, where
  `bankWithdrawalOps`/`bankReversalOps`/`rebuildBankBalanceOp` are shared by both features. Reversal
  paths have to read the `bank_id` **before** the batch: once the ledger row is gone there is nothing
  left to say which balance to rebuild. `deleteBankAccount()` refuses while any asset, asset payment,
  personal expense or customer still names the account. Add a new bank-sourced table and it needs its
  own `*_REF`, the same batched pairs, and a row in the `SOURCED` list in the verify script.
  `scripts/verify/verify_bank_withdrawals.js` asserts the invariant after every mutation; run it if
  you touch any of this.
- **TWELVE tables are bank-sourced now; TEN of them go through `BANK_SOURCES`.** Assets and personal
  expenses were the first two and keep their own named paths. Every screen where money is received
  or paid now carries the same Cash/Bank selector, so eight more tables feed the identical
  mechanism, declared once in `BANK_SOURCES` (`database.service.ts`) with their table, primary key,
  `reference_type` and direction:

  | Table | pk | `reference_type` | Direction | Screens |
  |-------|----|------------------|-----------|---------|
  | `sales` | `sale_id` | `broiler_sale` | in — debit, `DEP-` | `sale.component.ts` |
  | `egg_sales` | `egg_sale_id` | `egg_sale` | in | `egg-sales.component.ts` |
  | `hen_sales` | `hen_sale_id` | `hen_sale` | in | `hen-sales.component.ts` |
  | `income` | `income_id` | `farm_income` | in | `income.component.ts` (manual rows only) |
  | `expenses` | `expense_id` | `farm_expense` | out — credit, `WD-` | `expenses` + `layer-expenses` |
  | `labour_payments` | `payment_id` | `labour_payment` | out | `labour.component.ts` |
  | `purchase_orders` | `purchase_id` | `purchase_order` | out | `purchase-orders.component.ts` |
  | `receive_vouchers` | `voucher_id` | `receive_voucher` | in | `receive-voucher.component.ts` |
  | `payment_vouchers` | `voucher_id` | `payment_voucher` | out | `payment-voucher.component.ts` |
  | `expense_ledger` | `expense_id` | `distribution_expense` | out | `account-ledger/expense-ledger` |

  **`expense_ledger` is the tenth, and it was the gap the client noticed.** The distribution
  business's own running costs had offered a "Bank" payment type since the table existed, with no
  account behind it and no ledger effect — so a bank-paid expense moved nothing and the recorded
  balance climbed while the real one fell. It now writes a real entry, is weighed by the overdraw
  guard, and has a `cash-position.service.ts` term (`expense_ledger_out`). Its `payment_type` is
  'cash' (paid) vs 'credit' (unpaid) — a SETTLEMENT STATUS, the `purchase_orders` shape — so
  Cash/Bank is its own control, shown only on a paid expense, and an unpaid one carries no entry
  whatever `payment_source` says. The statements live in `database.service.ts` (`addExpense` /
  `updateExpense` / `deleteExpense`) rather than in the screen, which is where they already were;
  `verify_bank_screen_sql.js` lifts the INSERT from there under sentinels for the same reason it
  lifts the screens'.

  One entry per TABLE, not per screen — a primary key is unique across the table, so `expenses`
  needs one `reference_type` for both the broiler and the layer screen. `bankWithdrawalOps` is now a
  thin wrapper over **`bankEntryOps({ direction })`**, because four of these receive money: `'in'`
  writes a debit and takes a `DEP-` number, `'out'` a credit and a `WD-`. Do not add a deposit
  function — the sign is a parameter.

  Screens call three public helpers and supply only their own row's SQL:
  `bankSourceInsertOps()` (interleave `[row insert][its entry, $lastId:-1]` and close with
  `bankRebuildOps()`), `saveBankSourceEdit()` (reverse → update → re-post → rebuild the **union** of
  old and new account — the `updatePersonalExpense` shape, factored), and `deleteBankSourced()`.

  **`payment_source` is NOT `payment_type`.** Six of these tables already had a `payment_type` and
  four already offered the user "Bank" in it — free text, no account, no ledger effect, and **no
  report filters on it** (the only `payment_type` logic anywhere is the distribution `'internal'`
  own-farm rule on `bills`). `payment_type` still means only "what the user labelled the row";
  `payment_source` is the normalized fact that money moved through a *named* account and is the only
  thing this mechanism reads. On the four screens that already had the option, the existing selector
  IS the Cash/Bank selector and `payment_source` is derived from it — never add a second one.
  `income` and `layer-expenses` had no selector, so they drive `payment_source` directly.
  **`purchase_orders` is the deliberate exception**: its `payment_type` is "Paid (Debit)" vs
  "Unpaid (Credit)", a settlement status that drives `isPaid` and the supplier ledger, so adding
  'bank' there would flip a paid order to unpaid and move the supplier payable. There Cash/Bank is
  its own control, shown only on a paid order, and an unpaid order carries no entry whatever
  `payment_source` says (`bankFieldsFor()` normalizes that).

  **There is no backfill, and that is what makes legacy rows safe.** A row saved before this says
  `payment_type = 'bank'` and `payment_source = 'cash'`, which is true — no entry was ever posted
  for it. So the exemption is structural rather than a list: a row is exempt precisely because
  `payment_source <> 'bank'`. Editing one requires choosing an account and starts posting from then
  on; the screens refuse to save Bank with no account rather than quietly downgrading it to cash
  (`bankSourceError()` in `shared/utils/bank-source.util.ts`).

  **The account DROPDOWN shows the bank name plus the account's title**, via `bankOptionLabel()` in
  `shared/utils/bank-source.util.ts` — `"HBL Main — Mian Ahmed"`, falling back to the account number
  and then to the bare name. The client runs several accounts at one bank told apart only by whose
  name they are in, so a list of four options all reading "HBL" is a list they cannot use. It is
  DISPLAY ONLY, and deliberately not what `bankNameOf()` returns: that one names the account on a
  saved row, a table cell and a printed statement, where the row's own columns already carry the
  context and `bank_name` is what each of those reads by. `bank-picker` uses it, and so do the six
  screens that render their own `<option>` list (`assets` ×3, `internal-settlement` ×2,
  `payment-voucher`, `personal-expenses`, `receive-voucher`, `sales-orders`) — those are NOT folded
  into `bank-picker`, because two of them bind a composite value (`fromChoice`, `'house:' + id`)
  rather than a bare `bank_id`, and the picker's own empty-account and placeholder behaviour differs
  from theirs.

  **`income` mirror rows are never bankable.** `sale`, `egg-sales` and `hen-sales` each upsert a
  daily `income` mirror (`source` = `sale`/`egg_sale`/`hen_sale`). Those carry the selector on the
  sale itself, so banking the mirror too would deposit the same money twice — and the mirror is
  rebuilt from scratch on every change, so the choice could not survive anyway. Only
  `source = 'manual'` rows take the selector (`isBankable()` in `income.component.ts`).

  **THE CASCADE IS THE PATH WITH NO FORM.** Closing a flock or a batch deletes its `expenses`,
  `income`, `sales`, `labour_payments`, `egg_sales` and `hen_sales` outright, so their entries must
  go with them or the ledger holds lines for records that no longer exist and every balance they
  touched is overstated. `bankCascadeReversalOps(key, scopeSql, scopeParams)` returns the ops to run
  **ahead of** the deletes (it reads the accounts while the rows are still there), and both
  `flock-management.component.ts` and `batch-management.component.ts` pass the **identical** scope
  clause they then delete by — module guard included, without which a flock delete would reverse the
  colliding batch's deposits across accounts.

  Always draw from `getHouseBankAccounts()`, never `getBankAccounts()` unscoped: banking a sale into
  a *customer's* account records it as that customer's deposit. Adding a table means a row in
  `BANK_SOURCES`, a label in `deleteBankAccount()`'s refusal list, both cascades if it is
  flock/batch-scoped, and entries in both verify scripts.

  The two voucher tables are the exception to the cascade clause, and deliberately: they are
  **account-scoped**, not flock/batch-scoped, so no flock or batch close may reverse them — closing a
  flock must not un-settle a customer receipt. `verify_bank_withdrawals.js` clears them by hand before
  its cascade sections for exactly that reason.
  `scripts/verify/verify_bank_withdrawals.js` drives its sweep off `BANK_SOURCES` (so a declared
  table cannot escape it) and covers money-in, every edit transition, both cascades and the
  collision; `scripts/verify/verify_bank_screen_sql.js` lifts all fourteen screen statements as text
  and executes them with per-parameter sentinels, because TypeScript cannot see a placeholder count
  or a parameter *order* that stopped matching the column list. Run both if you touch any of this.
- **NO VERIFY SCRIPT SEES A TEMPLATE. A column added to the SQL is checked; a column added to the
  TABLE is not.** `verify_bank_screen_sql.js` lifts each screen's statements and executes them with
  per-parameter sentinels, so it catches a placeholder count or a parameter order that stopped
  matching the column list — but it reads `.ts`, never `.html`, and no other script reads one
  either. Change 1 added `payment_source`/`bank_id` to the income INSERT **and** a "Received In"
  `<th>` plus a matching `<td>` to the pending and edit rows — but in the view-mode row it
  *replaced* the amount cell instead of inserting beside it. Every script stayed green, because
  the write path and every total really were correct; the screen rendered "Bank HBL" under Amount,
  Edit/Delete under Received In, and the amount nowhere at all, and shipped that way. **Whenever a
  change alters a table's column count, count the cells of every row branch against the `<thead>`
  by hand and then open the screen.** Count all of them: the header, each mutually exclusive
  `*ngIf` `ng-container` branch of the body row (each is a whole row, so each must total the header
  on its own), the pending-row branch, and the `<tfoot>`, where a `colspan="n"` counts as n. An
  off-by-one here is invisible to every tool in this repo and immediately obvious to the user.
- **A personal expense is EDITABLE, and its withdrawal is reversed-and-re-posted, never patched.**
  It is the one bank-backed row that can change after the money moved: amount, date, source and
  account are all editable. `updatePersonalExpense()` deletes whatever entry the row had, updates the
  row, and writes a fresh entry if it is still bank-sourced — one shape covering all five transitions
  (amount, date, cash→bank, bank→cash, bank A→bank B), rather than a branch per case. Two things are
  load-bearing: the balance rebuild is **deferred** (`deferBalance`) until after both the delete and
  the insert, and it covers the **union** of the old and new accounts — rebuilding A mid-batch caches
  a figure the next statement invalidates, and rebuilding only B leaves A counting a withdrawal it no
  longer has. Fields absent from `data` fall back to the row's current values, so a partial update
  still rebuilds the withdrawal from the right date and account; naming only `bank_id` means "move
  the account", not "make it cash". The old `transaction_number` is carried over when the account is
  unchanged and regenerated when it moves (it belongs to the old account's WD- sequence and could
  collide in the new one).
- **SELLING AN ASSET BRINGS MONEY IN, AND IT NOW LANDS SOMEWHERE.** `assets.sale_amount` used to be
  recorded and no figure moved: the proceeds reached neither the drawer nor any account. The Sell
  form has a second selector — "Sale money received in" — and `sellAsset()` takes a `proceeds`
  argument beside its existing `settlement` one.

  **Two selectors on one form, running opposite ways, and they are separate fields on purpose.**
  `sale_payment_source` / `sale_bank_id` are the SALE's own (money in: a `bank_ledger` DEBIT under
  `ASSET_SALE_REF`, a `DEP-` number, keyed to the ASSET's id); `settlement` is the outstanding
  balance being cleared (money out, `ASSET_PAYMENT_REF`). One sale can legitimately take the
  proceeds into one account and settle out of another. `assets.payment_source` / `bank_id` are
  still only the FIRST payment's source and are never read here — a deposit posted off those would
  credit whichever account happened to make a down payment years earlier.

  `ASSET_SALE_REF` is its own reference type rather than sharing `ASSET_PAYMENT_REF`, for the
  reason the two internal-settlement types are separate: every reversal reads `bank_ledger` by
  `(reference_type, reference_id)`, and an asset's payments and its sale would otherwise come back
  together with opposite signs and nothing to tell them apart. An asset is sold once, so there is
  exactly one such entry per asset.

  Load-bearing details: the proceeds entry is written BEFORE the settlement in the same batch, so
  an account that receives the money and then pays the balance out of it reads in the order the
  money moved; the overdraw guard weighs the NET of both legs, or a sale that pays off its balance
  out of its own proceeds would be refused; `bankIdsForAsset()` now unions both directions so a
  delete rebuilds every account the asset touched; and a CASH sale writes no entry at all, which is
  exactly how it reaches Cash in Hand instead (`asset_sales_in` in `cash-position.service.ts`, with
  a NULL source reading as cash — true of every asset sold before the selector existed).
  `verify_bank_withdrawals.js` section D2 covers it; run it if you touch any of this.

- **The settlement a sale writes needs an explicit payment source — never an inherited one.**
  `sellAsset()` clears the outstanding balance with a real `asset_payments` row, so with bank entries
  now being written that row moves real money. Its source comes from the Sell form's Cash/Bank
  selector and **defaults to cash**. It is deliberately NOT taken from `assets.payment_source` /
  `assets.bank_id`: those record how the asset's FIRST payment was made, and settling on that basis
  would post a withdrawal of the entire remaining balance — often the largest single movement on the
  account — that nobody chose. `assets.payment_source`/`bank_id` are now only the initial payment's
  source; the Edit Asset form has no source selector at all, because each payment carries its own and
  those are already made.

- **A customer's balance is derived from `bills`, NOT from `customer_ledger` — so deleting a payment
  has to put the money back on the bill.** The balance everywhere (Customer Ledger, Sales Orders,
  Distribution report, the cached `customers.outstanding_balance`) is
  `Σ MAX(bills.total_amount − bills.amount_paid, 0)`; the ledger row is the statement line. A
  settlement writes both — `submitPayment()` updates `bills.amount_paid` first and logs the entry
  after — so a delete that removed only the row left the payment counted and the balance unmoved:
  charge 940,000, pay 900,000, delete the payment, balance stuck at 40,000 with nothing on screen
  holding it there. `deleteCustomerLedgerEntry()` in `database.service.ts` is the reversal, and it is
  the same discipline as the bank withdrawals — read first, then reverse and rebuild in ONE
  `runBatch` (bills, then the row, then the balance), because the three describe one movement.

  Which bills it unwinds: `reference_id` names the bill the entry was filed against, so that one
  first; anything left over comes off the customer's other paid bills newest-first, because a
  settlement entered against one bill spills FIFO onto the others and is still logged as **one**
  entry tagged to the selected bill (an untagged legacy row starts at that same newest-first order).
  Each bill gives back at most what it holds, so no `amount_paid` goes negative.

  **A `reference_type = 'bill'` row is refused** — it mirrors the debt itself, so deleting it would
  hide what is owed rather than reduce it; cancelling a charge means deleting the bill in Sales
  Orders, which also restores stock and `bill_items`. The Actions column already hides that button;
  the service enforces it where the template cannot be bypassed. A debit that is *not* a bill mirror
  never touched `bills` and stays deletable.

  The supplier side is a different model and needs none of this: a supplier's payable **is**
  `SUM(credit − debit)` over `supplier_ledger` itself, with nothing behind it, so removing the row is
  the reversal. `deleteSupplierLedgerEntry()` exists only to refuse a `'purchase'` row and to return
  a checked result. The bank side was already correct (`bank-ledger.component.ts` batches the delete
  with the balance rebuild). The invariant to hold on the customer side: **the running total down
  `customer_ledger` and the bills-derived outstanding must agree, and the cached column with both.**
  `scripts/verify/verify_ledger_payment_reversal.js` asserts it after every mutation — run it if you
  touch any of this.

  Adjacent, and deliberately untouched: editing a bill in Sales Orders overwrites `amount_paid` from
  the form and regenerates its `'bill'`/`'payment'` entries, so a later settlement recorded on the
  Customer Ledger is superseded by the edit. That is the bill screen's own behaviour, not this path's.

- **THE SETTLEMENT HAS EXACTLY ONE IMPLEMENTATION IN EACH DIRECTION, and both live in
  `database.service.ts`.** Forward is `customerSettlementOps()` — the FIFO allocation across unpaid
  bills, the `bills.amount_paid` updates, the `customer_ledger` credits and the balance recompute.
  Reverse is `customerUnwindOps()` — the give-back, newest bill first. The forward half was inline in
  `customer-ledger.component.ts`'s `submitPayment()` while its reverse half was already down here;
  the voucher screens needed the same event through a second door, so it moved to sit beside its
  twin. `submitPayment()` and `saveReceiveVoucher()` both call the one; `deleteCustomerLedgerEntry()`
  and `deleteReceiveVoucher()` both call the other.

  The extraction was a pure move and must stay one: the statement sequence — SQL text and params, in
  order — is unchanged, and `verify_ledger_payment_reversal.js` produces byte-identical output across
  it. That script is the safety net for any further change here; capture its output before and diff
  after. The bills read moved too, to `getUnpaidBills()`, with **no `bill_id` tiebreaker on
  `ORDER BY bill_date ASC`** — adding one would reorder same-day bills and change the allocation.

  **Neither delete may branch its reversal on vouchers.** `deleteCustomerLedgerEntry()` and
  `deleteReceiveVoucher()` call `customerUnwindOps()` on equal terms. What the ledger deletes *do*
  carry is a **precondition** refusing a row whose `voucher_id` is set, because that row is one side
  of a three-part event and deleting it alone would leave the bank entry standing on the account —
  the same shape as the existing `reference_type = 'bill'` refusal, and the templates hide those
  buttons too. A voucher delete unwinding several rows passes ONE shared `takenBack` accumulator
  across the calls: every read happens before any statement runs, so two rows drawing on one bill
  would otherwise each be credited from its original `amount_paid`.

- **Receive and Payment Vouchers are SHORTCUTS, and must never become a second book.**
  `receive-voucher.component.ts` and `payment-voucher.component.ts` collapse "navigate into the
  party, find their ledger, record a payment" into one form. They add the bank attribution and the
  guarantee that both sides are recorded together; they add **no** settlement logic. Receive goes
  through `customerSettlementOps()`; payment writes the single `supplier_ledger` debit
  (`supplierLedgerEntryOp()`, shared with `addSupplierLedgerEntry()`) that IS the payable reduction —
  the payable is `SUM(credit − debit)` over that table and **nothing is stored on `suppliers`**.

  One row per voucher is what lets them join `BANK_SOURCES`: that mechanism keys an entry to a source
  row's primary key, and a receive voucher's FIFO spill can write several ledger rows, so the entry
  points at the **voucher**, not at a ledger line. The voucher's own INSERT is **operation 0** of the
  batch, so the ledger credits and the bank entry both name it with `{ $lastId: 0 }`. The link is
  `customer_ledger.voucher_id` / `supplier_ledger.voucher_id` — nullable, added by ALTER, read by
  nothing else, and appended to the INSERT **only for a caller that has one**, so the ledger screens'
  own statements are unchanged.

  Standing rules: **house accounts only** (`getHouseBankAccounts()`); own-farm customers **excluded**
  from the receive picker (they are settled on Customer Ledger, which includes them deliberately);
  **overpayment refused** on both sides, the receive side testing the settlement's own `unapplied`
  remainder rather than a second outstanding calculation; and **no edit path** — a voucher is a
  compound event, so it is corrected by delete-and-re-enter, which reverses all three sides in one
  batch. The customer-deposit axis on `sales-orders` (`reference_type = 'payment'` with a NULL
  `reference_id`, on a *customer's* account) is a different mechanism and no voucher writes one.
  `scripts/verify/verify_vouchers.js` asserts all of it — including that a receive voucher of X leaves
  `bills`/`customer_ledger`/`customers` in the same state as the Customer Ledger screen's own payment
  of X, which is what stops the two doors reporting different revenue. Run it if you touch any of
  this.

- **An internal settlement can write ZERO bank entries, and that is the point.** An own-farm bill
  is distribution billing the owner's own farm; the farm clears it on the Internal Settlement screen
  (`internal-settlement.component.ts`, Distribution menu, route `internal-settlement`). Both ends of
  that money are the owner's, so the screen asks for a FROM account and a TO account, and **they can
  be the same one**. When they are — or when both are cash — no money crossed an account boundary:
  the debt clears and **not one `bank_ledger` row is written**. Writing a debit and a credit on one
  account and trusting them to cancel is arithmetically equal and structurally wrong; the first
  change that skips a leg or filters by direction leaves the account wrong, and a statement shows two
  lines for a movement that never happened.

  **THE INVARIANT, in its general form — use this one, not "the total never moves".** Bank balances
  in total move by

      (TO is a bank ? +amount : 0) - (FROM is a bank ? +amount : 0)

  so Bank→Bank (same account **or** different) and Cash→Cash leave the total **IDENTICAL**, while
  Bank→Cash and Cash→Bank move it by exactly the amount — the cash that genuinely crossed the edge of
  the banked world, which no account tracks. The flat "sum of all bank balances is identical" holds
  only when both ends are accounts; stated unconditionally it would forbid the mixed shapes the client
  asked for. Money is never invented either way: the bank side moves by exactly what left or entered
  it.

  **NOT a `BANK_SOURCES` table, and deliberately the only money screen that is not.** That mechanism
  keys exactly ONE entry to a source row's primary key with one direction declared per table; a
  settlement writes zero or TWO entries, in opposite directions, on two accounts. So it takes the
  named-path shape `assets` / `personal_expenses` have, with **two** reference types —
  `internal_settlement_out` (a `credit`, `WD-`, on FROM) and `internal_settlement_in` (a `debit`,
  `DEP-`, on TO) — because every reversal here reads `bank_ledger` by
  `(reference_type, reference_id)` and both halves carry the same `settlement_id`. One shared type
  would return two rows of opposite sign with nothing to tell them apart. Do not add it to
  `BANK_SOURCES`: `verify_bank_withdrawals.js` asserts exactly one entry per bank-sourced row, and
  this table would break that by design.

  **The settlement itself is `customerSettlementOps()`** — the same FIFO across unpaid bills the
  Customer Ledger and Receive Voucher screens run, now reached through a third door. `saveInternalSettlement()`
  / `deleteInternalSettlement()` in `database.service.ts` compose the row and the bank legs around it,
  and the delete unwinds through `customerUnwindOps()` with **one shared `takenBack` accumulator**
  across the settlement's ledger rows, exactly as `deleteReceiveVoucher()` does. The screen's own
  INSERT is **operation 0** of the batch, so the ledger credits and both bank legs name it with
  `{ $lastId: 0 }`.

  `customer_ledger.internal_settlement_id` is the N-ary link, the twin of `voucher_id` from Change 2,
  and the two are **mutually exclusive** — `customerSettlementOps()` appends whichever single tag
  column it was given, and emits the byte-identical statement it always did for a voucher and for an
  untagged payment. A credit row carrying it is **refused** by `deleteCustomerLedgerEntry()`, the same
  precondition shape as the voucher refusal (the Actions column hides the button and shows a
  `settlement` note). Neither delete branches its reversal on the tag.

  Standing rules: **house accounts only on BOTH sides** (`getHouseBankAccounts()` — settling through a
  customer's account records the movement as that customer's); **own-farm customers are the ONLY ones
  selectable**, the exact inverse of every other customer picker; **overpayment refused** on the
  settlement's own `unapplied` remainder; **no edit path** — correct one by delete-and-re-enter, which
  reverses every side in one batch. With exactly ONE house account both dropdowns auto-select it; with
  none, neither is rendered and it settles as cash on both sides; with several, neither has a default
  and the save is refused until both are picked. `deleteBankAccount()` refuses while any settlement
  names the account at either end.

  **Account-scoped, NOT flock/batch-scoped: it is in NO delete cascade** — closing a flock must never
  un-settle a receipt. Same reasoning as the two voucher tables.

  What the reports do: **Overview is unmoved**, because an internal bill is eliminated on its whole
  `total_amount` regardless of what has been settled — so the owner still cannot manufacture profit by
  billing himself and then paying himself. **The Distribution report's collected-basis revenue DOES
  rise** by exactly the settled amount, which is correct and already how own-farm bills behave there.
  The printed receipt is hand-rolled with the logo and watermark, like the Report screens, **not**
  through `printPdfReport()`; it branches once, on same-account vs different-account, and reads the
  bills it cleared back out of the ledger rows the settlement wrote rather than re-deriving them.
  `scripts/verify/verify_internal_settlements.js` asserts all of it — the general invariant after every
  case and every delete, Overview identical in both, the zero-row same-account case, and the refusals.
  Run it if you touch any of this.

- **NO SAVE MAY TAKE A BANK ACCOUNT BELOW ZERO, and the test is a NET DELTA PER ACCOUNT.**
  A bank account holds real money; a withdrawal the bank never honoured makes the ledger, the
  account's statement, Overview's Bank card and the Distribution report all wrong from that line on.
  So a save that would overdraw is **refused before the batch runs** and nothing at all is written —
  not the source row, not the ledger entry, not a moved balance. `checkBankBalances()` in
  `database.service.ts` is the one implementation; its refusal is already the sentence the user
  reads (`"HBL Main does not have enough balance. Current: Rs. X, needed: Rs. Y."`), because only it
  knows the account and both figures.

  **The shape is a net delta per account, never "an outgoing amount".** An edit reverses its old
  entry and posts a new one in the same batch, and one save can bank several rows into one account;
  checking each statement alone would refuse an edit that *lowers* a withdrawal and let through a
  pair that together overdraw. Summing the signed effects per account is the only test that matches
  what the batch will leave behind. Three consequences worth knowing:

  - **Zero is allowed, the refusal starts one paisa past it.** Emptying an account is a legitimate
    thing to do, and so is an internal settlement that brings FROM to exactly zero.
  - **An edit that moves no money is never refused**, whatever the account stands at — which is the
    only thing that keeps a row on an already-overdrawn account editable.
  - **The guard reads the LEDGER, not `bank_accounts.current_balance`.** That column is a cache
    rebuilt by `rebuildBankBalanceOp()`; guarding on it would refuse or allow a save on a figure a
    mid-batch rebuild had not yet corrected.

  **A DELETE IS NEVER GUARDED.** Removing a withdrawal puts money back, and removing a deposit
  un-makes a record the user has already decided was wrong — refusing it would strand a row that
  cannot be corrected. Every reversal path (`deleteBankSourced`, `deleteInternalSettlement`,
  `deletePersonalExpense`, `deleteAssetPayment`, `deleteAsset`, both cascades) skips the guard
  outright, and a delete may legitimately leave an account negative.

  **Existing negative balances are kept, not cleared.** Overview > Bank shows them in red with a
  warning icon (`.overdrawn-icon`, inside the existing balance `<td>` — the row's column count is
  unchanged, see the cell-count landmine above) and a deposit clears them. Being negative blocks
  nothing from being read; it only means the next *outgoing* save is refused.

  Where it is wired, as of now:

  - **The ten `BANK_SOURCES` tables.** `checkBankSourceInserts(key, rows)` takes the WHOLE row
    list and is awaited by each screen before its batch (`sale`, `egg-sales`, `hen-sales`, `income`,
    `expenses`, `layer-expenses`, `labour`, `purchase-orders`); `saveBankSourceEdit()` carries its
    own check internally. It is a separate call rather than folded into `bankSourceInsertOps()`
    because that one is synchronous by necessity — it is spliced into a batch being assembled, and a
    `runBatch` cannot take a read between its statements.
  - **The named paths**: `addAsset` (down payment), `addAssetPayment`, `sellAsset` (the settlement,
    often the largest single movement on the account), `addPersonalExpense`,
    `updatePersonalExpense`, `saveReceiveVoucher`, `savePaymentVoucher`, `saveInternalSettlement`
    (FROM side only, and only when `moved` — a settlement crossing no account boundary writes no
    ledger row and cannot overdraw anything), and `checkBillHouseReceipt()` for a bill's house
    receipt (money in on a new bill, but an EDIT that cuts or moves the receipt takes money back
    out).
  - **Deliberately NOT guarded**: `addBankLedgerEntry()`, the Bank Ledger screen's own writer — a
    manual entry is how the client corrects an account by hand, including one already overdrawn —
    and `deductCustomerBank()`, which draws on a *customer's* deposit account, a different
    mechanism on a different kind of account.

  A screen calling the guard must `await` it **before** opening any `db.transaction()`, so a refusal
  has nothing to roll back. Adding a bank-sourced path means calling the guard on its outgoing side
  and a section in `scripts/verify/verify_no_negative_bank.js`, whose section J is driven off the
  real `BANK_SOURCES` declaration so a table added there cannot escape the sweep. Run it if you
  touch any of this. Note that **the verify scripts bind real method bodies onto one hand-built
  object**, so a new `this.` dependency inside a guarded path has to be registered in every script
  that lifts it — six of them were, which is why their output is unchanged.

- **CASH IN HAND IS DERIVED, AND `bills.amount_paid` IS COUNTED ONCE WITH THE BANK PART TAKEN BACK
  OFF.** `CashPositionService` (`shared/services/cash-position.service.ts`) owns both figures the
  Overview dashboard, the Farm Report and the Distribution Report print as two cards (💵 Cash in
  Hand, 🏦 Total Bank Balance) and as a block in each of their PDFs. **One definition, three
  readers** — the client reconciles these against the notes in the drawer, so two screens
  disagreeing is worse than neither showing it. Do not add a second query for either.

  Both are **balances at a point in time, never flows across a range**, the same choice the two
  outstanding cards beside them make. By default that point is today. `getCashPosition(farmId,
  asOf?)` takes an optional **range-TO cut-off and nothing else**: every movement dated on or
  before `asOf` counts, nothing after it does, and there is deliberately **no `from`** — passing
  the Farm Report's `dateFrom` would report the cash *generated in* the period, a different and
  much smaller number than the cash the client has. Overview and the Distribution Report pass no
  date and get the query this service always ran; the **Farm Report passes its `dateTo`**, because
  its footer answers "as of this date you had Rs. X in cash and Rs. Y in bank". The Farm Report's
  pair is **account-wide, not per-farm** (one drawer behind every farm), which the card labels say
  outright.

  **The cut-off is a bound parameter, not a second statement.** Every term carries
  `<its own date column> <= COALESCE(?, '9999-12-31')`, so the SQL text and the parameter list are
  identical whether or not a date is given and the undated figure is byte-identically the old one.
  `cashSql()` now returns one **token** per `?` — `'farm_id'` or `AS_OF_PARAM` — in order, which is
  how the caller binds them without parsing the SQL. Two consequences:

  - **`bills.amount_paid` is the one term the cut-off cannot filter in place.** It is a running
    total raised by four doors over time and the only date on the row is `bill_date`, the date of
    the *charge* — filtering on it would count a March bill settled in September as collected in
    March. So `bills_paid_in` stays undated and a companion term, `bills_paid_after_asof`, takes
    back the `customer_ledger` CREDITS dated after the cut-off; all four doors write one, so that
    is the dated statement of the very figure `amount_paid` caches. With no cut-off nothing is
    dated after '9999-12-31' and the term is zero. Its one stated edge: a **sales return** rebuilds
    its bill's `'payment'` credit and re-dates it to the return date, so a return recorded after
    the cut-off takes that bill's whole receipt out of an as-of figure. The today figure — the one
    reconciled against the drawer — is exact.
  - **With an `asOf` the bank total reads the LEDGER, not `current_balance`.** That column only ever
    describes now, so the dated call sums `SUM(debit - credit)` over `bank_ledger` up to the date.
    That is not a second definition — it is the one `bankBalanceSql()` writes into every rebuild and
    the one `verify_bank_withdrawals.js` pins the cache equal to, simply stopped at a date. The
    **undated** call still reads the cache, so it cannot drift from Overview > Bank.

  The Farm Report shows the pair twice — the cards near the top and a **closing Money Position
  footer** (Cash in Hand, Total Bank Balance, **Total Money**) at the very bottom of the screen and
  as the last block of the PDF, after every section. Both read **one `cashPosition` object**, so one
  page can never print two answers, and both label themselves off `cashPosition.asOf` rather than
  off the form, so a label can never describe a day the numbers were not stopped at. The footer is
  **not a section**: it sits outside every `report` guard and shows 0 / 0 / 0 on an empty range. Total bank balance is `SUM(current_balance)` over **house** accounts
  (`customer_id IS NULL`) — the figure Overview > Bank lists; a customer's deposit is not the
  owner's money.

  **The cash rule is the exact complement of the bank mechanism**: a row moves cash when
  `payment_source <> 'bank'` (so no `bank_ledger` entry exists for it) **AND** its own
  `payment_type` says the money changed hands in cash. **`payment_source = 'cash'` alone is NOT the
  test** — `bankSourceFields()` writes it for every non-bank row *including a credit one*, so a
  credit sale, an unpaid wage and an unpaid purchase order all carry it while having moved nothing.
  A `'cheque'` expense and a legacy `payment_type = 'bank'` row with no account are in **neither**
  total, which is honest: nothing was posted for them and nothing left the drawer.

  **The customer side is the subtle half.** `bills.amount_paid` is raised through FOUR doors — the
  bill's own receipt, a Customer Ledger payment, a receive voucher, an internal settlement — so it
  is counted **once, in full**, and the bank-attributed part is deducted. Adding
  `receive_vouchers.amount` alongside it counts a voucher twice. That is also the only route by
  which a Customer Ledger payment is counted at all: `customer_ledger` has no `payment_source`, so
  such a payment has no recorded source and is cash by the same default as everywhere else.

  Where each correction is read from, and **why the source matters**:
  - a bill's **house receipt** and a **deposit-paid** bill off `bank_ledger`
    (`bill_payment_in` debits; `'payment'` credits on a *customer* account) — not off `bills`,
    because `amount_paid` may have grown since and deducting it would take back more than the bank
    got;
  - a **bank refund** on a sales return added BACK (`'return'` credits on a customer account) —
    it lowered `amount_paid` without touching the drawer; a *cash* refund has no entry and
    correctly does reduce cash;
  - **receive vouchers** and **internal settlements** off their OWN tables. This one is
    load-bearing: a settlement whose two ends are the SAME account writes **zero** ledger rows by
    design, so a `bank_ledger`-driven deduction would find nothing and credit the drawer with money
    that never left the bank.

  Internal settlements therefore appear twice and net correctly — FROM side out when
  `from_account = 'cash'`, TO side inside `bills_paid_in` and removed again when
  `to_account = 'bank'`. Cash→Cash and Bank→Bank (same account **or** different) move neither
  total; Bank→Cash and Cash→Bank move both by the amount with their **sum unchanged**.

  **THE FARM REPORT PRINTS A PER-FARM CASH FIGURE, AND IT IS A DIFFERENT QUANTITY.**
  `getFarmCashPosition(farmId, module, unitId, asOf)` returns `farmCashInHand` — the net cash ONE
  farm's own recorded transactions produced, from its own `farmCashSql(module)`: four terms on the
  broiler side (sales, manual income, expenses, labour) and five on the layer side (egg sales, hen
  sales, manual income, expenses, labour), each joined to `flocks`/`batches` and filtered by
  `(? IS NULL OR u.unit_id = ?)` so the statement never changes shape.

  It is a SEPARATE METHOD, not a parameter on `getCashPosition()`, because it answers a different
  question — and `cashSql()` is untouched, so the account-wide figure Overview and the Distribution
  Report read is byte-for-byte the one it always was. Every account-level term is simply absent from
  the per-farm figure: `bills`, `purchase_orders`, both voucher tables, `expense_ledger`, `assets`,
  `asset_payments`, `personal_expenses`, `internal_settlements`, the loans and every bank
  correction belong to no single farm, and attributing any of them to one would be an invention.
  So the two figures are NOT expected to agree and must never be added together — which is why the
  Farm Report's card and footer say "Cash from ‹farm›", name the scope in their notes, and keep the
  BANK half labelled as the whole account (a bank account belongs to the owner, not to a farm).
  `verify_cash_and_bank_totals.js` section M covers it.

  **`feed_entries`, `medicine_entries`, `chick_entries`, `vaccinations`, `ledger_entries` and
  `layer_ledger_entries` are NOT counted** and have no term: they carry no payment column of any
  kind, so there is nothing to claim they were paid in cash with. This is why the figure is a cash
  *position* and the cards say "from recorded cash transactions" — real spending it cannot see.
  Give one of those tables a `payment_source` and it gets a term. Adding a term means a key in
  `cashSql()` and a row in `EXPECTED_KEYS` in the verify script, which asserts the list is exactly
  complete so a dropped term fails there rather than silently vanishing from the client's cash.
  `scripts/verify/verify_cash_and_bank_totals.js` lifts the whole service and asserts every table's
  delta, the credit/cheque/mirror/legacy exclusions, both deletes, all five settlement shapes, the
  account-collision cases and the closing reconciliation; its **section L** covers the cut-off —
  inclusive of its own day on both the cash and the bank side, 0/0 before everything, identical to
  the undated call after everything, and a receipt dated past the cut-off not counted. Run it if
  you touch any of this. The script lifts `AS_OF_PARAM` out of the source rather than retyping it,
  so a renamed token fails there instead of binding a `farm_id` where the date belongs.
  `cash-position.service.ts` is on the **BOTH KINDS** list in
  `verify_layer_sales_customers.js` — an egg sale collected on credit is cash in hand exactly as a
  distribution bill is.

  **MOVING CASH BETWEEN THE DRAWER AND A HOUSE ACCOUNT IS A TRANSFER, and both
  halves are now recorded.** The client banked cash and watched Total Bank
  Balance rise while Cash in Hand did not move: Overview > Bank writes its
  `bank_ledger` row through `addBankLedgerEntry()`, the balance follows, and no
  cash term read those rows — so the money left the drawer as far as he was
  concerned and nowhere as far as the app was. `bank_manual_deposit_out` and
  `bank_manual_withdrawal_in` are that cash side, and the invariant is the
  transfer one: **the two totals move by the same amount in opposite
  directions, so cash + bank is UNCHANGED.**

  `reference_type` is what makes those rows readable as a transfer: 'deposit'
  and 'withdrawal' are stamped only by the Bank Ledger screen's own form, every
  other writer stamps its own type and is already covered by its own term, and
  that form is the only way in this app to move money between the drawer and an
  account. **'opening' is EXCLUDED and must stay excluded** — an opening balance
  is the account's starting state, not money that crossed from the drawer, and
  counting it would show an account opened with Rs 500,000 as Rs 500,000 of cash
  spent. A NULL or empty `reference_type` is excluded too: nothing writes one
  today, so any that exist predate this and their intent is unrecorded — the
  same structural exemption legacy `payment_source` rows get. **House accounts
  only** (`customer_id IS NULL`): a deposit into a customer's deposit account is
  that customer's money arriving, not the owner's cash leaving.

  This reads EXISTING manual deposits as cash movements — there is no flag to
  distinguish them, because there was never anything else they could have been.
  The deposit/withdrawal form now says its cash effect outright above the
  amount, so a future entry cannot be made without knowing. Section N of
  `verify_cash_and_bank_totals.js` asserts all of it, including both deletes,
  the opening-balance case and the legacy exemption.

- **THE FROM/TO FILTER ON THE TWO LEDGER STATEMENTS NARROWS ROWS AND NOTHING
  ELSE.** `date-range.util.ts` is the one implementation, used by
  `customer-ledger.component.ts` and `supplier-ledger.component.ts` through a
  `visibleEntries` getter; the statement table, the payment-history table and
  the printed PDF all read that, and **every summary figure goes on reading the
  full `ledgerEntries`**. Two reasons, and both matter more than the
  convenience:

  - A payable or a receivable is **what is owed NOW**, not a flow across a
    window — the same reason the Distribution report's two outstanding cards sit
    outside its date filter. A supplier's payable is `SUM(credit - debit)` over
    the WHOLE ledger with nothing behind it, so a filtered sum is a different
    quantity wearing the same label.
  - The Supplier Ledger's summary block is an IDENTITY:
    `purchased + other charges - paid - returned = payable`. Filtering four of
    those five terms breaks it on screen; filtering all five prints a payable
    the client cannot reconcile against what the supplier says he is owed.

  The `balance` column is likewise untouched: it is computed in SQL as the
  running total over every earlier row, so a listed row keeps showing the true
  balance as at its own date even when the rows before it are hidden — which is
  what makes a printed period statement correct rather than merely plausible.
  Dates compare as `YYYY-MM-DD` STRINGS (lexicographic order is chronological),
  with the day sliced off a value that carries a time, so a row dated on the To
  day stays in its own range. Both bounds are inclusive; an empty pair admits
  everything, so an unfiltered screen behaves exactly as before. The PDF names
  the range in its header and labels the summary "SUMMARY (all transactions)"
  when the rows above it are filtered. Asserted in `verify_supplier_tracking.js`.

- **A READ THAT NAMES ITS COLUMNS CAN SILENTLY DROP ONE, and
  `getSupplierLedgerWithBalance()` did.** `supplier_ledger.notes` was written by
  Payment Voucher and by the Supplier Ledger's own payment form, the ALTER was
  there, the template rendered it and the PDF printed it — and that statement
  selects an explicit column list that did not include `l.notes`, so every row
  showed a dash. Nothing caught it because `verify_vouchers.js` asserted the
  note on the VOUCHER row and its own test helper did not forward `notes` to
  `savePaymentVoucher()` the way the screen does, so the ledger row never
  carried one either. It now asserts the note through the SCREEN'S OWN READ,
  which is the only assertion that would have failed. **Any new column on a
  table these screens read has to be added to that read as well as to the
  ALTER** — `SELECT *` would have carried it, an explicit list will not.

- **A PURCHASE ORDER REQUIRES A SUPPLIER.** `addToSupplierLedger()` returns
  early when there is none, so an order saved without one brought the stock in
  and recorded the money owed to NOBODY: no `supplier_ledger` credit, nothing on
  any statement, and nothing in the payable the Distribution report prints — an
  unpaid order simply vanished from what the farm owes. Refused on the new-row
  save (per row, named by row number) and on the edit, where clearing it would
  delete the supplier's ledger row. The empty option reads "Select supplier",
  not "—", because it is not a legitimate "none".

- **`debt_records` IS A NOTEBOOK AND IS CONNECTED TO NOTHING. DO NOT WIRE IT IN.** Overview > Debt
  Payment (route `debt-payment`, `src/app/debt-payment/`) is somewhere for the client to write down
  who took money off him and disappeared. He asked for a place to REMEMBER, not a place to account
  for money, and that is also the only honest option: the app has no idea whether the money written
  down here ever moved through a drawer or an account. If it did, some other screen already recorded
  it and counting it again would double it; if it did not, counting it would invent a rupee that
  never existed.

  So: no `payment_source`/`bank_id` columns, no `BANK_SOURCES` entry, no `bank_ledger` row, no
  overdraw guard, no `runBatch`, no term in `cash-position.service.ts`, no card on the dashboard, no
  line in any report, and no delete cascade (it is `farm_id`-scoped, so no flock or batch close
  reaches it). The four service methods are the dullest in `database.service.ts` and must stay that
  way. The three totals the screen shows are summed over its own rows and go nowhere.

  **It is NOT the Loans screen and the difference is the whole point.** Overview > Loans records
  money that really moved — Cash/Bank selector, `bank_ledger` entries, overdraw guard, four cash
  terms. A loan is a transaction; this is a memo. If the client wants a figure here to start
  affecting his cash, the row belongs on Loans, not a change to this screen.

  `scripts/verify/verify_debt_records.js` makes the inertness a CHECKED property rather than a
  comment: it walks every `.ts`/`.html`/`.scss` under `src/` and fails if any file outside the
  screen and its own four methods so much as names the table, and it writes, edits and deletes rows
  against a database with real money in it and asserts Cash in Hand, every bank balance, every cash
  term and fourteen Overview revenue/expense/profit queries all move by exactly zero. If a change
  makes it fail, re-read the class comment in `debt-payment.component.ts` before touching the
  script.

- **A LOAN IS NEVER INCOME AND NEVER AN EXPENSE. `loans` / `loan_payments` touch the cash and bank
  position and two Overview cards, and NOTHING else.** Money the owner lent out and money other
  people left with him (Overview > Loans, route `loans`, `src/app/loans/`). Lending Rs. 100,000
  makes him no poorer and no richer — it moves the money out of the drawer and into a receivable —
  so no revenue, expense or profit figure on any report may move. `verify_loans.js` section H
  snapshots fourteen Overview revenue/expense/profit queries before and after a large loan each way
  plus settlements on both, and asserts not one of them moved. Keep it that way.

  **ONE TABLE WITH A `direction`, not two tables.** `'given'` is a RECEIVABLE (he lent it);
  `'received'` is a PAYABLE (he is holding it, or borrowed it). The two sides are the same five
  facts and differ only in which way the money went, so a direction column keeps one screen, one
  outstanding derivation and one reversal path. The column is `NOT NULL DEFAULT 'given'`, and every
  read COALESCEs it anyway.

  **WHICH WAY THE MONEY MOVES IS A PROPERTY OF THE ROW, WHICH IS WHY THIS IS NOT A `BANK_SOURCES`
  TABLE:**

  | direction | the principal | a settlement against it |
  |-----------|---------------|--------------------------|
  | `given` | money OUT — credit, `WD-` | money IN — debit, `DEP-` |
  | `received` | money IN — debit, `DEP-` | money OUT — credit, `WD-` |

  `BANK_SOURCES` declares ONE direction per table, so loans take the named-path shape `assets` and
  `internal_settlements` have, with two reference types: **`LOAN_REF` (`'loan'`)** keyed to
  `loans.loan_id` and **`LOAN_PAYMENT_REF` (`'loan_payment'`)** keyed to
  `loan_payments.payment_id`. Two rather than one because every reversal reads `bank_ledger` by
  `(reference_type, reference_id)` and the two primary keys are separate AUTOINCREMENT sequences
  that both start at 1 — the `bills.source`/`source_id` collision again. Within one type there is
  exactly one entry per row, so a reversal is a single DELETE.

  **`outstanding` is DERIVED on every read** — `MAX(principal - SUM(settlements), 0)` — and there is
  no stored column, ever. `getLoanTotals()` derives both headline figures off the same expression
  `getLoans()` uses, so the Overview cards and the list behind them cannot print different numbers;
  the same rule the Distribution Report's two outstanding cards follow.

  Standing rules: **house accounts only** (`getHouseBankAccounts()` — lending out of a customer's
  account records it as that customer's withdrawal); **Bank with no account chosen is REFUSED**, not
  quietly saved as cash; a settlement **past square is refused** on the loan's own outstanding
  figure, computed in the service so the screen cannot disagree with it; the **edit reverses and
  re-posts** rather than patching, which covers the transition unique to this table — flipping the
  direction turns a withdrawal into a deposit — with the rebuild deferred over the UNION of the old
  and new accounts; and **a delete is NEVER guarded**, because removing a movement puts the money
  back and refusing it would strand a row that cannot be corrected. A delete may legitimately leave
  an account negative.

  **ACCOUNT-SCOPED, so `loans` is in NO delete cascade** — closing a flock must not forget a debt.
  Same reasoning as the two voucher tables and hand-entered internal settlements.
  `deleteBankAccount()` counts both tables by hand (they are not `BANK_SOURCES` entries) and refuses
  while either names the account. Four `cash-position.service.ts` terms, two each way:
  `loans_given_out`, `loans_received_in`, `loan_repayments_in`, `loan_repayments_out` — each reading
  its OWN row's source, because the client may lend in cash and be repaid by transfer.
  `scripts/verify/verify_loans.js` asserts all of it; run it if you touch any of this.

- **The two outstanding cards on the Distribution Report REUSE the one definition each.**
  `totalCustomerOutstanding` filters the rows `getAllCustomersWithBalance()` already returned
  (`COALESCE(customer_type,'external') <> 'own_farm'`) and sums their `outstanding_balance` — the
  app's single definition of a customer's debt, `SUM(MAX(bills.total_amount - bills.amount_paid, 0))`,
  the same one Customer Ledger, Sales Orders and the cached `customers.outstanding_balance` read.
  `totalSupplierOutstanding` delegates to `totalSupplierPayable`, so the card and the Supplier
  Payables section lower down cannot print different numbers. **Do not add a second query that
  computes either figure another way** — the whole point of the cards is that they agree with every
  other screen. Both are balances **as at today** and are deliberately outside the report's date
  filter, matching `totalSupplierPayable`/`totalOutstandingBalance` beside them: a payable or a
  receivable is what is owed now, not a flow over a period. They print in the PDF **letterhead**,
  before any section, so they appear whichever sections are selected.
  `scripts/verify/verify_distribution_outstanding_cards.js` lifts the real reads and the real
  getters and asserts all of it; run it if you touch any of this.

- **CHICKS ARE THEIR OWN TABLE AND THEIR OWN SCREEN, exactly like feed and medicine. The chick
  purchase is NOT on the Add Flock row any more — do not put it back.** It was there briefly
  (`chickExpenseOp()` in `flock-management.component.ts`, one `expenses` row under category
  'Chicks') and the client asked for it removed: chicks are bought the way feed and medicine are, so
  they are recorded the way feed and medicine are. The Add Flock row is flock fields only.

  `chick_traders` / `chick_entries` mirror `feed_traders` / `feed_entries` column for column —
  `module_type`, and the `flock_id`-column-holds-a-`batch_id` convention — so every read pairs the
  id with the module and both delete cascades take them. The screen is `src/app/chicks/`, route
  `chicks`, resolver `chicks.resolver.ts`, sidebar item on the **broiler** menu only. It is
  module-aware all the same, because Distribution can bill a 'chicks' product to a layer batch.

  **Rows arrive two ways, which is the whole point.** Typed on the screen against a hatchery the
  client adds himself, or sent over from DISTRIBUTION: `products.category` drives which farm-side
  table an own-farm bill writes to, and `'chick'`/`'chicks'` now joins `'medicine'`, `'feed'` and
  `'vaccine'` in that branch (`sales-orders.component.ts`, and the matching rebuild in
  `sales-returns.component.ts`). Those land under the trader `'Internal Distribution'` and carry
  their `bill_id`, like every other transferred row. `internal_transfers.target_type` is
  `'chick'` — the same string `qTraderEntries()`/`specTraderEntries()` use as their `kind`, which is
  what keeps the elimination matching.

  **Chick cost is its own line everywhere, and nothing was double-counted by adding it.** A chick
  purchase recorded as an ordinary `expenses` row before this — including every row the old Add
  Flock form wrote — still is one, counted once inside Total Expenses exactly where it was. The new
  line reads `chick_entries` and nothing else. Consumers: `report.component.ts` (`totalChicks`, a
  section and a PDF page), `layer-report.component.ts` (`totalChickAmount`),
  `overview.service.ts` (`expenses.chicks`, in `total` and `byModule`) and
  `farm-report.service.ts` (`expenses.chicks`).

  **The quantity is a multiplicand, not a bird count.** There is still no `flocks.initial_birds`;
  broiler birds-placed is derived from `flock_health.total_birds` on the flock's earliest day, which
  is what the Report and the Farm Report both read. A population figure here would be a second,
  competing answer to the same question.

- **An "Add …" sidebar item is a SHORTCUT onto an existing screen, never a second form.**
  `flock-management` and `batch-management` each subscribe to `?add=1` in `ngOnInit` and call their
  own `addNewRow()` — the same method their "+ Add Flock" / "+ Add Batch" button calls, so there is
  one add path and one save path per module. **Only the LAYER menu carries such an item now
  ("Add Batch"): the broiler "Add Flock" one was removed at the client's request.** The `?add=1`
  handler stays on `flock-management` — it is a valid deep link and the two screens stay the same
  shape — but nothing in the sidebar points at it. The layout's `navigate()` stamps a nonce onto those
  params, because Angular ignores a navigation to the URL it is already on and a repeat click must
  reopen the form. The shortcut shares its route with the management item beside it, so the sidebar
  gives the active state only to the item with no `queryParams`. Add another shortcut the same way;
  do not copy a form.

- **A STOCK BATCH NUMBER IS TYPED BY THE CLIENT, NOT GENERATED.** `addBatch()` still has its
  `BATCH-<product>-<n>` fallback for a caller with nothing to pass, but the Purchase screen now
  carries a **required** Batch No. field and every path on it passes one: the new-row save, the
  product-changed branch of the edit, and the legacy quantity-increase branch. He reads these off
  the sack and off the supplier's own paperwork, and a generated `BATCH-003-007` is a number that
  exists nowhere outside this app.

  **One batch number per product, checked before the transaction opens.** Two batches of one product
  sharing a code are indistinguishable everywhere the code is shown — the batch picker on Sales
  Orders, the expiry warnings, the Inventory drill-down — and FIFO would then draw from "the" batch
  the client cannot identify. `findBatchCodeClash()` tests the pending rows against each other AND
  against what is stored, case-insensitively and trimmed, and names the clash in the refusal.
  `updateBatch()` learned `batch_code` (in both processes) so a mistyped one is corrected on the
  order that wrote it, and the orders read carries `product_batches.batch_code` through a LEFT JOIN
  so the column shows what was typed rather than deriving it a second way. The table is 12 columns
  now; header, pending row, view branch and edit branch all count 12.

- **EVERY DRILL-DOWN SCREEN UNDER ACCOUNT LEDGER HAS A BACK LINK AT ITS LIST LEVEL.** Each already
  had one at its DETAIL level — out of one customer, one supplier, one bank account, back to the
  list — and none had one a level up, so there was no way back to the Account Ledger dashboard
  except clicking the sidebar item again, which is what the client was doing.
  `shared/components/back-link/back-link.component.ts` (`<app-back-link>`) is on the list level of
  Customer Ledger, Supplier Ledger, Supplier Accounts, Expense Ledger and the CUSTOMER-scope Bank
  Ledger. It is a component rather than five copies of an `<a>` because `.btn-back` is styled
  separately in each of those screens' own stylesheets and view encapsulation means a child cannot
  pick those up; and it navigates absolutely to `/app/<to>` rather than calling history `back()`,
  which would depend on how the user arrived. **Overview > Bank deliberately has none** — same
  component, same two routes, but that one is a top-level sidebar item with no parent to return to
  (`*ngIf="!selectedBank && !isHouse"`).

- **A product that has been traded CANNOT be deleted — its cost history is what the reports read.**
  Cost of goods sold is `batch_transactions` joined to `product_batches.purchase_price`
  (`qDistributionCogs` in `overview.service.ts`, the same shape in
  `distribution-report.component.ts`), and bill lines those draws do not cover are re-priced off the
  `products` row itself (`productRateCte`). Deleting a sold product therefore does not remove a name
  from a list — it removes the cost side of bills already counted, so reported profit moves with
  nothing on screen to say why. Inventory used to do exactly that in two unchecked `run()` calls that
  also never touched `batch_transactions`, leaving rows pointing at batches that no longer existed
  (nothing cascades — `PRAGMA foreign_keys` is never on).

  `deleteProduct()` in `database.service.ts` is the rule, and it matches `deleteBatch()` one level
  down, which already refuses to hard-delete a batch that has transactions. **Refused** on any record
  outside the product's own stock-keeping: a `bill_items` line, a `sales_return_items` line, a
  `purchase_orders` row, a legacy `sales_orders` row, or a `batch_transactions` row whose type is not
  `'purchase'` (i.e. `'sale'`, `'return'`, `'adjustment'`). The message names what is blocking, with
  counts. **Cascaded** otherwise — the product, its batches and the `'purchase'` rows recording stock
  into them, which no report reads as a cost — in one `runBatch`, transactions first, and scoped by
  `farm_id`. Add a table that references `products.product_id` and it belongs in that blocker query.
  `scripts/verify/verify_product_delete.js` asserts all of it, including that a refused delete leaves
  Overview's COGS untouched while the old cascade moved it; run it if you touch any of this.

- **SUPPLIER LEDGER AND SUPPLIER ACCOUNTS ARE SIBLINGS — do not merge or replace either.**
  A bank statement and a bank account screen. `supplier-ledger.component.ts` (routes
  `supplier-ledger`, `supplier-ledger/:id`) is the row-by-row statement with a running balance, and
  it owns the manual cash payment form and the line delete. `supplier-accounts.component.ts`
  (`supplier-accounts`, `supplier-accounts/:id`, no resolver — it loads in `ngOnInit`) is the
  entity view: one card per supplier (name, purchased, paid, outstanding payable, last transaction
  date), click to drill into that one supplier's summary, purchases, payments, account breakdown
  and full statement. The customer side has the same pair.

  **THE NEW SCREEN DERIVES NOTHING OF ITS OWN**, which is the whole reason it is safe to have a
  third door onto the payable. Cards read `getAllSuppliersWithBalance()`; the drilldown's summary
  is `supplierTotals()` over the very rows its statement table lists; the breakdown is
  `getSupplierPaymentsByAccount()`. All three already existed. The payable stays
  `SUM(credit - debit)` over `supplier_ledger` — still no `suppliers.outstanding_balance`, ever.
  Its only own SQL is the per-supplier `MAX(transaction_date)` for the card and the supplier's
  `purchase_orders` rows for the Purchases list.

  **IT IS READ-ONLY, and the verify script asserts that.** "Record Payment" navigates to
  `/app/payment-voucher?supplierId=<id>&t=<nonce>`, which that screen honours in `ngOnInit` by
  awaiting its own `loaded` promise and then going through `openForm()`/`onSupplierChange()` — so a
  prefilled payable is the same figure a hand-picked supplier gets, and an id that is not this
  farm's selects nobody. The voucher is the one supplier-payment door that attributes a bank
  account (it writes the `supplier_ledger` debit and the `bank_ledger` withdrawal in one batch), so
  a payment form on the accounts screen would either duplicate it or offer Bank with nothing to
  post the withdrawal to. The nonce is the sidebar Add-shortcut trick: Angular ignores a navigation
  to the URL it is already on.

  `scripts/verify/verify_supplier_accounts_screen.js` lifts the screen's real `loadSuppliers()`,
  `loadSupplierDetail()`, getters and `recordPayment()` and asserts the cards equal the SQL, the
  drilldown's statement is row-for-row and balance-for-balance the Supplier Ledger screen's, the
  reconciliation holds per supplier, the hand-off prefills correctly, and the farm scoping holds on
  a colliding id. Its **section J is the only check in this repo that reads an `.html` file**: it
  counts the cells of every row branch against each `<thead>`, which is the one class of bug no
  other script here can see. Run it alongside `verify_supplier_tracking.js` if you touch any of
  this.

- **`supplier_ledger` HAS A `notes` COLUMN, AND `description` IS NOT IT.** `description` is what the
  row IS — "Purchase Order #12", "Payment Voucher PV-0003 — Al-Fateh Traders" — and every writer
  composes it, so it is not a field the client can use. `notes` is his: the cheque number, who
  collected, what the payment was against. Payment Voucher captured one and had nowhere to put it,
  so it reached `payment_vouchers` and stopped there — which is exactly what the client noticed was
  missing from the statement he actually reads.

  `supplierLedgerEntryOp()` appends `voucher_id` and `notes` as OPTIONAL TRAILING COLUMNS, in a
  fixed order, each only for a caller that has one — so a purchase order's own ledger row emits the
  statement it always did, column list and parameter count included. The Notes column renders on
  the Supplier Ledger statement, its Payment History, its PDF, and both tables of Supplier
  Accounts. The Supplier Ledger payment form's existing free-text field was relabelled
  **Description** (it always fed `description`) and a second **Notes** field added beside it.

- **A BANK SALE CAN CLEAR THE FARM'S OWN-FARM DEBT, AND THE BANK STILL MOVES BY THE SALE ALONE.**
  Distribution bills a flock or batch for the feed it sent (an own-farm bill, `payment_type =
  'internal'`); the farm carries that debt until it is settled. All three sale screens —
  `sale.component.ts` (broiler), `egg-sales.component.ts`, `hen-sales.component.ts` — now offer to
  settle it at the moment the sale is saved, as a **same-account internal settlement** written in the
  **same `runBatch`** as the sale.

  It fires when all three hold: the row is **banked** (`payment_source = 'bank'` with an account),
  the row's flock/batch maps to an **own-farm customer with debt > 0**, and the **Auto-settle
  checkbox is ticked** (default ticked). The amount is `min(sale total, total unpaid debt)`, allocated
  **oldest bill first**. **A cash sale never auto-settles** — the mechanism keys the settlement to a
  named account at both ends, and cash goes on being settled by hand on the Internal Settlement
  screen.

  **THE TWO THINGS THAT MUST STAY TRUE:**

  - **The bank moves by the SALE amount, never `sale − settled`.** FROM and TO are the same account,
    so `moved` is false in `saveInternalSettlement`'s terms and **not one `bank_ledger` row is
    written** for the settlement. A 1,50,000 sale against a 50,000 debt leaves the account 1,50,000
    higher with the debt cleared: the owner's money never left his account, one of his businesses
    just stopped owing the other. Writing a credit and a debit on one account and trusting them to
    cancel is arithmetically equal and structurally wrong — see the Internal Settlement rule above.
  - **Overview profit does not move.** An own-farm bill is eliminated on its whole `total_amount`
    regardless of what has been settled, so the owner cannot manufacture profit by billing himself
    and then paying himself. The **Distribution report's collected-basis revenue DOES rise** by the
    settled amount, which is correct and already how own-farm bills behave there.

  **It is the same settlement, reached through a fourth door.** The bills, the `customer_ledger`
  credits and the balance recompute are `customerSettlementOps()` — the same FIFO the Customer
  Ledger screen, the Receive Voucher screen and the Internal Settlement screen run, tagged with
  `internal_settlement_id` exactly as the third door tags it. `buildAutoSettleOps()` in
  `database.service.ts` composes the settlement row around it and hands back
  `{ ops, settledAmount, clearedBillIds, allocations, bills }` for the caller to splice into its own
  batch — the sibling of `saveInternalSettlement()`, which runs its own batch and therefore cannot
  be used here. **`internal-settlement.component.ts` is unchanged**, and must stay so:
  `verify_internal_settlements.js` lifts its `IS-%` numbering SQL out of it as text.

  Details that are load-bearing:

  - **The settlement row is op[0] of what the helper returns**, and `base_index` is where that lands
    in the caller's batch, so the ledger credits carry `internal_settlement_id: { $lastId: base_index }`
    — an absolute index, as `layerReceivableOps()` takes one.
  - **`reference` is a PREFIX concatenated in SQL** (`? || ?` with `{ $lastId: saleOp }`), because the
    sale's id does not exist in TypeScript yet. Built in TS it would read
    `'Auto-settled from Broiler Sale #'` with no number on it. Same trick, same reason, as the layer
    receivable's description.
  - **`settlement_number` is generated IN SQL** (`nextSettlementNumberSql()`, the
    `nextLayerBillNumberSql()` idiom). One save can write several settlements into one batch and a
    TypeScript-side `MAX + 1` would give them all the same number; each INSERT does see the previous
    one's row.
  - **The unpaid bill list is threaded from row to row** (`settleBills` on each screen, `bills` in
    and `bills` out of the helper). Every read happens before any statement runs, so a second row
    banked into the same farm's debt would otherwise allocate against the first row's stale
    `amount_paid` — the forward twin of `customerUnwindOps()`'s shared `takenBack`.
  - **No overdraw guard, and none is needed**: a settlement that writes no ledger row cannot take an
    account below zero. Same derivation `saveInternalSettlement()` already makes off `moved`.
  - **The own-farm customer is found by FARM UNIT, never created.** `getOwnFarmDebtByOwner(farmId,
    'flock' | 'batch', ownerIds)` joins `flocks`/`batches` to `customers` on `unit_id` (both-NULL
    included), the same keying `resolveOwnFarmCustomerId()` uses. No debt means no customer to settle
    with; a sale screen inventing one would put a customer on the Customer Ledger for a farm that has
    never been billed.
  - **`internal_settlements.auto_source_table` + `auto_source_id`** (nullable, added by idempotent
    ALTER, indexed) are how a sale delete finds its settlement. **Both** columns, because
    `sales.sale_id`, `egg_sales.egg_sale_id` and `hen_sales.hen_sale_id` are three AUTOINCREMENT
    sequences that all start at 1 — the `bills.source` / `source_id` collision and the same fix.
    `deleteAutoSettlementFor(source, saleId)` reverses through `deleteInternalSettlement()`, called
    inside each screen's existing `db.transaction()` **before** the sale's own delete, where its
    `runBatch` becomes a SAVEPOINT. A settlement the client already deleted by hand is simply not
    found, and the sale still deletes.

  **EDITING A SALE'S AMOUNT DOES NOT RESIZE OR REMOVE THE AUTO-CREATED INTERNAL SETTLEMENT. The
  settlement cleared the debt at the moment the sale was saved. To change it, delete the sale (which
  deletes the settlement too) and re-enter. This is a known limitation, not a bug.** The same holds
  for a changed payment source: on `bank → cash` or `bank A → bank B` the existing edit path reverses
  and re-posts the sale's **own** deposit and leaves the settlement alone. Nothing on the edit path
  calls `buildAutoSettleOps` at all.

  **AN AUTO-SETTLEMENT IS SALE-SCOPED, SO IT IS IN BOTH DELETE CASCADES — and it is the only
  settlement that is.** This is the one place the auto path differs from the three doors a human
  drives, and the difference is the whole reason it needs stating. A hand-entered settlement and a
  receive voucher are **account-scoped**: the client typed them, they stand on their own, and
  `closing a flock must never un-settle a receipt` still holds for them exactly as before. An
  auto-settlement is not: it carries the sale's own primary key in `auto_source_id` and was written
  in the same `runBatch` as that sale's bank deposit, as one event.

  Leaving it standing clears a debt from nothing, because a same-account settlement writes **no**
  `bank_ledger` row — the sale is the only thing that ever funded it:

      HBL = X,                   own farm owes 50,000
      bank sale 150,000          HBL = X + 150,000, owes 50,000
      auto-settlement            HBL = X + 150,000, owes 0      (no bank row)
      flock closed               HBL = X,           owes 0      <-- paid from nothing

  The cascade already reverses the deposit (`bankCascadeReversalOps`), so keeping the settlement
  reverses one half of an event and keeps the other — the asymmetry the cell-count landmine's cousin,
  "THE CASCADE IS THE PATH WITH NO FORM", exists to warn about. So
  `autoSettlementCascadeReversalOps(source, scopeSql, scopeParams)` returns the ops to run **ahead
  of** the deletes (it reads the settlements and their ledger rows while they are all still there),
  and both `flock-management.component.ts` (`'broiler_sale'`) and `batch-management.component.ts`
  (`'egg_sale'` and `'hen_sale'`) pass the **identical** scope clause they then delete the sales by —
  module guard included, without which a flock close would un-settle the colliding batch's sales.

  **ONE SHARED `takenBack` ACROSS EVERY SETTLEMENT IN SCOPE**, not just within one. Each sale settles
  whatever was still owing, so two sales of one flock can both have drawn on one bill; every read
  happens before any returned statement runs, so without the shared accumulator each would be
  credited from that bill's original `amount_paid` and give back more than it holds.
  `deleteInternalSettlement()` shares one per settlement; this shares one per cascade — the same rule
  one level up. The give-back itself is still `customerUnwindOps()`, the single implementation.

  **The bill survives the flock, correctly.** `bills` is farm-scoped and an own-farm customer is keyed
  to the farm **unit**, so the debt comes back onto a farm that still exists and can be settled by
  hand later. The flock's own cost rows go with the flock, as they always did.

  The checkbox is **one bar per screen, above the rows table and outside every table** — a cell added
  to a table is the one defect no script in this repo can see (see the cell-count landmine above). It
  reads `☑ Auto-settle Rs. 50,000 to Distribution from HBL Main — Mian Ahmed`, the account named by
  `bankOptionLabel()`, and its figure comes from a getter that **walks the pending rows exactly as the
  save does**, so the preview cannot disagree with what is written. Shared styling lives in
  `shared/styles/_autosettle-bar.scss`.

  **`sale.component.ts` is `OnPush`, and the bar needs `(ngModelChange)="onRowAmountChange()"` on
  every control it reads** — both weights, the rate and the Cash/Bank selector. Without it the getter
  is not re-read as the row is typed: the figure lagged a keystroke behind, and worse, switching a row
  back to **Cash left the bar on screen**, the one state it must never appear in. Confirmed in the
  real app over CDP, which is the only way to see it — no verify script renders a template. The two
  layer screens use default change detection and need nothing; the account dropdown is
  `app-bank-picker`, a child component, and already ticks.
  `scripts/verify/verify_auto_settlement_on_sale.js` asserts all of it — both invariants after every
  shape, the four bounds, the FIFO against the allocation a Receive Voucher produces for the same
  input, opt-out, cash, no-customer, no-debt, the delete, all three screens, the colliding ids, the
  parameter order of all four INSERTs under sentinels, and **section J: both cascades, the shared
  give-back across two settlements that drew on one bill, the account-scoped settlement they must
  leave alone, and the colliding flock/batch ids**. Run it if you touch any of this.

Note that `layer_health` is deliberately its own table rather than layer rows inside `flock_health`
under the "flock_id holds a batch_id" convention above. That convention is only safe for tables
carrying `module_type`; `flock_health` has none, and all its queries filter `flock_id` alone, so a
batch filed there would surface inside the broiler flock with the colliding id. The day-index and
cumulative-window arithmetic both screens need lives in `shared/utils/health-day.util.ts`, and their
shared styling in `shared/styles/_health-table.scss`.

**`layer_ledgers` / `layer_ledger_entries` follow exactly that pattern**, for exactly that reason.
`ledgers`/`ledger_entries` are keyed on `flock_id` and carry no `module_type` either, so the layer
Ledger screen got its own batch-keyed pair rather than a retrofitted column — which would have meant
the table rebuild this codebase has learned not to do. **Do not add `module_type` to
`ledgers`/`ledger_entries`.** Because the keys live in different tables, nothing here needs a guard:
a `batch_id` and a `flock_id` never meet in one column, so no delete and no read can cross over.
The layer pair also has **no `source` column** — that column exists on `ledger_entries` only to mark
the expense mirrors the old Expenses screen wrote, and nothing auto-files anywhere any more, so
there is no second kind of row to tell apart. Consumers, all four reading `type = 'debit'` and
nothing else: `layer-ledger.component.ts` (the screen, no resolver), `layer-report.component.ts`
(`totalLedgerDebit`, subtracted in `netProfitLoss`), `overview.service.ts` (`qLayerLedgerDebits`,
into `layerExpenseTotal` and the per-farm layer breakdown) and `farm-report.service.ts`
(`specLayerLedgerDebits`, picked by module). The two screens share one stylesheet,
`shared/styles/_ledger-screen.scss`. `batch-management.component.ts` deletes entries then ledgers
inside its existing `runBatch`. `scripts/verify/verify_layer_ledger.js` asserts the partition, that
the colliding broiler flock is untouched by every layer write and by the batch delete, and that no
cost is counted twice; run it if you touch any of this.

Also worth knowing: passwords in `auth.service.ts` and license codes in `main.js` use a 32-bit
string hash, not a cryptographic one. The licensing scheme (`activation` table, machine id,
clock-tamper checks, 7-day cycles) is deliberate — leave it alone unless asked.

## Conventions

- Standalone components, lazy-loaded via `loadComponent` in `app.routes.ts`; all app screens are
  children of `/app` (`layout.component.ts`).
- Route resolvers in `shared/resolvers/` prefetch a screen's data before navigation.
- `FormStateService` persists in-progress form data in `localStorage` across navigation.
- `PendingStateService` caches unsaved draft rows in `sessionStorage`, keyed by component name. On a
  screen shared by both modules (medicine, feed, income) the key **must** carry the module —
  `` `MedicineComponent_${this.moduleType}` `` via a private `stateKey()` — because flock and batch
  ids collide, so an id-only key restored a broiler draft onto layer batch N and saved it into the
  wrong module. The `clearState()` in the flock-change subscription takes the key computed **before**
  `currentFlock` is reassigned, so it clears the draft being switched away from.
- Destructive actions go through `DeleteAuthService` + `delete-code-dialog` (a per-farm PIN stored
  in `app_settings` via the `get/setAppSetting` IPC).
- Reports are generated client-side with jsPDF and printed through the `print-pdf-base64` IPC.
- `.spec.ts` files exist from the CLI scaffold but there is no meaningful test suite.
