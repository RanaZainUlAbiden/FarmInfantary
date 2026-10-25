// Egg and hen sales are attributed to a real `customers` row, and an unpaid
// one raises a real receivable.
//
// `egg_sales.customer_id` and `hen_sales.customer_id` are nullable with no
// backfill: a walk-in sale has no customer, which is what every row written
// before the column existed is. The list offered is the SAME one distribution
// sells to, with the owner's own farms excluded — an own-farm row here would
// let a layer batch sell eggs to a farm as though it were an outside buyer,
// with none of the internal-transfer cost or the Overview elimination.
//
// Both tables are layer-only and keyed on `batch_id`, so no module_type guard
// applies: a colliding broiler flock id can never reach them.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, both screens' own INSERT and UPDATE
// statements lifted out of the components as TEXT and executed with a distinct
// sentinel per parameter position, and the real computeQuantity /
// computeSaleTotal / onCustomerPick / syncIncomeFor*Sale lifted out of the
// same files. Nothing is a copy.
//
// What is proved:
//   A. The columns exist on a fresh schema AND on a database that predates
//      them (the ALTERs are idempotent and add nothing else).
//   B. Both INSERTs and both UPDATEs bind customer_id to the customer_id
//      column — not merely with the right placeholder count, but in the right
//      POSITION, which is the thing TypeScript cannot see. A column added in
//      the middle of a list is exactly how a parameter order goes wrong.
//   C. A picked customer is stored by id AND its name copied onto the row's
//      own free-text `customer_name`, which is what the receipt, the statement
//      line and the layer report already read. A renamed or deleted customer
//      afterwards does not blank the record of who bought.
//   D. A walk-in sale stores NULL and keeps whatever name was typed.
//   E. THE CUSTOMER LIST excludes own_farm rows and includes everything else,
//      including a row whose customer_type is NULL (legacy external).
//   F. THE SALE IS UNCHANGED. The same row saved with and without a customer
//      produces identical quantity, identical total_amount and an identical
//      `income` mirror — in per_egg AND per_carton mode, and per_hen AND
//      per_kg mode. Pinned against literals too, so this still means something
//      if both sides drift together.
//   G. Re-attributing by edit moves the sale to the new customer, and clearing
//      the dropdown makes it a walk-in again.
//   H. THE RECEIVABLE. A 'credit' sale to a named customer raises ONE real
//      `bills` row — tagged `source` = 'egg_sale'/'hen_sale', keyed to the
//      sale, numbered in its own EGG-/HEN- sequence clear of Sales Orders'
//      BILL-% — plus the same `customer_ledger` 'bill' debit Sales Orders
//      writes, and the customer's balance moves. A cash or bank sale is
//      already settled and a walk-in has nobody to owe: both raise nothing.
//      THE INVARIANT is asserted after every mutation: the running total down
//      the ledger, the bills-derived outstanding and the cached column all
//      land on the same number. That is what a bare `customer_ledger` debit
//      would have broken — `customers.outstanding_balance` is derived from
//      `bills`, so a debit with no bill behind it moves no balance.
//   I. IT SETTLES THROUGH THE EXISTING DOORS, unchanged: `getUnpaidBills()`
//      finds it and `customerSettlementOps()` allocates across it FIFO, which
//      is what the Customer Ledger, Receive Voucher and Internal Settlement
//      screens all run. Overpayment still comes back as `unapplied`. This is
//      the whole reason the receivable is a bill rather than a ledger line: a
//      debit with no bill is refused by every settlement door as an
//      overpayment against nothing.
//   J. A SETTLED receivable locks its sale: `layerSaleBill()` reports the
//      amount paid, and both screens refuse to edit or delete a sale whose
//      bill has been paid against, because the payment may also have moved
//      money through a bank account via a Receive Voucher.
//   K. DELETE and every EDIT TRANSITION reverse and re-raise it — cash->credit,
//      a changed amount, a moved customer, credit->cash — with the invariant
//      holding after each.
//   L. IT MOVES NO DISTRIBUTION FIGURE. All four of Overview's bill queries,
//      the Distribution report's bill list, Sales Orders' list and Sales
//      Returns' picker are unmoved by a receivable and still count a real
//      distribution bill. The sale's revenue is booked once, in the layer
//      module's `income` mirror.
//   M. EVERY `FROM bills` READER in src/ is on one of two lists — filtered, or
//      deliberately not — so a forgotten eighth query cannot double-count
//      revenue with nothing on screen to say why.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const EGG_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'egg-sales', 'egg-sales.component.ts'), 'utf8')
const HEN_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'hen-sales', 'hen-sales.component.ts'), 'utf8')
const SQLERR_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'sql-error.util.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(src, name, kw, from) {
  const start = from !== undefined ? from : src.indexOf(`${kw}${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('(', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break } }
  }
  depth = 0
  for (i = src.indexOf('{', i); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

function declAt(src, needle) {
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    const lineStart = src.lastIndexOf('\n', i) + 1
    if (src.slice(lineStart, i).trim() === '') return i
  }
  return -1
}

function loadFrom(src, name, kw = '') {
  const decl = /async/.test(kw) ? 'async function ' : 'function '
  const at = declAt(src, `${kw}${name}(`)
  if (at < 0) throw new Error(`${name} not declared as a member`)
  const raw = extractFn(src, name, kw, at)
  const stripped = kw.trim()
    ? raw.replace(new RegExp('^' + kw.trim().replace(/\s+/g, '\\s+') + '\\s+'), '')
    : raw
  const js = ts.transpileModule(decl + stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

/**
 * The SQL string literal containing `marker`, lifted out of a component as
 * text. The only way to test a statement a component builds inline — which is
 * this codebase's convention — from a node script that cannot load Angular.
 */
function liftSql(source, marker) {
  const idx = source.indexOf(marker)
  if (idx < 0) throw new Error(`marker not found: ${marker}`)
  let open = -1, quote = ''
  for (const q of ['`', "'", '"']) {
    const at = source.lastIndexOf(q, idx)
    if (at > open) { open = at; quote = q }
  }
  if (open < 0) throw new Error(`no SQL literal around: ${marker}`)
  const close = source.indexOf(quote, idx)
  if (close < 0) throw new Error(`unterminated SQL literal at: ${marker}`)
  return source.slice(open + 1, close)
}

// ── The main process, for real ──────────────────────────────────────────────

let db = null
let inTransaction = false
let poisonedConnection = null
let savepointCounter = 0
const TRANSACTION_TIMEOUT_MS = 60000
const startTransactionWatchdog = () => {}
const clearTransactionWatchdog = () => {}
const clearPoison = () => { poisonedConnection = null; return true }
const saveDatabase = () => {}
const getDbPath = () => ':memory:'

eval(DB_SRC.slice(
  DB_SRC.indexOf('const PRIMARY_KEY_MAP = {'),
  DB_SRC.indexOf('\n}', DB_SRC.indexOf('const PRIMARY_KEY_MAP = {')) + 2)
  .replace('const PRIMARY_KEY_MAP', 'var PRIMARY_KEY_MAP'))
eval(extractFn(DB_SRC, 'refuseWrite', 'function '))
eval(extractFn(DB_SRC, 'executeStatement', 'function '))
eval(extractFn(DB_SRC, 'resolveBatchParams', 'function '))
eval(extractFn(DB_SRC, 'runBatch', 'function '))
eval(extractFn(DB_SRC, 'getQuery', 'function '))
eval(extractFn(DB_SRC, 'runQuery', 'function '))

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// ── The renderer, for real ──────────────────────────────────────────────────

eval(SQLERR_SRC.slice(SQLERR_SRC.indexOf('const SQL_ERROR_PATTERN'),
  SQLERR_SRC.indexOf('\n', SQLERR_SRC.indexOf('const SQL_ERROR_PATTERN')))
  .replace('const SQL_ERROR_PATTERN', 'var SQL_ERROR_PATTERN'))
const friendlySqlError = loadFrom(SQLERR_SRC, 'friendlySqlError', 'export function ')

function rows(sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

const svc = {
  async run(sql, params = []) { return runQuery(sql, params) },
  async get(sql, params = []) { return getQuery(sql, params) },
  async runBatch(ops) { return runBatch(ops) },

  rebuildCustomerBalanceOp:         loadFrom(SVC_SRC, 'rebuildCustomerBalanceOp', 'private '),
  updateCustomerOutstandingBalance: loadFrom(SVC_SRC, 'updateCustomerOutstandingBalance', 'async '),
  addCustomerLedgerEntry:           loadFrom(SVC_SRC, 'addCustomerLedgerEntry', 'async '),
  getUnpaidBills:                   loadFrom(SVC_SRC, 'getUnpaidBills', 'async '),
  customerSettlementOps:            loadFrom(SVC_SRC, 'customerSettlementOps'),

  // The receivable, composed out of the same balance recompute every other
  // settlement path uses.
  layerBillPrefix:               loadFrom(SVC_SRC, 'layerBillPrefix', 'private '),
  nextLayerBillNumberSql:        loadFrom(SVC_SRC, 'nextLayerBillNumberSql', 'private '),
  layerReceivableLabel:          loadFrom(SVC_SRC, 'layerReceivableLabel', 'private '),
  layerReceivableOps:            loadFrom(SVC_SRC, 'layerReceivableOps'),
  layerReceivableReversalOps:    loadFrom(SVC_SRC, 'layerReceivableReversalOps'),
  layerSaleBill:                 loadFrom(SVC_SRC, 'layerSaleBill', 'async ')
}

/** Both screens, with only what the attribution and mirror paths touch. */
const makeScreen = (src, syncName) => {
  const screen = {
    db: svc,
    currentFarm: { farm_id: 1 },
    cdr: { detectChanges: () => {} },
    customers: [],
    houseBanks: [],
    batches: [],
    errorMessage: '',
    assertOk:          loadFrom(src, 'assertOk', 'private '),
    mustRun:           loadFrom(src, 'mustRun', 'private async '),
    computeSaleTotal:  loadFrom(src, 'computeSaleTotal', 'private '),
    depositLabel:      loadFrom(src, 'depositLabel', 'private '),
    validateSaleRow:   loadFrom(src, 'validateSaleRow', 'private '),
    onCustomerPick:    loadFrom(src, 'onCustomerPick'),
    layerReceivableFor: loadFrom(src, 'layerReceivableFor', 'private '),
    sync:              loadFrom(src, syncName, 'async ')
  }
  if (src === EGG_SRC) {
    screen.computeQuantity = loadFrom(src, 'computeQuantity')
    screen.getAvailableForGrade = () => 1e9
    screen.getBatchName = () => 'Batch'
  }
  return screen
}

const egg = makeScreen(EGG_SRC, 'syncIncomeForEggSale')
const hen = makeScreen(HEN_SRC, 'syncIncomeForHenSale')

// bankSourceError/bankSourceFields are module imports in both screens, so the
// lifted validators bind to these module-scope names.
//
// The whole util is transpiled and eval'd rather than lifted function by
// function: it has no imports of its own, and `bankSourceFields()` declares an
// inline object RETURN type, whose brace extractFn() would take for the start
// of the body. Function declarations in a direct eval reach module scope the
// way `var` does, which is what the lifted screen methods need.
const BANK_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bank-source.util.ts'), 'utf8')
eval(ts.transpileModule(BANK_SRC.replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText)

// ── The distribution readers, for the exclusion ─────────────────────────────
//
// `distributionBillsOnly()` is what keeps a layer-sale receivable out of every
// distribution figure. The whole util is transpiled and eval'd, so the lifted
// Overview methods below bind to the real function rather than a restatement.
const BILLSRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bill-source.util.ts'), 'utf8')
eval(ts.transpileModule(BILLSRC.replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText)

const OV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

/** Overview's four bill queries, lifted whole, with its real dateClause. */
const overview = {
  dateClause:            loadFrom(OV_SRC, 'dateClause', 'private '),
  qDistributionBills:    loadFrom(OV_SRC, 'qDistributionBills', 'private '),
  qDistributionBillsAll: loadFrom(OV_SRC, 'qDistributionBillsAll', 'private '),
  qDistributionUnpaid:   loadFrom(OV_SRC, 'qDistributionUnpaid', 'private '),
  qInternalBills:        loadFrom(OV_SRC, 'qInternalBills', 'private ')
}
const overviewAmount = async (name) => {
  const [sql, params] = overview[name].call(overview, 1, {})
  return Number(rows(sql, params)[0].amount)
}

/**
 * A lifted statement is a template literal, so the filter arrives as the
 * literal text `${distributionBillsOnly('b')}`. This substitutes the REAL
 * function's output — and throws when there is no placeholder at all, which is
 * what makes "the screen filters" a thing this file proves rather than assumes.
 */
const resolveFilter = (what, sql) => {
  const pattern = /\$\{distributionBillsOnly\((?:'([^']*)')?\)\}/g
  if (!pattern.test(sql)) {
    throw new Error(`${what} does not call distributionBillsOnly() — a layer-sale receivable would be counted as a distribution bill`)
  }
  return sql.replace(pattern, (_m, alias) => distributionBillsOnly(alias || ''))
}

// The three screens' own bill statements, lifted as text.
const distributionReportBills = resolveFilter('the Distribution report', liftSql(
  fs.readFileSync(path.join(ROOT, 'src', 'app', 'distribution-report', 'distribution-report.component.ts'), 'utf8'),
  'SELECT * FROM bills WHERE farm_id = ?'))
const salesOrdersBills = resolveFilter('Sales Orders', liftSql(
  fs.readFileSync(path.join(ROOT, 'src', 'app', 'sales-orders', 'sales-orders.component.ts'), 'utf8'),
  'SELECT * FROM bills WHERE farm_id=?'))
const salesReturnsBills = resolveFilter('Sales Returns', liftSql(
  fs.readFileSync(path.join(ROOT, 'src', 'app', 'sales-returns', 'sales-returns.component.ts'), 'utf8'),
  'LEFT JOIN sales_returns sr ON sr.bill_id = b.bill_id'))

const FARM = 1

// ── The statements under test, as the screens build them ────────────────────
//
// A distinct sentinel per parameter POSITION, because a column added in the
// middle of a list is exactly how a parameter order silently stops matching —
// something TypeScript cannot see and a count check would not catch.

const CUST = 5555
const BANK = 7777

const STATEMENTS = [
  { what: 'egg sale INSERT', table: 'egg_sales', pk: 'egg_sale_id',
    sql: liftSql(EGG_SRC, 'INSERT INTO egg_sales (batch_id, date, customer_id, customer_name'),
    params: [1, '2025-01-01', CUST, 'Shop', 'mixed', 100, 12, 1200, 'cash', 'cash', null, 'per_egg', null, 360],
    expect: { customer_id: CUST, customer_name: 'Shop', quantity: 100, total_amount: 1200 } },
  { what: 'egg sale UPDATE', table: 'egg_sales', pk: 'egg_sale_id',
    sql: liftSql(EGG_SRC, 'UPDATE egg_sales SET batch_id=?, date=?'),
    params: [1, '2025-02-02', CUST, 'Shop2', 'large', 200, 13, 2600, 'cash', 'cash', null, 'per_egg', null, 360, 1],
    expect: { customer_id: CUST, customer_name: 'Shop2', quantity: 200, total_amount: 2600 } },
  { what: 'hen sale INSERT', table: 'hen_sales', pk: 'hen_sale_id',
    sql: liftSql(HEN_SRC, 'INSERT INTO hen_sales (batch_id, date, customer_id, customer_name'),
    params: [1, '2025-01-01', CUST, 'Shop', 50, 900, null, 'per_hen', 45000, 'cash', 'cash', null],
    expect: { customer_id: CUST, customer_name: 'Shop', quantity: 50, total_amount: 45000 } },
  { what: 'hen sale UPDATE', table: 'hen_sales', pk: 'hen_sale_id',
    sql: liftSql(HEN_SRC, 'UPDATE hen_sales SET batch_id=?, date=?'),
    params: [1, '2025-02-02', CUST, 'Shop2', 60, 950, null, 'per_hen', 57000, 'cash', 'cash', null, 1],
    expect: { customer_id: CUST, customer_name: 'Shop2', quantity: 60, total_amount: 57000 } }
]

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkStr = check
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

const columnsOf = (table) => rows(`PRAGMA table_info(${table})`)
const incomeMirror = (batchId, date, source) =>
  rows(`SELECT amount, description FROM income
        WHERE flock_id = ? AND date = ? AND source = ? AND module_type = 'layer'`,
    [batchId, date, source])[0] || null

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  const realLog = console.log
  const quiet = async (fn) => { console.log = () => {}; try { return await fn() } finally { console.log = realLog } }

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1, 'Talha', 'x', 'all')`)
  db.run(`INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name) VALUES (1, 1, 'layer', 'Layer Farm')`)
  db.run(`INSERT INTO batches (batch_id, farm_id, unit_id, batch_name, start_date, initial_birds, status)
          VALUES (1, 1, 1, 'Batch A', '2025-01-01', 5000, 'active')`)
  // An external customer, a legacy row with a NULL customer_type, and an
  // own-farm row — the one that must never be offered.
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type) VALUES (1, 1, 'Ahmed Textiles', 'external')`)
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name) VALUES (2, 1, 'Legacy Buyer')`)
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, unit_id, customer_type) VALUES (3, 1, 'Own Farm - Layer Farm', 1, 'own_farm')`)

  console.log('\n=== A. the columns exist, and the ALTERs are idempotent ===')

  for (const t of ['egg_sales', 'hen_sales']) {
    const col = columnsOf(t).find(c => c.name === 'customer_id')
    checkTrue(`${t}.customer_id exists`, !!col)
    check(`${t}.customer_id is nullable`, col ? col.notnull : 1, 0)
    check(`${t}.customer_id has no default`, col && col.dflt_value === null ? 'none' : String(col && col.dflt_value), 'none')
  }
  const before = JSON.stringify([columnsOf('egg_sales'), columnsOf('hen_sales')])
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }
  checkTrue('re-running every ALTER changes nothing (they run on EVERY launch)',
    JSON.stringify([columnsOf('egg_sales'), columnsOf('hen_sales')]) === before)

  console.log('\n=== B. every statement binds customer_id to the right COLUMN ===')

  for (const s of STATEMENTS) {
    // The UPDATEs need a row to update, at the id their last parameter names.
    if (/^UPDATE/i.test(s.sql.trim())) {
      db.run(`DELETE FROM ${s.table}`)
      db.run(s.table === 'egg_sales'
        ? `INSERT INTO egg_sales (egg_sale_id, batch_id, date, quantity, rate_per_egg, total_amount) VALUES (1, 1, '2000-01-01', 0, 0, 0)`
        : `INSERT INTO hen_sales (hen_sale_id, batch_id, date, quantity, rate_per_hen, total_amount) VALUES (1, 1, '2000-01-01', 0, 0, 0)`)
    } else {
      db.run(`DELETE FROM ${s.table}`)
    }

    const placeholders = (s.sql.match(/\?/g) || []).length
    check(`${s.what} placeholder count matches the screen's parameter list`, placeholders, s.params.length)

    let ok = true
    try { db.run(s.sql, s.params) } catch (e) { ok = false; console.log('    ' + e.message) }
    checkTrue(`${s.what} executes against the real schema`, ok)

    const row = rows(`SELECT * FROM ${s.table} ORDER BY ${s.pk} DESC LIMIT 1`)[0] || {}
    for (const [col, want] of Object.entries(s.expect)) {
      check(`${s.what} -> ${col}`, row[col], want)
    }
  }

  console.log('\n=== C/D. a picked customer is stored by id AND by name; a walk-in is NULL ===')

  egg.customers = rows(
    `SELECT customer_id, customer_name FROM customers
     WHERE farm_id = ? AND COALESCE(customer_type,'external') <> 'own_farm'
     ORDER BY customer_name ASC`, [1])
  hen.customers = egg.customers

  const picked = { customer_id: '1', customer_name: '' }
  egg.onCustomerPick(picked)
  check('picking a customer normalizes the id to a number', typeof picked.customer_id, 'number')
  check('and copies the name onto the row', picked.customer_name, 'Ahmed Textiles')

  const typed = { customer_id: null, customer_name: 'Cash buyer at the gate' }
  egg.onCustomerPick(typed)
  check('clearing the dropdown leaves the id null', typed.customer_id === null ? 'null' : typed.customer_id, 'null')
  check('and does not touch the typed name', typed.customer_name, 'Cash buyer at the gate')

  // The name really is copied rather than joined, so a later rename or delete
  // cannot blank the record of who bought.
  db.run(`DELETE FROM egg_sales`)
  db.run(`INSERT INTO egg_sales (batch_id, date, customer_id, customer_name, grade, quantity, rate_per_egg, total_amount, payment_type, payment_source, bank_id, sale_mode, carton_count, eggs_per_carton)
          VALUES (1, '2025-03-01', 1, 'Ahmed Textiles', 'mixed', 10, 10, 100, 'cash', 'cash', NULL, 'per_egg', NULL, 360)`)
  db.run(`UPDATE customers SET customer_name = 'Ahmed Textiles (renamed)' WHERE customer_id = 1`)
  check('a renamed customer does not rewrite the sale',
    rows(`SELECT customer_name AS n FROM egg_sales`)[0].n, 'Ahmed Textiles')
  db.run(`UPDATE customers SET customer_name = 'Ahmed Textiles' WHERE customer_id = 1`)

  console.log('\n=== E. the customer list excludes own-farm rows and nothing else ===')

  check('three customers exist on this account',
    rows('SELECT COUNT(*) AS n FROM customers WHERE farm_id = 1')[0].n, 3)
  check('two are offered', egg.customers.length, 2)
  checkTrue('the external one is offered', egg.customers.some(c => c.customer_name === 'Ahmed Textiles'))
  checkTrue('and so is the legacy NULL-type one', egg.customers.some(c => c.customer_name === 'Legacy Buyer'))
  checkTrue('the own-farm one is NOT', !egg.customers.some(c => c.customer_type === 'own_farm'
    || String(c.customer_name).startsWith('Own Farm')))

  console.log('\n=== F. the sale itself is unchanged by who bought it ===')

  // Each row saved twice, identically but for the customer. The quantity, the
  // total and the income mirror must come out the same both times.
  const EGG_ROWS = [
    { what: 'per_egg', row: { batch_id: 1, grade: 'mixed', sale_mode: 'per_egg', quantity: 120, carton_count: null, eggs_per_carton: 360, rate_per_egg: 11, amount: null }, qty: 120, total: 1320 },
    { what: 'per_carton', row: { batch_id: 1, grade: 'mixed', sale_mode: 'per_carton', quantity: null, carton_count: 2, eggs_per_carton: 180, rate_per_egg: 4000, amount: null }, qty: 360, total: 8000 }
  ]
  const eggInsert = liftSql(EGG_SRC, 'INSERT INTO egg_sales (batch_id, date, customer_id, customer_name')

  for (const spec of EGG_ROWS) {
    const shapes = []
    for (const customerId of [null, 1]) {
      db.run('DELETE FROM egg_sales'); db.run('DELETE FROM income')
      const row = { ...spec.row, date: '2025-04-01', customer_id: customerId, customer_name: 'Shop', payment_type: 'cash', bank_id: null }
      const bank = bankSourceFields(row)
      db.run(eggInsert, [
        row.batch_id, row.date, Number(row.customer_id) || null, row.customer_name, row.grade,
        egg.computeQuantity(row), row.rate_per_egg, egg.computeSaleTotal(row), row.payment_type,
        bank.payment_source, bank.bank_id,
        row.sale_mode || 'per_egg',
        row.sale_mode === 'per_carton' ? row.carton_count : null,
        row.eggs_per_carton || 360
      ])
      await quiet(() => egg.sync(row.date, row.batch_id))
      shapes.push(JSON.stringify({
        sale: rows('SELECT quantity, total_amount, sale_mode, carton_count, eggs_per_carton FROM egg_sales'),
        mirror: incomeMirror(1, '2025-04-01', 'egg_sale')
      }))
    }
    checkTrue(`egg ${spec.what}: a customer sale and a walk-in sale are identical bar the customer`,
      shapes[0] === shapes[1])
    check(`egg ${spec.what}: quantity`, rows('SELECT quantity AS q FROM egg_sales')[0].q, spec.qty)
    check(`egg ${spec.what}: total`, rows('SELECT total_amount AS t FROM egg_sales')[0].t, spec.total)
    check(`egg ${spec.what}: income mirror`, incomeMirror(1, '2025-04-01', 'egg_sale').amount, spec.total)
  }

  const HEN_ROWS = [
    { what: 'per_hen', row: { batch_id: 1, pricing_mode: 'per_hen', quantity: 40, rate_per_hen: 900, total_weight: null, amount: null }, total: 36000 },
    { what: 'per_kg', row: { batch_id: 1, pricing_mode: 'per_kg', quantity: 40, rate_per_hen: 480, total_weight: 75, amount: null }, total: 36000 }
  ]
  const henInsert = liftSql(HEN_SRC, 'INSERT INTO hen_sales (batch_id, date, customer_id, customer_name')

  for (const spec of HEN_ROWS) {
    const shapes = []
    for (const customerId of [null, 1]) {
      db.run('DELETE FROM hen_sales'); db.run('DELETE FROM income')
      const row = { ...spec.row, date: '2025-04-02', customer_id: customerId, customer_name: 'Shop', payment_type: 'cash', bank_id: null }
      const bank = bankSourceFields(row)
      db.run(henInsert, [
        row.batch_id, row.date, Number(row.customer_id) || null, row.customer_name, row.quantity, row.rate_per_hen,
        row.pricing_mode === 'per_kg' ? row.total_weight : null,
        row.pricing_mode || 'per_hen',
        hen.computeSaleTotal(row),
        row.payment_type,
        bank.payment_source, bank.bank_id
      ])
      await quiet(() => hen.sync(row.date, row.batch_id))
      shapes.push(JSON.stringify({
        sale: rows('SELECT quantity, total_amount, pricing_mode, total_weight FROM hen_sales'),
        mirror: incomeMirror(1, '2025-04-02', 'hen_sale')
      }))
    }
    checkTrue(`hen ${spec.what}: a customer sale and a walk-in sale are identical bar the customer`,
      shapes[0] === shapes[1])
    check(`hen ${spec.what}: total`, rows('SELECT total_amount AS t FROM hen_sales')[0].t, spec.total)
    check(`hen ${spec.what}: income mirror`, incomeMirror(1, '2025-04-02', 'hen_sale').amount, spec.total)
  }

  console.log('\n=== G. re-attributing by edit, and back to a walk-in ===')

  db.run('DELETE FROM egg_sales')
  db.run(eggInsert, [1, '2025-05-01', 1, 'Ahmed Textiles', 'mixed', 10, 10, 100, 'cash', 'cash', null, 'per_egg', null, 360])
  const eggUpdate = liftSql(EGG_SRC, 'UPDATE egg_sales SET batch_id=?, date=?')
  const saleId = rows('SELECT MAX(egg_sale_id) AS id FROM egg_sales')[0].id

  db.run(eggUpdate, [1, '2025-05-01', 2, 'Legacy Buyer', 'mixed', 10, 10, 100, 'cash', 'cash', null, 'per_egg', null, 360, saleId])
  check('the sale moved to the other customer', rows('SELECT customer_id AS c FROM egg_sales')[0].c, 2)
  check('and its name moved with it', rows('SELECT customer_name AS n FROM egg_sales')[0].n, 'Legacy Buyer')

  db.run(eggUpdate, [1, '2025-05-01', null, 'Gate sale', 'mixed', 10, 10, 100, 'cash', 'cash', null, 'per_egg', null, 360, saleId])
  check('clearing it makes the sale a walk-in again',
    rows('SELECT customer_id AS c FROM egg_sales')[0].c === null ? 'null' : rows('SELECT customer_id AS c FROM egg_sales')[0].c, 'null')
  check('and the typed name is what records the buyer',
    rows('SELECT customer_name AS n FROM egg_sales')[0].n, 'Gate sale')

  console.log('\n=== H. an unpaid sale raises a REAL bill; a paid one raises nothing ===')

  const clearSales = () => {
    db.run('DELETE FROM egg_sales'); db.run('DELETE FROM hen_sales')
    db.run('DELETE FROM bills'); db.run('DELETE FROM customer_ledger')
    db.run('DELETE FROM income'); db.run('UPDATE customers SET outstanding_balance = 0')
  }

  /** Saves one egg row through the real statement + the real receivable ops. */
  const saveEggRow = async (row) => {
    const ops = []
    const saleOp = ops.length
    const bank = bankSourceFields(row)
    ops.push({
      sql: eggInsert,
      params: [row.batch_id, row.date, Number(row.customer_id) || null, row.customer_name, row.grade,
        egg.computeQuantity(row), row.rate_per_egg, egg.computeSaleTotal(row), row.payment_type,
        bank.payment_source, bank.bank_id,
        row.sale_mode || 'per_egg',
        row.sale_mode === 'per_carton' ? row.carton_count : null,
        row.eggs_per_carton || 360]
    })
    const receivable = egg.layerReceivableFor(row)
    if (receivable) ops.push(...svc.layerReceivableOps({ ...receivable, saleOp }, ops.length))
    const res = await quiet(() => runBatch(ops))
    if (!res.success) throw new Error('save failed: ' + res.error)
    const id = rows('SELECT MAX(egg_sale_id) AS id FROM egg_sales')[0].id
    await quiet(() => egg.sync(row.date, row.batch_id))
    return id
  }

  const CREDIT = (over = {}) => ({
    batch_id: 1, date: '2025-07-01', customer_id: 1, customer_name: 'Ahmed Textiles',
    grade: 'mixed', sale_mode: 'per_egg', quantity: 100, carton_count: null,
    eggs_per_carton: 360, rate_per_egg: 50, amount: null,
    payment_type: 'credit', bank_id: null, ...over
  })

  const billsOf = (customerId) => rows(
    'SELECT * FROM bills WHERE customer_id = ? ORDER BY bill_id', [customerId])
  const ledgerOf = (customerId) => rows(
    'SELECT * FROM customer_ledger WHERE customer_id = ? ORDER BY ledger_id', [customerId])
  const cached = (customerId) => Number(rows(
    'SELECT COALESCE(outstanding_balance, 0) AS b FROM customers WHERE customer_id = ?',
    [customerId])[0].b)
  const fromBills = (customerId) => Number(rows(
    `SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)), 0) AS b
     FROM bills WHERE customer_id = ?`, [customerId])[0].b)
  const fromLedger = (customerId) => Number(rows(
    'SELECT COALESCE(SUM(debit - credit), 0) AS b FROM customer_ledger WHERE customer_id = ?',
    [customerId])[0].b)

  /**
   * THE INVARIANT this whole design exists to keep: the running total down the
   * customer's ledger, the bills-derived outstanding, and the cached column all
   * land on the same number. That is what a bare ledger debit would have broken
   * and what making the receivable a real bill preserves.
   */
  const invariant = (step, customerId) => {
    const b = fromBills(customerId), l = fromLedger(customerId), c = cached(customerId)
    const ok = b === l && c === b
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  INVARIANT after ${step}: bills=${b} ledger=${l} cached=${c}`)
    return b
  }

  // Paid in full: cash.
  clearSales()
  await saveEggRow(CREDIT({ payment_type: 'cash' }))
  check('a CASH sale raises no bill', billsOf(1).length, 0)
  check('and no ledger row', ledgerOf(1).length, 0)
  check('and the customer owes nothing', invariant('a cash sale', 1), 0)

  // Paid in full: bank. (payment_source stays cash here — the bank deposit is
  // its own mechanism and has its own script; what matters is that a bank sale
  // is settled and raises no debt.)
  clearSales()
  await saveEggRow(CREDIT({ payment_type: 'bank' }))
  check('a BANK sale raises no bill', billsOf(1).length, 0)
  check('and the customer owes nothing', invariant('a bank sale', 1), 0)

  // A walk-in on credit: nobody to owe.
  clearSales()
  await saveEggRow(CREDIT({ customer_id: null, customer_name: 'Gate sale' }))
  check('a WALK-IN credit sale raises no bill', rows('SELECT COUNT(*) AS n FROM bills')[0].n, 0)
  check('and no ledger row anywhere', rows('SELECT COUNT(*) AS n FROM customer_ledger')[0].n, 0)

  // The real case.
  clearSales()
  const creditSaleId = await saveEggRow(CREDIT())
  const raised = billsOf(1)
  check('a CREDIT sale to a named customer raises exactly one bill', raised.length, 1)
  check('for the full amount', raised[0].total_amount, 5000)
  check('with nothing paid', raised[0].amount_paid, 0)
  checkStr('tagged as an egg sale', raised[0].source, 'egg_sale')
  check('and keyed to the sale', raised[0].source_id, creditSaleId)
  checkStr('numbered in its own sequence, clear of BILL-%', raised[0].bill_number, 'EGG-001')
  check('dated the sale date', raised[0].bill_date, '2025-07-01')
  check('exactly one ledger row', ledgerOf(1).length, 1)
  checkStr("and it is a 'bill' debit, the same mirror Sales Orders writes", ledgerOf(1)[0].reference_type, 'bill')
  check('for the full amount', ledgerOf(1)[0].debit, 5000)
  check('pointing at the bill', ledgerOf(1)[0].reference_id, raised[0].bill_id)
  checkStr('and it names the sale', ledgerOf(1)[0].description, `Egg sale #${creditSaleId}`)
  check('THE POINT: the customer now owes it', invariant('a credit sale', 1), 5000)
  check('and the income mirror still books the revenue in the layer module',
    incomeMirror(1, '2025-07-01', 'egg_sale').amount, 5000)

  // A second credit sale numbers on from the first.
  const secondId = await saveEggRow(CREDIT({ date: '2025-07-02', rate_per_egg: 20 }))
  checkStr('a second receivable takes the next number',
    billsOf(1).find(b => b.source_id === secondId).bill_number, 'EGG-002')
  check('and the debt is the sum of both', invariant('a second credit sale', 1), 7000)

  console.log('\n=== I. the receivable settles through the EXISTING doors ===')
  // This is what making it a bill buys: getUnpaidBills() finds it and
  // customerSettlementOps() allocates across it, with no change to either.

  const unpaidNow = await quiet(() => svc.getUnpaidBills(1))
  check('both receivables show as unpaid bills', (unpaidNow.data || []).length, 2)
  checkStr('oldest first, which is the allocation order', (unpaidNow.data || [])[0].bill_number, 'EGG-001')

  const settle = svc.customerSettlementOps({
    customer_id: 1, amount: 6000, date: '2025-07-05',
    description: 'Receipt', bills: unpaidNow.data || [], bill_id: null
  })
  check('a receipt of 6,000 is fully applied — nothing unapplied', settle.unapplied, 0)
  check('across both bills, FIFO', settle.allocations.length, 2)
  check('5,000 onto the older one', settle.allocations[0].payAmount, 5000)
  check('and 1,000 onto the newer', settle.allocations[1].payAmount, 1000)
  const settled = await quiet(() => runBatch(settle.ops))
  checkTrue('the settlement runs', settled.success)
  check('the debt falls to 1,000', invariant('a 6,000 receipt', 1), 1000)

  // And it is refused beyond the debt, exactly as the Receive Voucher screen does.
  const over = svc.customerSettlementOps({
    customer_id: 1, amount: 99999, date: '2025-07-06',
    description: 'Too much', bills: (await quiet(() => svc.getUnpaidBills(1))).data || [], bill_id: null
  })
  checkTrue('a receipt larger than the debt comes back with an unapplied remainder',
    over.unapplied > 0.005)
  check('of exactly the excess', over.unapplied, 99999 - 1000)

  console.log('\n=== J. a settled receivable cannot have its sale edited or deleted ===')

  const settledBill = await quiet(() => svc.layerSaleBill('egg_sale', creditSaleId))
  checkTrue('the sale can see its own bill', !!settledBill.bill)
  check('which has been paid against', settledBill.bill.amount_paid, 5000)
  checkTrue('so the screens refuse to touch the sale (amount_paid > 0)',
    Number(settledBill.bill.amount_paid) > 0)
  const unsettledBill = await quiet(() => svc.layerSaleBill('egg_sale', 999999))
  check('and a sale with no bill reads as having none',
    unsettledBill.bill === null ? 'null' : 'something', 'null')

  console.log('\n=== K. deleting and re-attributing reverse the receivable ===')

  clearSales()
  const delId = await saveEggRow(CREDIT())
  check('the debt is there', invariant('the sale', 1), 5000)

  const toDelete = await quiet(() => svc.layerSaleBill('egg_sale', delId))
  const delRes = await quiet(() => runBatch([
    { sql: 'DELETE FROM egg_sales WHERE egg_sale_id = ?', params: [delId] },
    ...svc.layerReceivableReversalOps(toDelete.bill)
  ]))
  checkTrue('the delete runs', delRes.success)
  check('the bill is gone', rows('SELECT COUNT(*) AS n FROM bills')[0].n, 0)
  check('the ledger row with it', ledgerOf(1).length, 0)
  check('and the customer owes nothing again', invariant('the delete', 1), 0)

  // Every edit transition, through the real reverse-and-re-raise shape.
  const editTo = async (saleId, next) => {
    const had = await quiet(() => svc.layerSaleBill('egg_sale', saleId))
    const ops = svc.layerReceivableReversalOps(had.bill)
    const r = egg.layerReceivableFor(next)
    if (r) ops.push(...svc.layerReceivableOps({ ...r, sale_id: saleId }, ops.length))
    if (ops.length) {
      const res = await quiet(() => runBatch(ops))
      if (!res.success) throw new Error('edit failed: ' + res.error)
    }
  }

  clearSales()
  const editId = await saveEggRow(CREDIT({ payment_type: 'cash' }))
  check('K1 starts paid, so no debt', invariant('K1 a cash sale', 1), 0)

  await editTo(editId, CREDIT({ payment_type: 'credit' }))
  check('K2 cash -> credit raises the receivable', invariant('K2 cash -> credit', 1), 5000)
  check('K2 one bill', billsOf(1).length, 1)

  await editTo(editId, CREDIT({ payment_type: 'credit', rate_per_egg: 30 }))
  check('K3 a changed amount re-raises it at the new figure', invariant('K3 amount changed', 1), 3000)
  check('K3 still one bill', billsOf(1).length, 1)

  await editTo(editId, CREDIT({ payment_type: 'credit', customer_id: 2, customer_name: 'Legacy Buyer' }))
  check('K4 moving the customer clears the old one', invariant('K4 old customer', 1), 0)
  check('K4 and charges the new one', invariant('K4 new customer', 2), 5000)

  await editTo(editId, CREDIT({ payment_type: 'cash', customer_id: 2, customer_name: 'Legacy Buyer' }))
  check('K5 credit -> cash removes it', invariant('K5 credit -> cash', 2), 0)
  check('K5 no bill left', rows('SELECT COUNT(*) AS n FROM bills')[0].n, 0)

  console.log('\n=== L. the receivable moves NO distribution figure ===')
  // The sale already books its revenue in the layer module's income mirror, so
  // a distribution reader that counted the bill too would report it twice.

  clearSales()
  const distBefore = {
    bills: await overviewAmount('qDistributionBills'),
    all: await overviewAmount('qDistributionBillsAll'),
    unpaid: await overviewAmount('qDistributionUnpaid'),
    internal: await overviewAmount('qInternalBills'),
    report: rows(distributionReportBills, [FARM]).length,
    salesOrders: rows(salesOrdersBills, [FARM]).length,
    returnable: rows(salesReturnsBills, [FARM]).length
  }

  await saveEggRow(CREDIT())
  check('the receivable exists', rows('SELECT COUNT(*) AS n FROM bills')[0].n, 1)
  check('and the customer owes it', invariant('the receivable', 1), 5000)

  check('Overview collected revenue is unmoved', await overviewAmount('qDistributionBills'), distBefore.bills)
  check('Overview per-farm distribution revenue is unmoved', await overviewAmount('qDistributionBillsAll'), distBefore.all)
  check('Overview distribution receivable is unmoved', await overviewAmount('qDistributionUnpaid'), distBefore.unpaid)
  check('Overview internal-transfer total is unmoved', await overviewAmount('qInternalBills'), distBefore.internal)
  check('the Distribution report does not list it', rows(distributionReportBills, [FARM]).length, distBefore.report)
  check('Sales Orders does not list it', rows(salesOrdersBills, [FARM]).length, distBefore.salesOrders)
  check('and Sales Returns does not offer it', rows(salesReturnsBills, [FARM]).length, distBefore.returnable)

  // A real distribution bill, for contrast — the exclusion must not drop those.
  db.run(`INSERT INTO bills (farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (1, 'BILL-001', 1, 'Ahmed Textiles', '2025-07-10', 1000, 1000, 1000, 'cash')`)
  check('a distribution bill with NULL source IS counted (no backfill, so every legacy bill is one)',
    await overviewAmount('qDistributionBills'), distBefore.bills + 1000)
  check('and listed by the Distribution report', rows(distributionReportBills, [FARM]).length, distBefore.report + 1)
  check('and by Sales Orders', rows(salesOrdersBills, [FARM]).length, distBefore.salesOrders + 1)

  console.log('\n=== M. every `FROM bills` reader in src/ is on one of the two lists ===')
  // The filter has to appear in seven queries. A forgotten eighth would
  // double-count revenue with nothing on screen to say why, so the readers are
  // enumerated here rather than trusted.

  const BOTH_KINDS = [
    // The debt is the debt whoever raised it — these are where it is shown and
    // settled, and they must NOT filter.
    'account-ledger/customer-ledger/customer-ledger.component.ts',
    'receive-voucher/receive-voucher.component.ts',
    'internal-settlement/internal-settlement.component.ts',
    'shared/services/database.service.ts',
    // Cash in hand counts `bills.amount_paid` as the authoritative record of
    // money received from a customer, and a layer-sale receivable settled in
    // cash is money in exactly as a distribution bill is. Filtering it out
    // would lose every egg and hen sale collected on credit from the client's
    // cash position.
    'shared/services/cash-position.service.ts',
    // Already demands payment_type = 'internal' AND customer_type = 'own_farm',
    // and a layer-sale bill is neither.
    'shared/services/farm-report.service.ts'
  ]
  const DISTRIBUTION_ONLY = [
    'sales-orders/sales-orders.component.ts',
    'sales-returns/sales-returns.component.ts',
    'distribution-report/distribution-report.component.ts',
    'shared/services/overview.service.ts'
  ]

  const srcFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) srcFiles.push(full)
    }
  }
  walk(path.join(ROOT, 'src', 'app'))

  const APP = path.join(ROOT, 'src', 'app')
  // The util itself mentions `FROM bills` in its own documentation; it is
  // where the filter is DEFINED, not a reader of the table.
  const readers = srcFiles
    .filter(f => /FROM\s+bills\b/i.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(APP, f).split(path.sep).join('/'))
    .filter(r => r !== 'shared/utils/bill-source.util.ts')

  checkTrue(`${readers.length} file(s) read FROM bills`, readers.length > 0)
  for (const r of readers) {
    const listed = BOTH_KINDS.includes(r) || DISTRIBUTION_ONLY.includes(r)
    checkTrue(`${r} is on one of the two lists`, listed)
  }
  for (const r of DISTRIBUTION_ONLY) {
    const src = fs.readFileSync(path.join(APP, r), 'utf8')
    checkTrue(`${r} filters with distributionBillsOnly()`, src.includes('distributionBillsOnly('))
  }
  for (const r of BOTH_KINDS) {
    if (r === 'shared/services/farm-report.service.ts') continue
    const src = fs.readFileSync(path.join(APP, r), 'utf8')
    checkTrue(`${r} deliberately does NOT filter`, !src.includes('distributionBillsOnly('))
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => {
  console.error('verify_layer_sales_customers.js crashed:', (err && err.stack) || err)
  process.exit(1)
})
