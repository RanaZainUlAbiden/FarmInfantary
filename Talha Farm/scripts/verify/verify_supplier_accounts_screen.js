// SUPPLIER ACCOUNTS — the entity-based view of the supplier side, asserted
// against the row-by-row Supplier Ledger screen beside it.
//
// THE ONE THING THIS FILE EXISTS TO PROTECT: there is now a THIRD door onto the
// supplier payable, and all three must report the same number. The payable is
// `SUM(credit - debit)` over `supplier_ledger`, stored nowhere — no
// `suppliers.outstanding_balance`, ever. `verify_supplier_tracking.js` proves
// the SQL and the util agree; this file proves the NEW SCREEN calls them rather
// than adding arithmetic of its own, which is the part that can rot without
// anything failing to compile.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, the atomic writer from runBatch(), the
// service's own methods lifted out of database.service.ts, and the screen's own
// `loadSuppliers()` / `loadSupplierDetail()` / getters / `recordPayment()`
// lifted out of the component. Nothing is a restatement.
//
// What is proved:
//   A. SCREEN SQL. Both of the screen's own statements run on the real schema
//      with a distinct sentinel per parameter position — TypeScript cannot see
//      a placeholder count or a parameter ORDER that stopped matching.
//   B. THE CARDS. Every figure on a supplier card equals the same figure from
//      `getAllSuppliersWithBalance()`, and the last transaction date equals
//      MAX(transaction_date) over that supplier's own ledger.
//   C. THE SAME STATEMENT. The drilldown lists the identical rows, in the
//      identical order, with the identical running balance as the Supplier
//      Ledger screen — one read, two screens — and its summary equals the card.
//   D. PURCHASES. Exactly this supplier's `purchase_orders` rows, nothing else,
//      and the list total equals SUM(total_amount).
//   E. PAYMENTS AND ACCOUNTS. The payments list is the money-out rows (returns
//      excluded), its total equals `total_paid`, and the by-account breakdown
//      sums to the same figure.
//   F. THE RECONCILIATION, per supplier, on the screen's own numbers:
//          purchased + other - paid - returned == payable
//   G. RECORD PAYMENT. The drilldown lands on `/app/payment-voucher` with this
//      supplier's id, and the voucher screen's own `?supplierId=` handler then
//      prefills that supplier and their payable — and refuses an id that is
//      not this farm's.
//   H. FARM SCOPING, including when the ids collide.
//   I. A READ-ONLY SCREEN. The component contains no INSERT/UPDATE/DELETE: the
//      one payment door stays the Payment Voucher.
//   J. THE TEMPLATE'S CELL COUNTS, per table and per row branch, against the
//      <thead>. No other script in this repo reads an .html file, and an
//      off-by-one here is invisible to every tool and immediately obvious to
//      the user.
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
const UTIL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'supplier-ledger.util.ts'), 'utf8')
const BANK_UTIL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bank-source.util.ts'), 'utf8')
const SA_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'account-ledger',
  'supplier-accounts', 'supplier-accounts.component.ts'), 'utf8')
const SA_HTML = fs.readFileSync(path.join(ROOT, 'src', 'app', 'account-ledger',
  'supplier-accounts', 'supplier-accounts.component.html'), 'utf8')
const SL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'account-ledger',
  'supplier-ledger', 'supplier-ledger.component.ts'), 'utf8')
const PV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'payment-voucher', 'payment-voucher.component.ts'), 'utf8')
const ROUTES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'app.routes.ts'), 'utf8')
const LAYOUT_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'layout', 'layout.component.ts'), 'utf8')

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

/** The position where `needle` is a DECLARATION, not a doc-comment mention. */
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

const loadMethod = (name, kw = '') => loadFrom(SVC_SRC, name, kw)
const loadUtil = (name) => loadFrom(UTIL_SRC, name, 'export function ')

/** A getter body (`get x(): T { … }`), as a zero-arg function. */
function loadGetter(src, name) {
  const at = declAt(src, `get ${name}(`)
  if (at < 0) throw new Error(`getter ${name} not found`)
  const raw = extractFn(src, name, 'get ', at).replace(/^get\s+/, '')
  const js = ts.transpileModule('function ' + raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

/** The SQL string literal containing `marker`, lifted out of a component. */
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

// The engine — the real writer, savepoints and $lastId resolution included.
let db = null
let poisonedConnection = false
let inTransaction = false
let savepointCounter = 0
const startTransactionWatchdog = () => {}
const clearTransactionWatchdog = () => {}
const saveDatabase = () => {}
const getDbPath = () => ':memory:'
const refuseWrite = (what) => ({ success: false, error: `refused ${what}` })

const PRIMARY_KEY_MAP = eval(
  DB_SRC.slice(DB_SRC.indexOf('const PRIMARY_KEY_MAP = {'), DB_SRC.indexOf('\n}', DB_SRC.indexOf('const PRIMARY_KEY_MAP = {')) + 2)
    .replace('const PRIMARY_KEY_MAP =', '(') + ')')

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const executeStatement = eval('(' + extractFn(DB_SRC, 'executeStatement', 'function ') + ')')
const resolveBatchParams = eval('(' + extractFn(DB_SRC, 'resolveBatchParams', 'function ') + ')')
const runBatch = eval('(' + extractFn(DB_SRC, 'runBatch', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

function rows(sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

// ── The utils, lifted ───────────────────────────────────────────────────────

const NUM_AT = UTIL_SRC.indexOf('const num =')
const NUM_SRC = UTIL_SRC.slice(NUM_AT, UTIL_SRC.indexOf('\n', NUM_AT))
const num = eval('(' + ts.transpileModule(
  NUM_SRC.replace(/^const num =/, '').replace(/;\s*$/, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }
).outputText.trim().replace(/;$/, '') + ')')
global.num = num

const supplierRowKind = loadUtil('supplierRowKind')
const purchasedOf = loadUtil('purchasedOf')
const otherChargeOf = loadUtil('otherChargeOf')
const paidOf = loadUtil('paidOf')
const returnedOf = loadUtil('returnedOf')
const isSupplierPayment = loadUtil('isSupplierPayment')
const supplierTotals = loadUtil('supplierTotals')
const supplierRowLabel = loadUtil('supplierRowLabel')
Object.assign(global, {
  supplierRowKind, purchasedOf, otherChargeOf, paidOf, returnedOf,
  isSupplierPayment, supplierTotals, supplierRowLabel
})

const bankNameOf = loadFrom(BANK_UTIL_SRC, 'bankNameOf', 'export function ')
global.bankNameOf = bankNameOf
const paymentSourceLabel = loadFrom(BANK_UTIL_SRC, 'paymentSourceLabel', 'export function ')
global.paymentSourceLabel = paymentSourceLabel
global.friendlySqlError = (err, fallback) => String(err || fallback)
global.toLocalDateString = () => '2025-06-01'

// ── The service under test ──────────────────────────────────────────────────

const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()
const DatabaseService = { BANK_SOURCES }

const svc = {
  async get(sql, params = []) {
    try { return { success: true, data: rows(sql, params) } }
    catch (err) { return { success: false, error: err.message } }
  },
  async run(sql, params = []) {
    try { return { success: true, ...executeStatement(sql, params) } }
    catch (err) { return { success: false, error: err.message } }
  },
  async runBatch(ops) { return runBatch(ops) },

  // The bank mechanism the payment voucher rides on. These scripts bind real
  // method bodies onto this one object, so a new `this.` dependency inside a
  // lifted path has to be registered here or the method throws.
  bankBalanceSql:            loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql:  loadMethod('nextTransactionNumberSql', 'private '),
  rebuildBankBalanceOp:      loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:              loadMethod('bankEntryOps', 'private '),
  bankReversalOps:           loadMethod('bankReversalOps', 'private '),
  bankAmountText:            loadMethod('bankAmountText', 'private '),
  bankSourceDelta:           loadMethod('bankSourceDelta', 'private '),
  bankSource:                loadMethod('bankSource', 'private '),
  bankIdOf:                  loadMethod('bankIdOf', 'private '),
  bankSourceExisting:        loadMethod('bankSourceExisting', 'private async '),
  bankSourceInsertOps:       loadMethod('bankSourceInsertOps'),
  bankRebuildOps:            loadMethod('bankRebuildOps'),
  checkBankBalances:         loadMethod('checkBankBalances', 'async '),
  checkBankSourceInserts:    loadMethod('checkBankSourceInserts', 'async '),
  getBankAccounts:           loadMethod('getBankAccounts', 'async '),
  getHouseBankAccounts:      loadMethod('getHouseBankAccounts', 'async '),
  addBankAccount:            loadMethod('addBankAccount', 'async '),
  addBankLedgerEntry:        loadMethod('addBankLedgerEntry', 'async '),

  // The supplier side.
  supplierLedgerEntryOp:        loadMethod('supplierLedgerEntryOp', 'private '),
  addSupplierLedgerEntry:       loadMethod('addSupplierLedgerEntry', 'async '),
  getSupplierPayable:           loadMethod('getSupplierPayable', 'async '),
  getAllSuppliersWithBalance:   loadMethod('getAllSuppliersWithBalance', 'async '),
  getSupplierLedgerWithBalance: loadMethod('getSupplierLedgerWithBalance', 'async '),
  getSupplierPaymentsByAccount: loadMethod('getSupplierPaymentsByAccount', 'async '),
  savePaymentVoucher:           loadMethod('savePaymentVoucher', 'async ')
}
const call = (name, ...args) => svc[name].apply(svc, args)

// ── The SCREEN under test, assembled from its own source ────────────────────
//
// `loadSuppliers()` and `loadSupplierDetail()` are the real methods, so the
// screen's own SQL, its own assembly of the last-transaction date onto each
// card, and its own choice of service calls are all what is being exercised.

const FARM = 1

function makeScreen(farmId = FARM) {
  const screen = {
    currentFarm: { farm_id: farmId, farm_name: 'Talha' },
    suppliers: [], filteredSuppliers: [], searchTerm: '',
    selectedSupplier: null, ledgerEntries: [], purchases: [], paymentsByAccount: [],
    isLoading: true, errorMessage: '',
    db: svc,
    cdr: { detectChanges: () => {} },
    navigations: [],
    router: {
      navigate: (commands, extras) => {
        screen.navigations.push({ commands, extras })
        return Promise.resolve(true)
      }
    },
    loadSuppliers:      loadFrom(SA_SRC, 'loadSuppliers', 'async '),
    loadSupplierDetail: loadFrom(SA_SRC, 'loadSupplierDetail', 'async '),
    applyFilter:        loadFrom(SA_SRC, 'applyFilter'),
    clearSearch:        loadFrom(SA_SRC, 'clearSearch'),
    getTotalPurchased:  loadFrom(SA_SRC, 'getTotalPurchased'),
    getTotalPaid:       loadFrom(SA_SRC, 'getTotalPaid'),
    getTotalPayable:    loadFrom(SA_SRC, 'getTotalPayable'),
    getSupplierBalance: loadFrom(SA_SRC, 'getSupplierBalance'),
    getPurchaseOrderTotal: loadFrom(SA_SRC, 'getPurchaseOrderTotal'),
    getPaymentsTotal:   loadFrom(SA_SRC, 'getPaymentsTotal'),
    rowLabel:           loadFrom(SA_SRC, 'rowLabel'),
    accountLabel:       loadFrom(SA_SRC, 'accountLabel'),
    hasAccount:         loadFrom(SA_SRC, 'hasAccount'),
    isPaidOrder:        loadFrom(SA_SRC, 'isPaidOrder'),
    selectSupplier:     loadFrom(SA_SRC, 'selectSupplier'),
    recordPayment:      loadFrom(SA_SRC, 'recordPayment'),
    viewStatement:      loadFrom(SA_SRC, 'viewStatement'),
    goBack:             loadFrom(SA_SRC, 'goBack')
  }
  // The getters, as getters, so the methods above read them the way the
  // template does.
  Object.defineProperty(screen, 'totals',
    { get: loadGetter(SA_SRC, 'totals'), configurable: true })
  Object.defineProperty(screen, 'paymentHistory',
    { get: loadGetter(SA_SRC, 'paymentHistory'), configurable: true })
  return screen
}

/** The SUPPLIER LEDGER screen's own detail load, for the side-by-side. */
function makeLedgerScreen(farmId = FARM) {
  const screen = {
    currentFarm: { farm_id: farmId },
    selectedSupplier: null, ledgerEntries: [], paymentsByAccount: [],
    isLoading: true, errorMessage: '',
    db: svc,
    cdr: { detectChanges: () => {} },
    loadSupplierDetail: loadFrom(SL_SRC, 'loadSupplierDetail', 'async '),
    getSupplierBalance: loadFrom(SL_SRC, 'getSupplierBalance')
  }
  Object.defineProperty(screen, 'totals',
    { get: loadGetter(SL_SRC, 'totals'), configurable: true })
  Object.defineProperty(screen, 'paymentHistory',
    { get: loadGetter(SL_SRC, 'paymentHistory'), configurable: true })
  return screen
}

/** The PAYMENT VOUCHER screen's `?supplierId=` handler, and what it reads. */
function makeVoucherScreen(farmId = FARM) {
  const screen = {
    currentFarm: { farm_id: farmId },
    suppliers: [], houseBanks: [], vouchers: [],
    isLoading: false, isSaving: false, errorMessage: '', formError: '',
    showForm: false,
    loaded: Promise.resolve(),
    db: svc,
    cdr: { detectChanges: () => {} },
    emptyForm:            loadFrom(PV_SRC, 'emptyForm', 'private '),
    openForm:             loadFrom(PV_SRC, 'openForm'),
    onSupplierChange:     loadFrom(PV_SRC, 'onSupplierChange'),
    openFormForSupplier:  loadFrom(PV_SRC, 'openFormForSupplier', 'private async ')
  }
  screen.form = screen.emptyForm()
  Object.defineProperty(screen, 'selectedSupplier',
    { get: loadGetter(PV_SRC, 'selectedSupplier'), configurable: true })
  Object.defineProperty(screen, 'selectedPayable',
    { get: loadGetter(PV_SRC, 'selectedPayable'), configurable: true })
  return screen
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const check = (label, actual, expected) => {
  const ok = Math.abs(Number(actual) - Number(expected)) < 0.005
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

const one = (sql, params = []) => Number(rows(sql, params)[0].v)

/** THE canonical payable. Every figure on this screen is measured against it. */
const payableOf = (supplierId) => one(
  `SELECT COALESCE(SUM(COALESCE(credit,0) - COALESCE(debit,0)), 0) v
   FROM supplier_ledger WHERE supplier_id = ?`, [supplierId])

const PO_SELECT = liftSql(SA_SRC, 'SELECT po.purchase_id, po.date, po.quantity')
const LAST_TXN_SELECT = liftSql(SA_SRC, 'MAX(l.transaction_date) AS last_transaction_date')
const SUPPLIER_SELECT = liftSql(SA_SRC, 'SELECT * FROM suppliers WHERE supplier_id = ? AND farm_id = ?')
const PV_INSERT = liftSql(PV_SRC, 'INSERT INTO payment_vouchers')

const SELECTS = [
  { what: 'the cards: last transaction date per supplier', sql: LAST_TXN_SELECT, params: [1] },
  { what: 'the drilldown: this supplier\'s purchase orders', sql: PO_SELECT, params: [1, 2] },
  { what: 'the drilldown: the supplier row itself', sql: SUPPLIER_SELECT, params: [1, 2] }
]

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  // ── A. SCREEN SQL ────────────────────────────────────────────────────────
  console.log('=== A. the screen\'s own statements, on the real schema, parameters in order ===')

  for (const st of SELECTS) {
    let threw = null
    try { rows(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes`, threw === null)
    if (threw) console.log(`        ${threw}`)
    check(`${st.what} placeholder count matches its parameter list`,
      (st.sql.match(/\?/g) || []).length, st.params.length)
  }

  // The whole screen, on an empty database — the state a fresh account sees.
  const empty = makeScreen()
  await empty.loadSuppliers()
  checkStr('an empty account loads with no error', empty.errorMessage, '')
  check('  and no cards', empty.filteredSuppliers.length, 0)
  check('  with every list total at zero',
    empty.getTotalPurchased() + empty.getTotalPaid() + empty.getTotalPayable(), 0)

  // ── Fixture ──────────────────────────────────────────────────────────────
  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'), (2,'Other','x')`)
  db.run(`INSERT INTO suppliers (supplier_id, farm_id, supplier_name, phone, products_supplied)
          VALUES (1,1,'Agri Supplies','0300','Feed'),
                 (2,1,'Feed Mill','0301','Feed, Medicine'),
                 (3,1,'Quiet Trader','0302','Nothing yet'),
                 (4,2,'Other Farm Supplier','0303','Feed')`)
  db.run(`INSERT INTO products (product_id, farm_id, product_name, cost_price, selling_price)
          VALUES (1,1,'Feed Bag',2000,2400), (2,1,'Vaccine',500,700)`)

  await call('addBankAccount', { farm_id: 1, bank_name: 'House Main', account_number: 'H-1', opening_balance: 900000 })
  await call('addBankAccount', { farm_id: 1, bank_name: 'House Second', account_number: 'H-2', opening_balance: 400000 })
  const HOUSE_A = rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'House Main'`)[0].bank_id
  const HOUSE_B = rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'House Second'`)[0].bank_id

  /** A purchase order and its ledger mirror, as purchase-orders.component does. */
  async function purchaseOrder(supplierId, { productId = 1, quantity = 1, cost, paid = false,
    bankId = null, date = '2025-06-02', farmId = FARM } = {}) {
    const amount = quantity * cost
    const res = await svc.run(
      `INSERT INTO purchase_orders (farm_id, supplier_id, product_id, date, quantity,
        cost_price, total_amount, payment_type, payment_source, bank_id, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [farmId, supplierId, productId, date, quantity, cost, amount,
       paid ? 'cash' : 'credit', paid && bankId ? 'bank' : 'cash', paid ? bankId : null, null])
    if (!res.success) throw new Error('purchase order insert failed: ' + res.error)
    await call('addSupplierLedgerEntry', {
      supplier_id: supplierId, transaction_date: date,
      description: `Purchase Order #${res.lastId}`,
      debit: paid ? amount : 0, credit: amount,
      reference_type: 'purchase', reference_id: res.lastId
    })
    return { purchaseId: res.lastId, amount }
  }

  async function purchaseReturn(supplierId, purchaseId, amount, { date = '2025-06-03' } = {}) {
    await call('addSupplierLedgerEntry', {
      supplier_id: supplierId, transaction_date: date,
      description: `Return PRET-001 - Purchase #${purchaseId}`,
      debit: amount, credit: 0, reference_type: 'return', reference_id: purchaseId
    })
  }

  async function manualPayment(supplierId, amount, { date = '2025-06-04' } = {}) {
    await call('addSupplierLedgerEntry', {
      supplier_id: supplierId, transaction_date: date,
      description: 'Payment made', debit: amount, reference_type: 'payment'
    })
  }

  let pvSeq = 0
  async function paymentVoucher(supplierId, amount, { bankId = null, date = '2025-06-06' } = {}) {
    const number = 'PV-' + String(++pvSeq).padStart(3, '0')
    const source = bankId ? 'bank' : 'cash'
    const res = await call('savePaymentVoucher', {
      sql: PV_INSERT,
      params: [FARM, supplierId, number, date, amount, source, bankId, null, null]
    }, {
      supplier_id: supplierId, amount, date,
      description: `Payment Voucher ${number}`,
      bank_description: `Payment Voucher ${number} — Supplier`,
      payment_source: source, bank_id: bankId
    })
    if (!res.success) throw new Error('payment voucher failed: ' + res.error)
  }

  // Supplier 1: every row shape at once — an unpaid order, a bank-paid order,
  // a return against the unpaid one, a cash manual payment and a bank voucher.
  const s1credit = await purchaseOrder(1, { quantity: 6, cost: 2000 })            // 12,000 credit
  await purchaseOrder(1, { quantity: 2, cost: 2500, paid: true, bankId: HOUSE_A }) //  5,000 cash-at-source
  await purchaseReturn(1, s1credit.purchaseId, 2000)
  await manualPayment(1, 3000)
  await paymentVoucher(1, 4000, { bankId: HOUSE_B })

  // Supplier 2: a single unpaid order, nothing paid.
  await purchaseOrder(2, { productId: 2, quantity: 10, cost: 500, date: '2025-06-07' })

  // Supplier 3: no history at all — the card must still render.
  // Farm 2's supplier 4: must never appear in farm 1's screen.
  await purchaseOrder(4, { quantity: 1, cost: 777777, farmId: 2, date: '2025-06-09' })
  await manualPayment(4, 111111, { date: '2025-06-10' })

  // ── B. THE CARDS ─────────────────────────────────────────────────────────
  console.log('\n=== B. every card figure equals the SQL behind it ===')

  const screen = makeScreen()
  await screen.loadSuppliers()
  const sqlRows = (await call('getAllSuppliersWithBalance', FARM)).data || []

  check('one card per supplier of this farm', screen.filteredSuppliers.length, 3)
  check('  and the card list is the SQL list', screen.suppliers.length, sqlRows.length)

  for (const card of screen.filteredSuppliers) {
    const sql = sqlRows.find(r => Number(r.supplier_id) === Number(card.supplier_id))
    const name = card.supplier_name
    checkTrue(`${name}: the card IS the SQL row`, card === sql || !!sql)
    check(`${name}: card purchased == SQL`, Number(card.total_purchased), Number(sql.total_purchased))
    check(`${name}: card paid == SQL`, Number(card.total_paid), Number(sql.total_paid))
    check(`${name}: card payable == SQL`,
      Number(card.outstanding_balance), Number(sql.outstanding_balance))
    check(`${name}: card payable == SUM(credit - debit)`,
      Number(card.outstanding_balance), payableOf(card.supplier_id))
    check(`${name}: last transaction date == MAX(transaction_date)`,
      Date.parse(card.last_transaction_date || '1970-01-01'),
      Date.parse(one(`SELECT COUNT(*) v FROM supplier_ledger WHERE supplier_id = ?`,
        [card.supplier_id]) === 0
        ? '1970-01-01'
        : rows(`SELECT MAX(transaction_date) d FROM supplier_ledger WHERE supplier_id = ?`,
            [card.supplier_id])[0].d))
    check(`${name}: transaction count == its ledger rows`,
      Number(card.transaction_count),
      one(`SELECT COUNT(*) v FROM supplier_ledger WHERE supplier_id = ?`, [card.supplier_id]))
  }

  // A supplier with no history is on screen, with no date rather than a wrong one.
  const quiet = screen.filteredSuppliers.find(s => Number(s.supplier_id) === 3)
  checkTrue('a supplier with no history still gets a card', !!quiet)
  checkTrue('  with no last transaction date', !quiet.last_transaction_date)
  check('  and nothing owed', Number(quiet.outstanding_balance), 0)

  // The list totals are sums of the cards shown, never a second query.
  check('list total purchased == sum of the cards',
    screen.getTotalPurchased(), sqlRows.reduce((s, r) => s + Number(r.total_purchased || 0), 0))
  check('list total paid == sum of the cards',
    screen.getTotalPaid(), sqlRows.reduce((s, r) => s + Number(r.total_paid || 0), 0))
  check('list total payable == sum of the cards',
    screen.getTotalPayable(), sqlRows.reduce((s, r) => s + Number(r.outstanding_balance || 0), 0))
  check('  and == the ledger itself', screen.getTotalPayable(),
    payableOf(1) + payableOf(2) + payableOf(3))

  // The search narrows the cards AND the totals with them.
  screen.searchTerm = 'Feed Mill'
  screen.applyFilter()
  check('a search narrows the cards', screen.filteredSuppliers.length, 1)
  check('  and the totals narrow with them', screen.getTotalPayable(), payableOf(2))
  screen.clearSearch()
  check('clearing the search restores every card', screen.filteredSuppliers.length, 3)

  // ── C. THE SAME STATEMENT AS SUPPLIER LEDGER ─────────────────────────────
  console.log('\n=== C. the drilldown and the Supplier Ledger screen are one read ===')

  for (const supplierId of [1, 2, 3]) {
    const accounts = makeScreen()
    await accounts.loadSupplierDetail(supplierId)
    const ledger = makeLedgerScreen()
    await ledger.loadSupplierDetail(supplierId)
    const name = accounts.selectedSupplier.supplier_name

    check(`${name}: same number of statement rows`,
      accounts.ledgerEntries.length, ledger.ledgerEntries.length)
    checkTrue(`${name}: same rows in the same order`,
      accounts.ledgerEntries.every((e, i) =>
        Number(e.ledger_id) === Number(ledger.ledgerEntries[i].ledger_id)))
    checkTrue(`${name}: the same RUNNING BALANCE on every row`,
      accounts.ledgerEntries.every((e, i) =>
        Math.abs(Number(e.balance) - Number(ledger.ledgerEntries[i].balance)) < 0.005))
    checkTrue(`${name}: the same account named on every row`,
      accounts.ledgerEntries.every((e, i) =>
        accounts.accountLabel(e) === paymentSourceLabel(ledger.ledgerEntries[i])))
    check(`${name}: the closing balance agrees`,
      accounts.getSupplierBalance(), ledger.getSupplierBalance())
    check(`${name}: and both equal SUM(credit - debit)`,
      accounts.getSupplierBalance(), payableOf(supplierId))

    // The summary line == the card for the same supplier.
    const card = sqlRows.find(r => Number(r.supplier_id) === supplierId)
    check(`${name}: summary purchased == card`, accounts.totals.purchased, Number(card.total_purchased))
    check(`${name}: summary paid == card`, accounts.totals.paid, Number(card.total_paid))
    check(`${name}: summary returned == card`, accounts.totals.returned, Number(card.total_returned))
    check(`${name}: summary other charges == card`, accounts.totals.otherCharges, Number(card.other_charges))
    check(`${name}: summary payable == card`, accounts.totals.outstanding, Number(card.outstanding_balance))

    // ── F. THE RECONCILIATION, on the screen's own numbers ────────────────
    const t = accounts.totals
    check(`${name}: purchased + other - paid - returned == payable`,
      t.purchased + t.otherCharges - t.paid - t.returned, payableOf(supplierId))
  }

  // ── D. PURCHASES ─────────────────────────────────────────────────────────
  console.log('\n=== D. the purchases list is exactly this supplier\'s orders ===')

  const d1 = makeScreen()
  await d1.loadSupplierDetail(1)
  check('supplier 1 lists both of its orders', d1.purchases.length, 2)
  check('  and nothing belonging to anyone else',
    d1.purchases.filter(p =>
      one(`SELECT supplier_id v FROM purchase_orders WHERE purchase_id = ?`, [p.purchase_id]) !== 1
    ).length, 0)
  check('  the list total == SUM(total_amount)',
    d1.getPurchaseOrderTotal(),
    one(`SELECT COALESCE(SUM(total_amount),0) v FROM purchase_orders
         WHERE farm_id = ? AND supplier_id = 1`, [FARM]))
  check('  which is also what was purchased on the ledger',
    d1.getPurchaseOrderTotal(), d1.totals.purchased)
  checkTrue('  newest order first',
    d1.purchases.every((p, i) => i === 0 ||
      Date.parse(d1.purchases[i - 1].date) >= Date.parse(p.date)))
  checkTrue('  every row names its product', d1.purchases.every(p => !!p.product_name))

  const creditOrder = d1.purchases.find(p => Number(p.purchase_id) === s1credit.purchaseId)
  const paidOrder = d1.purchases.find(p => Number(p.purchase_id) !== s1credit.purchaseId)
  checkTrue('an unpaid order reads as Credit, not as an account',
    !d1.isPaidOrder(creditOrder))
  checkTrue('a paid order reads as the account it was paid from',
    d1.isPaidOrder(paidOrder))
  checkStr('  naming that account', d1.accountLabel(paidOrder), 'Bank · House Main')

  const d3 = makeScreen()
  await d3.loadSupplierDetail(3)
  check('a supplier with no orders has an empty purchases list', d3.purchases.length, 0)
  check('  and a zero total', d3.getPurchaseOrderTotal(), 0)

  // ── E. PAYMENTS AND THE ACCOUNT BREAKDOWN ────────────────────────────────
  console.log('\n=== E. the payments list and the account breakdown tie to total_paid ===')

  const card1 = sqlRows.find(r => Number(r.supplier_id) === 1)
  check('the payments list holds every money-out row',
    d1.paymentHistory.length, d1.ledgerEntries.filter(e => isSupplierPayment(e)).length)
  check('  and no return', d1.paymentHistory.filter(e => supplierRowKind(e) === 'return').length, 0)
  check('  its total == total_paid', d1.getPaymentsTotal(), Number(card1.total_paid))
  check('  == the summary line', d1.getPaymentsTotal(), d1.totals.paid)
  checkTrue('  newest first', d1.paymentHistory.every((e, i) =>
    i === 0 || Number(d1.paymentHistory[i - 1].ledger_id) >= Number(e.ledger_id)))
  checkTrue('  and every row names an account',
    d1.paymentHistory.every(e => !!d1.accountLabel(e)))

  // The three payments supplier 1 made came from three different places, and
  // the breakdown must say so rather than lumping them together.
  const accountTotals = {}
  for (const a of d1.paymentsByAccount) accountTotals[d1.accountLabel(a)] = Number(a.total_paid)
  check('the breakdown splits by account', d1.paymentsByAccount.length, 3)
  check('  the cash-at-source order is on House Main', accountTotals['Bank · House Main'], 5000)
  check('  the voucher is on House Second', accountTotals['Bank · House Second'], 4000)
  check('  the manual payment is Cash', accountTotals['Cash'], 3000)
  check('  and the breakdown sums to total_paid',
    d1.paymentsByAccount.reduce((s, a) => s + Number(a.total_paid || 0), 0),
    Number(card1.total_paid))
  check('  with a payment count matching the rows',
    d1.paymentsByAccount.reduce((s, a) => s + Number(a.payment_count || 0), 0),
    d1.paymentHistory.length)

  const d2 = makeScreen()
  await d2.loadSupplierDetail(2)
  check('a supplier paid nothing has an empty breakdown', d2.paymentsByAccount.length, 0)
  check('  and nothing in the payments list', d2.paymentHistory.length, 0)
  check('  while still owing the whole order', d2.getSupplierBalance(), 5000)

  // ── G. RECORD PAYMENT ────────────────────────────────────────────────────
  console.log('\n=== G. Record Payment hands off to the Payment Voucher, prefilled ===')

  const hand = makeScreen()
  await hand.loadSupplierDetail(1)
  hand.recordPayment()
  check('Record Payment navigates once', hand.navigations.length, 1)
  const nav = hand.navigations[0]
  checkStr('  to the Payment Voucher screen', nav.commands.join('/'), '/app/payment-voucher')
  check('  carrying THIS supplier\'s id', Number(nav.extras.queryParams.supplierId), 1)
  checkTrue('  with a nonce, so a repeat click re-opens the form',
    Number(nav.extras.queryParams.t) > 0)

  // The drilldown still offers the statement screen, which must not have been
  // replaced by this one.
  hand.navigations.length = 0
  hand.viewStatement()
  checkStr('"Supplier Ledger" still goes to the statement screen',
    hand.navigations[0].commands.join('/'), '/app/supplier-ledger/1')
  hand.navigations.length = 0
  hand.selectSupplier({ supplier_id: 2 })
  checkStr('a card opens the drilldown on that supplier',
    hand.navigations[0].commands.join('/'), '/app/supplier-accounts/2')
  hand.navigations.length = 0
  hand.goBack()
  checkStr('Back returns to the card list',
    hand.navigations[0].commands.join('/'), '/app/supplier-accounts')

  // And the other end of the hand-off: the voucher screen's own handler.
  const voucher = makeVoucherScreen()
  voucher.suppliers = (await call('getAllSuppliersWithBalance', FARM)).data || []
  await voucher.openFormForSupplier(Number(nav.extras.queryParams.supplierId))
  checkTrue('the voucher form opens on arrival', voucher.showForm === true)
  check('  with the handed-off supplier selected', Number(voucher.form.supplier_id), 1)
  checkStr('  which is the supplier the drilldown was on',
    voucher.selectedSupplier.supplier_name, 'Agri Supplies')
  check('  and the amount prefilled to their payable',
    Number(voucher.form.amount), payableOf(1))
  check('  == what the drilldown showed', Number(voucher.form.amount), hand.getSupplierBalance())

  // A supplier that is not this farm's must not be selected — the id is the
  // thing a stale link carries, and the save would refuse it anyway.
  const foreign = makeVoucherScreen()
  foreign.suppliers = (await call('getAllSuppliersWithBalance', FARM)).data || []
  await foreign.openFormForSupplier(4)
  checkTrue('another farm\'s supplier id opens no form', foreign.showForm === false)
  checkTrue('  and selects nobody', !foreign.form.supplier_id)

  // A supplier with nothing owing prefills zero rather than a stale figure.
  const settled = makeVoucherScreen()
  settled.suppliers = (await call('getAllSuppliersWithBalance', FARM)).data || []
  await settled.openFormForSupplier(3)
  checkTrue('a supplier owing nothing still opens the form', settled.showForm === true)
  checkTrue('  with no amount forced on the user', !settled.form.amount)

  // ── H. FARM SCOPING ──────────────────────────────────────────────────────
  console.log('\n=== H. the other farm is invisible, ids colliding or not ===')

  checkTrue('farm 1\'s cards do not include farm 2\'s supplier',
    !screen.suppliers.some(s => Number(s.supplier_id) === 4))
  check('no farm-1 figure contains the other farm\'s purchase',
    screen.suppliers.filter(s => Number(s.total_purchased) === 777777).length, 0)

  const foreignDetail = makeScreen()
  await foreignDetail.loadSupplierDetail(4)
  checkTrue('the drilldown refuses another farm\'s supplier id',
    foreignDetail.selectedSupplier === null)
  checkStr('  and says so', foreignDetail.errorMessage, 'Supplier not found')
  check('  loading nothing', foreignDetail.ledgerEntries.length + foreignDetail.purchases.length, 0)

  const farm2 = makeScreen(2)
  await farm2.loadSuppliers()
  check('farm 2 sees exactly its own one supplier', farm2.filteredSuppliers.length, 1)
  check('  with its own purchased', farm2.getTotalPurchased(), 777777)
  check('  its own paid', farm2.getTotalPaid(), 111111)
  check('  and its own payable', farm2.getTotalPayable(), 666666)

  const farm2Detail = makeScreen(2)
  await farm2Detail.loadSupplierDetail(4)
  check('farm 2\'s drilldown reads its own statement', farm2Detail.ledgerEntries.length, 2)
  check('  its own purchases', farm2Detail.purchases.length, 1)
  check('  and reconciles', farm2Detail.totals.purchased - farm2Detail.totals.paid
    - farm2Detail.totals.returned, payableOf(4))

  // ── I. A READ-ONLY SCREEN ────────────────────────────────────────────────
  console.log('\n=== I. the screen writes nothing, and nothing claims to store the payable ===')

  checkTrue('the component contains no INSERT / UPDATE / DELETE',
    !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(SA_SRC))
  checkTrue('  and calls no write method on the service',
    !/this\.db\.(run|runBatch|transaction)\b/.test(SA_SRC))
  checkTrue('suppliers still has NO outstanding_balance column',
    !rows(`SELECT name FROM pragma_table_info('suppliers')`)
      .some(c => /outstanding|payable|owed|balance/i.test(c.name)))
  checkTrue('the payable on the cards is read, not stored',
    /getAllSuppliersWithBalance/.test(SA_SRC) &&
    !/outstanding_balance\s*=/.test(SA_SRC))

  // The Supplier Ledger screen is still there, and still routed.
  checkTrue('Supplier Ledger still exists as its own component',
    fs.existsSync(path.join(ROOT, 'src', 'app', 'account-ledger', 'supplier-ledger',
      'supplier-ledger.component.ts')))
  checkTrue('  and is still routed on both of its paths',
    /path: 'supplier-ledger'/.test(ROUTES_SRC) && /path: 'supplier-ledger\/:id'/.test(ROUTES_SRC))
  checkTrue('  and still owns a payment form of its own',
    /submitPayment\(/.test(SL_SRC))
  checkTrue('the new screen is routed on both of its paths',
    /path: 'supplier-accounts'/.test(ROUTES_SRC) && /path: 'supplier-accounts\/:id'/.test(ROUTES_SRC))
  checkTrue('  with no resolver on either',
    !/supplier-accounts[\s\S]{0,320}?resolve:/.test(ROUTES_SRC))
  checkTrue('  and reachable from the Distribution sidebar',
    /route: 'supplier-accounts'/.test(LAYOUT_SRC))

  // ── J. THE TEMPLATE'S CELL COUNTS ────────────────────────────────────────
  //
  // No other verify script in this repo reads an .html file. A column added to
  // the <thead> without a matching <td> in every mutually exclusive row branch
  // is invisible to every tool here and immediately obvious to the user — see
  // the cell-count landmine in CLAUDE.md.
  console.log('\n=== J. every row branch totals the header, per table ===')

  const tables = SA_HTML.match(/<table[\s\S]*?<\/table>/g) || []
  check('the template has the four tables this screen describes', tables.length, 4)
  tables.forEach((table, n) => {
    const headRow = (table.match(/<thead[\s\S]*?<\/thead>/) || [''])[0]
    const headCount = (headRow.match(/<th\b/g) || []).length
    const bodyAndFoot = table.replace(/<thead[\s\S]*?<\/thead>/, '')
    const bodyRows = bodyAndFoot.match(/<tr\b[\s\S]*?<\/tr>/g) || []
    checkTrue(`table ${n + 1} has a header`, headCount > 0)
    bodyRows.forEach((row, r) => {
      let cells = 0
      for (const cell of row.match(/<td\b[^>]*>/g) || []) {
        const span = /colspan\s*=\s*"(\d+)"/i.exec(cell)
        cells += span ? Number(span[1]) : 1
      }
      check(`table ${n + 1}, row branch ${r + 1}: cells == ${headCount} header columns`,
        cells, headCount)
    })
  })

  // ── The end state ────────────────────────────────────────────────────────
  console.log('\n=== the end state ===')

  // This screen is read-only, so nothing it did may have moved a figure.
  check('every supplier still reconciles',
    [1, 2, 3, 4].filter(id => {
      const row = rows(`SELECT
          (SELECT COALESCE(SUM(COALESCE(l.credit,0)),0) FROM supplier_ledger l
            WHERE l.supplier_id = ? AND COALESCE(l.reference_type,'') = 'purchase') p,
          (SELECT COALESCE(SUM(COALESCE(l.credit,0)),0) FROM supplier_ledger l
            WHERE l.supplier_id = ? AND COALESCE(l.reference_type,'') <> 'purchase') o,
          (SELECT COALESCE(SUM(COALESCE(l.debit,0)),0) FROM supplier_ledger l
            WHERE l.supplier_id = ? AND COALESCE(l.reference_type,'') <> 'return') d,
          (SELECT COALESCE(SUM(COALESCE(l.debit,0)),0) FROM supplier_ledger l
            WHERE l.supplier_id = ? AND COALESCE(l.reference_type,'') = 'return') r`,
        [id, id, id, id])[0]
      return Math.abs(row.p + row.o - row.d - row.r - payableOf(id)) > 0.005
    }).length, 0)
  check('no orphaned ledger rows',
    one(`SELECT COUNT(*) v FROM supplier_ledger l
         WHERE NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.supplier_id = l.supplier_id)`), 0)
  check('every bank account\'s cached balance still equals its own ledger',
    one(`SELECT COUNT(*) v FROM bank_accounts ba
         WHERE COALESCE(ba.current_balance,0) <> (
           SELECT COALESCE(SUM(COALESCE(bl.debit,0) - COALESCE(bl.credit,0)),0)
           FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)`), 0)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
