// A distribution bill's payment can land on either KIND of bank account, and
// the two are not the same movement.
//
//   HOUSE      one of the owner's own accounts (bank_accounts.customer_id IS
//              NULL). A real receipt: money IN, a debit, numbered DEP-, keyed
//              to the bill by reference_type 'bill_payment_in'. The account
//              rises, and so does the sum of all bank balances.
//   CUSTOMER   the deposit this customer already holds with the farm. Money OUT
//              of the customer's own account: a credit, reference_type
//              'payment' with a NULL reference_id. This is the axis the screen
//              has always had and its shape is unchanged.
//
// Why `bills` is NOT a BANK_SOURCES table: that mechanism declares ONE
// direction per table and keys exactly one entry to the row's primary key. A
// bill is 'in' on a house account and 'out' on a customer's, and the
// customer-deposit entry is keyed to nothing at all, so both halves of the
// shape fail. The house half therefore takes the named-path shape `assets`,
// `personal_expenses` and `internal_settlements` have — its own reference_type,
// composed out of the same primitives. See the block above
// `BILL_PAYMENT_IN_REF` in database.service.ts.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, the REAL executeStatement/runQuery/
// runBatch and the REAL begin/commit/rollback from electron/database.js, the
// bank and ledger methods lifted out of database.service.ts, and saveBill() /
// onDeleteConfirmed() themselves lifted out of sales-orders.component.ts.
// Nothing is a copy, so the path under test is the one the app runs.
//
// What is proved:
//   A. A bill received into a HOUSE account raises that account by the amount
//      paid, writes exactly one 'bill_payment_in' entry keyed to the bill, as a
//      debit numbered DEP-, and leaves every other account alone.
//   B. Deleting that bill takes the entry with it and lowers the account back.
//   C. A bill paid from a CUSTOMER DEPOSIT account writes the EXISTING shape —
//      reference_type 'payment', reference_id NULL, a credit on the customer's
//      own account — and touches no house account at all.
//   D. THE DIRECTION INVARIANT. The sum of all bank balances moves by the
//      house-account amount and by nothing else: a deposit draw-down is money
//      leaving the banked world, a house receipt is money entering it, and a
//      cash bill moves neither.
//   E. THE SALE IS UNTOUCHED. The same cart, saved three ways (cash, house
//      bank, customer deposit), produces byte-identical bill_items, identical
//      batch_transactions and identical remaining stock. Pinned against
//      literals as well, so this still means something if all three drift
//      together.
//   F. EVERY EDIT TRANSITION reverses what the bill said before and posts what
//      it says now: cash->house, house->cash, house A->house B, house->deposit,
//      deposit->house, and an amount change on the same account.
//   G. LEGACY. A bill written before any of this — payment_type 'bank' with no
//      payment_account_kind, no bank_id and no entry — is read as the
//      customer-deposit axis it could only have been, is refunded on the
//      customer's account when deleted, and never has a house entry invented
//      for it.
//   H. REFUSALS write nothing: an account named that does not exist, and a
//      deposit account that is not the bill customer's own.
//   I. `deleteBankAccount()` refuses while a house-received bill names the
//      account, and the refusal names it.
//   J. An OWN-FARM bill takes no bank receipt whatever the dropdown held — it
//      settles on the Internal Settlement screen, and a receipt here as well
//      would record the same money twice.
//   K. The cached current_balance equals SUM(debit - credit) over each
//      account's own ledger, after every single mutation.
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
const SO_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'sales-orders', 'sales-orders.component.ts'), 'utf8')
const SQLERR_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'sql-error.util.ts'), 'utf8')
const DATE_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'date.util.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(src, name, kw, from) {
  const start = from !== undefined ? from : src.indexOf(`${kw}${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  // Skip the parameter list first: a signature can carry an inline object type,
  // whose braces would otherwise be mistaken for the start of the body.
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

/**
 * The position where `needle` is a DECLARATION — the first non-blank text on
 * its line — rather than a mention of the same name in a doc comment (those
 * lines start with `*`) or a `this.`-qualified call site.
 */
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

const svcMethod = (name, kw = '') => loadFrom(SVC_SRC, name, kw)
const screenMethod = (name, kw = '') => loadFrom(SO_SRC, name, kw)

/** A getter, lifted as a plain function so it can be re-attached with defineProperty. */
const screenGetter = (name) => loadFrom(SO_SRC, name, 'get ')

// ── The main process, for real ──────────────────────────────────────────────
//
// These are the module-scope bindings the lifted functions close over. The
// watchdog is stubbed — it is not under test and the real one would hold the
// process open for a minute. saveDatabase() is a no-op: this script is about
// what lands in the tables, and the one bug that needs a real file write has
// its own script (verify_product_opening_stock.js).
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

// Direct eval, so each function closes over the bindings above exactly as it
// does over its own module scope in electron/database.js. `const` inside a
// direct eval stays trapped in that eval's scope, so the one declaration here
// is rewritten to `var` on the way in.
eval(DB_SRC.slice(
  DB_SRC.indexOf('const PRIMARY_KEY_MAP = {'),
  DB_SRC.indexOf('\n}', DB_SRC.indexOf('const PRIMARY_KEY_MAP = {')) + 2)
  .replace('const PRIMARY_KEY_MAP', 'var PRIMARY_KEY_MAP'))
eval(extractFn(DB_SRC, 'refuseWrite', 'function '))
eval(extractFn(DB_SRC, 'executeStatement', 'function '))
eval(extractFn(DB_SRC, 'resolveBatchParams', 'function '))
eval(extractFn(DB_SRC, 'runBatch', 'function '))
eval(extractFn(DB_SRC, 'getQuery', 'function '))
eval(extractFn(DB_SRC, 'beginTransaction', 'function '))
eval(extractFn(DB_SRC, 'commitTransaction', 'function '))
eval(extractFn(DB_SRC, 'performRollback', 'function '))
eval(extractFn(DB_SRC, 'rollbackTransaction', 'function '))
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
const toLocalDateString = loadFrom(DATE_SRC, 'toLocalDateString', 'export function ')

function rows(sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

// The reference_type the house receipt is keyed by, read off the real
// declaration rather than restated — a rename breaks this file instead of
// quietly passing.
const BILL_PAYMENT_IN_REF = (() => {
  const m = SVC_SRC.match(/BILL_PAYMENT_IN_REF\s*=\s*'([^']+)'/)
  if (!m) throw new Error('BILL_PAYMENT_IN_REF not found')
  return m[1]
})()

const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()
const DatabaseService = { BANK_SOURCES, BILL_PAYMENT_IN_REF }

const svc = {
  async run(sql, params = []) { return runQuery(sql, params) },
  async get(sql, params = []) { return getQuery(sql, params) },
  async runBatch(ops) { return runBatch(ops) },
  async beginTransaction() { return beginTransaction() },
  async commitTransaction() { return commitTransaction() },
  async rollbackTransaction() { return rollbackTransaction() },

  transaction: svcMethod('transaction<T>', 'async '),

  // The bank primitives, and the two bill methods composed out of them.
  bankBalanceSql:            svcMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql:  svcMethod('nextTransactionNumberSql', 'private '),
  rebuildBankBalanceOp:      svcMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:              svcMethod('bankEntryOps', 'private '),
  bankReversalOps:           svcMethod('bankReversalOps', 'private '),
  bankRebuildOps:            svcMethod('bankRebuildOps'),
  bankIdOf:                  svcMethod('bankIdOf', 'private '),
  houseBankIdOf:             svcMethod('houseBankIdOf', 'private '),
  billHouseReceiptOps:       svcMethod('billHouseReceiptOps'),
  billHouseReversalOps:      svcMethod('billHouseReversalOps', 'async '),

  // The save-time balance guard. This script binds the real method bodies onto
  // one object, so a new `this.` dependency has to be registered here or the
  // method under test throws instead of running.
  bankAmountText:            svcMethod('bankAmountText', 'private '),
  bankEntryEffect:           svcMethod('bankEntryEffect', 'private async '),
  checkBankBalances:         svcMethod('checkBankBalances', 'async '),
  checkBillHouseReceipt:     svcMethod('checkBillHouseReceipt', 'async '),

  getBankAccounts:           svcMethod('getBankAccounts', 'async '),
  getHouseBankAccounts:      svcMethod('getHouseBankAccounts', 'async '),
  addBankAccount:            svcMethod('addBankAccount', 'async '),
  linkCustomerToBank:        svcMethod('linkCustomerToBank', 'async '),
  deleteBankAccount:         svcMethod('deleteBankAccount', 'async '),
  addBankLedgerEntry:        svcMethod('addBankLedgerEntry', 'async '),
  getCustomerBankAccount:    svcMethod('getCustomerBankAccount', 'async '),
  deductCustomerBank:        svcMethod('deductCustomerBank', 'async '),

  rebuildCustomerBalanceOp:          svcMethod('rebuildCustomerBalanceOp', 'private '),
  addCustomerLedgerEntry:            svcMethod('addCustomerLedgerEntry', 'async '),
  updateCustomerOutstandingBalance:  svcMethod('updateCustomerOutstandingBalance', 'async '),

  getBatchesByProduct:  svcMethod('getBatchesByProduct', 'async '),
  updateBatch:          svcMethod('updateBatch', 'async '),
  addBatch:             svcMethod('addBatch', 'async '),
  addBatchTransaction:  svcMethod('addBatchTransaction', 'async '),
  updateBatchStatuses:  svcMethod('updateBatchStatuses', 'async '),
  getTotalStock:        svcMethod('getTotalStock', 'async ')
}
// addBankAccount and the customer-balance recompute call bare helpers, not methods.
global.toLocalDateString = toLocalDateString

// ── SalesOrdersComponent, with only what the save and delete paths touch ────

eval(ts.transpileModule(
  SO_SRC.slice(SO_SRC.indexOf('class BillWriteAborted'),
    SO_SRC.indexOf('}', SO_SRC.indexOf('class BillWriteAborted')) + 1)
    .replace('class BillWriteAborted', 'var BillWriteAborted = class BillWriteAborted'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText)

const RESOLVE_DEPOSIT_ACCOUNT = (() => {
  const m = SO_SRC.match(/RESOLVE_DEPOSIT_ACCOUNT\s*=\s*'([^']+)'/)
  if (!m) throw new Error('RESOLVE_DEPOSIT_ACCOUNT not found')
  return m[1]
})()

const screen = {
  db: svc,
  currentFarm: { farm_id: 1 },
  cdr: { detectChanges: () => {} },
  formState: { clearState: () => {}, getState: () => null, saveState: () => {} },
  FORM_KEY: 'sales_orders_form_state',
  router: { navigate: () => {} },

  products: [],
  customers: [],
  allBills: [],
  filteredBills: [],
  gridItems: [],
  houseBanks: [],
  viewMode: 'create',
  isEditMode: false,
  editingBillId: null,
  isSubmitting: false,
  errorMessage: '',
  billSearchTerm: '',
  currentPage: 1,

  customerType: 'walkin',
  selectedCustomerId: null,
  receivedInto: 'cash',
  customerHasBank: false,
  customerBankBalance: 0,
  customerBankId: null,
  internalTargetModule: 'broiler',
  internalTargetFlockId: null,
  internalFlocks: [],
  paidAmount: 0,
  explicitUnpaid: false,
  lastCartSubtotal: 0,
  showDeleteDialog: false,
  deletingBillId: null,

  onFormChange: () => {},
  resetForm: () => {},
  saveState: () => {},

  assertOk:                 screenMethod('assertOk', 'private '),
  mustRun:                  screenMethod('mustRun', 'private async '),
  mustRunBatch:             screenMethod('mustRunBatch', 'private async '),
  getAvailableStock:        screenMethod('getAvailableStock', 'async '),
  getNextBillNumber:        screenMethod('getNextBillNumber', 'async '),
  getBillItems:             screenMethod('getBillItems', 'private async '),
  validateStockForBill:     screenMethod('validateStockForBill', 'private async '),
  deductFromBatches:        screenMethod('deductFromBatches', 'private async '),
  restoreBillStock:         screenMethod('restoreBillStock', 'private async '),
  cleanupInternalTransfers: screenMethod('cleanupInternalTransfers', 'private async '),
  addToCustomerLedger:      screenMethod('addToCustomerLedger', 'async '),
  removeFromCustomerLedger: screenMethod('removeFromCustomerLedger', 'async '),
  resolveOwnFarmCustomerId: screenMethod('resolveOwnFarmCustomerId', 'private async '),
  addCustomerBankCredit:    screenMethod('addCustomerBankCredit', 'private async '),
  applyBankPaymentChange:   screenMethod('applyBankPaymentChange', 'private async '),
  checkCustomerBank:        screenMethod('checkCustomerBank', 'async '),
  dropCustomerDepositChoice: screenMethod('dropCustomerDepositChoice', 'private '),
  bankFieldsForBill:        screenMethod('bankFieldsForBill', 'private '),
  isCustomerDepositBill:    screenMethod('isCustomerDepositBill', 'private '),
  receivedIntoError:        screenMethod('receivedIntoError', 'private '),
  billPaymentLabel:         screenMethod('billPaymentLabel'),
  saveBill:                 screenMethod('saveBill', 'async '),
  onDeleteConfirmed:        screenMethod('onDeleteConfirmed', 'async '),

  loadBills: async () => {
    const r = await svc.get('SELECT * FROM bills WHERE farm_id=? ORDER BY bill_date DESC', [1])
    screen.allBills = r.success ? r.data : []
    screen.filteredBills = [...screen.allBills]
  },
  loadData: async () => { await screen.loadBills() }
}

for (const name of ['cartSubtotal', 'paymentMethod', 'receivedIntoKind',
                    'receivedIntoBankId', 'selectedCustomerName']) {
  const fn = screenGetter(name)
  Object.defineProperty(screen, name, { get: fn, configurable: true })
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const check = (label, actual, expected) => {
  const ok = Number(actual) === Number(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkStr = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got "${actual}", expected "${expected}"`)
}
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

const balance = (bankId) =>
  Number(rows('SELECT current_balance FROM bank_accounts WHERE bank_id = ?', [bankId])[0].current_balance)
const totalBankBalance = () =>
  Number(rows('SELECT COALESCE(SUM(current_balance), 0) AS t FROM bank_accounts')[0].t)
const houseEntries = (billId) =>
  rows('SELECT * FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
    [BILL_PAYMENT_IN_REF, billId])
const billRow = (billId) => rows('SELECT * FROM bills WHERE bill_id = ?', [billId])[0] || null

/**
 * THE INVARIANT, checked after every mutation rather than once at the end, so a
 * failure names the step that broke it.
 *
 *   1. every bill whose payment_account_kind is 'house' has exactly one receipt
 *   2. every receipt points at a bill that still exists
 *   3. no bill that is NOT a house receipt has one
 *   4. every account's cached balance equals the ledger it caches
 */
function assertInvariant(step) {
  const unmirrored = rows(
    `SELECT COUNT(*) AS n FROM bills b
     WHERE b.payment_account_kind = 'house' AND b.payment_source = 'bank'
       AND (SELECT COUNT(*) FROM bank_ledger bl
            WHERE bl.reference_type = ? AND bl.reference_id = b.bill_id) <> 1`,
    [BILL_PAYMENT_IN_REF])[0].n
  const orphaned = rows(
    `SELECT COUNT(*) AS n FROM bank_ledger bl
     WHERE bl.reference_type = ?
       AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.bill_id = bl.reference_id)`,
    [BILL_PAYMENT_IN_REF])[0].n
  const spurious = rows(
    `SELECT COUNT(*) AS n FROM bank_ledger bl
     WHERE bl.reference_type = ?
       AND EXISTS (SELECT 1 FROM bills b
                   WHERE b.bill_id = bl.reference_id
                     AND COALESCE(b.payment_account_kind, '') <> 'house')`,
    [BILL_PAYMENT_IN_REF])[0].n
  const drifted = rows(
    `SELECT COUNT(*) AS n FROM bank_accounts ba
     WHERE ROUND(COALESCE(ba.current_balance, 0), 2) <> ROUND(
       (SELECT COALESCE(SUM(bl.debit - bl.credit), 0) FROM bank_ledger bl
        WHERE bl.bank_id = ba.bank_id), 2)`)[0].n

  check(`${step} — house-received bills with no receipt`, unmirrored, 0)
  check(`${step} — receipts with no bill`, orphaned, 0)
  check(`${step} — receipts on a bill that is not a house receipt`, spurious, 0)
  check(`${step} — accounts whose balance drifted from their ledger`, drifted, 0)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

const FARM = 1
let HOUSE_A = 0, HOUSE_B = 0, DEPOSIT = 0
const CUSTOMER = 1

/** One cart, used for every sale in this file, so section E can compare them. */
const CART = () => ([
  { productId: 1, productName: 'Vanda Feed', quantity: 4, unitPrice: 2500, totalPrice: 10000, batches: [], selectedBatchId: null },
  { productId: 2, productName: 'Chick Guard', quantity: 2, unitPrice: 1500, totalPrice: 3000, batches: [], selectedBatchId: null }
])
const CART_TOTAL = 13000

/** Everything about the SALE half of a bill, for comparing one save to another. */
const saleShape = (billId) => JSON.stringify({
  items: rows(`SELECT product_id, product_name, quantity, unit_price, total_price
               FROM bill_items WHERE bill_id = ? ORDER BY product_id, item_id`, [billId]),
  moves: rows(`SELECT product_id, type, quantity, transaction_date, notes
               FROM batch_transactions WHERE reference_id = ?
               ORDER BY product_id, type, transaction_id`, [billId]),
  totals: rows(`SELECT subtotal, total_amount FROM bills WHERE bill_id = ?`, [billId])
})
const stockShape = () => JSON.stringify(
  rows('SELECT product_id, SUM(quantity) AS q FROM product_batches GROUP BY product_id ORDER BY product_id'))

/** Puts the screen back into a known "fresh bill" state. */
const freshForm = (overrides = {}) => {
  screen.gridItems = CART()
  screen.isEditMode = false
  screen.editingBillId = null
  screen.isSubmitting = false
  screen.errorMessage = ''
  screen.customerType = 'walkin'
  screen.selectedCustomerId = null
  screen.receivedInto = 'cash'
  screen.customerHasBank = false
  screen.customerBankId = null
  screen.customerBankBalance = 0
  screen.internalTargetModule = 'broiler'
  screen.internalTargetFlockId = null
  screen.paidAmount = CART_TOTAL
  screen.explicitUnpaid = false
  Object.assign(screen, overrides)
}

/** Restocks both products to a known quantity, so each sale starts level. */
const restock = () => {
  db.run('DELETE FROM batch_transactions')
  db.run('DELETE FROM product_batches')
  db.run(`INSERT INTO product_batches (batch_id, product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price, status)
          VALUES (1, 1, 1, 'B-1', '2025-01-01', '2030-01-01', 100, 2000, 'active'),
                 (2, 2, 1, 'B-2', '2025-01-01', '2030-01-01', 100, 1000, 'active')`)
}

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  // executeStatement narrates every insert; the test output is what matters.
  const realLog = console.log
  const quiet = async (fn) => { console.log = () => {}; try { return await fn() } finally { console.log = realLog } }

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1, 'Talha', 'x', 'all')`)
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type) VALUES (1, 1, 'Ahmed Textiles', 'external')`)
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type) VALUES (2, 1, 'Bilal Traders', 'external')`)
  db.run(`INSERT INTO products (product_id, farm_id, product_name, category, unit, selling_price)
          VALUES (1, 1, 'Vanda Feed', 'feed', 'bag', 2500), (2, 1, 'Chick Guard', 'other', 'pc', 1500)`)
  db.run(`INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name) VALUES (1, 1, 'broiler', 'Farm One')`)
  db.run(`INSERT INTO flocks (flock_id, farm_id, unit_id, flock_name, start_date, status)
          VALUES (1, 1, 1, 'Flock A', '2025-01-01', 'active')`)

  await quiet(async () => {
    HOUSE_A = (await svc.addBankAccount({ farm_id: FARM, bank_name: 'HBL Main', account_number: '1234', opening_balance: 50000 })).lastId
    HOUSE_B = (await svc.addBankAccount({ farm_id: FARM, bank_name: 'Meezan', account_number: '5678', opening_balance: 0 })).lastId
    DEPOSIT = (await svc.addBankAccount({ farm_id: FARM, customer_id: CUSTOMER, bank_name: 'Ahmed Deposit', opening_balance: 80000 })).lastId
  })
  screen.customers = rows('SELECT * FROM customers WHERE farm_id = 1')
  screen.houseBanks = (await svc.getHouseBankAccounts(FARM)).data

  const save = async () => quiet(() => screen.saveBill())
  const removeBill = async (billId) => {
    await screen.loadBills()
    screen.deletingBillId = billId
    screen.errorMessage = ''
    await quiet(() => screen.onDeleteConfirmed())
  }

  console.log('\n=== A. a bill received INTO a house account is a real receipt ===')

  restock()
  const beforeA = balance(HOUSE_A)
  const totalBeforeA = totalBankBalance()
  freshForm({ receivedInto: `house:${HOUSE_A}` })
  const billA = await save()

  checkTrue('the bill saved', !!billA)
  check('the house account rose by the amount paid', balance(HOUSE_A), beforeA + CART_TOTAL)
  check('exactly one receipt was written', houseEntries(billA).length, 1)
  const entryA = houseEntries(billA)[0]
  check('as a debit, not a credit', Number(entryA.debit), CART_TOTAL)
  check('credit is zero', Number(entryA.credit), 0)
  checkStr('numbered like a deposit', String(entryA.transaction_number).slice(0, 4), 'DEP-')
  check('on the account that was picked', Number(entryA.bank_id), HOUSE_A)
  check('keyed to the bill', Number(entryA.reference_id), billA)
  checkTrue('and it names the bill', String(entryA.description).includes('BILL-001'))
  check('the other house account is untouched', balance(HOUSE_B), 0)
  check('the deposit account is untouched', balance(DEPOSIT), 80000)
  check('the sum of all balances rose by the amount', totalBankBalance(), totalBeforeA + CART_TOTAL)
  checkStr('the bill stores which kind of account', billRow(billA).payment_account_kind, 'house')
  checkStr('and that money moved through a named one', billRow(billA).payment_source, 'bank')
  check('and which account', Number(billRow(billA).bank_id), HOUSE_A)
  checkStr('payment_type still reads bank, for the badge', billRow(billA).payment_type, 'bank')
  checkStr('the list tells the two kinds apart', screen.billPaymentLabel(billRow(billA)), '🏦 Bank')
  assertInvariant('A')

  console.log('\n=== B. deleting that bill takes the receipt with it ===')

  await removeBill(billA)
  check('the bill is gone', rows('SELECT COUNT(*) AS n FROM bills WHERE bill_id = ?', [billA])[0].n, 0)
  check('the receipt is gone', houseEntries(billA).length, 0)
  check('the account is back where it started', balance(HOUSE_A), beforeA)
  check('and so is the sum of all balances', totalBankBalance(), totalBeforeA)
  assertInvariant('B')

  console.log('\n=== C. a bill paid from a CUSTOMER DEPOSIT keeps the existing shape ===')

  restock()
  const houseBeforeC = balance(HOUSE_A) + balance(HOUSE_B)
  const depositBeforeC = balance(DEPOSIT)
  const totalBeforeC = totalBankBalance()
  freshForm({ customerType: 'regular', selectedCustomerId: CUSTOMER })
  await screen.checkCustomerBank(CUSTOMER)
  screen.receivedInto = `customer:${DEPOSIT}`
  const billC = await save()

  checkTrue('the bill saved', !!billC)
  check('the deposit account fell by the amount', balance(DEPOSIT), depositBeforeC - CART_TOTAL)
  check('no house account moved', balance(HOUSE_A) + balance(HOUSE_B), houseBeforeC)
  check('no bill_payment_in entry was written', houseEntries(billC).length, 0)
  const depositEntries = rows(
    `SELECT * FROM bank_ledger WHERE bank_id = ? AND reference_type = 'payment'
     ORDER BY ledger_id DESC LIMIT 1`, [DEPOSIT])
  check('the existing shape was written instead', depositEntries.length, 1)
  check("reference_type 'payment' carries a NULL reference_id",
    depositEntries[0].reference_id === null ? 1 : 0, 1)
  check('as a credit — money out of the customer', Number(depositEntries[0].credit), CART_TOTAL)
  check('debit is zero', Number(depositEntries[0].debit), 0)
  checkStr('the bill stores the other kind', billRow(billC).payment_account_kind, 'customer')
  checkStr('and the list says so', screen.billPaymentLabel(billRow(billC)), '🏦 Customer Deposit')
  check('the sum of all balances FELL by the amount', totalBankBalance(), totalBeforeC - CART_TOTAL)
  assertInvariant('C')

  console.log('\n=== D. the direction invariant, stated for all three shapes ===')
  // Bank balances in total move by:
  //   (received into a HOUSE account ? +amount : 0)
  //   - (taken from a CUSTOMER deposit ? +amount : 0)
  // Cash moves neither. A house receipt is money entering the banked world; a
  // deposit draw-down is money leaving it; neither invents any.

  await removeBill(billC)
  check('the deposit refund put it back', balance(DEPOSIT), depositBeforeC)
  check('and the total with it', totalBankBalance(), totalBeforeC)

  restock()
  const totalBeforeCash = totalBankBalance()
  const ledgerRowsBeforeCash = rows('SELECT COUNT(*) AS n FROM bank_ledger')[0].n
  freshForm()
  const billCash = await save()
  check('a cash bill moves no balance at all', totalBankBalance(), totalBeforeCash)
  check('and writes no receipt', houseEntries(billCash).length, 0)
  // Counted rather than matched on the description: a deposit draw-down and its
  // refund stay on the customer's account for good (they offset rather than
  // delete), and bill numbers are reissued once earlier bills are gone, so
  // older rows really do name this bill's number.
  check('and adds no bank_ledger row at all',
    rows('SELECT COUNT(*) AS n FROM bank_ledger')[0].n, ledgerRowsBeforeCash)
  checkStr('a cash bill stores no account kind',
    billRow(billCash).payment_account_kind === null ? 'null' : billRow(billCash).payment_account_kind, 'null')
  assertInvariant('D')

  console.log('\n=== E. THE SALE IS UNTOUCHED by how it was paid ===')

  // The cash bill above is the reference. The same cart saved into a house
  // account and out of a customer deposit must produce the identical sale.
  const cashSale = saleShape(billCash).replace(new RegExp(`"total_amount":${CART_TOTAL}`), '"total_amount":T')
  const cashStock = stockShape()
  check('four units of product 1 left the shelf',
    rows(`SELECT quantity AS q FROM batch_transactions
          WHERE reference_id = ? AND product_id = 1 AND type = 'sale'`, [billCash])[0].q, 4)
  check('two units of product 2',
    rows(`SELECT quantity AS q FROM batch_transactions
          WHERE reference_id = ? AND product_id = 2 AND type = 'sale'`, [billCash])[0].q, 2)
  check('product 1 is down to 96', rows('SELECT quantity AS q FROM product_batches WHERE product_id = 1')[0].q, 96)
  check('product 2 is down to 98', rows('SELECT quantity AS q FROM product_batches WHERE product_id = 2')[0].q, 98)
  check('two bill_items rows', rows('SELECT COUNT(*) AS n FROM bill_items WHERE bill_id = ?', [billCash])[0].n, 2)
  await removeBill(billCash)

  restock()
  freshForm({ receivedInto: `house:${HOUSE_A}` })
  const billHouseE = await save()
  const houseSale = saleShape(billHouseE).replace(new RegExp(`"total_amount":${CART_TOTAL}`), '"total_amount":T')
  const houseStock = stockShape()
  checkTrue('a house-banked sale writes the IDENTICAL sale lines and stock moves',
    houseSale === cashSale)
  checkTrue('and leaves the identical stock behind', houseStock === cashStock)
  await removeBill(billHouseE)

  restock()
  freshForm({ customerType: 'regular', selectedCustomerId: CUSTOMER })
  await screen.checkCustomerBank(CUSTOMER)
  screen.receivedInto = `customer:${DEPOSIT}`
  const billDepE = await save()
  const depSale = saleShape(billDepE).replace(new RegExp(`"total_amount":${CART_TOTAL}`), '"total_amount":T')
  checkTrue('a deposit-paid sale writes the IDENTICAL sale lines and stock moves',
    depSale === cashSale)
  checkTrue('and leaves the identical stock behind', stockShape() === houseStock)
  await removeBill(billDepE)
  assertInvariant('E')

  console.log('\n=== F. every edit transition reverses then re-posts ===')

  const editTo = async (billId, overrides) => {
    freshForm(Object.assign({ isEditMode: true, editingBillId: billId }, overrides))
    // saveBill() reads the PREVIOUS state of the bill out of `allBills` — that
    // is how it knows what to reverse — so the list is refreshed from the
    // table, exactly as loadBills() does on the screen. The fields selectBill()
    // would set from the row are the ones passed in `overrides`.
    screen.allBills = rows('SELECT * FROM bills WHERE farm_id = 1')
    return quiet(() => screen.saveBill())
  }

  // F1 cash -> house
  restock()
  freshForm()
  const billF = await save()
  const houseBeforeF = balance(HOUSE_A)
  await editTo(billF, { receivedInto: `house:${HOUSE_A}` })
  check('F1 cash -> house: the account rose', balance(HOUSE_A), houseBeforeF + CART_TOTAL)
  check('F1 one receipt', houseEntries(billF).length, 1)
  assertInvariant('F1 cash -> house')

  // F2 same account, smaller amount
  await editTo(billF, { receivedInto: `house:${HOUSE_A}`, customerType: 'regular',
                        selectedCustomerId: CUSTOMER, paidAmount: 5000, explicitUnpaid: true })
  check('F2 amount changed: the account holds only what was paid', balance(HOUSE_A), houseBeforeF + 5000)
  check('F2 still exactly one receipt', houseEntries(billF).length, 1)
  checkStr('F2 and it kept its number', String(houseEntries(billF)[0].transaction_number), 'DEP-0001')
  assertInvariant('F2 amount changed')

  // F3 house A -> house B
  await editTo(billF, { receivedInto: `house:${HOUSE_B}`, customerType: 'regular',
                        selectedCustomerId: CUSTOMER, paidAmount: 5000, explicitUnpaid: true })
  check('F3 house A -> house B: A is back where it started', balance(HOUSE_A), houseBeforeF)
  check('F3 and B holds it', balance(HOUSE_B), 5000)
  check('F3 still exactly one receipt', houseEntries(billF).length, 1)
  check('F3 on B', Number(houseEntries(billF)[0].bank_id), HOUSE_B)
  assertInvariant('F3 house A -> house B')

  // F4 house -> deposit
  await editTo(billF, { customerType: 'regular', selectedCustomerId: CUSTOMER,
                        receivedInto: `customer:${DEPOSIT}`, customerHasBank: true,
                        customerBankId: DEPOSIT, paidAmount: 5000, explicitUnpaid: true })
  check('F4 house -> deposit: B is back where it started', balance(HOUSE_B), 0)
  check('F4 the receipt is gone', houseEntries(billF).length, 0)
  check('F4 and the deposit was drawn down', balance(DEPOSIT), 80000 - 5000)
  assertInvariant('F4 house -> deposit')

  // F5 deposit -> house
  await editTo(billF, { receivedInto: `house:${HOUSE_A}`, customerType: 'regular',
                        selectedCustomerId: CUSTOMER, paidAmount: 5000, explicitUnpaid: true })
  check('F5 deposit -> house: the deposit was refunded', balance(DEPOSIT), 80000)
  check('F5 and the house account holds it', balance(HOUSE_A), houseBeforeF + 5000)
  check('F5 exactly one receipt', houseEntries(billF).length, 1)
  assertInvariant('F5 deposit -> house')

  // F6 house -> cash
  await editTo(billF, { customerType: 'regular', selectedCustomerId: CUSTOMER,
                        paidAmount: 5000, explicitUnpaid: true })
  check('F6 house -> cash: the receipt is gone', houseEntries(billF).length, 0)
  check('F6 and the account is back where it started', balance(HOUSE_A), houseBeforeF)
  checkStr('F6 the row says cash', billRow(billF).payment_source, 'cash')
  assertInvariant('F6 house -> cash')

  await removeBill(billF)
  assertInvariant('F after deleting the edited bill')

  console.log('\n=== G. a LEGACY bank bill is the deposit axis, and keeps no receipt ===')

  // Exactly the shape the previous version wrote: payment_type 'bank', no
  // payment_account_kind, no bank_id, and a real deduction already made on the
  // customer's account. There is no way to write one through the screen now,
  // which is the point — this is a row that is already in a user's database.
  restock()
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (900, 1, 'BILL-900', 1, 'Ahmed Textiles', '2025-05-01', 9000, 9000, 9000, 'bank')`)
  db.run(`INSERT INTO bank_ledger (bank_id, transaction_date, description, debit, credit, balance,
                                   reference_type, reference_id, transaction_number)
          VALUES (${DEPOSIT}, '2025-05-01', 'Payment - Bill #BILL-900', 0, 9000, 71000, 'payment', NULL, 'WD-0009')`)
  db.run(`UPDATE bank_accounts SET current_balance =
            (SELECT COALESCE(SUM(debit - credit), 0) FROM bank_ledger WHERE bank_id = ${DEPOSIT})
          WHERE bank_id = ${DEPOSIT}`)

  const legacy = billRow(900)
  checkTrue('it is read as the customer-deposit axis', screen.isCustomerDepositBill(legacy))
  check('it has no receipt of its own', houseEntries(900).length, 0)
  checkStr('and the list labels it as a deposit payment',
    screen.billPaymentLabel(legacy), '🏦 Customer Deposit')
  const depositBeforeG = balance(DEPOSIT)
  await removeBill(900)
  check('deleting it refunds the customer', balance(DEPOSIT), depositBeforeG + 9000)
  check('and invents no house entry', houseEntries(900).length, 0)
  assertInvariant('G')

  console.log('\n=== H. refusals write nothing ===')

  restock()
  const beforeH = JSON.stringify(rows('SELECT bank_id, current_balance FROM bank_accounts ORDER BY bank_id'))
  const billsBeforeH = rows('SELECT COUNT(*) AS n FROM bills')[0].n

  freshForm({ receivedInto: 'house:9999' })
  const refusedGhost = await save()
  check('an account that does not exist is refused', refusedGhost === null ? 1 : 0, 1)
  checkTrue('and says so', screen.errorMessage.includes('no longer exists'))

  freshForm({ customerType: 'regular', selectedCustomerId: 2, receivedInto: `customer:${DEPOSIT}` })
  const refusedOther = await save()
  check("another customer's deposit account is refused", refusedOther === null ? 1 : 0, 1)
  checkTrue('and says so', screen.errorMessage.includes('no longer available'))

  check('no bill was written', rows('SELECT COUNT(*) AS n FROM bills')[0].n, billsBeforeH)
  checkStr('and no balance moved',
    JSON.stringify(rows('SELECT bank_id, current_balance FROM bank_accounts ORDER BY bank_id')), beforeH)
  assertInvariant('H')

  console.log('\n=== I. the account cannot be deleted while a bill names it ===')

  restock()
  freshForm({ receivedInto: `house:${HOUSE_B}` })
  const billI = await save()
  const refusal = await quiet(() => svc.deleteBankAccount(HOUSE_B))
  check('the delete is refused', refusal.success ? 1 : 0, 0)
  checkTrue('and the refusal names the bill payment', String(refusal.error).includes('bill payment'))
  check('the account is still there', rows('SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_id = ?', [HOUSE_B])[0].n, 1)
  check('and its ledger with it', houseEntries(billI).length, 1)
  await removeBill(billI)
  const allowed = await quiet(() => svc.deleteBankAccount(HOUSE_B))
  check('and allowed once the bill is gone', allowed.success ? 1 : 0, 1)
  assertInvariant('I')

  console.log('\n=== J. an OWN-FARM bill takes no bank receipt ===')

  restock()
  const totalBeforeJ = totalBankBalance()
  freshForm({
    customerType: 'internal',
    internalTargetModule: 'broiler',
    internalTargetFlockId: 1,
    // Deliberately left holding a house account: the dropdown is hidden for an
    // own-farm bill, but a value left over from before the switch must not
    // post a receipt anyway.
    receivedInto: `house:${HOUSE_A}`,
    paidAmount: 0,
    explicitUnpaid: true
  })
  const billJ = await save()
  checkTrue('the own-farm bill saved', !!billJ)
  checkStr('it is an internal bill', billRow(billJ).payment_type, 'internal')
  checkStr('with no account kind', billRow(billJ).payment_account_kind === null ? 'null' : billRow(billJ).payment_account_kind, 'null')
  checkStr('and no claim that money moved through an account', billRow(billJ).payment_source, 'cash')
  check('no receipt was written', houseEntries(billJ).length, 0)
  check('and no balance moved', totalBankBalance(), totalBeforeJ)
  check('the farm owes the whole amount',
    rows('SELECT outstanding_balance AS b FROM customers WHERE customer_type = ?', ['own_farm'])[0].b, CART_TOTAL)
  assertInvariant('J')

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => {
  console.error("verify_bill_bank_account.js crashed:", err && err.stack || err)
  process.exit(1)
})
