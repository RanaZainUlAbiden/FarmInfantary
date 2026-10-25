const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let db = null
// The initSqlJs handle, kept module-scope so a poisoned connection can be
// rebuilt from the last committed file without re-running initializeDatabase()
// (which would re-run every migration). See reloadFromDisk().
let SQL = null

// Local-date formatting for anything stored as a date. `toISOString()` converts
// to UTC, which for PKT (UTC+5) drops any local time before 05:00 onto the
// PREVIOUS day — a batch filed a day early, an expiry a day short, FIFO picking
// the wrong batch. The renderer uses shared/utils/date.util.ts for this; the
// main process has no access to it, so the same rule lives here.
// Timestamps (backup filenames, log lines in main.js) are not affected — only
// values stored as the day a record belongs to.
function toLocalDateString(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// =============================================
// CREATE ALL TABLES
// =============================================
function createTables(db) {
  // ── Core ───────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (
  farm_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (farm_id, key),
  FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
);`);
  db.run(`CREATE TABLE IF NOT EXISTS farms (farm_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_name TEXT NOT NULL, password_hash TEXT NOT NULL, business_type TEXT DEFAULT 'broiler', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`)

  // ── Farm Units ─────────────────────────────────────────
  // The client calls these "Farms". `farms` is already taken by the login
  // account, so the physical-site level between an account and its
  // flocks/batches lives here as farm_units.
  db.run(`CREATE TABLE IF NOT EXISTS farm_units (
    unit_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id     INTEGER NOT NULL,
    module_type TEXT NOT NULL,
    unit_name   TEXT NOT NULL,
    location    TEXT,
    notes       TEXT,
    status      TEXT DEFAULT 'active',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
  );`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_farm_units_farm_module ON farm_units(farm_id, module_type);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_farm_units_status ON farm_units(status);`)

  db.run(`CREATE TABLE IF NOT EXISTS flocks (flock_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, flock_name TEXT NOT NULL, start_date DATE NOT NULL, end_date DATE, status TEXT DEFAULT 'active', unit_id INTEGER, FOREIGN KEY (farm_id) REFERENCES farms(farm_id), FOREIGN KEY (unit_id) REFERENCES farm_units(unit_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS ledgers (ledger_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, ledger_name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS expenses (expense_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, ledger_id INTEGER, ledger_entry_id INTEGER, date DATE NOT NULL, description TEXT, amount REAL NOT NULL, bill_available TEXT DEFAULT 'No', payment_type TEXT DEFAULT 'cash', module_type TEXT DEFAULT 'broiler', payment_source TEXT DEFAULT 'cash', bank_id INTEGER, FOREIGN KEY (flock_id) REFERENCES flocks(flock_id), FOREIGN KEY (ledger_id) REFERENCES ledgers(ledger_id), FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(entry_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS ledger_entries (entry_id INTEGER PRIMARY KEY AUTOINCREMENT, ledger_id INTEGER NOT NULL, flock_id INTEGER NOT NULL, date DATE NOT NULL, description TEXT, amount REAL NOT NULL, type TEXT DEFAULT 'debit', source TEXT DEFAULT 'manual', FOREIGN KEY (ledger_id) REFERENCES ledgers(ledger_id), FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS medicine_traders (trader_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, trader_name TEXT NOT NULL, module_type TEXT DEFAULT 'broiler', FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS medicine_entries (entry_id INTEGER PRIMARY KEY AUTOINCREMENT, trader_id INTEGER NOT NULL, flock_id INTEGER NOT NULL, date DATE NOT NULL, medicine_name TEXT NOT NULL, quantity REAL NOT NULL, price_per_unit REAL NOT NULL, total_amount REAL NOT NULL, module_type TEXT DEFAULT 'broiler', bill_id INTEGER, bill_number TEXT, FOREIGN KEY (trader_id) REFERENCES medicine_traders(trader_id), FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS feed_traders (trader_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, trader_name TEXT NOT NULL, module_type TEXT DEFAULT 'broiler', FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS feed_entries (entry_id INTEGER PRIMARY KEY AUTOINCREMENT, trader_id INTEGER NOT NULL, flock_id INTEGER NOT NULL, date DATE NOT NULL, feed_name TEXT NOT NULL, quantity REAL NOT NULL, price_per_unit REAL NOT NULL, total_amount REAL NOT NULL, module_type TEXT DEFAULT 'broiler', bill_id INTEGER, bill_number TEXT, FOREIGN KEY (trader_id) REFERENCES feed_traders(trader_id), FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  // CHICKS, the same pair of tables as feed and medicine and for the same
  // reason: a purchased input with a supplier, a quantity and a rate, whose
  // cost belongs in the flock's breakdown as its own line. `module_type` plus
  // the `flock_id`-holds-a-`batch_id` convention, so the layer side gets it
  // free if a Chicks item is ever added to that menu.
  // ── DEBT PAYMENT: A NOTEBOOK, CONNECTED TO NOTHING ────────────────────
  //
  // THIS TABLE IS DELIBERATELY INERT. It is the Overview > Debt Payment
  // screen's own store and NOTHING ELSE IN THE APP READS IT — not the cash
  // position, not any bank account or ledger, not Overview's dashboard, not one
  // report, not one delete cascade. The client asked for somewhere to write
  // down who took money off him and disappeared, so that he can remember it. It
  // is a note, not a transaction.
  //
  // WHAT THAT MEANS FOR ANYONE CHANGING THIS: do not give it a
  // `payment_source`/`bank_id` pair, do not add it to `BANK_SOURCES`, do not
  // give it a term in `cash-position.service.ts`, and do not sum it into any
  // figure outside its own screen. The amount here has NOT moved through the
  // drawer or an account as far as this app is concerned — whether it ever
  // really did is exactly the thing the client is keeping a note about. Wiring
  // it in would double-count money that another screen has already recorded, or
  // invent money that was never recorded at all.
  //
  // `scripts/verify/verify_debt_records.js` asserts the inertness: that no
  // other source file reads the table, and that writing rows moves no cash,
  // bank or Overview figure by a single rupee. If a change here is genuinely
  // wanted, that script is the thing to argue with first.
  //
  // Account-scoped (`farm_id`), so no flock or batch close can touch it either.
  db.run(`CREATE TABLE IF NOT EXISTS debt_records (
    debt_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id     INTEGER NOT NULL,
    person_name TEXT NOT NULL,
    phone       TEXT,
    date        DATE,
    amount      REAL DEFAULT 0,
    -- Free text, driven by the screen's own dropdown: 'outstanding' (still
    -- gone), 'recovered' (got it back) or 'written_off' (given up on). It
    -- changes nothing anywhere; it is how he sorts his own list.
    status      TEXT DEFAULT 'outstanding',
    notes       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
  );`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_debt_records_farm ON debt_records(farm_id);`)

  // ── LOANS AND ADVANCES ────────────────────────────────────────────────
  //
  // Money the owner lent out, and money other people left with him. NOT income
  // and NOT an expense on either side — a loan is a balance sheet movement, so
  // nothing here ever enters a profit figure. What it does move is the cash and
  // bank position, and the two outstanding cards on the Overview dashboard.
  //
  // ONE TABLE WITH A DIRECTION rather than two tables. The two sides are the
  // same five facts (who, when, how much, from which account, what is left) and
  // differ only in which way the money went, so a direction column keeps one
  // screen, one outstanding derivation and one reversal path. `direction` is
  // 'given' (he lent it -> a receivable) or 'received' (he is holding it -> a
  // payable).
  //
  // Account-scoped like assets and personal expenses: `farm_id` only, no flock
  // or batch, so NO delete cascade reaches it. Closing a flock must not forget
  // a debt.
  db.run(`CREATE TABLE IF NOT EXISTS loans (
    loan_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id        INTEGER NOT NULL,
    -- 'given' = money lent out (a receivable); 'received' = money being held
    -- for someone, or borrowed (a payable).
    direction      TEXT NOT NULL DEFAULT 'given',
    party_name     TEXT NOT NULL,
    phone          TEXT,
    date           DATE NOT NULL,
    principal      REAL NOT NULL DEFAULT 0,
    notes          TEXT,
    -- How the principal itself moved. 'cash' (the default) posts no bank entry,
    -- which is exactly how it reaches Cash in Hand instead.
    payment_source TEXT DEFAULT 'cash',
    bank_id        INTEGER,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id)
  );`)

  // Every settlement against a loan, in whichever direction that loan runs: a
  // repayment received on a loan GIVEN, or a payment made back on money
  // RECEIVED. Each carries its own source, because the client may lend in cash
  // and be repaid by transfer.
  db.run(`CREATE TABLE IF NOT EXISTS loan_payments (
    payment_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id        INTEGER NOT NULL,
    farm_id        INTEGER NOT NULL,
    date           DATE NOT NULL,
    amount         REAL NOT NULL DEFAULT 0,
    notes          TEXT,
    payment_source TEXT DEFAULT 'cash',
    bank_id        INTEGER,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (loan_id) REFERENCES loans(loan_id),
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id)
  );`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_loan_payments_loan ON loan_payments(loan_id);`)

  db.run(`CREATE TABLE IF NOT EXISTS chick_traders (trader_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, trader_name TEXT NOT NULL, module_type TEXT DEFAULT 'broiler', FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS chick_entries (entry_id INTEGER PRIMARY KEY AUTOINCREMENT, trader_id INTEGER NOT NULL, flock_id INTEGER NOT NULL, date DATE NOT NULL, chick_name TEXT NOT NULL, quantity REAL NOT NULL, price_per_unit REAL NOT NULL, total_amount REAL NOT NULL, module_type TEXT DEFAULT 'broiler', bill_id INTEGER, bill_number TEXT, FOREIGN KEY (trader_id) REFERENCES chick_traders(trader_id), FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS sales (sale_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, date DATE NOT NULL, vehicle_number TEXT, broker TEXT, empty_weight REAL, load_weight REAL, bird_weight REAL, rate REAL NOT NULL, total_amount REAL NOT NULL, payment_type TEXT DEFAULT 'cash', driver_name TEXT DEFAULT '', driver_phone TEXT DEFAULT '', receipt_image TEXT, module_type TEXT DEFAULT 'broiler', payment_source TEXT DEFAULT 'cash', bank_id INTEGER, FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS income (income_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, date DATE NOT NULL, description TEXT, amount REAL NOT NULL, source TEXT DEFAULT 'manual', module_type TEXT DEFAULT 'broiler', payment_source TEXT DEFAULT 'cash', bank_id INTEGER, FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS flock_health (health_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, week_number INTEGER NOT NULL, total_birds INTEGER NOT NULL, mortality INTEGER DEFAULT 0, feed_used REAL DEFAULT 0, avg_weight REAL DEFAULT 0, fcr REAL DEFAULT 0, fcr_manual INTEGER DEFAULT 0, FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS balance (balance_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, date DATE NOT NULL, description TEXT, amount REAL NOT NULL, type TEXT NOT NULL, module_type TEXT DEFAULT 'broiler', FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS brokers (broker_id INTEGER PRIMARY KEY AUTOINCREMENT, flock_id INTEGER NOT NULL, broker_name TEXT NOT NULL, FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
db.run(`CREATE TABLE IF NOT EXISTS activation (machine_id TEXT PRIMARY KEY, activation_code TEXT NOT NULL, trial_start_date TEXT, last_launch_date TEXT, is_permanent INTEGER DEFAULT 0, activated_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_active INTEGER DEFAULT 1,activation_cycle INTEGER DEFAULT 0);`)
  // ── Layer Module ───────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS batches (batch_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, batch_name TEXT NOT NULL, start_date DATE NOT NULL, initial_birds INTEGER NOT NULL, breed TEXT, status TEXT DEFAULT 'active', unit_id INTEGER, FOREIGN KEY (farm_id) REFERENCES farms(farm_id), FOREIGN KEY (unit_id) REFERENCES farm_units(unit_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS egg_collection (collection_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, date DATE NOT NULL, total_eggs INTEGER DEFAULT 0, broken_eggs INTEGER DEFAULT 0, small_grade INTEGER DEFAULT 0, medium_grade INTEGER DEFAULT 0, large_grade INTEGER DEFAULT 0, xl_grade INTEGER DEFAULT 0, collection_mode TEXT DEFAULT 'per_egg', carton_count REAL, eggs_per_carton INTEGER DEFAULT 360, FOREIGN KEY (batch_id) REFERENCES batches(batch_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS egg_sales (egg_sale_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, date DATE NOT NULL, customer_name TEXT, grade TEXT, quantity INTEGER NOT NULL, rate_per_egg REAL NOT NULL, total_amount REAL NOT NULL, payment_type TEXT DEFAULT 'cash', sale_mode TEXT DEFAULT 'per_egg', carton_count REAL, eggs_per_carton INTEGER DEFAULT 360, payment_source TEXT DEFAULT 'cash', bank_id INTEGER, customer_id INTEGER, FOREIGN KEY (batch_id) REFERENCES batches(batch_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS vaccinations (vaccination_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, flock_id INTEGER, date DATE NOT NULL, vaccine_name TEXT NOT NULL, dose TEXT, notes TEXT, cost REAL DEFAULT 0, done INTEGER DEFAULT 0, bill_id INTEGER, bill_number TEXT, FOREIGN KEY (batch_id) REFERENCES batches(batch_id), FOREIGN KEY (flock_id) REFERENCES flocks(flock_id));`)
  // Superseded by layer_health below, which the Flock Health screen now reads and
  // writes. Kept, still created, and never emptied: it is the source the one-time
  // migration copies from, so it stays as the recoverable original.
  db.run(`CREATE TABLE IF NOT EXISTS layer_mortality (mortality_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, date DATE NOT NULL, count INTEGER NOT NULL, reason TEXT, FOREIGN KEY (batch_id) REFERENCES batches(batch_id));`)

  // Layer daily health — the layer counterpart to broiler's `flock_health`.
  //
  // Deliberately its OWN table rather than layer rows inside flock_health under the
  // usual "flock_id holds a batch_id" convention. That convention is safe only for
  // tables carrying `module_type`, which every query then pairs with flock_id.
  // flock_health has no such column and all six of its call sites filter on flock_id
  // alone, so a batch filed there would surface inside the broiler flock whose id
  // happens to collide. Giving flock_health a nullable batch_id instead is no better:
  // flock_id is declared NOT NULL, and dropping that needs the same table rebuild
  // that has been destroying vaccinations data on every launch.
  //
  //   date        the calendar truth (flock_health has no date column and must derive one)
  //   day_number  1-based day since batches.start_date; ordering + cumulative-window key
  //   feed_used / avg_weight  nullable on purpose — migrated rows have no source for them
  //   source_mortality_id     which layer_mortality row a migrated record came from
  db.run(`CREATE TABLE IF NOT EXISTS layer_health (health_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, day_number INTEGER NOT NULL, date DATE, total_birds INTEGER, mortality INTEGER DEFAULT 0, feed_used REAL, avg_weight REAL, notes TEXT, source_mortality_id INTEGER, FOREIGN KEY (batch_id) REFERENCES batches(batch_id));`)
  // A layer batch runs 70+ weeks, so this table reaches 500+ rows per batch and is
  // always read batch-scoped and day-ordered.
  db.run(`CREATE INDEX IF NOT EXISTS idx_layer_health_batch_day ON layer_health(batch_id, day_number);`)
  // Makes a duplicated migration structurally impossible, not merely guarded against:
  // a second copy of any layer_mortality row cannot be inserted at all. Partial, so
  // the many hand-entered rows (source_mortality_id NULL) are unaffected.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_layer_health_source ON layer_health(source_mortality_id) WHERE source_mortality_id IS NOT NULL;`)

  // The layer module's own ledger book — parallel tables keyed on batch_id, the
  // same shape as `layer_health` sitting beside `flock_health`, and for the same
  // reason. `ledgers`/`ledger_entries` are keyed on flock_id with NO module_type
  // column, so a batch filed there would surface inside the broiler flock whose
  // id collides (flocks.flock_id and batches.batch_id are separate AUTOINCREMENT
  // sequences that both start at 1, database-wide). Retrofitting module_type onto
  // those two tables would need the table rebuild this codebase has learned not
  // to do; separate tables need no guard at all, because a batch_id and a
  // flock_id never meet in one column.
  //
  // No `source` column, deliberately. `ledger_entries.source` exists only to mark
  // the expense mirrors the old Expenses screen wrote; expenses and ledgers are
  // fully independent books now and nothing auto-files anywhere, so there is no
  // second kind of row here to tell apart. Manual entries only, like broiler's.
  //
  // farm_id is stored on the ledger (not just reachable through batches) so a
  // list query can filter the login account without a join.
  db.run(`CREATE TABLE IF NOT EXISTS layer_ledgers (ledger_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, farm_id INTEGER NOT NULL, ledger_name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (batch_id) REFERENCES batches(batch_id), FOREIGN KEY (farm_id) REFERENCES farms(farm_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS layer_ledger_entries (entry_id INTEGER PRIMARY KEY AUTOINCREMENT, ledger_id INTEGER NOT NULL, batch_id INTEGER NOT NULL, date DATE NOT NULL, description TEXT, amount REAL NOT NULL, type TEXT DEFAULT 'debit', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (ledger_id) REFERENCES layer_ledgers(ledger_id), FOREIGN KEY (batch_id) REFERENCES batches(batch_id));`)

  // ── Distribution Module ─────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS products (product_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, product_name TEXT NOT NULL, category TEXT, unit TEXT, current_stock REAL DEFAULT 0, min_stock_alert REAL DEFAULT 0, cost_price REAL DEFAULT 0, selling_price REAL DEFAULT 0, FOREIGN KEY (farm_id) REFERENCES farms(farm_id));`)
  // customer_type: 'external' (a real customer) | 'own_farm' (one of the owner's
  // own farm_units, which the distribution business bills like any other
  // customer — see migrateOwnFarmCustomers). unit_id is set only on 'own_farm'
  // rows and names the farm_units row that owes the money.
  db.run(`CREATE TABLE IF NOT EXISTS customers (customer_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, customer_name TEXT NOT NULL, phone TEXT, address TEXT, outstanding_balance REAL DEFAULT 0, bank_id INTEGER, unit_id INTEGER, customer_type TEXT DEFAULT 'external', FOREIGN KEY (farm_id) REFERENCES farms(farm_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS suppliers (supplier_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, supplier_name TEXT NOT NULL, phone TEXT, products_supplied TEXT, FOREIGN KEY (farm_id) REFERENCES farms(farm_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS purchase_orders (purchase_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, supplier_id INTEGER, product_id INTEGER NOT NULL, date DATE NOT NULL, quantity REAL NOT NULL, cost_price REAL NOT NULL, total_amount REAL NOT NULL, payment_type TEXT DEFAULT 'cash', notes TEXT, payment_source TEXT DEFAULT 'cash', bank_id INTEGER, FOREIGN KEY (farm_id) REFERENCES farms(farm_id), FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id), FOREIGN KEY (product_id) REFERENCES products(product_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS sales_orders (order_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, customer_id INTEGER, product_id INTEGER NOT NULL, date DATE NOT NULL, quantity REAL NOT NULL, selling_price REAL NOT NULL, total_amount REAL NOT NULL, payment_type TEXT DEFAULT 'cash', amount_paid REAL DEFAULT 0, notes TEXT, FOREIGN KEY (farm_id) REFERENCES farms(farm_id), FOREIGN KEY (customer_id) REFERENCES customers(customer_id), FOREIGN KEY (product_id) REFERENCES products(product_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS customer_payments (payment_id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, date DATE NOT NULL, amount REAL NOT NULL, notes TEXT, FOREIGN KEY (customer_id) REFERENCES customers(customer_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS bills (bill_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, bill_number TEXT NOT NULL, customer_id INTEGER, customer_name TEXT, bill_date DATE NOT NULL, subtotal REAL NOT NULL, total_amount REAL NOT NULL, amount_paid REAL NOT NULL, payment_type TEXT DEFAULT 'cash', status TEXT DEFAULT 'completed', payment_source TEXT DEFAULT 'cash', bank_id INTEGER, payment_account_kind TEXT, source TEXT, source_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (farm_id) REFERENCES farms(farm_id));`)
  db.run(`CREATE TABLE IF NOT EXISTS bill_items (item_id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, product_id INTEGER, product_name TEXT NOT NULL, quantity REAL NOT NULL, unit_price REAL NOT NULL, total_price REAL NOT NULL, FOREIGN KEY (bill_id) REFERENCES bills(bill_id) ON DELETE CASCADE);`)

  // ── Distribution Batch Module ──────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS product_batches (
    batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    farm_id INTEGER NOT NULL,
    batch_code TEXT NOT NULL,
    manufacturing_date DATE NOT NULL,
    expiry_date DATE NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    purchase_price REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
  );`)

  db.run(`CREATE TABLE IF NOT EXISTS batch_transactions (
    transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    transaction_date DATE NOT NULL,
    reference_id INTEGER,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES product_batches(batch_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id)
  );`)

  // ── Account Ledger Module ──────────────────────────────────

  // Customer Ledger
  db.run(`CREATE TABLE IF NOT EXISTS customer_ledger (
    ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    transaction_date DATE NOT NULL,
    description TEXT,
    debit REAL DEFAULT 0,
    credit REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    reference_type TEXT,
    reference_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
  );`)

  // Supplier Ledger
  db.run(`CREATE TABLE IF NOT EXISTS supplier_ledger (
    ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    transaction_date DATE NOT NULL,
    description TEXT,
    debit REAL DEFAULT 0,
    credit REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    reference_type TEXT,
    reference_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id) ON DELETE CASCADE
  );`)

  // Bank Accounts
  db.run(`CREATE TABLE IF NOT EXISTS bank_accounts (
    bank_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    customer_id INTEGER,
    bank_name TEXT NOT NULL,
    account_number TEXT,
    account_holder TEXT,
    opening_balance REAL DEFAULT 0,
    current_balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
  );`)

  // Bank Ledger – 🔥 ADDED transaction_number column
  db.run(`CREATE TABLE IF NOT EXISTS bank_ledger (
    ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id INTEGER NOT NULL,
    transaction_date DATE NOT NULL,
    description TEXT,
    debit REAL DEFAULT 0,
    credit REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    reference_type TEXT,
    reference_id INTEGER,
    transaction_number TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id) ON DELETE CASCADE
  );`)

  // ── Receive / Payment Vouchers ─────────────────────────────
  //
  // A voucher is ONE money event with two sides, and it exists so that the two
  // sides can only ever be recorded together. A receive voucher settles a
  // customer's bills AND deposits the money into a house account; a payment
  // voucher reduces a supplier's payable AND withdraws it. Neither screen adds
  // settlement logic of its own — they go through customerSettlementOps() and
  // the supplier_ledger debit respectively, the same paths the Customer and
  // Supplier Ledger screens use — so a voucher is a shortcut, not a second
  // book.
  //
  // One row per voucher is what lets them join BANK_SOURCES in
  // database.service.ts: that mechanism keys a bank_ledger entry to a source
  // row's primary key, and a voucher's FIFO spill can touch several bills, so
  // the voucher — not the ledger line — is the thing the entry points at.
  // Separate tables rather than one with a type column, because direction is
  // declared per table in BANK_SOURCES ('in' for receive, 'out' for payment)
  // and the parties are different tables too.
  //
  // There is no edit path on purpose: a voucher is a compound event (bills,
  // ledger, bank) and re-allocating a settlement in place would need a second
  // reversal path. Correct one by deleting it and entering it again.
  db.run(`CREATE TABLE IF NOT EXISTS receive_vouchers (
    voucher_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    voucher_number TEXT,
    date DATE NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    payment_source TEXT DEFAULT 'cash',
    bank_id INTEGER,
    reference TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id)
  );`)

  db.run(`CREATE TABLE IF NOT EXISTS payment_vouchers (
    voucher_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    supplier_id INTEGER NOT NULL,
    voucher_number TEXT,
    date DATE NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    payment_source TEXT DEFAULT 'cash',
    bank_id INTEGER,
    reference TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id)
  );`)

  // ── Internal Settlement ────────────────────────────────────
  //
  // The owner's farm paying the distribution business what it owes for an
  // own-farm bill. Change 4 of the money-movement work, and the only one of
  // these events where BOTH ends of the money can be the owner's own account —
  // which is what makes it different from a receive voucher.
  //
  // from_account / to_account are 'cash' | 'bank', each with its own nullable
  // bank_id. When both name the SAME account (or both are cash) nothing moved
  // between accounts: the settlement is bookkeeping, and NO bank_ledger row is
  // written at all. Writing a debit and a credit on one account and trusting
  // them to cancel would leave the account wrong the first time a future change
  // skipped one leg.
  //
  // NOT a BANK_SOURCES table, deliberately: that mechanism keys exactly one
  // entry to a row's primary key with one declared direction, and this row
  // writes zero or two entries in opposite directions on two accounts. It has
  // its own named path in database.service.ts, the way assets and personal
  // expenses do, with two reference_types ('internal_settlement_out' /
  // '_in') so each (reference_type, reference_id) pair stays unique.
  //
  // There is no bill-ids column. Which bills a settlement landed on is
  // customer_ledger.internal_settlement_id -> reference_id, which is what the
  // printed receipt reads; storing the allocation again would be a second place
  // for it to drift from the ledger that actually holds the money.
  //
  // Account-scoped, not flock/batch-scoped: closing a flock must never
  // un-settle a receipt, so this table is in NO delete cascade.
  db.run(`CREATE TABLE IF NOT EXISTS internal_settlements (
    settlement_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    settlement_number TEXT NOT NULL,
    date DATE NOT NULL,
    amount REAL NOT NULL,
    from_account TEXT NOT NULL,
    from_bank_id INTEGER,
    to_account TEXT NOT NULL,
    to_bank_id INTEGER,
    reference TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
    FOREIGN KEY (from_bank_id) REFERENCES bank_accounts(bank_id),
    FOREIGN KEY (to_bank_id) REFERENCES bank_accounts(bank_id)
  );`)

  // 🔥 NEW: Expense Ledger
  db.run(`CREATE TABLE IF NOT EXISTS expense_ledger (
    expense_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    transaction_date DATE NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT,
    payment_type TEXT DEFAULT 'cash',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
  );`)

db.run(`CREATE TABLE IF NOT EXISTS categories (category_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, category_name TEXT NOT NULL, category_type TEXT DEFAULT 'product', FOREIGN KEY (farm_id) REFERENCES farms(farm_id));`);
// Dedupe + unique index (scoped per category_type, so "other" can exist once for
// products and once for expenses without colliding) is handled below in the
// alterStatements block so it runs correctly on both fresh and existing installs.

  // ── Sales Returns Module ───────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS sales_returns (
    return_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    bill_id INTEGER NOT NULL,
    return_number TEXT NOT NULL,
    return_date DATE NOT NULL,
    return_amount REAL NOT NULL,
    refund_amount REAL DEFAULT 0,
    refund_method TEXT DEFAULT 'cash',
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (bill_id) REFERENCES bills(bill_id)
  );`)

  db.run(`CREATE TABLE IF NOT EXISTS purchase_returns (
    return_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    purchase_id INTEGER NOT NULL,
    return_number TEXT NOT NULL,
    return_date DATE NOT NULL,
    quantity REAL NOT NULL,
    return_amount REAL NOT NULL,
    refund_method TEXT DEFAULT 'cash',
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (purchase_id) REFERENCES purchase_orders(purchase_id)
  );`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_returns_farm ON purchase_returns(farm_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns(purchase_id);`)
  db.run(`CREATE TABLE IF NOT EXISTS labour (
    labour_id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL,
    labour_name TEXT NOT NULL,
    phone TEXT,
    role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
  );`)
  db.run(`CREATE TABLE IF NOT EXISTS labour_payments (
    payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    labour_id INTEGER NOT NULL,
    flock_id INTEGER NOT NULL,
    date DATE NOT NULL,
    description TEXT,
    amount REAL NOT NULL,
    payment_type TEXT DEFAULT 'cash',
    module_type TEXT DEFAULT 'broiler',
    payment_source TEXT DEFAULT 'cash', bank_id INTEGER, FOREIGN KEY (labour_id) REFERENCES labour(labour_id)
  );`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_labour_farm ON labour(farm_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_labour_payments_flock ON labour_payments(flock_id, module_type);`)
  db.run(`CREATE TABLE IF NOT EXISTS hen_sales (
    hen_sale_id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    date DATE NOT NULL,
    customer_name TEXT,
    quantity INTEGER NOT NULL,
    rate_per_hen REAL NOT NULL,
    total_amount REAL NOT NULL,
    payment_type TEXT DEFAULT 'cash',
    pricing_mode TEXT DEFAULT 'per_hen',
    total_weight REAL,
    payment_source TEXT DEFAULT 'cash', bank_id INTEGER, customer_id INTEGER, FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
  );`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_hen_sales_batch ON hen_sales(batch_id);`)

  db.run(`CREATE TABLE IF NOT EXISTS sales_return_items (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL,
    bill_id INTEGER NOT NULL,
    bill_item_id INTEGER,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    FOREIGN KEY (return_id) REFERENCES sales_returns(return_id) ON DELETE CASCADE,
    FOREIGN KEY (bill_id) REFERENCES bills(bill_id)
  );`)

  // ── Internal Transfers (Distribution → Broiler/Layer) ─────
  db.run(`CREATE TABLE IF NOT EXISTS internal_transfers (
    transfer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL,
    expense_id INTEGER,
    target_module TEXT,
    target_flock_id INTEGER,
    target_type TEXT,
    reference_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bill_id) REFERENCES bills(bill_id)
  );`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_sales_returns_farm ON sales_returns(farm_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sales_returns_bill ON sales_returns(bill_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sales_return_items_return ON sales_return_items(return_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_internal_transfers_bill ON internal_transfers(bill_id);`)
  // Indexes for performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger(customer_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_customer_ledger_date ON customer_ledger(transaction_date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier ON supplier_ledger(supplier_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_supplier_ledger_date ON supplier_ledger(transaction_date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_bank_ledger_bank ON bank_ledger(bank_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_bank_ledger_date ON bank_ledger(transaction_date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_bank_ledger_number ON bank_ledger(transaction_number);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_customers_bank ON customers(bank_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_expense_ledger_date ON expense_ledger(transaction_date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_expense_ledger_category ON expense_ledger(category);`)

  // Add indexes for batch
  db.run(`CREATE INDEX IF NOT EXISTS idx_batches_product ON product_batches(product_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_batches_expiry ON product_batches(expiry_date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_batches_status ON product_batches(status);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_batch ON batch_transactions(batch_id);`)

  // ── Overview Module: Fixed Assets & Personal Expenses ──────
  // Account-level (farm_id scoped), not tied to any flock/batch. Pattern
  // follows bank_accounts. No depreciation — gain/loss is only recognised
  // when an asset is sold (sale_amount - purchase_amount).
  db.run(`CREATE TABLE IF NOT EXISTS assets (
    asset_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id         INTEGER NOT NULL,
    unit_id         INTEGER,
    asset_name      TEXT NOT NULL,
    category        TEXT,
    purchase_date   DATE NOT NULL,
    -- The full agreed price. Canonical since assets became payable in
    -- installments; purchase_amount is kept in step with it for older readers.
    total_price     REAL,
    -- Legacy mirror of total_price. Predates installments, when an asset was
    -- bought outright and this was both price and payment. Every write path
    -- still sets it, so anything reading it gets the right number.
    purchase_amount REAL NOT NULL DEFAULT 0,
    payment_source  TEXT DEFAULT 'cash',
    bank_id         INTEGER,
    status          TEXT DEFAULT 'active',
    sale_date       DATE,
    sale_amount     REAL,
    notes           TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (unit_id) REFERENCES farm_units(unit_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id)
  );`)

  db.run(`CREATE TABLE IF NOT EXISTS personal_expenses (
    pexpense_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id         INTEGER NOT NULL,
    date            DATE NOT NULL,
    -- The category's name, kept populated alongside category_id on every write.
    -- It is the fallback the UI matches on when a row's link is missing, so an
    -- entry can never fall out of the category grid entirely.
    category        TEXT,
    category_id     INTEGER,
    description     TEXT,
    amount          REAL NOT NULL DEFAULT 0,
    payment_source  TEXT DEFAULT 'cash',
    bank_id         INTEGER,
    notes           TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id),
    FOREIGN KEY (category_id) REFERENCES expense_categories(category_id)
  );`)

  // Installment payments against an asset. An asset's agreed price lives on
  // assets.total_price; what has actually been handed over is the sum of these
  // rows. Foreign keys are declared but NOT enforced (no PRAGMA foreign_keys),
  // so deleting an asset must delete its payments explicitly — see
  // assets.component.ts, which does both in one runBatch.
  db.run(`CREATE TABLE IF NOT EXISTS asset_payments (
    payment_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        INTEGER NOT NULL,
    farm_id         INTEGER NOT NULL,
    date            DATE NOT NULL,
    amount          REAL NOT NULL DEFAULT 0,
    payment_source  TEXT DEFAULT 'cash',
    bank_id         INTEGER,
    -- 1 when the app wrote this row itself to clear the remaining balance as the
    -- asset was sold; 0 for an installment the user recorded. A real column and
    -- not a note-text convention, because the sale-settlement migration needs a
    -- guard it can trust and the payment history labels the row from it.
    is_settlement   INTEGER DEFAULT 0,
    notes           TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id),
    FOREIGN KEY (bank_id) REFERENCES bank_accounts(bank_id)
  );`)

  // User-defined personal expense categories, replacing the hardcoded
  // Household/Medical/Education/Travel/Other list. personal_expenses keeps its
  // `category` TEXT column populated alongside category_id — see
  // backfillExpenseCategories() for why that redundancy is load-bearing.
  db.run(`CREATE TABLE IF NOT EXISTS expense_categories (
    category_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id         INTEGER NOT NULL,
    category_name   TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (farm_id) REFERENCES farms(farm_id)
  );`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_assets_farm ON assets(farm_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_personal_expenses_farm ON personal_expenses(farm_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_personal_expenses_date ON personal_expenses(date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_asset_payments_asset ON asset_payments(asset_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_asset_payments_farm ON asset_payments(farm_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_asset_payments_date ON asset_payments(date);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_expense_categories_farm ON expense_categories(farm_id);`)
  // Two categories with the same name on one account would split that account's
  // card grid in two, so uniqueness is enforced here rather than only in the UI.
  // NOCASE because "Travel" and "travel" are the same account to the client.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_unique
          ON expense_categories(farm_id, category_name COLLATE NOCASE);`)
  // NOTE: the index on personal_expenses(category_id) is deliberately NOT here.
  // On an existing database that column does not exist until the ALTER in
  // alterStatements has run, which is after this function, so indexing it here
  // throws "no such column" — and createTables() is called unguarded, so that
  // throw takes the whole of initializeDatabase() with it and the app will not
  // start. It lives in alterStatements instead, which try/catches per statement.
}

// =============================================
// ATTEMPT TO RECOVER DATA FROM CORRUPTED DB
// =============================================
function attemptRecovery(dbPath, oldDb, SQL) {
  const tables = ['farms', 'farm_units', 'flocks', 'ledgers', 'expenses', 'ledger_entries', 'medicine_traders', 'medicine_entries', 'feed_traders', 'feed_entries', 'chick_traders', 'chick_entries', 'sales', 'income', 'flock_health', 'balance', 'brokers', 'activation', 'batches', 'egg_collection', 'egg_sales', 'vaccinations', 'layer_mortality', 'layer_health', 'products', 'customers', 'suppliers', 'purchase_orders', 'sales_orders', 'customer_payments', 'product_batches', 'batch_transactions', 'customer_ledger', 'supplier_ledger', 'bank_accounts', 'bank_ledger', 'expense_ledger', 'categories', 'sales_returns', 'sales_return_items', 'internal_transfers','purchase_returns','labour', 'labour_payments', 'hen_sales', 'assets', 'personal_expenses', 'asset_payments', 'expense_categories', 'loans', 'loan_payments', 'debt_records']
  
  const newDb = new SQL.Database()
  createTables(newDb)
  
  let totalRecovered = 0
  
  for (const table of tables) {
    try {
      const stmt = oldDb.prepare(`SELECT * FROM ${table}`)
      const rows = []
      while (stmt.step()) {
        rows.push(stmt.getAsObject())
      }
      stmt.free()
      
      if (rows.length > 0) {
        const columns = Object.keys(rows[0]).join(', ')
        const placeholders = Object.keys(rows[0]).map(() => '?').join(', ')
        const insertStmt = newDb.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`)
        
        for (const row of rows) {
          insertStmt.run(Object.values(row))
        }
        insertStmt.free()
        totalRecovered += rows.length
        console.log(`Recovered ${rows.length} rows from ${table}`)
      }
    } catch (tableErr) {
      console.error(`Could not recover table ${table}:`, tableErr.message)
    }
  }
  
  console.log(`Total rows recovered: ${totalRecovered}`)
  return totalRecovered > 0 ? newDb : null
}

// =============================================
// BACKUP CORRUPTED FILE AND START FRESH
// =============================================
function backupAndStartFresh(dbPath, SQL) {
  const backupPath = dbPath + '.corrupted.' + Date.now() + '.bak'
  try {
    fs.copyFileSync(dbPath, backupPath)
    console.log('Corrupted database backed up to:', backupPath)
  } catch (e) {
    console.error('Could not backup corrupted database:', e.message)
  }
  return new SQL.Database()
}

// =============================================
// ONE-TIME REBUILD: make vaccinations.batch_id nullable
// =============================================
// The oldest schema declared vaccinations.batch_id NOT NULL, which blocks
// broiler rows (they carry flock_id and leave batch_id null). SQLite cannot drop
// a NOT NULL constraint in place, so the fix is a table rebuild.
//
// This rebuild previously sat in alterStatements, which runs on EVERY launch. It
// re-created the table from a 7-column INSERT...SELECT, so on every single app
// start it destroyed flock_id, cost, bill_id and bill_number for every existing
// vaccination row. Three things stop that from happening again:
//
//   1. an app_settings flag, so the body runs at most once per database;
//   2. a PRAGMA check, so it only rebuilds a table that actually still has the
//      NOT NULL constraint — on a current schema it just sets the flag;
//   3. the INSERT...SELECT carries every column the table has, computed from
//      PRAGMA rather than hardcoded, so a future column cannot be forgotten.
//
// Same convergent shape as backfillFarmUnits below: the flag is written last, so
// any throw leaves it unset and the next launch retries from wherever it stopped.
function migrateVaccinationsNullableBatchId(db) {
  const MIGRATION_KEY = 'migration_vaccinations_nullable_batch_v1'
  const SETTINGS_SCOPE_APP = 0

  // Mirrors the vaccinations definition in createTables(). Order matters only for
  // readability — the INSERT names its columns explicitly.
  const COLUMNS = [
    'vaccination_id', 'batch_id', 'flock_id', 'date', 'vaccine_name',
    'dose', 'notes', 'cost', 'done', 'bill_id', 'bill_number'
  ]
  const CREATE_SQL = `CREATE TABLE vaccinations (vaccination_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, flock_id INTEGER, date DATE NOT NULL, vaccine_name TEXT NOT NULL, dose TEXT, notes TEXT, cost REAL DEFAULT 0, done INTEGER DEFAULT 0, bill_id INTEGER, bill_number TEXT, FOREIGN KEY (batch_id) REFERENCES batches(batch_id), FOREIGN KEY (flock_id) REFERENCES flocks(flock_id))`

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  const tableExists = (name) => selectRows(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]
  ).length > 0

  // Only the columns the new table and the source table have in common. On a
  // legacy database the ALTER statements above have already added flock_id, cost,
  // bill_id and bill_number by the time this runs, so in practice this is all of
  // COLUMNS — the intersection is here so a truly ancient table still copies what
  // it does have instead of failing the whole INSERT.
  const carriedColumns = (sourceTable) => {
    const present = selectRows(`PRAGMA table_info(${sourceTable})`).map(c => c.name)
    return COLUMNS.filter(c => present.includes(c))
  }

  // Leftover from a run that died between the RENAME and the DROP: the real rows
  // are in vaccinations_old and createTables() has since made an empty (or
  // partly-filled) vaccinations. Fold the missing rows back in rather than
  // dropping the table outright, which would throw that data away.
  if (tableExists('vaccinations_old')) {
    const cols = carriedColumns('vaccinations_old').join(', ')
    db.run(`INSERT OR IGNORE INTO vaccinations (${cols})
            SELECT ${cols} FROM vaccinations_old
            WHERE vaccination_id NOT IN (SELECT vaccination_id FROM vaccinations)`)
    db.run(`DROP TABLE vaccinations_old`)
    console.log('recovered vaccinations rows from an interrupted rebuild')
  }

  const batchIdColumn = selectRows(`PRAGMA table_info(vaccinations)`)
    .find(c => c.name === 'batch_id')
  // notnull === 1 means the old constraint is still there and the rebuild is
  // genuinely needed. Anything else (current schema, or no such column because
  // createTables just made the table fresh) needs no rebuild at all.
  if (batchIdColumn && batchIdColumn.notnull === 1) {
    const cols = carriedColumns('vaccinations').join(', ')
    db.run(`ALTER TABLE vaccinations RENAME TO vaccinations_old`)
    db.run(CREATE_SQL)
    db.run(`INSERT INTO vaccinations (${cols}) SELECT ${cols} FROM vaccinations_old`)
    db.run(`DROP TABLE vaccinations_old`)
    console.log(`vaccinations rebuilt for nullable batch_id — carried columns: ${cols}`)
  }

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )
}

// =============================================
// ONE-TIME BACKFILL: give pre-existing flocks/batches a farm_unit
// =============================================
// Guarded by a flag in app_settings, because everything in alterStatements runs
// on every single launch and this must not.
//
// There are no transactions in this database, and initializeDatabase() writes the
// whole file to disk when it finishes regardless of what threw, so a failure
// partway through WILL be persisted. The design therefore is not "all or nothing"
// but "convergent": the flag is written last, so any throw leaves it unset and
// the next launch re-runs; and every step re-runs to the same end state.
//
// Ordering, per farm and per module: create the unit FIRST, then point the child
// rows at it. Crashing between the two leaves an unreferenced farm_units row —
// harmless, and the next run adopts it via findOrCreateMainUnit instead of
// inserting a second "Main Farm". The reverse order would be unrecoverable: rows
// carrying a unit_id for a unit that does not exist, with foreign keys off and
// nothing left to say what the intent was.
function backfillFarmUnits(db) {
  const MIGRATION_KEY = 'migration_farm_units_v1'
  // app_settings is keyed (farm_id, key). farms.farm_id is AUTOINCREMENT, so it
  // never yields 0 — 0 is reserved here for app-wide rows like a migration flag.
  const SETTINGS_SCOPE_APP = 0
  const DEFAULT_UNIT_NAME = 'Main Farm'

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  const findMainUnit = (farmId, moduleType) => {
    const rows = selectRows(
      `SELECT unit_id FROM farm_units WHERE farm_id = ? AND module_type = ? AND unit_name = ?`,
      [farmId, moduleType, DEFAULT_UNIT_NAME]
    )
    return rows.length > 0 ? rows[0].unit_id : null
  }

  const findOrCreateMainUnit = (farmId, moduleType) => {
    const existing = findMainUnit(farmId, moduleType)
    if (existing) return existing
    db.run(
      `INSERT INTO farm_units (farm_id, module_type, unit_name, status) VALUES (?, ?, ?, 'active')`,
      [farmId, moduleType, DEFAULT_UNIT_NAME]
    )
    // Re-select rather than trusting last_insert_rowid(), which this codebase has
    // already found unreliable under sql.js (see the fallback in runQuery).
    return findMainUnit(farmId, moduleType)
  }

  const countPending = (sql, farmId) => selectRows(sql, [farmId])[0].count

  const farms = selectRows(`SELECT farm_id FROM farms`)
  let unitsCreated = 0

  for (const farm of farms) {
    const farmId = farm.farm_id

    const pendingFlocks = countPending(
      `SELECT COUNT(*) AS count FROM flocks WHERE farm_id = ? AND unit_id IS NULL`, farmId
    )
    if (pendingFlocks > 0) {
      const unitId = findOrCreateMainUnit(farmId, 'broiler')
      if (!unitId) throw new Error(`Could not create broiler farm unit for farm ${farmId}`)
      db.run(`UPDATE flocks SET unit_id = ? WHERE farm_id = ? AND unit_id IS NULL`, [unitId, farmId])
      unitsCreated++
    }

    const pendingBatches = countPending(
      `SELECT COUNT(*) AS count FROM batches WHERE farm_id = ? AND unit_id IS NULL`, farmId
    )
    if (pendingBatches > 0) {
      const unitId = findOrCreateMainUnit(farmId, 'layer')
      if (!unitId) throw new Error(`Could not create layer farm unit for farm ${farmId}`)
      db.run(`UPDATE batches SET unit_id = ? WHERE farm_id = ? AND unit_id IS NULL`, [unitId, farmId])
      unitsCreated++
    }
    // A farm with neither flocks nor batches gets no unit.
  }

  // Written only once every farm above has been fully backfilled.
  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`farm_units backfill complete — ${unitsCreated} unit(s) touched across ${farms.length} account(s)`)
}

// =============================================
// ONE-TIME BACKFILL: assets bought on installments
// =============================================
// Assets used to be bought outright: one `purchase_amount`, paid in full on
// `purchase_date`. They are now payable over time, so the agreed price lives on
// `assets.total_price` and what has actually been handed over is the sum of the
// asset's `asset_payments` rows.
//
// The trap this migration exists to avoid: without it, every asset already in
// the database would have total_price NULL and no payment rows, so the new
// screens would report the client's fully-paid assets as 100% outstanding. So an
// existing purchase_amount is read as BOTH the agreed price AND a single payment
// already made, which is exactly what it meant before.
//
// Same convergent shape as backfillFarmUnits: guarded by an app_settings flag,
// every statement individually re-runnable, and the flag written last so any
// throw leaves it unset and the next launch picks up where this one stopped.
// Note that step 2 is guarded by NOT EXISTS rather than by the flag alone --
// that is what stops a retry from seeding a second payment for the same asset.
function backfillAssetInstallments(db) {
  const MIGRATION_KEY = 'migration_asset_installments_v1'
  // app_settings is keyed (farm_id, key); farms.farm_id is AUTOINCREMENT and
  // never yields 0, so 0 is the app-wide scope used for migration flags.
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  // 1. The price that was paid becomes the price that was agreed. Only touches
  //    rows the migration has not already set, so it is safe to re-run.
  db.run(`UPDATE assets
          SET total_price = COALESCE(purchase_amount, 0)
          WHERE total_price IS NULL`)

  const pending = selectRows(
    `SELECT COUNT(*) AS count FROM assets a
     WHERE COALESCE(a.purchase_amount, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM asset_payments p WHERE p.asset_id = a.asset_id)`
  )[0].count

  // 2. ...and the money that changed hands becomes a payment record, dated and
  //    sourced exactly as the original purchase was, so the Overview's cash
  //    figures come out unchanged. Assets recorded with a zero price get no
  //    payment row -- there was no money to record.
  if (pending > 0) {
    db.run(`INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, notes)
            SELECT a.asset_id, a.farm_id, a.purchase_date, a.purchase_amount,
                   COALESCE(a.payment_source, 'cash'), a.bank_id,
                   'Opening payment carried over from the original purchase record'
            FROM assets a
            WHERE COALESCE(a.purchase_amount, 0) > 0
              AND NOT EXISTS (SELECT 1 FROM asset_payments p WHERE p.asset_id = a.asset_id)`)
  }

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`asset installments backfill complete -- ${pending} asset(s) given an opening payment`)
}

// =============================================
// ONE-TIME BACKFILL: settle the balance on already-sold assets
// =============================================
// Selling an asset now settles whatever is still owed on it: the sale hands the
// thing over, so the debt against it goes with it, and the app writes a
// settlement payment for the remainder dated on the sale date. See sellAsset().
//
// Assets sold BEFORE that change never got one, so they still sit in the
// account's outstanding installments forever -- the balance can never fall,
// because the asset is gone and no further payment will ever be recorded
// against it. This gives each of them the settlement payment the sale would
// write today.
//
// Guarded twice, the same shape as backfillAssetInstallments above: an
// app_settings flag written last, so a throw leaves it unset and the next launch
// retries, AND a NOT EXISTS on the asset's own settlement row, so a retry that
// picks up half-done work cannot seed a second settlement for the same asset.
// The is_settlement flag is what makes that second guard reliable -- matching on
// note text would break the moment anyone edited a note.
function backfillAssetSaleSettlements(db) {
  const MIGRATION_KEY = 'migration_asset_sale_settlements_v1'
  // Same app-wide scope the migration flags above use: farms.farm_id is
  // AUTOINCREMENT and never yields 0.
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  // Sold assets whose recorded payments fall short of the agreed price. The
  // ROUND guards against float dust making a square asset look a rupee short;
  // > 0 excludes both the fully-paid and the overpaid, so no negative settlement
  // can be written.
  const PENDING_WHERE =
    `a.status = 'sold'
       AND ROUND(COALESCE(a.total_price, a.purchase_amount, 0)
                 - COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                             WHERE p.asset_id = a.asset_id), 0), 2) > 0
       AND NOT EXISTS (SELECT 1 FROM asset_payments p
                       WHERE p.asset_id = a.asset_id AND COALESCE(p.is_settlement, 0) = 1)`

  const summary = selectRows(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(ROUND(COALESCE(a.total_price, a.purchase_amount, 0)
                               - COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                                           WHERE p.asset_id = a.asset_id), 0), 2)), 0) AS total
     FROM assets a
     WHERE ${PENDING_WHERE}`
  )[0]

  if (summary.count > 0) {
    // Dated on the sale date so the settlement lands in the same period as the
    // sale it belongs to, which is what makes the Overview's cash arithmetic
    // come out right for that period. sale_date should always be set on a sold
    // asset; purchase_date is the fallback for a row where it somehow is not,
    // since asset_payments.date is NOT NULL.
    db.run(`INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, is_settlement, notes)
            SELECT a.asset_id, a.farm_id,
                   COALESCE(a.sale_date, a.purchase_date),
                   ROUND(COALESCE(a.total_price, a.purchase_amount, 0)
                         - COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                                     WHERE p.asset_id = a.asset_id), 0), 2),
                   COALESCE(a.payment_source, 'cash'), a.bank_id, 1,
                   'Balance settled automatically when the asset was sold (added by update)'
            FROM assets a
            WHERE ${PENDING_WHERE}`)
  }

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`asset sale settlements backfill complete -- ${summary.count} sold asset(s) settled, ` +
              `Rs. ${summary.total} cleared from outstanding installments`)
}

// =============================================
// ONE-TIME BACKFILL: user-defined personal expense categories
// =============================================
// Personal expense categories were a hardcoded list in the component
// (Household/Medical/Education/Travel/Other) written into personal_expenses as
// free text. They are now rows in expense_categories that the client creates,
// renames and deletes, and each one is an account you click into.
//
// Ordering here is the same lesson farm_units taught: create the category rows
// FIRST, then point the expense rows at them. Crashing between the two leaves a
// category with no entries -- harmless, and the re-run adopts it via INSERT OR
// IGNORE instead of duplicating it. The reverse order would leave category_id
// values referencing categories that do not exist, and with foreign keys off
// there would be nothing left to say what the intent had been.
//
// personal_expenses.category is NOT cleared, here or anywhere else. Every write
// path keeps it in step with category_id, and the UI matches entries on
// `category_id = ? OR (category_id IS NULL AND category = ?)`. So if a link is
// ever missing, the entry still shows up under its named category and still
// counts against that category's total rather than silently disappearing from a
// grid that only knows about ids.
function backfillExpenseCategories(db) {
  const MIGRATION_KEY = 'migration_expense_categories_v1'
  const SETTINGS_SCOPE_APP = 0
  // Entries saved with no category at all still need a card to live under.
  const FALLBACK_CATEGORY = 'Uncategorised'

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  // 1. One category per distinct name per account. OR IGNORE against the
  //    UNIQUE(farm_id, category_name COLLATE NOCASE) index makes this
  //    re-runnable and collapses "Travel"/"travel" into one category.
  db.run(`INSERT OR IGNORE INTO expense_categories (farm_id, category_name)
          SELECT DISTINCT pe.farm_id, TRIM(pe.category)
          FROM personal_expenses pe
          WHERE TRIM(COALESCE(pe.category, '')) <> ''`)

  // 2. A fallback category, but only for accounts that actually have entries
  //    with no category -- no point giving every account an empty card.
  db.run(`INSERT OR IGNORE INTO expense_categories (farm_id, category_name)
          SELECT DISTINCT pe.farm_id, ?
          FROM personal_expenses pe
          WHERE TRIM(COALESCE(pe.category, '')) = ''`, [FALLBACK_CATEGORY])

  // 3. Only now, with every category row committed, link the entries. Matched
  //    per farm_id so one account can never be pointed at another's category.
  db.run(`UPDATE personal_expenses
          SET category_id = (
            SELECT c.category_id FROM expense_categories c
            WHERE c.farm_id = personal_expenses.farm_id
              AND c.category_name = TRIM(personal_expenses.category) COLLATE NOCASE
          )
          WHERE category_id IS NULL
            AND TRIM(COALESCE(category, '')) <> ''`)

  // Uncategorised entries get both the link and the text, so they behave like
  // every other row from here on.
  db.run(`UPDATE personal_expenses
          SET category_id = (
                SELECT c.category_id FROM expense_categories c
                WHERE c.farm_id = personal_expenses.farm_id
                  AND c.category_name = ? COLLATE NOCASE
              ),
              category = ?
          WHERE category_id IS NULL
            AND TRIM(COALESCE(category, '')) = ''`, [FALLBACK_CATEGORY, FALLBACK_CATEGORY])

  const categories = selectRows(`SELECT COUNT(*) AS count FROM expense_categories`)[0].count
  const unlinked = selectRows(
    `SELECT COUNT(*) AS count FROM personal_expenses WHERE category_id IS NULL`
  )[0].count

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`expense categories backfill complete -- ${categories} category row(s), ${unlinked} entry/entries left unlinked`)
}

// migration_farm_units_v1 above only ever runs once — it fixes every flock/batch
// that had a NULL unit_id as of the FIRST launch after farm_units shipped, then
// sets its flag and never runs again. Before flock/batch creation was made to
// require a farm (Farm selector step 4), the create forms could still insert
// unit_id = NULL — those rows are invisible to every farm-filtered dropdown, and
// v1 will never touch them again because its flag is already set. This is a
// second, separately-flagged, idempotent sweep for exactly that gap.
//
// Unlike v1, this does NOT invent a new "Main Farm" — by the time this runs,
// every account that had pending rows during v1 already has at least one
// farm_unit, so orphans found here are assigned to the OLDEST existing unit for
// that farm+module (by created_at, then unit_id as a tiebreak). The one case
// with nothing to assign to is an account whose first-ever flock/batch was
// created through the buggy form before that account ever had any farm_units at
// all — those rows are left NULL and logged; the create-form guard shipped
// alongside this migration stops any new occurrences.
function repairOrphanedUnitIds(db) {
  const MIGRATION_KEY = 'migration_farm_units_orphan_repair_v1'
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  const oldestUnit = (farmId, moduleType) => {
    const rows = selectRows(
      `SELECT unit_id FROM farm_units WHERE farm_id = ? AND module_type = ? ORDER BY created_at ASC, unit_id ASC LIMIT 1`,
      [farmId, moduleType]
    )
    return rows.length > 0 ? rows[0].unit_id : null
  }

  const countPending = (sql, farmId) => selectRows(sql, [farmId])[0].count

  const farms = selectRows(`SELECT farm_id FROM farms`)
  let rowsFixed = 0
  let rowsSkipped = 0

  for (const farm of farms) {
    const farmId = farm.farm_id

    const pendingFlocks = countPending(
      `SELECT COUNT(*) AS count FROM flocks WHERE farm_id = ? AND unit_id IS NULL`, farmId
    )
    if (pendingFlocks > 0) {
      const unitId = oldestUnit(farmId, 'broiler')
      if (unitId) {
        db.run(`UPDATE flocks SET unit_id = ? WHERE farm_id = ? AND unit_id IS NULL`, [unitId, farmId])
        rowsFixed += pendingFlocks
      } else {
        rowsSkipped += pendingFlocks
      }
    }

    const pendingBatches = countPending(
      `SELECT COUNT(*) AS count FROM batches WHERE farm_id = ? AND unit_id IS NULL`, farmId
    )
    if (pendingBatches > 0) {
      const unitId = oldestUnit(farmId, 'layer')
      if (unitId) {
        db.run(`UPDATE batches SET unit_id = ? WHERE farm_id = ? AND unit_id IS NULL`, [unitId, farmId])
        rowsFixed += pendingBatches
      } else {
        rowsSkipped += pendingBatches
      }
    }
  }

  // Written only once every farm above has been fully repaired.
  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`orphaned unit_id repair complete — ${rowsFixed} row(s) fixed, ${rowsSkipped} row(s) skipped (no farm to assign to) across ${farms.length} account(s)`)
}

// =============================================
// ONE-TIME MIGRATION: mark ledger entries that mirror an expense
// =============================================
// `ledger_entries.source = 'expense'` means "this debit is the ledger-side mirror
// of a row in `expenses`". Every report that totals ledger debits excludes those
// (see report.component.ts totalLedgerDebit, farm-report.service.ts,
// overview.service.ts), because the expenses table already counts the cost.
// Flipping an entry to 'expense' therefore REMOVES it from the books.
//
// The original version of this migration ran on every launch and matched on
// (ledger_id, date, amount) — a fuzzy triple. Two debits of, say, 5000 booked to
// the same ledger on the same day are ordinary in this business, so a genuine
// manual debit that merely coincided with an expense was silently reclassified
// and vanished from every cost total. Nothing about that was visible in the UI:
// the row still renders in the ledger, it just stops being counted.
//
// This version matches only on the explicit link that expenses.ledger_entry_id
// already carries — written by linkExpenseToLedger() at the moment the pair is
// created, so it identifies the mirror rather than guessing at it.
//
// Deliberately NOT backfilled by any heuristic: a legacy mirror whose
// ledger_entry_id was never written stays 'manual'. The two failure directions
// are not symmetric. Leaving a real mirror unmarked double-counts one cost —
// wrong, but it shows up as a number that is too big, and both rows are visible.
// Marking a real debit as a mirror deletes a cost from the books with nothing
// on screen to say so. Between an overstatement you can see and an understatement
// you cannot, this migration always errs toward the visible one.
//
// Same convergent shape as the backfills above: flag written last, so a throw
// leaves it unset and the next launch re-runs. The UPDATE is idempotent anyway.
function migrateExpenseLedgerSource(db) {
  const MIGRATION_KEY = 'migration_ledger_source_expense_v2'
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  const pending = selectRows(`
    SELECT COUNT(*) AS count FROM ledger_entries
    WHERE COALESCE(source, 'manual') <> 'expense'
      AND entry_id IN (SELECT ledger_entry_id FROM expenses WHERE ledger_entry_id IS NOT NULL)
  `)[0].count

  if (pending > 0) {
    db.run(`
      UPDATE ledger_entries
      SET source = 'expense'
      WHERE COALESCE(source, 'manual') <> 'expense'
        AND entry_id IN (SELECT ledger_entry_id FROM expenses WHERE ledger_entry_id IS NOT NULL)
    `)
  }

  // Diagnostic only — never modifies anything. An entry marked 'expense' that no
  // expense row points at is either a pre-link mirror (benign) or a genuine debit
  // that the old fuzzy migration reclassified (a lost cost). The two cannot be
  // told apart from the data alone, so this only reports the count; see the
  // README note on recovering from a backup if it is non-zero and unexplained.
  const orphaned = selectRows(`
    SELECT COUNT(*) AS count FROM ledger_entries
    WHERE source = 'expense'
      AND entry_id NOT IN (SELECT ledger_entry_id FROM expenses WHERE ledger_entry_id IS NOT NULL)
  `)[0].count

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`ledger source backfill complete — ${pending} entry(s) linked to an expense marked; ${orphaned} entry(s) marked 'expense' with no linking expense row (see migrateExpenseLedgerSource)`)
}

// =============================================
// ONE-TIME MIGRATION: delete the expense→ledger mirror rows
// =============================================
// Expenses and ledgers are now two independent books. An expense is a row in
// `expenses` with a category and touches no ledger; a ledger entry lives in the
// ledger and touches no expense. The Expenses screen no longer writes a mirror.
//
// What this removes is the mirrors already written: `ledger_entries` rows with
// `source = 'expense'`. That marker means exactly one thing — "this debit is the
// ledger-side copy of a row in `expenses`" — and every total in the app already
// excludes them (`report.component.ts` totalLedgerDebit, `overview.service.ts`
// qLedgerDebits, `farm-report.service.ts` specLedgerDebits all carry
// `COALESCE(source,'manual') <> 'expense'`). So **no reported figure moves**:
// the cost stays counted once, on the expense side, exactly as before. What
// changes is the Ledger screen, which stops listing rows that now have no reason
// to exist and — with the mirror concept gone — would otherwise read as genuine
// ledger debits to anyone looking at the screen.
//
// MUST run after migrateExpenseLedgerSource(): that one marks the linked legacy
// mirrors, and a mirror marked after this DELETE would survive for the life of
// the install, excluded from every total but still on screen. Ordering, not the
// flag, is what makes the pair converge.
//
// Deliberately NOT touched: `expenses.ledger_id` / `ledger_entry_id`. The columns
// stay (the client asked for the link to stop, not for the table to be rebuilt),
// and their existing values stay with them. Nothing reads either column any more,
// and `ledger_entries.entry_id` is AUTOINCREMENT so an id is never reissued — a
// leftover `ledger_entry_id` can therefore never resolve to some other row. They
// are the only surviving trace of which ledger a legacy expense was once filed
// under, and blanking them would destroy that for no gain.
//
// Same convergent shape as the backfills above: flag written last, so a throw
// leaves it unset and the next launch re-runs. The DELETE is idempotent anyway —
// nothing writes `source = 'expense'` any more, so there is never a second crop.
function migrateDropExpenseLedgerMirrors(db) {
  const MIGRATION_KEY = 'migration_drop_expense_ledger_mirrors_v1'
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  const counts = selectRows(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(amount), 0) AS amount,
           SUM(CASE WHEN entry_id IN (
                 SELECT ledger_entry_id FROM expenses WHERE ledger_entry_id IS NOT NULL
               ) THEN 1 ELSE 0 END) AS linked
    FROM ledger_entries
    WHERE COALESCE(source, 'manual') = 'expense'
  `)[0]
  const total = Number(counts.total || 0)
  const linked = Number(counts.linked || 0)
  // A row marked 'expense' that no expense points at is either a pre-link mirror
  // or — see migrateExpenseLedgerSource — a genuine debit the ORIGINAL fuzzy
  // migration reclassified years ago. Both have been excluded from every total
  // ever since, so deleting them moves no figure either; the count is logged so
  // a non-zero number is at least visible in the log rather than silent.
  const unlinked = total - linked

  if (total > 0) {
    db.run(`DELETE FROM ledger_entries WHERE COALESCE(source, 'manual') = 'expense'`)
  }

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`expense ledger mirrors removed — ${total} entry(s) deleted (${linked} linked to an expense row, ${unlinked} unlinked), Rs. ${counts.amount || 0} of mirrored debit; no report total moves, all of it was already excluded from every ledger-debit figure`)
}

// =============================================
// ONE-TIME MIGRATION: de-duplicate categories
// =============================================
// Collapses duplicate (farm_id, category_type, category_name) rows down to the
// lowest category_id so the unique index below can be created. This ran unguarded
// on every launch, which is the same shape as the vaccinations bug: a DELETE in
// the always-runs path keeps deleting for the life of the install. Any category
// a user legitimately re-created after this first ran was destroyed again at the
// next start, with no error and nothing on screen to explain where it went.
//
// Behind a flag it does what it was meant to do — clean up once, before the index
// exists — and after that the UNIQUE index is what prevents duplicates.
function migrateDeduplicateCategories(db) {
  const MIGRATION_KEY = 'migration_categories_dedupe_v1'
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  // No child rows need repointing, and this is worth stating because it is not
  // obvious: nothing in the schema holds a foreign key to categories.category_id
  // (`grep "REFERENCES categories"` finds none). `products.category` is TEXT, and
  // the inventory and expense-ledger screens match categories by NAME. The one
  // table that does carry a `category_id` — personal_expenses — points at
  // `expense_categories`, a different table in a different id space; joining it
  // to `categories` here would repoint rows on a coincidental id collision and
  // corrupt them. Collapsing same-name rows is therefore invisible to every
  // consumer: they were already resolving the name to the surviving row.
  const removed = selectRows(`
    SELECT COUNT(*) AS count FROM categories WHERE category_id NOT IN (
      SELECT MIN(category_id) FROM categories
      GROUP BY farm_id, category_type, category_name
    )
  `)[0].count

  db.run(`
    DELETE FROM categories WHERE category_id NOT IN (
      SELECT MIN(category_id) FROM categories
      GROUP BY farm_id, category_type, category_name
    )
  `)

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(`categories de-duplicated — ${removed} duplicate row(s) removed`)
}

// =============================================
// ONE-TIME MIGRATION: layer_mortality -> layer_health
// =============================================
// The layer module's Mortality screen became a full Flock Health screen, mirroring
// broiler. Every existing mortality entry becomes one health row, carrying its date,
// batch and count. feed_used and avg_weight stay NULL — there is no source for them,
// and a zero would be a claim that no feed was used that day, which would then be
// divided into every later day's cumulative feed metric.
//
// `layer_mortality` is deliberately NOT dropped, emptied, or altered. It stays as the
// untouched original, so a wrong migration costs a re-run and not the client's data.
//
// Three independent things keep this from running twice:
//   1. the app_settings flag, written last, so a throw part-way leaves it unset and
//      the next launch resumes rather than skipping;
//   2. the NOT EXISTS clause, so a resumed run copies only what is still missing;
//   3. the partial UNIQUE index on source_mortality_id, which makes a duplicate
//      physically impossible even if both guards above were somehow lost.
// It is therefore idempotent by construction, not merely by flag.
function migrateLayerMortalityToHealth(db) {
  const MIGRATION_KEY = 'migration_layer_health_v1'
  // app_settings is keyed (farm_id, key); farms.farm_id is AUTOINCREMENT and never
  // yields 0, so 0 is the app-wide scope used for migration flags.
  const SETTINGS_SCOPE_APP = 0

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  // Mortality rows whose batch is already gone. The JOIN below cannot carry them —
  // there is no start_date to date them against and no initial_birds to size them
  // from — and they are invisible in the app today for the same reason. Reported so
  // a mismatch in the counts has an explanation rather than looking like data loss.
  const orphaned = selectRows(`
    SELECT COUNT(*) AS count FROM layer_mortality m
    WHERE NOT EXISTS (SELECT 1 FROM batches b WHERE b.batch_id = m.batch_id)
  `)[0].count

  // total_birds is the flock size AT that entry: the batch's initial birds less every
  // mortality recorded before it. Ordering inside a single date falls back to
  // mortality_id so two entries on one day do not both subtract the same prior total.
  // MAX(...) here is the two-argument scalar function, not the aggregate — it floors
  // a day index at 1 for an entry dated before its batch started, and floors
  // total_birds at 0 where recorded mortality exceeds the batch's initial birds.
  // COALESCE guards a malformed date, which would otherwise make julianday() return
  // NULL and violate day_number NOT NULL, failing the whole migration forever.
  db.run(`
    INSERT INTO layer_health
      (batch_id, day_number, date, total_birds, mortality, feed_used, avg_weight, notes, source_mortality_id)
    SELECT
      m.batch_id,
      MAX(1, COALESCE(CAST(julianday(m.date) - julianday(b.start_date) AS INTEGER) + 1, 1)),
      m.date,
      MAX(0, b.initial_birds - COALESCE((
        SELECT SUM(p.count) FROM layer_mortality p
        WHERE p.batch_id = m.batch_id
          AND (p.date < m.date OR (p.date = m.date AND p.mortality_id < m.mortality_id))
      ), 0)),
      m.count,
      NULL,
      NULL,
      m.reason,
      m.mortality_id
    FROM layer_mortality m
    JOIN batches b ON b.batch_id = m.batch_id
    WHERE NOT EXISTS (
      SELECT 1 FROM layer_health h WHERE h.source_mortality_id = m.mortality_id
    )
  `)

  const migrated = selectRows(
    `SELECT COUNT(*) AS count FROM layer_health WHERE source_mortality_id IS NOT NULL`
  )[0].count

  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(
    `layer_mortality -> layer_health migration complete — ${migrated} row(s) carried across` +
    (orphaned > 0 ? `, ${orphaned} row(s) skipped as their batch no longer exists` : '') +
    ` (layer_mortality left intact)`
  )
}

// =============================================
// ONE-TIME BACKFILL: own-farm bills become customer debts
// =============================================
// Distribution is its own business and the owner's farms are its customers.
// An own-farm bill (`payment_type = 'internal'`) used to be written with
// `customer_id = NULL` and `amount_paid = total_amount` — forced "paid" so it
// would not sit Unpaid forever — which meant no receivable existed anywhere:
// distribution absorbed the cost of the goods with no revenue, and the farm
// carried the cost but never the debt.
//
// Own-farm bills now carry a real `customers` row (customer_type = 'own_farm',
// one per farm_units row) and a real `amount_paid`, so the farm goes negative
// in customer_ledger until it settles.
//
// THE REINTERPRETATION, and why it is the conservative direction: every
// historical own-farm bill says amount_paid = total_amount, but that was a
// display workaround, not a record of money changing hands — the farm never
// actually paid. Left alone, those bills would enter the distribution revenue
// pool as fully collected and retroactively inflate past revenue by the whole
// value of every transfer ever made. They are therefore set to amount_paid = 0.
// The effect is that NO existing figure on any screen moves — those bills
// contributed zero revenue before and contribute zero now — while the debt they
// always represented becomes visible for the first time.
//
// Same convergent shape as backfillFarmUnits: guarded by an app_settings flag
// written LAST, so a throw part way leaves it unset and the next launch re-runs;
// every step re-runs to the same end state. Bills are selected on
// `customer_id IS NULL`, so ones already converted are skipped on a re-run, and
// the ledger row is deleted before it is re-inserted so it cannot double up.
function migrateOwnFarmCustomers(db) {
  const MIGRATION_KEY = 'migration_own_farm_customers_v1'
  // app_settings is keyed (farm_id, key); farms.farm_id is AUTOINCREMENT and never
  // yields 0, so 0 is the app-wide scope used for migration flags.
  const SETTINGS_SCOPE_APP = 0
  const FALLBACK_UNIT_NAME = 'Own Farm (Unassigned)'

  const selectRows = (sql, params = []) => {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  const alreadyApplied = selectRows(
    `SELECT value FROM app_settings WHERE farm_id = ? AND key = ?`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY]
  )
  if (alreadyApplied.length > 0) return

  // ALTER TABLE ... ADD COLUMN with a constant DEFAULT fills existing rows in
  // SQLite, so this should be a no-op — it is here so the invariant holds even
  // if a database arrived by some other route. Every pre-existing customer is a
  // real one.
  db.run(`UPDATE customers SET customer_type = 'external' WHERE customer_type IS NULL`)

  // One own-farm customer per farm_units row. Resolved by (farm_id, unit_id) so
  // renaming the unit later cannot orphan it or cause a second one to be made.
  const findOwnFarmCustomer = (farmId, unitId) =>
    unitId == null
      ? selectRows(
          `SELECT customer_id FROM customers
           WHERE farm_id = ? AND customer_type = 'own_farm' AND unit_id IS NULL`,
          [farmId]
        )
      : selectRows(
          `SELECT customer_id FROM customers
           WHERE farm_id = ? AND customer_type = 'own_farm' AND unit_id = ?`,
          [farmId, unitId]
        )

  const findOrCreateOwnFarmCustomer = (farmId, unitId) => {
    const existing = findOwnFarmCustomer(farmId, unitId)
    if (existing.length > 0) return existing[0].customer_id

    let name = FALLBACK_UNIT_NAME
    if (unitId != null) {
      const unit = selectRows(`SELECT unit_name FROM farm_units WHERE unit_id = ?`, [unitId])
      // Plain hyphen, not an em dash: this name is rendered into jsPDF's
      // helvetica, which has no glyph for one.
      if (unit.length > 0 && unit[0].unit_name) name = `Own Farm - ${unit[0].unit_name}`
    }

    db.run(
      `INSERT INTO customers (farm_id, customer_name, unit_id, customer_type, outstanding_balance)
       VALUES (?, ?, ?, 'own_farm', 0)`,
      [farmId, name, unitId]
    )
    // Re-select rather than trusting last_insert_rowid(), which this codebase
    // has already found unreliable under sql.js (see the fallback in runQuery).
    const created = findOwnFarmCustomer(farmId, unitId)
    return created.length > 0 ? created[0].customer_id : null
  }

  // The target flock/batch comes off internal_transfers. A bill can have several
  // transfer rows (one per line item) but they all share the same target, so the
  // first one is enough.
  const pending = selectRows(`
    SELECT b.bill_id, b.farm_id, b.total_amount, b.bill_date, b.bill_number,
           (SELECT it.target_module FROM internal_transfers it
             WHERE it.bill_id = b.bill_id LIMIT 1) AS target_module,
           (SELECT it.target_flock_id FROM internal_transfers it
             WHERE it.bill_id = b.bill_id LIMIT 1) AS target_flock_id
    FROM bills b
    WHERE COALESCE(b.payment_type, 'cash') = 'internal' AND b.customer_id IS NULL
    ORDER BY b.bill_id ASC
  `)

  const touchedCustomers = new Set()
  let converted = 0
  let fellBack = 0

  for (const bill of pending) {
    // internal_transfers rows can be missing entirely on a bill whose save was
    // interrupted before this codebase had transactions. Those bills still owe
    // money; they just cannot say which farm owes it, so they go to the
    // per-account fallback customer rather than being skipped.
    let unitId = null
    if (bill.target_flock_id != null) {
      const owner = bill.target_module === 'layer'
        ? selectRows(`SELECT unit_id FROM batches WHERE batch_id = ?`, [bill.target_flock_id])
        : selectRows(`SELECT unit_id FROM flocks WHERE flock_id = ?`, [bill.target_flock_id])
      if (owner.length > 0 && owner[0].unit_id != null) unitId = owner[0].unit_id
    }
    if (unitId == null) fellBack++

    const customerId = findOrCreateOwnFarmCustomer(bill.farm_id, unitId)
    if (!customerId) throw new Error(`Could not create own-farm customer for bill ${bill.bill_id}`)

    const nameRow = selectRows(`SELECT customer_name FROM customers WHERE customer_id = ?`, [customerId])
    const customerName = nameRow.length > 0 ? nameRow[0].customer_name : FALLBACK_UNIT_NAME

    db.run(
      `UPDATE bills SET customer_id = ?, customer_name = ?, amount_paid = 0 WHERE bill_id = ?`,
      [customerId, customerName, bill.bill_id]
    )

    // Convergent: a re-run after a crash re-inserts, so clear first. Nothing
    // else can own a 'bill'/'payment' ledger row keyed to this bill_id.
    db.run(
      `DELETE FROM customer_ledger WHERE reference_id = ? AND reference_type IN ('bill', 'payment')`,
      [bill.bill_id]
    )
    db.run(
      `INSERT INTO customer_ledger
         (customer_id, transaction_date, description, debit, credit, balance, reference_type, reference_id)
       VALUES (?, ?, ?, ?, 0,
         (SELECT COALESCE(SUM(debit - credit), 0) FROM customer_ledger WHERE customer_id = ?) + ?,
         'bill', ?)`,
      [
        customerId,
        bill.bill_date,
        `Bill #${bill.bill_number || bill.bill_id}`,
        bill.total_amount || 0,
        customerId,
        bill.total_amount || 0,
        bill.bill_id
      ]
    )

    touchedCustomers.add(customerId)
    converted++
  }

  // Derived from bills, exactly as updateCustomerOutstandingBalance does, so the
  // figure matches what every screen computes for itself.
  for (const customerId of touchedCustomers) {
    db.run(
      `UPDATE customers SET outstanding_balance =
         (SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0)
          FROM bills WHERE customer_id = ?)
       WHERE customer_id = ?`,
      [customerId, customerId]
    )
  }

  // Written only once every bill above has been fully converted.
  db.run(
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
    [SETTINGS_SCOPE_APP, MIGRATION_KEY, '1']
  )

  console.log(
    `own-farm customers migration complete — ${converted} bill(s) reinterpreted as unpaid across ` +
    `${touchedCustomers.size} own-farm customer(s)` +
    (fellBack > 0
      ? `, ${fellBack} of them with no resolvable farm (their internal_transfers rows are missing), ` +
        `assigned to the "${FALLBACK_UNIT_NAME}" customer`
      : '')
  )
}

// =============================================
// MAIN INITIALIZE FUNCTION
// =============================================
async function initializeDatabase() {
  const initSqlJs = require('sql.js')
  SQL = await initSqlJs()

  const dbPath = path.join(app.getPath('userData'), 'sng_farm.db')
  let recovered = false

  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath)
      db = new SQL.Database(fileBuffer)
      console.log('Database loaded successfully')
      
      try {
        const result = db.exec('PRAGMA integrity_check')
        if (result[0] && result[0].values[0][0] !== 'ok') {
          console.error('Integrity check failed, attempting recovery...')
          const recoveredDb = attemptRecovery(dbPath, db, SQL)
          if (recoveredDb) {
            db = recoveredDb
            recovered = true
          } else {
            db = backupAndStartFresh(dbPath, SQL)
          }
        }
      } catch (integrityErr) {
        console.error('Integrity check error, attempting recovery:', integrityErr.message)
        const recoveredDb = attemptRecovery(dbPath, db, SQL)
        if (recoveredDb) {
          db = recoveredDb
          recovered = true
        } else {
          db = backupAndStartFresh(dbPath, SQL)
        }
      }
      
    } catch (err) {
      console.error('Database load failed:', err.message)
      db = backupAndStartFresh(dbPath, SQL)
    }
  } else {
    db = new SQL.Database()
  }

  createTables(db)

  const alterStatements = [
    `ALTER TABLE batches ADD COLUMN end_date DATE`,
        `ALTER TABLE purchase_orders ADD COLUMN status TEXT DEFAULT 'completed'`,
    `ALTER TABLE expenses ADD COLUMN receipt_image TEXT`,
    `ALTER TABLE purchase_orders ADD COLUMN receipt_image TEXT`,
`ALTER TABLE activation ADD COLUMN activation_cycle INTEGER DEFAULT 0`,
    `ALTER TABLE activation ADD COLUMN trial_start_date TEXT`,
`ALTER TABLE activation ADD COLUMN last_launch_date TEXT`,
`ALTER TABLE activation ADD COLUMN is_permanent INTEGER DEFAULT 0`,
    `ALTER TABLE customers ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE sales ADD COLUMN payment_type TEXT DEFAULT 'cash'`,
    `ALTER TABLE expenses ADD COLUMN payment_type TEXT DEFAULT 'cash'`,
    `ALTER TABLE sales ADD COLUMN driver_name TEXT DEFAULT ''`,
    `ALTER TABLE sales ADD COLUMN driver_phone TEXT DEFAULT ''`,
    `ALTER TABLE expenses ADD COLUMN bill_available TEXT DEFAULT 'No'`,
    `ALTER TABLE ledger_entries ADD COLUMN type TEXT DEFAULT 'debit'`,
    `ALTER TABLE ledger_entries ADD COLUMN source TEXT DEFAULT 'manual'`,
    `ALTER TABLE expenses ADD COLUMN ledger_entry_id INTEGER`,
    `ALTER TABLE farms ADD COLUMN business_type TEXT DEFAULT 'broiler'`,
    `ALTER TABLE expenses ADD COLUMN module_type TEXT DEFAULT 'broiler'`,
    `ALTER TABLE sales ADD COLUMN module_type TEXT DEFAULT 'broiler'`,
    `ALTER TABLE income ADD COLUMN module_type TEXT DEFAULT 'broiler'`,
    `ALTER TABLE balance ADD COLUMN module_type TEXT DEFAULT 'broiler'`,
    `ALTER TABLE medicine_traders ADD COLUMN module_type TEXT`,
    `ALTER TABLE medicine_entries ADD COLUMN module_type TEXT`,
    `ALTER TABLE feed_traders ADD COLUMN module_type TEXT`,
    `ALTER TABLE feed_entries ADD COLUMN module_type TEXT`,
    `ALTER TABLE flocks ADD COLUMN end_date DATE`,
    `ALTER TABLE sales ADD COLUMN receipt_image TEXT`,
    `ALTER TABLE bills ADD COLUMN status TEXT DEFAULT 'completed'`,
    `ALTER TABLE customers ADD COLUMN bank_id INTEGER`,
    // 🔥 ADD transaction_number to bank_ledger
    `ALTER TABLE bank_ledger ADD COLUMN transaction_number TEXT`,
    // 🔥 Make vaccinations work for both Broiler and Layer
    `ALTER TABLE vaccinations ADD COLUMN flock_id INTEGER`,
    `ALTER TABLE vaccinations ADD COLUMN cost REAL DEFAULT 0`,
    // NOTE: the "make vaccinations.batch_id nullable" table rebuild used to live
    // here, unguarded, and therefore re-ran on every launch — silently dropping
    // flock_id, cost, bill_id and bill_number every time. It now lives in the
    // flagged, one-shot migrateVaccinationsNullableBatchId() below. Do not put a
    // RENAME/CREATE/INSERT...SELECT/DROP rebuild in this array: everything here
    // runs on every start, and only ALTER-style statements survive that safely.
    `ALTER TABLE internal_transfers ADD COLUMN target_type TEXT`,
    `ALTER TABLE internal_transfers ADD COLUMN reference_id INTEGER`,
    `ALTER TABLE purchase_orders ADD COLUMN batch_id INTEGER`,
    `ALTER TABLE categories ADD COLUMN category_type TEXT DEFAULT 'product'`,
    `ALTER TABLE medicine_entries ADD COLUMN bill_id INTEGER`,
    `ALTER TABLE medicine_entries ADD COLUMN bill_number TEXT`,
    `ALTER TABLE feed_entries ADD COLUMN bill_id INTEGER`,
    `ALTER TABLE feed_entries ADD COLUMN bill_number TEXT`,
    `ALTER TABLE vaccinations ADD COLUMN bill_id INTEGER`,
    `ALTER TABLE vaccinations ADD COLUMN bill_number TEXT`,
    // Farm units (client-facing name: "Farm"). Deliberately NOT added to labour
    // yet — the shared broiler/layer tables overload flock_id to hold a batch_id
    // when module_type = 'layer', and labour needs that ambiguity resolved first.
    `ALTER TABLE flocks ADD COLUMN unit_id INTEGER`,
    `ALTER TABLE batches ADD COLUMN unit_id INTEGER`,
    // Assets bought on installments. total_price is the full agreed price;
    // purchase_amount stays as its mirror (see the assets table definition).
    // Backfilled from purchase_amount by backfillAssetInstallments() below.
    `ALTER TABLE assets ADD COLUMN total_price REAL`,
    // User-defined personal expense categories. The `category` text column is
    // deliberately left in place and still written — see backfillExpenseCategories().
    `ALTER TABLE personal_expenses ADD COLUMN category_id INTEGER`,
    // Must come after the ADD COLUMN above — this array runs in order, and the
    // index cannot be built before the column exists.
    `CREATE INDEX IF NOT EXISTS idx_personal_expenses_category ON personal_expenses(category_id)`,
    // Marks a flock_health row whose FCR the user typed by hand, so it survives a
    // reload and is never overwritten by the auto calculation. Rows saved before
    // this existed default to 0 (auto), and their stored `fcr` is left untouched —
    // the UI derives what it displays from cumulative feed instead.
    `ALTER TABLE flock_health ADD COLUMN fcr_manual INTEGER DEFAULT 0`,
    // Flags the settlement payment the app writes for itself when an asset is
    // sold with a balance still owed. Existing rows take the DEFAULT 0, which is
    // correct — every payment written before this column existed was one the
    // user entered by hand. Backfilled for already-sold assets by
    // backfillAssetSaleSettlements() below.
    `ALTER TABLE asset_payments ADD COLUMN is_settlement INTEGER DEFAULT 0`,
    // Distribution treats the owner's own farms as customers: an own-farm bill
    // now carries a real customer_id, so the farm carries the debt in
    // customer_ledger until it settles. 'external' is the DEFAULT and is
    // correct for every row that existed before this — they are all real
    // customers. Backfilled for own-farm bills by migrateOwnFarmCustomers().
    `ALTER TABLE customers ADD COLUMN unit_id INTEGER`,
    `ALTER TABLE customers ADD COLUMN customer_type TEXT DEFAULT 'external'`,
    // Must come after the ADD COLUMN above — this array runs in order.
    `CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(farm_id, customer_type)`,
    // Profit carried forward from the client's previous system, entered by hand
    // per farm_units row (not app-calculated). Existing farms default to 0 — no
    // backfill needed. Negative values are allowed (a farm may carry a loss).
    `ALTER TABLE farm_units ADD COLUMN opening_balance REAL DEFAULT 0`,
    // Lets a worker be retired without deleting their history. Existing rows
    // default to 'active' — no backfill needed. Inactive workers must be
    // filtered out of every payment-recording dropdown, but still show in
    // Labour Management and in historical reports.
    `ALTER TABLE labour ADD COLUMN status TEXT DEFAULT 'active'`,
    // Hen Sales can now price by weight instead of per bird. Existing rows
    // default to 'per_hen' and keep working unchanged; total_weight (kg) is
    // only populated for 'per_kg' rows. No backfill needed.
    `ALTER TABLE hen_sales ADD COLUMN pricing_mode TEXT DEFAULT 'per_hen'`,
    `ALTER TABLE hen_sales ADD COLUMN total_weight REAL`,
    // Layer Expenses screen — miscellaneous batch costs (diesel, repairs,
    // transport, ...) that don't belong to the medicine/feed trader screens.
    // Existing (broiler) rows keep these NULL; the new screen always writes
    // both alongside module_type='layer'.
    `ALTER TABLE expenses ADD COLUMN category TEXT`,
    `ALTER TABLE expenses ADD COLUMN notes TEXT`,
    // Egg Sales can now price by carton (360 eggs) instead of per egg.
    // Existing rows default to 'per_egg' and keep working unchanged;
    // `quantity` always holds the real egg count either way — a per_carton
    // row derives it from carton_count * eggs_per_carton at save time — so
    // egg stock/production figures never need to know which mode was used.
    // eggs_per_carton is stored per row (not hardcoded) so a different
    // carton size later needs no migration. No backfill needed.
    `ALTER TABLE egg_sales ADD COLUMN sale_mode TEXT DEFAULT 'per_egg'`,
    `ALTER TABLE egg_sales ADD COLUMN carton_count REAL`,
    `ALTER TABLE egg_sales ADD COLUMN eggs_per_carton INTEGER DEFAULT 360`,
    // Egg Collection can now be RECORDED by carton, the same way Egg Sales is
    // priced by carton. Same discipline, and the stakes are higher: `total_eggs`
    // always holds the real egg count, derived at save time as
    // carton_count * eggs_per_carton for a per_carton row. Nothing downstream
    // knows about modes — egg stock (egg-sales), cumulative production
    // (layer-flock-health) and the layer report all keep reading `total_eggs`
    // as they always have. A per_carton row that wrote the CARTON count there
    // would divide every one of those figures by 360.
    // broken_eggs and the four grade columns stay plain egg counts in both
    // modes; only total_eggs is derived.
    // Existing rows default to 'per_egg' and keep working unchanged;
    // carton_count stays NULL for them. eggs_per_carton is stored per row (not
    // hardcoded) so a different carton size later needs no migration.
    // No backfill needed.
    `ALTER TABLE egg_collection ADD COLUMN collection_mode TEXT DEFAULT 'per_egg'`,
    `ALTER TABLE egg_collection ADD COLUMN carton_count REAL`,
    `ALTER TABLE egg_collection ADD COLUMN eggs_per_carton INTEGER DEFAULT 360`,
    // Layer Ledger. The two tables themselves are created by createTables above,
    // which runs on EVERY launch with CREATE TABLE IF NOT EXISTS — so an existing
    // database gets them there and there is no column to add here. Their indexes
    // live in this array with the other after-the-fact indexes; both reads are
    // always scoped (ledgers by batch, entries by ledger and ordered by date), and
    // a batch runs 70+ weeks so the entry table grows.
    `CREATE INDEX IF NOT EXISTS idx_layer_ledgers_batch ON layer_ledgers(batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_layer_ledger_entries_ledger ON layer_ledger_entries(ledger_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_layer_ledger_entries_batch ON layer_ledger_entries(batch_id)`,
    // ── Money received or paid through a bank account ──────────────────────
    // Six more tables join `asset_payments` and `personal_expenses` as sources
    // of a real bank movement: for every row here with payment_source = 'bank'
    // there is exactly one bank_ledger row carrying that table's reference_type
    // and that row's primary key. See the BANK_SOURCES block in
    // src/app/shared/services/database.service.ts for the full invariant.
    //
    // `payment_source` is NOT the same column as the `payment_type` several of
    // these already carry. payment_type is what the user labelled the row —
    // free text that has always included 'bank', 'cheque' and 'credit' and that
    // no report filters on. payment_source is the normalized fact that money
    // moved through a named account, and it is the ONLY thing the bank wiring
    // keys off.
    //
    // There is deliberately NO backfill. Rows written before this existed keep
    // the 'cash' column default even where payment_type already said 'bank',
    // because no withdrawal or deposit was ever posted for them — there is
    // nothing to reverse and nothing to rebuild. That makes the "legacy row"
    // exemption structural rather than a list somebody has to maintain: a row
    // is exempt precisely because payment_source is not 'bank'. Editing such a
    // row requires choosing an account, and from then on it carries a real
    // entry — the row becomes accurate rather than retroactively inventing
    // history.
    `ALTER TABLE sales ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE sales ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE income ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE income ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE expenses ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE expenses ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE labour_payments ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE labour_payments ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE egg_sales ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE egg_sales ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE hen_sales ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE hen_sales ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE purchase_orders ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE purchase_orders ADD COLUMN bank_id INTEGER`,
    // ── A DISTRIBUTION BILL'S PAYMENT ─────────────────────────────────────
    // A bill is the one money row whose payment can land on either KIND of
    // account, which is why it carries a third column the nine tables above do
    // not need. The owner's customer may pay into one of the owner's own house
    // accounts (money IN, a real receipt), or the payment may be taken from the
    // deposit that customer already holds with the farm (money OUT of that
    // customer's account — the axis this screen has always had, written as
    // reference_type 'payment' with a NULL reference_id).
    //
    // `payment_account_kind` is 'house' or 'customer', and it is the ONLY thing
    // that tells the two apart on a saved row. `payment_type` cannot: it reads
    // 'bank' for both, because that is what the user labelled the bill and what
    // the list's badge shows. Branching on payment_type would make a house
    // receipt look like a customer-deposit payment to the edit and delete
    // paths, which would then credit a refund into a customer's account that
    // the money never came out of.
    //
    // NULL is the legacy value and is read as 'customer' wherever payment_type
    // = 'bank', because the customer-deposit axis was the only bank axis a bill
    // had before this. No backfill, for the same reason the block above has
    // none — and here it would also be a guess.
    `ALTER TABLE bills ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE bills ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE bills ADD COLUMN payment_account_kind TEXT`,
    // ── WHO BOUGHT A LAYER SALE ────────────────────────────────────────────
    // Egg and hen sales are made to real customers, and the client wants them
    // attributed — the same `customers` list distribution sells to, own-farm
    // rows excluded. Nullable with no backfill, because a walk-in sale has no
    // customer and every row written before this was one as far as the
    // database knows; `customer_name` (free text, still written) is all those
    // rows ever recorded.
    //
    // Attribution only. These tables are layer-only and keyed on `batch_id`,
    // so no module_type guard applies to them — see the egg_sales/hen_sales
    // rows in the delete-cascade notes in CLAUDE.md.
    `ALTER TABLE egg_sales ADD COLUMN customer_id INTEGER`,
    `ALTER TABLE hen_sales ADD COLUMN customer_id INTEGER`,
    // ── A LAYER SALE'S RECEIVABLE ──────────────────────────────────────────
    // An unpaid egg or hen sale made to a named customer raises a real `bills`
    // row, because in this app a customer's balance IS
    // `Σ MAX(bills.total_amount − bills.amount_paid, 0)` — every screen and
    // every settlement derives from that one expression. A bare
    // `customer_ledger` debit would show on the statement, move no balance,
    // and be unsettleable, since `customerSettlementOps()` allocates across
    // unpaid BILLS.
    //
    // `source` says which kind of row it is: NULL or 'distribution' for every
    // bill Sales Orders has ever written, 'egg_sale' / 'hen_sale' for a
    // receivable. `source_id` is the sale's own primary key.
    //
    // BOTH columns are needed, not just source_id: `egg_sales.egg_sale_id` and
    // `hen_sales.hen_sale_id` are separate AUTOINCREMENT sequences that both
    // start at 1, so an id alone is ambiguous between the two tables — the
    // same collision `flock_id` and `batch_id` have, and the same fix.
    //
    // No backfill. NULL is read as 'distribution' everywhere, which is what
    // every existing row is. See src/app/shared/utils/bill-source.util.ts for
    // which readers take which side of the split.
    `ALTER TABLE bills ADD COLUMN source TEXT`,
    `ALTER TABLE bills ADD COLUMN source_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_bills_source ON bills(source, source_id)`,
    // The link from a voucher to the ledger rows it wrote. A receive voucher's
    // FIFO spill can produce several customer_ledger credits, one tagged per
    // bill, so the link is N-ary and lives here rather than as a ledger_id on
    // the voucher. Nullable and read by nothing else: every row written before
    // vouchers existed stays NULL, which is exactly right — no voucher wrote
    // it. ALTER-style and idempotent, so re-running on every launch is safe;
    // the duplicate-column error is how this array detects "already applied".
    `ALTER TABLE customer_ledger ADD COLUMN voucher_id INTEGER`,
    `ALTER TABLE supplier_ledger ADD COLUMN voucher_id INTEGER`,
    // A SUPPLIER LEDGER LINE'S OWN NOTE, alongside its description.
    //
    // `description` is what the row IS — "Purchase Order #12", "Payment
    // Voucher PV-0003 — Al-Fateh Traders" — and every writer composes it, so
    // it is not a field the client can use. The note is the client's: the
    // cheque number, who collected, what the payment was against. Payment
    // Voucher already captured one and had nowhere to put it, so it reached
    // the voucher table and stopped there, which is exactly what the client
    // noticed was missing from the ledger.
    //
    // Nullable with no backfill, and the column is appended to the INSERT only
    // for a caller that has a note — so a purchase order's own ledger row
    // emits the statement it always did. ALTER-style and idempotent: the
    // duplicate-column error is how this array detects "already applied".
    `ALTER TABLE supplier_ledger ADD COLUMN notes TEXT`,
    // WHERE THE MONEY FROM SELLING AN ASSET LANDED.
    //
    // `assets.payment_source` / `assets.bank_id` are the asset's FIRST
    // PAYMENT — how the owner paid for it when he bought it — and they are
    // deliberately not reused here: selling is the opposite direction, so a
    // deposit posted off those columns would credit whichever account happened
    // to have made a down payment years earlier. These two are the sale's own,
    // written only when the asset is sold.
    //
    // No backfill, and that is what makes every asset sold before this safe: a
    // row saying `sale_payment_source` IS NULL (read as 'cash') is one no
    // `bank_ledger` entry was ever posted for, which is true. The exemption is
    // structural rather than a list of ids. ALTER-style and idempotent.
    // WHICH ACCOUNT A DISTRIBUTION EXPENSE WAS PAID FROM.
    //
    // `expense_ledger.payment_type` has offered the user "Bank" since this
    // table existed, as free text with no account behind it and no ledger
    // effect — so the recorded bank balance never moved while the real one
    // did. These two are the normalized fact, and the table joins the same
    // BANK_SOURCES mechanism the nine others use.
    //
    // No backfill: a row saved before this says `payment_type = 'bank'` and
    // `payment_source` NULL (read as 'cash'), which is true — no entry was
    // ever posted for it. Editing one requires choosing an account and starts
    // posting from then on. ALTER-style and idempotent.
    `ALTER TABLE expense_ledger ADD COLUMN payment_source TEXT DEFAULT 'cash'`,
    `ALTER TABLE expense_ledger ADD COLUMN bank_id INTEGER`,
    `ALTER TABLE assets ADD COLUMN sale_payment_source TEXT`,
    `ALTER TABLE assets ADD COLUMN sale_bank_id INTEGER`,
    // The same link for an internal settlement, and the same reasoning: a
    // settlement's FIFO spill can credit several bills, so the link is N-ary and
    // lives on the ledger row. Mutually exclusive with voucher_id — a credit row
    // comes from one door or the other, never both. Nullable, ALTER-style and
    // idempotent; every row written before Change 4 stays NULL, which is right.
    `ALTER TABLE customer_ledger ADD COLUMN internal_settlement_id INTEGER`,
    // Every reversal reads bank_ledger by (reference_type, reference_id) — the
    // one lookup the whole invariant rests on, now run on eleven source tables.
    `CREATE INDEX IF NOT EXISTS idx_bank_ledger_reference ON bank_ledger(reference_type, reference_id)`,
    // And a voucher delete reads its own ledger rows by voucher_id.
    `CREATE INDEX IF NOT EXISTS idx_customer_ledger_voucher ON customer_ledger(voucher_id)`,
    `CREATE INDEX IF NOT EXISTS idx_supplier_ledger_voucher ON supplier_ledger(voucher_id)`,
    // And an internal settlement delete reads its own ledger rows the same way.
    `CREATE INDEX IF NOT EXISTS idx_customer_ledger_internal_settlement ON customer_ledger(internal_settlement_id)`,
    // WHICH SALE CREATED THIS SETTLEMENT, when one did. A bank sale on any of
    // the three sale screens can auto-settle the own-farm debt the flock or
    // batch carries, and deleting that sale has to take its settlement with it
    // — so the settlement has to be findable from the sale, and from nothing
    // else.
    //
    // BOTH columns, not just the id: `sales.sale_id`, `egg_sales.egg_sale_id`
    // and `hen_sales.hen_sale_id` are three separate AUTOINCREMENT sequences
    // that all start at 1, so an id alone is ambiguous between the three — the
    // same collision `bills.source` / `bills.source_id` solves, and the same
    // fix. Each is AUTOINCREMENT, so an id is never reissued and a stale
    // pointer can never resolve to some other sale.
    //
    // Nullable with no backfill: every settlement entered by hand on the
    // Internal Settlement screen leaves both NULL, which is exactly right —
    // no sale created it. ALTER-style and idempotent, so re-running on every
    // launch is safe; the duplicate-column error is how this array detects
    // "already applied".
    `ALTER TABLE internal_settlements ADD COLUMN auto_source_table TEXT`,
    `ALTER TABLE internal_settlements ADD COLUMN auto_source_id INTEGER`,
    // A sale delete reads its own settlement by the pair.
    `CREATE INDEX IF NOT EXISTS idx_internal_settlements_auto_source ON internal_settlements(auto_source_table, auto_source_id)`,
  ]
  
  for (const sql of alterStatements) {
    try { db.run(sql) } catch(e) {}
  }

  // Must run after alterStatements — those add vaccinations.flock_id / cost /
  // bill_id / bill_number to a legacy table, and this copies whatever columns the
  // table has. Running it earlier would rebuild before they exist.
  try {
    migrateVaccinationsNullableBatchId(db)
  } catch (e) {
    console.error('vaccinations rebuild failed, will retry on next launch:', e.message)
  }

  // One-shot, flagged. Was an every-launch UPDATE matching expenses on a fuzzy
  // (ledger_id, date, amount) triple, which reclassified genuine debits out of
  // the books whenever amounts coincided. See the function for the full story.
  try {
    migrateExpenseLedgerSource(db)
  } catch (e) {
    console.error('ledger source backfill failed, will retry on next launch:', e.message)
  }

  // One-shot, flagged, and deliberately AFTER the backfill above: that one marks
  // the legacy mirrors, this one deletes every marked row. Expenses and ledgers
  // are separate books now and nothing mirrors anything. Moves no report figure —
  // every total already excluded `source = 'expense'`. See the function.
  try {
    migrateDropExpenseLedgerMirrors(db)
  } catch (e) {
    console.error('expense ledger mirror removal failed, will retry on next launch:', e.message)
  }

  try {
    db.run(`DROP INDEX IF EXISTS idx_categories_farm_name`)
  } catch(e) {}

  // Must stay ahead of the de-dupe below and of the unique index: NULLs are
  // distinct to a UNIQUE index and to GROUP BY, so rows still carrying a NULL
  // category_type would neither collapse nor be constrained. Idempotent.
  try {
    db.run(`UPDATE categories SET category_type = 'product' WHERE category_type IS NULL`)
  } catch(e) {}

  // One-shot, flagged. Was an unguarded every-launch DELETE — the same shape as
  // the vaccinations bug, destroying legitimately re-created categories on every
  // start. The unique index below is what keeps duplicates out from here on.
  try {
    migrateDeduplicateCategories(db)
  } catch (e) {
    console.error('categories de-dupe failed, will retry on next launch:', e.message)
  }

  try {
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_farm_type_name ON categories(farm_id, category_type, category_name)`)
  } catch(e) {}

  try {
    db.run(`
      UPDATE medicine_traders
      SET module_type = 'layer'
      WHERE module_type IS NULL
        AND flock_id IN (SELECT batch_id FROM batches)
        AND flock_id NOT IN (SELECT flock_id FROM flocks);

      UPDATE medicine_traders
      SET module_type = 'broiler'
      WHERE module_type IS NULL
        AND flock_id IN (SELECT flock_id FROM flocks)
        AND flock_id NOT IN (SELECT batch_id FROM batches);

      UPDATE medicine_entries
      SET module_type = (
        SELECT mt.module_type FROM medicine_traders mt
        WHERE mt.trader_id = medicine_entries.trader_id
      )
      WHERE module_type IS NULL;

      UPDATE feed_traders
      SET module_type = 'layer'
      WHERE module_type IS NULL
        AND flock_id IN (SELECT batch_id FROM batches)
        AND flock_id NOT IN (SELECT flock_id FROM flocks);

      UPDATE feed_traders
      SET module_type = 'broiler'
      WHERE module_type IS NULL
        AND flock_id IN (SELECT flock_id FROM flocks)
        AND flock_id NOT IN (SELECT batch_id FROM batches);

      UPDATE feed_entries
      SET module_type = (
        SELECT ft.module_type FROM feed_traders ft
        WHERE ft.trader_id = feed_entries.trader_id
      )
      WHERE module_type IS NULL;
    `)
  } catch(e) {}

  // Must run after alterStatements — it depends on flocks.unit_id / batches.unit_id
  // existing. Swallowing the error here is deliberate: the flag stays unset, so a
  // failure retries on the next launch instead of blocking startup.
  try {
    backfillFarmUnits(db)
  } catch (e) {
    console.error('farm_units backfill failed, will retry on next launch:', e.message)
  }

  // Must run after backfillFarmUnits — it relies on that migration having
  // already created a farm_unit for any account that needed one.
  try {
    repairOrphanedUnitIds(db)
  } catch (e) {
    console.error('orphaned unit_id repair failed, will retry on next launch:', e.message)
  }

  // Must run after alterStatements — it reads assets.total_price, which the
  // ALTER above adds to a legacy table. Swallowing the error is deliberate and
  // matches the migrations above: the flag stays unset, so a failure retries on
  // the next launch instead of blocking startup.
  try {
    backfillAssetInstallments(db)
  } catch (e) {
    console.error('asset installments backfill failed, will retry on next launch:', e.message)
  }

  // Must run after backfillAssetInstallments — it measures each sold asset's
  // shortfall against the payment rows, and that migration is what gives legacy
  // assets their opening payment. Running first would read every legacy asset as
  // wholly unpaid and settle its full price a second time. Also after
  // alterStatements, which adds asset_payments.is_settlement.
  try {
    backfillAssetSaleSettlements(db)
  } catch (e) {
    console.error('asset sale settlements backfill failed, will retry on next launch:', e.message)
  }

  // Must run after alterStatements — it writes personal_expenses.category_id.
  try {
    backfillExpenseCategories(db)
  } catch (e) {
    console.error('expense categories backfill failed, will retry on next launch:', e.message)
  }

  // Must run after createTables — it reads layer_mortality and writes layer_health,
  // and relies on that table's partial UNIQUE index existing to be duplicate-proof.
  // Swallowed like the migrations above: the flag stays unset, so a failure retries
  // on the next launch instead of blocking startup.
  try {
    migrateLayerMortalityToHealth(db)
  } catch (e) {
    console.error('layer health migration failed, will retry on next launch:', e.message)
  }

  // Must run after alterStatements — it reads and writes customers.unit_id and
  // customers.customer_type, which that array adds. Swallowed like the
  // migrations above: the flag is written last, so a failure retries on the
  // next launch instead of blocking startup.
  try {
    migrateOwnFarmCustomers(db)
  } catch (e) {
    console.error('own-farm customers migration failed, will retry on next launch:', e.message)
  }

  saveDatabase(dbPath)

  if (recovered) {
    console.log('⚠️  Database was recovered from corruption')
  }
  
  return { db, recovered }
}

// =============================================
// SAVE DATABASE
// =============================================
function saveDatabase(dbPath) {
  // The last line of defence. runQuery/runBatch already refuse while poisoned,
  // but a number of helper functions in this file call db.run() directly and
  // never went through either — those mutate the in-memory database, and this is
  // the single chokepoint where anything reaches the file. Refusing here is what
  // makes "nothing was written" true regardless of which path a stray statement
  // took. clearPoison() then discards that in-memory drift by reloading.
  if (poisonedConnection) {
    console.error('🛑 Refused a disk write on a poisoned connection — the file keeps its last committed state.')
    return
  }
  // db.export() closes and re-opens the connection, which silently throws away
  // any open transaction (verified against sql.js 1.14). Writing to disk
  // mid-transaction would lose the very work being protected — commitTransaction()
  // does the single write once everything is committed.
  if (inTransaction) {
    console.error('saveDatabase() called while a transaction is open — skipped; the commit will write instead.')
    return
  }
  if (db) {
    try {
      const data = db.export()
      const buffer = Buffer.from(data)
      fs.writeFileSync(dbPath, buffer)
    } catch (err) {
      console.error('Failed to save database:', err.message)
    }
  }
}

// =============================================
// RUN QUERY (INSERT/UPDATE/DELETE) - FIXED
// =============================================
const PRIMARY_KEY_MAP = {
  farm_units: 'unit_id',
  purchase_returns: 'return_id',
  labour: 'labour_id',
  labour_payments: 'payment_id',
  purchase_orders: 'purchase_id',
  sales_orders: 'order_id',
  product_batches: 'batch_id',
  hen_sales: 'hen_sale_id',
  batch_transactions: 'transaction_id',
  customer_ledger: 'ledger_id',
  supplier_ledger: 'ledger_id',
  bank_ledger: 'ledger_id',
  receive_vouchers: 'voucher_id',
  payment_vouchers: 'voucher_id',
  internal_settlements: 'settlement_id',
  suppliers: 'supplier_id',
  customers: 'customer_id',
  products: 'product_id',
  bills: 'bill_id',
  bill_items: 'item_id',
  bank_accounts: 'bank_id',
  customer_payments: 'payment_id',
  flocks: 'flock_id',
  ledgers: 'ledger_id',
  expenses: 'expense_id',
  ledger_entries: 'entry_id',
  medicine_traders: 'trader_id',
  medicine_entries: 'entry_id',
  feed_traders: 'trader_id',
  feed_entries: 'entry_id',
  chick_traders: 'trader_id',
  chick_entries: 'entry_id',
  loans: 'loan_id',
  loan_payments: 'payment_id',
  debt_records: 'debt_id',
  sales: 'sale_id',
  income: 'income_id',
  flock_health: 'health_id',
  balance: 'balance_id',
  brokers: 'broker_id',
  batches: 'batch_id',
  egg_collection: 'collection_id',
  egg_sales: 'egg_sale_id',
  vaccinations: 'vaccination_id',
  layer_mortality: 'mortality_id',
  layer_health: 'health_id',
  layer_ledgers: 'ledger_id',
  layer_ledger_entries: 'entry_id',
  farms: 'farm_id',
  expense_ledger: 'expense_id',
  categories: 'category_id',
  sales_returns: 'return_id',
  sales_return_items: 'item_id',
  internal_transfers: 'transfer_id',
  assets: 'asset_id',
  personal_expenses: 'pexpense_id',
  asset_payments: 'payment_id',
  expense_categories: 'category_id'
};

// Executes a single statement and returns its lastId (INSERTs only). Throws on
// SQL error so the caller can decide whether that merely gets reported
// (runQuery) or unwinds a whole transaction (runBatch).
//
// The semantics here are deliberately the ones runQuery has always had:
// INSERTs go through prepare/run so last_insert_rowid() means something, and
// everything else goes through db.run(sql, params). Note that sql.js treats a
// non-null params — `[]` included — as the "prepare" path, which executes only
// the FIRST statement of a multi-statement string. Callers such as
// updateBatchStatuses() depend on that, so do not "fix" it here.
function executeStatement(sql, params = []) {
  const sqlUpper = sql.trim().toUpperCase();
  let lastId = null;

  if (sqlUpper.startsWith('INSERT')) {
    const stmt = db.prepare(sql);
    stmt.run(params);
    stmt.free();

    try {
      const idResult = db.exec('SELECT last_insert_rowid() as id');
      if (idResult && idResult.length > 0 && idResult[0].values && idResult[0].values.length > 0) {
        lastId = idResult[0].values[0][0];
      }
    } catch (e) {
      console.error('last_insert_rowid lookup failed:', e.message);
    }

    if (!lastId) {
      const tableMatch = sql.match(/INSERT\s+INTO\s+["`\[]?(\w+)["`\]]?/i);
      const tableName = tableMatch ? tableMatch[1] : null;
      const pk = tableName ? PRIMARY_KEY_MAP[tableName] : null;
      if (pk) {
        try {
          const fallbackResult = db.exec(`SELECT MAX(${pk}) as id FROM ${tableName}`);
          if (fallbackResult && fallbackResult.length > 0 && fallbackResult[0].values && fallbackResult[0].values.length > 0) {
            lastId = fallbackResult[0].values[0][0];
            console.log(`📝 last_insert_rowid() was unreliable — used MAX(${pk}) fallback: ${lastId}`);
          }
        } catch (e) {
          console.error('Fallback lastId lookup failed:', e.message);
        }
      } else if (tableName) {
        console.warn(`⚠️ No primary key mapping for table "${tableName}" — add it to PRIMARY_KEY_MAP if lastId is needed for it.`);
      }
    }

    console.log(`📝 Last insert ID: ${lastId}`);
  } else {
    db.run(sql, params);
  }

  return { lastId: lastId };
}

function runQuery(sql, params = []) {
  if (poisonedConnection) return refuseWrite('a write')

  try {
    const { lastId } = executeStatement(sql, params);

    // Inside a transaction the write is not durable until COMMIT, which does
    // the single export. Exporting here would destroy the open transaction.
    if (!inTransaction) {
      saveDatabase(getDbPath())
    }

    return { success: true, lastId: lastId };
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// =============================================
// TRANSACTIONS
// =============================================
// A transaction is owned by one renderer flow: begin -> work -> commit, with a
// rollback in that flow's finally. Reads issued in between go over this same
// connection, so they see the transaction's own uncommitted rows — which is what
// lets a multi-step save (restore stock, then re-deduct it) behave exactly as it
// did back when every statement committed immediately.
let inTransaction = false
let transactionWatchdog = null
let savepointCounter = 0

// If a flow dies without committing, every later write would stop reaching disk
// (runQuery skips saveDatabase while a transaction is open). Unwind an
// abandoned transaction rather than leaving the app in that state.
const TRANSACTION_TIMEOUT_MS = 60000

// =============================================
// POISONED CONNECTION
// =============================================
// The watchdog fires on a wall clock, not on the renderer flow it is unwinding.
// A flow that is merely SLOW — not dead — is still mid-way through its
// statements when the rollback lands, and the rollback clears `inTransaction`.
// Without the poison, that flow's remaining statements go to runQuery, see no
// open transaction, execute in autocommit and each call saveDatabase(). Its
// eventual commitTransaction() then fails ("No database transaction is open")
// and the UI reports the save failed — while the tail end of that same save is
// already on disk, with the first half rolled back. Half a bill, half a ledger,
// and a screen that says nothing was written.
//
// That is strictly worse than having no transaction at all: without one, the
// whole save reaches disk and the books are at least complete. So once the
// watchdog has unwound a flow, this refuses every subsequent write on that
// connection. A save that fails completely is recoverable — the user retries it.
// A save that half-succeeds while reporting failure is not, because nobody knows
// to go looking.
//
// Cleared when the owning flow acknowledges the failure by calling commit or
// rollback (both then report the failure honestly), or by the stale-poison
// escape hatch in beginTransaction() below for a flow that never comes back.
let poisonedConnection = null

function poisonConnection(reason) {
  poisonedConnection = { reason, poisonedAt: Date.now(), refusedWrites: 0 }
  console.error(
    `🛑 Database connection poisoned: ${reason}\n` +
    `   Every further write is refused until the interrupted flow finishes. ` +
    `This is deliberate — see the poisoned-connection note in electron/database.js.`
  )
}

// Every refused write pushes `poisonedAt` forward. A zombie flow that is still
// grinding therefore keeps the poison alive for as long as it keeps trying to
// write, and only a genuinely silent connection can ever go stale.
function refuseWrite(what) {
  poisonedConnection.refusedWrites++
  poisonedConnection.poisonedAt = Date.now()
  console.error(
    `🛑 Refused ${what} on a poisoned connection ` +
    `(${poisonedConnection.refusedWrites} refused so far): ${poisonedConnection.reason}`
  )
  return {
    success: false,
    poisoned: true,
    error:
      'This save was cancelled part-way through because it took too long, and nothing from it ' +
      'has been written. The database was left exactly as it was before the save started. ' +
      'Please close this screen and try again.'
  }
}

// The in-memory database after a watchdog rollback cannot be trusted: the
// ROLLBACK may itself have thrown, and the helper functions in this file that
// call db.run() directly (rather than going through runQuery) can have mutated
// it while the poison only blocked the disk write. Rebuilding the connection
// from the file — which the poison guaranteed nobody wrote to — is what makes
// "nothing from that save survived" true of memory as well as of disk.
function reloadFromDisk() {
  if (!SQL) throw new Error('sql.js is not initialised')
  const dbPath = getDbPath()
  if (!fs.existsSync(dbPath)) throw new Error(`No database file at ${dbPath}`)
  const fresh = new SQL.Database(fs.readFileSync(dbPath))
  try { if (db) db.close() } catch (e) { /* the old handle is being discarded anyway */ }
  db = fresh
}

// Returns true if the connection is usable again. Kept separate from the
// callers so a failed reload leaves the poison in place rather than handing back
// a connection whose state nobody can vouch for.
function clearPoison() {
  try {
    reloadFromDisk()
  } catch (err) {
    console.error(
      `🛑 Could not rebuild the database connection after a poisoned transaction: ${err.message}\n` +
      `   Staying poisoned. Restart the app.`
    )
    return false
  }
  const held = poisonedConnection
  poisonedConnection = null
  console.log(
    `Database connection recovered after ${held.refusedWrites} refused write(s); ` +
    `reloaded from the last committed file on disk.`
  )
  return true
}

function isPoisoned() {
  return poisonedConnection !== null
}

function getDbPath() {
  return path.join(app.getPath('userData'), 'sng_farm.db')
}

function isInTransaction() {
  return inTransaction
}

function startTransactionWatchdog() {
  clearTransactionWatchdog()
  transactionWatchdog = setTimeout(() => {
    transactionWatchdog = null
    if (!inTransaction) return
    console.error(`⚠️ A database transaction has been open for more than ${TRANSACTION_TIMEOUT_MS}ms — rolling it back.`)
    // Poison BEFORE the rollback. rollbackTransaction() clears `inTransaction`,
    // and the instant it does, any statement the owning flow issues would be
    // free to execute in autocommit and hit the disk.
    poisonConnection(`a transaction was open for more than ${TRANSACTION_TIMEOUT_MS}ms and was rolled back`)
    performRollback()
  }, TRANSACTION_TIMEOUT_MS)
  if (typeof transactionWatchdog.unref === 'function') transactionWatchdog.unref()
}

function clearTransactionWatchdog() {
  if (transactionWatchdog) {
    clearTimeout(transactionWatchdog)
    transactionWatchdog = null
  }
}

function beginTransaction() {
  // Escape hatch for a flow that was killed outright — a renderer reload, or an
  // exception path that skipped its finally — and so will never call commit or
  // rollback to clear the poison itself. Without this the app would be
  // permanently read-only until restart, which is the very lock-up the watchdog
  // exists to prevent.
  //
  // Safe because refuseWrite() pushes `poisonedAt` forward on every refusal: a
  // zombie flow still issuing statements keeps the poison fresh and never
  // reaches this branch. Only a connection that has been silent for a full
  // timeout AND is now seeing a brand-new transaction begin is treated as clear.
  if (poisonedConnection && Date.now() - poisonedConnection.poisonedAt >= TRANSACTION_TIMEOUT_MS) {
    console.error('🛑 The poisoned flow has been silent for a full timeout — recovering the connection for a new transaction.')
    clearPoison()
  }
  if (poisonedConnection) return refuseWrite('a BEGIN')

  if (inTransaction) {
    return { success: false, error: 'A database transaction is already open' }
  }
  try {
    db.run('BEGIN TRANSACTION')
    inTransaction = true
    startTransactionWatchdog()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function commitTransaction() {
  // The owning flow has come back to commit a transaction the watchdog already
  // unwound. Tell it the truth — nothing it did was kept — and let it go. The
  // bare `!inTransaction` check below would say "No database transaction is
  // open", which is accurate and completely uninformative.
  if (poisonedConnection) {
    const reason = poisonedConnection.reason
    const recovered = clearPoison()
    return {
      success: false,
      poisoned: true,
      recovered,
      error:
        'This save was cancelled part-way through because it took too long, and nothing from it ' +
        'has been written. The database was left exactly as it was before the save started. ' +
        'Please try again.' + (recovered ? '' : ' If it fails again, restart the app.') +
        ` (${reason})`
    }
  }

  if (!inTransaction) {
    return { success: false, error: 'No database transaction is open' }
  }

  try {
    db.run('COMMIT')
  } catch (err) {
    // The commit itself failed — don't leave the transaction half-open.
    inTransaction = false
    clearTransactionWatchdog()
    try {
      db.run('ROLLBACK')
    } catch (rollbackErr) {
      console.error('Rollback after a failed commit also failed:', rollbackErr.message)
    }
    return { success: false, error: err.message }
  }

  inTransaction = false
  clearTransactionWatchdog()
  // The one and only disk write for everything the transaction contained.
  saveDatabase(getDbPath())
  return { success: true }
}

// The actual unwind. Split out from rollbackTransaction() so the watchdog can
// unwind WITHOUT clearing the poison it just set — the public entry point treats
// a rollback as the owning flow acknowledging the failure, which is exactly what
// the watchdog is not.
function performRollback() {
  if (!inTransaction) {
    return { success: true, rolledBack: false }
  }

  inTransaction = false
  clearTransactionWatchdog()
  try {
    db.run('ROLLBACK')
    return { success: true, rolledBack: true }
  } catch (err) {
    console.error('Rollback failed:', err.message)
    return { success: false, error: err.message }
  }
}

function rollbackTransaction() {
  // The owning flow's finally block, arriving after the watchdog already unwound
  // its transaction. The rollback it is asking for has happened, so this reports
  // success — but it is also the signal that the flow is done, which is what
  // releases the poison.
  if (poisonedConnection) {
    const recovered = clearPoison()
    return { success: recovered, rolledBack: true, poisoned: true, recovered }
  }

  // Safe to call from a finally block that doesn't know whether the transaction
  // is still open.
  return performRollback()
}

// Resolves { $lastId: n } placeholders against the ids of earlier operations in
// the same batch. n >= 0 is an absolute operation index; n < 0 is relative to
// the current one (-1 being the operation immediately before it).
function resolveBatchParams(params, results, opIndex) {
  if (!Array.isArray(params)) return []

  return params.map((param) => {
    if (!param || typeof param !== 'object' || !('$lastId' in param)) return param

    const requested = param.$lastId
    if (typeof requested !== 'number') {
      throw new Error(`Statement ${opIndex + 1} has a $lastId reference that is not a number`)
    }

    const ref = requested < 0 ? opIndex + requested : requested
    if (ref < 0 || ref >= results.length) {
      throw new Error(`Statement ${opIndex + 1} references the id of statement ${ref + 1}, which has not run`)
    }

    const id = results[ref].lastId
    if (id === null || id === undefined) {
      throw new Error(`Statement ${opIndex + 1} needs the inserted id of statement ${ref + 1}, but no id came back`)
    }
    return id
  })
}

// Runs an ordered list of { sql, params } atomically: either all of them commit
// or none of them do, and the database file is written once — not once per
// statement the way runQuery does it.
function runBatch(ops) {
  if (poisonedConnection) return refuseWrite('a batch')

  if (!Array.isArray(ops) || ops.length === 0) {
    return { success: false, error: 'runBatch expects a non-empty array of { sql, params } operations' }
  }

  // A batch issued while a transaction is already open becomes a savepoint, so
  // it can unwind on its own without discarding the outer transaction. SQLite
  // rejects a nested BEGIN outright.
  const nested = inTransaction
  const savepoint = `batch_sp_${++savepointCounter}`

  try {
    db.run(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN TRANSACTION')
  } catch (err) {
    return { success: false, error: err.message }
  }
  if (!nested) {
    inTransaction = true
    startTransactionWatchdog()
  }

  const unwind = () => {
    try {
      db.run(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
      if (nested) db.run(`RELEASE ${savepoint}`)
    } catch (err) {
      console.error('Rolling back a failed batch failed:', err.message)
    }
    if (!nested) {
      inTransaction = false
      clearTransactionWatchdog()
    }
  }

  const results = []
  let failure = null

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {}
    try {
      if (!op.sql || typeof op.sql !== 'string') {
        throw new Error('Statement is missing its SQL')
      }
      results.push(executeStatement(op.sql, resolveBatchParams(op.params, results, i)))
    } catch (err) {
      failure = { index: i, sql: op.sql || '', error: err.message }
      break
    }
  }

  if (failure) {
    unwind()
    console.error(`Batch failed at statement ${failure.index + 1}/${ops.length}: ${failure.error}\n  SQL: ${failure.sql}`)
    return {
      success: false,
      error: `${failure.error} (statement ${failure.index + 1} of ${ops.length})`,
      failedIndex: failure.index,
      failedSql: failure.sql
    }
  }

  try {
    db.run(nested ? `RELEASE ${savepoint}` : 'COMMIT')
  } catch (err) {
    unwind()
    return { success: false, error: err.message }
  }

  if (!nested) {
    inTransaction = false
    clearTransactionWatchdog()
    saveDatabase(getDbPath())
  }

  return {
    success: true,
    results: results,
    lastId: results.length > 0 ? results[results.length - 1].lastId : null
  }
}


function getLastInsertId(tableName, pk) {
  try {
    const idResult = db.exec('SELECT last_insert_rowid() as id')
    if (idResult && idResult.length > 0 && idResult[0].values && idResult[0].values.length > 0) {
      const id = idResult[0].values[0][0]
      if (id) return id
    }
  } catch (e) {}
  try {
    const fallback = db.exec(`SELECT MAX(${pk}) as id FROM ${tableName}`)
    if (fallback && fallback.length > 0 && fallback[0].values && fallback[0].values.length > 0) {
      return fallback[0].values[0][0]
    }
  } catch (e) {}
  return null
}


// =============================================
// GET QUERY (SELECT)
// =============================================
function getQuery(sql, params = []) {
  try {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── BATCH OPERATIONS ─────────────────────────────────────────

function getBatchesByProduct(productId, farmId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        b.*,
        p.product_name,
        p.unit,
        julianday(b.expiry_date) - julianday('now') as days_until_expiry,
        CASE 
          WHEN b.status = 'expired' THEN 'expired'
          WHEN julianday(b.expiry_date) - julianday('now') <= 90 AND b.quantity > 0 THEN 'expiring'
          WHEN b.quantity <= 0 THEN 'depleted'
          ELSE 'active'
        END as calculated_status
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.product_id = ? AND b.farm_id = ?
      ORDER BY b.expiry_date ASC
    `)
    stmt.bind([productId, farmId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function addBatch(batchData) {
  try {
    const { product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price } = batchData
    
    let finalBatchCode = batch_code
    if (!finalBatchCode) {
      const stmt = db.prepare(`SELECT COUNT(*) as count FROM product_batches WHERE product_id = ?`)
      stmt.bind([product_id])
      const result = stmt.getAsObject()
      stmt.free()
      const count = (result.count || 0) + 1
      finalBatchCode = `BATCH-${String(product_id).padStart(3, '0')}-${String(count).padStart(3, '0')}`
    }
    
    const stmt = db.prepare(`
      INSERT INTO product_batches 
      (product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `)
    stmt.run([product_id, farm_id, finalBatchCode, manufacturing_date, expiry_date, quantity, purchase_price || 0])
    stmt.free()
    
    // The batch row and the 'purchase' row recording where its stock came from
    // are ONE write, so neither may fail quietly. addBatchTransaction() reports
    // a failure in its result rather than throwing, and this used to discard
    // that result and return success regardless — a batch with no record of
    // where its stock came from, and a caller told everything was fine.
    // The twin of this function in database.service.ts is the one the screens
    // actually reach; this one is exported but has no ipcMain handler and no
    // caller. Fixed in both so wiring it up later cannot revive the bug.
    const batchId = getLastInsertId('product_batches', 'batch_id')
    if (!batchId) {
      return {
        success: false,
        error: 'The stock batch was written but its id did not come back, so the stock-in entry could not be recorded.'
      }
    }

    const logged = addBatchTransaction(batchId, product_id, 'purchase', quantity, toLocalDateString(), null, 'Initial batch addition')
    if (!logged || !logged.success) {
      return {
        success: false,
        error: (logged && logged.error) || 'Could not record the stock-in entry for the new batch.'
      }
    }

    return { success: true, batch_id: batchId, batch_code: finalBatchCode }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function updateBatch(batchId, data) {
  try {
    const fields = []
    const values = []
    
    if (data.batch_code !== undefined) { fields.push('batch_code = ?'); values.push(data.batch_code) }
    if (data.manufacturing_date !== undefined) { fields.push('manufacturing_date = ?'); values.push(data.manufacturing_date) }
    if (data.expiry_date !== undefined) { fields.push('expiry_date = ?'); values.push(data.expiry_date) }
    if (data.quantity !== undefined) { fields.push('quantity = ?'); values.push(data.quantity) }
    if (data.purchase_price !== undefined) { fields.push('purchase_price = ?'); values.push(data.purchase_price) }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status) }
    
    if (fields.length === 0) return { success: false, error: 'No fields to update' }
    
    values.push(batchId)
    const sql = `UPDATE product_batches SET ${fields.join(', ')} WHERE batch_id = ?`
    db.run(sql, values)
    
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function deleteBatch(batchId) {
  try {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM batch_transactions WHERE batch_id = ?`)
    stmt.bind([batchId])
    const result = stmt.getAsObject()
    stmt.free()
    
    if (result.count > 0) {
      db.run(`UPDATE product_batches SET status = 'depleted' WHERE batch_id = ?`, [batchId])
      return { success: true, message: 'Batch marked as depleted due to existing transactions' }
    } else {
      db.run(`DELETE FROM product_batches WHERE batch_id = ?`, [batchId])
      return { success: true, message: 'Batch deleted successfully' }
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getTotalStock(productId) {
  try {
    const stmt = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as total 
      FROM product_batches 
      WHERE product_id = ? AND quantity > 0 AND expiry_date >= date('now')
    `)
    stmt.bind([productId])
    const result = stmt.getAsObject()
    stmt.free()
    return { success: true, total: result.total || 0 }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getExpiringBatches(farmId, monthsThreshold = 3) {
  try {
    const stmt = db.prepare(`
      SELECT 
        b.*,
        p.product_name,
        p.unit,
        julianday(b.expiry_date) - julianday('now') as days_until_expiry,
        CAST((julianday(b.expiry_date) - julianday('now')) / 30.44 AS INTEGER) as months_until_expiry
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.farm_id = ? 
        AND b.quantity > 0
        AND julianday(b.expiry_date) - julianday('now') <= (? * 30.44)
        AND julianday(b.expiry_date) - julianday('now') > 0
      ORDER BY b.expiry_date ASC
    `)
    stmt.bind([farmId, monthsThreshold])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function hasExpiringBatches(productId, monthsThreshold = 3) {
  try {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM product_batches
      WHERE product_id = ?
        AND quantity > 0
        AND julianday(expiry_date) - julianday('now') <= (? * 30.44)
        AND julianday(expiry_date) - julianday('now') > 0
    `)
    stmt.bind([productId, monthsThreshold])
    const result = stmt.getAsObject()
    stmt.free()
    return { success: true, hasExpiring: result.count > 0 }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function addBatchTransaction(batchId, productId, type, quantity, transactionDate, referenceId = null, notes = '') {
  try {
    const stmt = db.prepare(`
      INSERT INTO batch_transactions 
      (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([batchId, productId, type, quantity, transactionDate, referenceId, notes])
    stmt.free()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getBatchTransactions(batchId) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM batch_transactions 
      WHERE batch_id = ? 
      ORDER BY transaction_date DESC, created_at DESC
    `)
    stmt.bind([batchId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getBatchById(batchId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        b.*,
        p.product_name,
        p.unit,
        julianday(b.expiry_date) - julianday('now') as days_until_expiry
      FROM product_batches b
      INNER JOIN products p ON b.product_id = p.product_id
      WHERE b.batch_id = ?
    `)
    stmt.bind([batchId])
    const result = stmt.getAsObject()
    stmt.free()
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function updateBatchStatuses() {
  try {
    db.run(`
      UPDATE product_batches 
      SET status = 'expired' 
      WHERE expiry_date < date('now') 
        AND status IN ('active', 'expiring')
    `)
    
    db.run(`
      UPDATE product_batches 
      SET status = 'depleted' 
      WHERE quantity <= 0 
        AND status IN ('active', 'expiring')
    `)
    
    db.run(`
      UPDATE product_batches 
      SET status = 'expiring' 
      WHERE expiry_date >= date('now') 
        AND expiry_date <= date('now', '+3 months')
        AND quantity > 0
        AND status = 'active'
    `)
    
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function migrateExistingStock(farmId) {
  try {
    const stmt = db.prepare(`
      SELECT product_id, product_name, current_stock, cost_price 
      FROM products 
      WHERE farm_id = ? AND current_stock > 0
    `)
    stmt.bind([farmId])
    const products = []
    while (stmt.step()) {
      products.push(stmt.getAsObject())
    }
    stmt.free()
    
    let migrated = 0
    for (const product of products) {
      const checkStmt = db.prepare(`SELECT COUNT(*) as count FROM product_batches WHERE product_id = ?`)
      checkStmt.bind([product.product_id])
      const result = checkStmt.getAsObject()
      checkStmt.free()
      
      if (result.count === 0 && product.current_stock > 0) {
        const today = toLocalDateString()
        const oneYearLater = new Date()
        oneYearLater.setFullYear(oneYearLater.getFullYear() + 1)
        const expiryDate = toLocalDateString(oneYearLater)
        
        const batchCode = `BATCH-${String(product.product_id).padStart(3, '0')}-001`
        
        const insertStmt = db.prepare(`
          INSERT INTO product_batches 
          (product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        `)
        insertStmt.run([product.product_id, farmId, batchCode, today, expiryDate, product.current_stock, product.cost_price || 0])
        insertStmt.free()
        
        const batchId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0]
        addBatchTransaction(batchId, product.product_id, 'purchase', product.current_stock, today, null, 'Migrated from existing stock')
        
        migrated++
      }
    }
    
    return { success: true, migrated }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── LEDGER OPERATIONS ─────────────────────────────────────────

function addCustomerLedgerEntry(entry) {
  try {
    const { customer_id, transaction_date, description, debit = 0, credit = 0, reference_type, reference_id } = entry;
    
    let currentBalance = 0;
    try {
      const stmt = db.prepare(`
        SELECT COALESCE(SUM(debit - credit), 0) as balance 
        FROM customer_ledger 
        WHERE customer_id = ?
      `)
      stmt.bind([customer_id])
      const result = stmt.getAsObject()
      stmt.free()
      currentBalance = result.balance || 0;
    } catch (e) {
      console.error('Error getting balance:', e.message);
    }
    
    const newBalance = currentBalance + debit - credit;
    
    const stmt = db.prepare(`
      INSERT INTO customer_ledger 
      (customer_id, transaction_date, description, debit, credit, balance, reference_type, reference_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([customer_id, transaction_date, description, debit, credit, newBalance, reference_type || null, reference_id || null])
    stmt.free()
    
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function addSupplierLedgerEntry(entry) {
  try {
    const { supplier_id, transaction_date, description, debit = 0, credit = 0, reference_type, reference_id } = entry;
    
    let currentBalance = 0;
    try {
      const stmt = db.prepare(`
        SELECT COALESCE(SUM(credit - debit), 0) as balance 
        FROM supplier_ledger 
        WHERE supplier_id = ?
      `)
      stmt.bind([supplier_id])
      const result = stmt.getAsObject()
      stmt.free()
      currentBalance = result.balance || 0;
    } catch (e) {
      console.error('Error getting balance:', e.message);
    }
    
    const newBalance = currentBalance + credit - debit;
    
    const stmt = db.prepare(`
      INSERT INTO supplier_ledger 
      (supplier_id, transaction_date, description, debit, credit, balance, reference_type, reference_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([supplier_id, transaction_date, description, debit, credit, newBalance, reference_type || null, reference_id || null])
    stmt.free()
    
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── BANK LEDGER ENTRY ──────────────────────────────────────

function addBankLedgerEntry(entry) {
  try {
    const { bank_id, transaction_date, description, debit = 0, credit = 0, reference_type, reference_id, transaction_number } = entry;
    
    // Get current balance
    let currentBalance = 0;
    try {
      const stmt = db.prepare(`
        SELECT COALESCE(SUM(debit - credit), 0) as balance 
        FROM bank_ledger 
        WHERE bank_id = ?
      `);
      stmt.bind([bank_id]);
      const result = stmt.getAsObject();
      stmt.free();
      currentBalance = result.balance || 0;
    } catch (e) {
      console.error('Error getting bank balance:', e.message);
    }
    
    const newBalance = currentBalance + debit - credit;
    
    // Insert ledger entry
    const stmt = db.prepare(`
      INSERT INTO bank_ledger 
      (bank_id, transaction_date, description, debit, credit, balance, reference_type, reference_id, transaction_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([bank_id, transaction_date, description, debit, credit, newBalance, reference_type || null, reference_id || null, transaction_number || null]);
    stmt.free();
    
    // 🔥 CRITICAL: Update the bank account current balance
    db.run(`UPDATE bank_accounts SET current_balance = ? WHERE bank_id = ?`, [newBalance, bank_id]);
    
    return { success: true };
  } catch (err) {
    console.error('Error adding bank ledger entry:', err);
    return { success: false, error: err.message };
  }
}
function updateCustomerOutstandingBalance(customerId) {
  try {
    const stmt = db.prepare(`
      SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) as balance 
      FROM bills 
      WHERE customer_id = ?
    `)
    stmt.bind([customerId])
    const result = stmt.getAsObject()
    stmt.free()
    const balance = result.balance || 0;
    
    db.run(`UPDATE customers SET outstanding_balance = ? WHERE customer_id = ?`, [balance, customerId])
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getCustomerLedgerWithBalance(customerId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        l.ledger_id,
        l.customer_id,
        l.transaction_date,
        l.description,
        l.debit,
        l.credit,
        l.reference_type,
        l.reference_id,
        l.created_at,
        c.customer_name,
        c.phone,
        c.address,
        (SELECT COALESCE(SUM(cl.debit - cl.credit), 0)
         FROM customer_ledger cl
         WHERE cl.customer_id = l.customer_id
           AND (
             cl.transaction_date < l.transaction_date OR
             (cl.transaction_date = l.transaction_date AND cl.ledger_id <= l.ledger_id)
           )) as balance
      FROM customer_ledger l
      INNER JOIN customers c ON l.customer_id = c.customer_id
      WHERE l.customer_id = ?
      ORDER BY l.transaction_date ASC, l.ledger_id ASC
    `)
    stmt.bind([customerId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getSupplierLedgerWithBalance(supplierId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        l.ledger_id,
        l.supplier_id,
        l.transaction_date,
        l.description,
        l.debit,
        l.credit,
        l.reference_type,
        l.reference_id,
        l.created_at,
        s.supplier_name,
        s.phone,
        (SELECT COALESCE(SUM(sl.credit - sl.debit), 0)
         FROM supplier_ledger sl
         WHERE sl.supplier_id = l.supplier_id
           AND (
             sl.transaction_date < l.transaction_date OR
             (sl.transaction_date = l.transaction_date AND sl.ledger_id <= l.ledger_id)
           )) as balance
      FROM supplier_ledger l
      INNER JOIN suppliers s ON l.supplier_id = s.supplier_id
      WHERE l.supplier_id = ?
      ORDER BY l.transaction_date ASC, l.ledger_id ASC
    `)
    stmt.bind([supplierId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getBankLedgerWithBalance(bankId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        l.ledger_id,
        l.bank_id,
        l.transaction_date,
        l.description,
        l.debit,
        l.credit,
        l.reference_type,
        l.reference_id,
        l.transaction_number,
        l.created_at,
        b.bank_name,
        b.account_number,
        (SELECT COALESCE(SUM(bl.debit - bl.credit), 0)
         FROM bank_ledger bl
         WHERE bl.bank_id = l.bank_id
           AND (
             bl.transaction_date < l.transaction_date OR
             (bl.transaction_date = l.transaction_date AND bl.ledger_id <= l.ledger_id)
           )) as balance
      FROM bank_ledger l
      INNER JOIN bank_accounts b ON l.bank_id = b.bank_id
      WHERE l.bank_id = ?
      ORDER BY l.transaction_date ASC, l.ledger_id ASC
    `)
    stmt.bind([bankId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getBankAccounts(farmId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        ba.*,
        c.customer_name
      FROM bank_accounts ba
      LEFT JOIN customers c ON ba.customer_id = c.customer_id
      WHERE ba.farm_id = ?
      ORDER BY ba.bank_name ASC
    `)
    stmt.bind([farmId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getBankAccount(bankId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        ba.*,
        c.customer_name
      FROM bank_accounts ba
      LEFT JOIN customers c ON ba.customer_id = c.customer_id
      WHERE ba.bank_id = ?
    `)
    stmt.bind([bankId])
    const result = stmt.getAsObject()
    stmt.free()
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function addBankAccount(account) {
  try {
    const { farm_id, customer_id, bank_name, account_number, account_holder, opening_balance = 0 } = account;
    
    const stmt = db.prepare(`
      INSERT INTO bank_accounts 
      (farm_id, customer_id, bank_name, account_number, account_holder, opening_balance, current_balance)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([farm_id, customer_id || null, bank_name, account_number || null, account_holder || null, opening_balance, opening_balance])
    stmt.free()
    
    const bankId = getLastInsertId('bank_accounts', 'bank_id')
    
    if (opening_balance > 0) {
      const entry = {
        bank_id: bankId,
        transaction_date: toLocalDateString(),
        description: 'Opening Balance',
        debit: opening_balance,
        credit: 0,
        reference_type: 'opening',
        reference_id: null
      };
      addBankLedgerEntry(entry);
    }
    
    if (customer_id && bankId) {
      db.run(`UPDATE customers SET bank_id = ? WHERE customer_id = ?`, [bankId, customer_id])
    }
    
    return { success: true, bank_id: bankId }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function updateBankAccount(bankId, data) {
  try {
    const fields = []
    const values = []

    if (data.bank_name !== undefined) { fields.push('bank_name = ?'); values.push(data.bank_name); }
    if (data.account_number !== undefined) { fields.push('account_number = ?'); values.push(data.account_number); }
    if (data.account_holder !== undefined) { fields.push('account_holder = ?'); values.push(data.account_holder); }

    if (fields.length === 0) return { success: false, error: 'No fields to update' };

    values.push(bankId);
    const sql = `UPDATE bank_accounts SET ${fields.join(', ')} WHERE bank_id = ?`;
    db.run(sql, values)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function deleteBankAccount(bankId) {
  try {
    db.run(`DELETE FROM bank_accounts WHERE bank_id = ?`, [bankId])
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getAllCustomersWithBalance(farmId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        c.*,
        (SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) FROM bills WHERE customer_id = c.customer_id) as outstanding_balance
      FROM customers c
      WHERE c.farm_id = ?
      ORDER BY c.customer_name ASC
    `)
    stmt.bind([farmId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getAllSuppliersWithBalance(farmId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        s.*,
        (SELECT COALESCE(SUM(credit - debit), 0) FROM supplier_ledger WHERE supplier_id = s.supplier_id) as outstanding_balance
      FROM suppliers s
      WHERE s.farm_id = ?
      ORDER BY s.supplier_name ASC
    `)
    stmt.bind([farmId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── CUSTOMER BANK METHODS ────────────────────────────────────

function getCustomerBankAccount(customerId) {
  try {
    const stmt = db.prepare(`
      SELECT ba.* 
      FROM bank_accounts ba
      INNER JOIN customers c ON c.bank_id = ba.bank_id
      WHERE c.customer_id = ?
    `)
    stmt.bind([customerId])
    const result = stmt.getAsObject()
    stmt.free()
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getCustomerBankBalance(customerId) {
  try {
    const stmt = db.prepare(`
      SELECT ba.current_balance 
      FROM bank_accounts ba
      INNER JOIN customers c ON c.bank_id = ba.bank_id
      WHERE c.customer_id = ?
    `)
    stmt.bind([customerId])
    const result = stmt.getAsObject()
    stmt.free()
    return { success: true, balance: result.current_balance || 0 }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function deductCustomerBank(customerId, amount, description) {
  try {
    const bankResult = getCustomerBankAccount(customerId);
    if (!bankResult.success || !bankResult.data) {
      return { success: false, error: 'Customer has no bank account' };
    }
    
    const bank = bankResult.data;
    
    const entry = {
      bank_id: bank.bank_id,
      transaction_date: toLocalDateString(),
      description: description,
      debit: 0,
      credit: amount,
      reference_type: 'payment',
      reference_id: null
    };
    
    return addBankLedgerEntry(entry);
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function linkCustomerToBank(customerId, bankId) {
  try {
    db.run(`UPDATE customers SET bank_id = ? WHERE customer_id = ?`, [bankId, customerId]);
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getCustomersWithBankAccounts(farmId) {
  try {
    const stmt = db.prepare(`
      SELECT 
        c.*,
        ba.bank_id,
        ba.bank_name,
        ba.current_balance
      FROM customers c
      LEFT JOIN bank_accounts ba ON c.bank_id = ba.bank_id
      WHERE c.farm_id = ?
      ORDER BY c.customer_name ASC
    `)
    stmt.bind([farmId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── EXPENSE LEDGER OPERATIONS ──────────────────────────────

function addExpense(expense) {
  try {
    const { farm_id, transaction_date, description, amount, category, payment_type, notes } = expense;
    const stmt = db.prepare(`
      INSERT INTO expense_ledger (farm_id, transaction_date, description, amount, category, payment_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run([farm_id, transaction_date, description, amount, category || null, payment_type || 'cash', notes || null])
    stmt.free()
    const expenseId = getLastInsertId('expense_ledger', 'expense_id')
    return { success: true, expense_id: expenseId }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function updateExpense(expenseId, data) {
  try {
    const fields = []
    const values = []
    if (data.transaction_date !== undefined) { fields.push('transaction_date = ?'); values.push(data.transaction_date) }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
    if (data.amount !== undefined) { fields.push('amount = ?'); values.push(data.amount) }
    if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category) }
    if (data.payment_type !== undefined) { fields.push('payment_type = ?'); values.push(data.payment_type) }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes) }
    if (fields.length === 0) return { success: false, error: 'No fields to update' }
    values.push(expenseId)
    const sql = `UPDATE expense_ledger SET ${fields.join(', ')} WHERE expense_id = ?`
    db.run(sql, values)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function deleteExpense(expenseId) {
  try {
    db.run(`DELETE FROM expense_ledger WHERE expense_id = ?`, [expenseId])
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getExpenses(farmId, startDate = null, endDate = null) {
  try {
    let sql = `SELECT * FROM expense_ledger WHERE farm_id = ?`
    const params = [farmId]
    if (startDate && endDate) {
      sql += ` AND transaction_date BETWEEN ? AND ?`
      params.push(startDate, endDate)
    }
    sql += ` ORDER BY transaction_date DESC`
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getExpenseCategories(farmId) {
  try {
    const stmt = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM expense_ledger
      WHERE farm_id = ?
      GROUP BY category
      ORDER BY total DESC
    `)
    stmt.bind([farmId])
    const rows = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { success: true, data: rows }
  } catch (err) {
    return { success: false, error: err.message }
  }
}


// ── CATEGORY OPERATIONS ──────────────────────────────────

function getCategories(farmId) {
  try {
    const stmt = db.prepare('SELECT * FROM categories WHERE farm_id = ? ORDER BY category_name ASC');
    stmt.bind([farmId]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return { success: true, data: rows };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function addCategory(farmId, categoryName) {
  try {
    db.run('INSERT OR IGNORE INTO categories (farm_id, category_name) VALUES (?, ?)', [farmId, categoryName.toLowerCase().trim()]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function deleteCategory(categoryId) {
  try {
    db.run('DELETE FROM categories WHERE category_id = ?', [categoryId]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── FARM UNIT OPERATIONS ─────────────────────────────────
// These go through runQuery/getQuery rather than raw db.run so that writes are
// flushed to disk — a bare db.run() here only mutates the in-memory database.

function getFarmUnits(farmId, moduleType = null) {
  let sql = `SELECT * FROM farm_units WHERE farm_id = ?`
  const params = [farmId]
  if (moduleType) {
    sql += ` AND module_type = ?`
    params.push(moduleType)
  }
  sql += ` ORDER BY unit_name ASC`
  return getQuery(sql, params)
}

function addFarmUnit(unit) {
  const { farm_id, module_type, unit_name, location, notes, status } = unit
  if (!farm_id || !module_type || !unit_name) {
    return { success: false, error: 'farm_id, module_type and unit_name are required' }
  }
  return runQuery(
    `INSERT INTO farm_units (farm_id, module_type, unit_name, location, notes, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [farm_id, module_type, unit_name, location || null, notes || null, status || 'active']
  )
}

function updateFarmUnit(unitId, data) {
  const fields = []
  const values = []

  if (data.unit_name !== undefined) { fields.push('unit_name = ?'); values.push(data.unit_name) }
  if (data.location !== undefined) { fields.push('location = ?'); values.push(data.location) }
  if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes) }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status) }
  if (data.module_type !== undefined) { fields.push('module_type = ?'); values.push(data.module_type) }

  if (fields.length === 0) return { success: false, error: 'No fields to update' }

  values.push(unitId)
  return runQuery(`UPDATE farm_units SET ${fields.join(', ')} WHERE unit_id = ?`, values)
}

function deleteFarmUnit(unitId) {
  // Foreign keys are declared but never enforced (PRAGMA foreign_keys is never
  // turned on), so this check is the only thing standing between a delete and
  // orphaned rows pointing at a unit that no longer exists. Every table that
  // carries a unit_id column must be checked here — flocks, batches, customers
  // (own-farm customers are keyed on unit_id precisely so the debt survives a
  // flock/batch delete — see CLAUDE.md) and assets.
  const flockCheck = getQuery(`SELECT COUNT(*) AS count FROM flocks WHERE unit_id = ?`, [unitId])
  if (!flockCheck.success) return flockCheck
  const batchCheck = getQuery(`SELECT COUNT(*) AS count FROM batches WHERE unit_id = ?`, [unitId])
  if (!batchCheck.success) return batchCheck
  const customerCheck = getQuery(`SELECT COUNT(*) AS count FROM customers WHERE unit_id = ?`, [unitId])
  if (!customerCheck.success) return customerCheck
  const assetCheck = getQuery(`SELECT COUNT(*) AS count FROM assets WHERE unit_id = ?`, [unitId])
  if (!assetCheck.success) return assetCheck

  const flockCount = flockCheck.data[0].count
  const batchCount = batchCheck.data[0].count
  const customerCount = customerCheck.data[0].count
  const assetCount = assetCheck.data[0].count

  if (flockCount > 0 || batchCount > 0 || customerCount > 0 || assetCount > 0) {
    const parts = []
    if (flockCount > 0) parts.push(`${flockCount} flock(s)`)
    if (batchCount > 0) parts.push(`${batchCount} batch(es)`)
    if (customerCount > 0) parts.push(`${customerCount} customer(s)`)
    if (assetCount > 0) parts.push(`${assetCount} asset(s)`)
    return {
      success: false,
      error: `Cannot delete this farm — ${parts.join(', ')} still assigned to it. Move or delete them first.`
    }
  }

  return runQuery(`DELETE FROM farm_units WHERE unit_id = ?`, [unitId])
}

// ── OVERVIEW MODULE: FIXED ASSETS ────────────────────────
// Account-level (farm_id scoped, not flock/batch scoped). Routes through
// runQuery/getQuery so writes are flushed to disk, matching the farm_units
// pattern above.

function getAssets(farmId, status = null) {
  let sql = `SELECT * FROM assets WHERE farm_id = ?`
  const params = [farmId]
  if (status) {
    sql += ` AND status = ?`
    params.push(status)
  }
  sql += ` ORDER BY purchase_date DESC`
  return getQuery(sql, params)
}

function addAsset(asset) {
  const { farm_id, unit_id, asset_name, category, purchase_date, total_price, purchase_amount, payment_source, bank_id, notes } = asset
  if (!farm_id || !asset_name || !purchase_date) {
    return { success: false, error: 'farm_id, asset_name and purchase_date are required' }
  }
  // total_price is the agreed price; purchase_amount is its legacy mirror and is
  // always written with the same value. Accepting either name keeps older
  // callers working. What has actually been PAID lives in asset_payments.
  // Left null (not defaulted to 0) when neither is given — the price is not
  // always known up front, and 0 would silently read as "nothing owed".
  const price = total_price !== undefined && total_price !== null ? total_price
              : (purchase_amount !== undefined && purchase_amount !== null ? purchase_amount : null)
  // purchase_amount is NOT NULL DEFAULT 0 and cannot hold total_price's
  // "unknown" null — see the addAsset()/getAssets() comments in
  // database.service.ts, the path the renderer actually takes.
  return runQuery(
    `INSERT INTO assets (farm_id, unit_id, asset_name, category, purchase_date, total_price, purchase_amount, payment_source, bank_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [farm_id, unit_id || null, asset_name, category || null, purchase_date, price, price ?? 0, payment_source || 'cash', bank_id || null, notes || null]
  )
}

function updateAsset(assetId, data) {
  const fields = []
  const values = []

  if (data.unit_id !== undefined) { fields.push('unit_id = ?'); values.push(data.unit_id) }
  if (data.asset_name !== undefined) { fields.push('asset_name = ?'); values.push(data.asset_name) }
  if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category) }
  if (data.purchase_date !== undefined) { fields.push('purchase_date = ?'); values.push(data.purchase_date) }
  // Either price field updates BOTH columns — they are one value stored twice,
  // and letting a caller set one alone is how they would drift apart.
  const newPrice = data.total_price !== undefined ? data.total_price
                 : data.purchase_amount !== undefined ? data.purchase_amount
                 : undefined
  if (newPrice !== undefined) {
    fields.push('total_price = ?'); values.push(newPrice)
    fields.push('purchase_amount = ?'); values.push(newPrice ?? 0)
  }
  if (data.payment_source !== undefined) { fields.push('payment_source = ?'); values.push(data.payment_source) }
  if (data.bank_id !== undefined) { fields.push('bank_id = ?'); values.push(data.bank_id) }
  if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes) }

  if (fields.length === 0) return { success: false, error: 'No fields to update' }

  values.push(assetId)
  return runQuery(`UPDATE assets SET ${fields.join(', ')} WHERE asset_id = ?`, values)
}

// Selling an asset settles what is still owed on it. The thing has been handed
// over, so the debt against it goes with it: the remaining balance is written as
// a settlement payment dated on the sale date, and outstanding falls to zero.
// Kept in step with sellAsset() in src/app/shared/services/database.service.ts,
// which is the path the renderer actually takes.
function sellAsset(assetId, saleDate, saleAmount) {
  const existing = getQuery(
    `SELECT a.farm_id,
            a.status,
            a.payment_source,
            a.bank_id,
            COALESCE(a.total_price, NULLIF(a.purchase_amount, 0)) AS agreed_price,
            COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                      WHERE p.asset_id = a.asset_id), 0) AS amount_paid
     FROM assets a WHERE a.asset_id = ?`,
    [assetId]
  )
  if (!existing.success) return existing
  if (!existing.data || existing.data.length === 0) {
    return { success: false, error: 'Asset not found' }
  }
  const asset = existing.data[0]
  if (asset.status === 'sold') {
    return { success: false, error: 'Asset is already sold' }
  }

  const ops = [{
    sql: `UPDATE assets SET status = 'sold', sale_date = ?, sale_amount = ? WHERE asset_id = ?`,
    params: [saleDate, saleAmount, assetId]
  }]

  // No agreed price on file means there is no outstanding figure to settle —
  // skip the auto-settlement rather than inventing one against a price of 0.
  const hasPrice = asset.agreed_price !== null && asset.agreed_price !== undefined

  // Rounded to whole paisa so float dust cannot leave a fraction of a rupee
  // outstanding; floored at zero so a fully-paid or overpaid asset gets no row
  // rather than a negative one.
  const owed = hasPrice
    ? Math.round((Number(asset.agreed_price) - Number(asset.amount_paid)) * 100) / 100
    : 0
  if (owed > 0) {
    ops.push({
      sql: `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, is_settlement, notes)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      params: [assetId, asset.farm_id, saleDate, owed,
               asset.payment_source || 'cash', asset.bank_id || null,
               'Balance settled automatically on sale of the asset']
    })
  }

  return ops.length === 1 ? runQuery(ops[0].sql, ops[0].params) : runBatch(ops)
}

// Foreign keys are declared but never enforced (no PRAGMA foreign_keys), so
// nothing cascades — the payments have to be deleted by hand or they are left
// orphaned, still counting toward the account's outstanding installments.
// runBatch so the asset and its payments go together or not at all.
function deleteAsset(assetId) {
  return runBatch([
    { sql: `DELETE FROM asset_payments WHERE asset_id = ?`, params: [assetId] },
    { sql: `DELETE FROM assets WHERE asset_id = ?`, params: [assetId] }
  ])
}

// ── OVERVIEW MODULE: ASSET INSTALLMENT PAYMENTS ──────────

function getAssetPayments(assetId) {
  return getQuery(
    `SELECT * FROM asset_payments WHERE asset_id = ? ORDER BY date DESC, payment_id DESC`,
    [assetId]
  )
}

function addAssetPayment(payment) {
  const { asset_id, farm_id, date, amount, payment_source, bank_id, notes } = payment
  if (!asset_id || !farm_id || !date) {
    return { success: false, error: 'asset_id, farm_id and date are required' }
  }
  return runQuery(
    `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [asset_id, farm_id, date, amount || 0, payment_source || 'cash', bank_id || null, notes || null]
  )
}

function deleteAssetPayment(paymentId) {
  return runQuery(`DELETE FROM asset_payments WHERE payment_id = ?`, [paymentId])
}

// ── OVERVIEW MODULE: PERSONAL EXPENSES ───────────────────
// Account-level (farm_id scoped). Kept separate from the shared `expenses`
// table even though its total rolls into the dashboard's expense figure.

function getPersonalExpenses(farmId, fromDate = null, toDate = null) {
  let sql = `SELECT * FROM personal_expenses WHERE farm_id = ?`
  const params = [farmId]
  if (fromDate && toDate) {
    sql += ` AND date BETWEEN ? AND ?`
    params.push(fromDate, toDate)
  }
  sql += ` ORDER BY date DESC`
  return getQuery(sql, params)
}

function addPersonalExpense(pe) {
  const { farm_id, date, category, description, amount, payment_source, bank_id, notes } = pe
  if (!farm_id || !date) {
    return { success: false, error: 'farm_id and date are required' }
  }
  return runQuery(
    `INSERT INTO personal_expenses (farm_id, date, category, description, amount, payment_source, bank_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [farm_id, date, category || null, description || null, amount || 0, payment_source || 'cash', bank_id || null, notes || null]
  )
}

function updatePersonalExpense(id, data) {
  const fields = []
  const values = []

  if (data.date !== undefined) { fields.push('date = ?'); values.push(data.date) }
  if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category) }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
  if (data.amount !== undefined) { fields.push('amount = ?'); values.push(data.amount) }
  if (data.payment_source !== undefined) { fields.push('payment_source = ?'); values.push(data.payment_source) }
  if (data.bank_id !== undefined) { fields.push('bank_id = ?'); values.push(data.bank_id) }
  if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes) }

  if (fields.length === 0) return { success: false, error: 'No fields to update' }

  values.push(id)
  return runQuery(`UPDATE personal_expenses SET ${fields.join(', ')} WHERE pexpense_id = ?`, values)
}

function deletePersonalExpense(id) {
  return runQuery(`DELETE FROM personal_expenses WHERE pexpense_id = ?`, [id])
}

function getAppSetting(farmId, key) {
  try {
    const stmt = db.prepare('SELECT value FROM app_settings WHERE farm_id = ? AND key = ?');
    stmt.bind([farmId, key]);
    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return { success: true, value: result ? result.value : null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function setAppSetting(farmId, key, value) {
  try {
    db.run(
      `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
      [farmId, key, value]
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}





module.exports = { 
  getAppSetting,
setAppSetting,
  initializeDatabase, 
  runQuery,
  getQuery,
  runBatch,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  isInTransaction,
  isPoisoned,
  getBatchesByProduct,
  addBatch,
  updateBatch,
  deleteBatch,
  getTotalStock,
  getExpiringBatches,
  hasExpiringBatches,
  getBatchTransactions,
  getBatchById,
  updateBatchStatuses,
  migrateExistingStock,
  addBatchTransaction,
  // Ledger functions
  addCustomerLedgerEntry,
  addSupplierLedgerEntry,
  addBankLedgerEntry,
  updateCustomerOutstandingBalance,
  getCustomerLedgerWithBalance,
  getSupplierLedgerWithBalance,
  getBankLedgerWithBalance,
  getBankAccounts,
  getBankAccount,
  addBankAccount,
  updateBankAccount,
  deleteBankAccount,
  getAllCustomersWithBalance,
  getAllSuppliersWithBalance,
  // Customer Bank functions
  getCustomerBankAccount,
  getCustomerBankBalance,
  deductCustomerBank,
  linkCustomerToBank,
  getCustomersWithBankAccounts,
  // Expense Ledger functions
  addExpense,
  updateExpense,
  deleteExpense,
  getExpenses,
  getExpenseCategories,
getCategories,
addCategory,
deleteCategory,
  // Farm unit functions
  getFarmUnits,
  addFarmUnit,
  updateFarmUnit,
  deleteFarmUnit,
  // Overview: fixed asset functions
  getAssets,
  addAsset,
  updateAsset,
  sellAsset,
  deleteAsset,
  getAssetPayments,
  addAssetPayment,
  deleteAssetPayment,
  // Overview: personal expense functions
  getPersonalExpenses,
  addPersonalExpense,
  updatePersonalExpense,
  deletePersonalExpense
}
