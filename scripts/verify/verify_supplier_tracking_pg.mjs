// [Codex] PostgreSQL port of verify_supplier_tracking.js.
// Application method bodies come from src/, not the frozen desktop tree.
// Original fixture values and assertions are retained; SQL helpers now await
// the real server query layer. Scratch schemas are removed even on failure.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
const runBatch = (ops) => db.batch(ops)
async function runSql(sql, params = []) {
  const result = await db.run(sql, params)
  if (!result.success) throw new Error(result.error)
  return result
}

// Supplier payment tracking: what was purchased, what was paid, what is still
// owed, and WHICH ACCOUNT each payment came out of.
//
// THE ONE THING THIS FILE EXISTS TO PROTECT: the supplier payable is DERIVED,
// `SUM(credit - debit)` over `supplier_ledger`, and is stored nowhere. There is
// no `suppliers.outstanding_balance`, no cached column, no trigger. A stored
// balance drifts from the rows behind it — the customer side has to rebuild its
// cached column by hand on every single path for exactly that reason — and the
// supplier side has nothing to keep in step, which is the feature. Section A
// asserts that no column anywhere claims to be this figure, so a "performance"
// column cannot be added quietly.
//
// Everything here runs REAL source against a real PostgreSQL database: the schema
// from createTables/alterStatements, the atomic writer from runBatch(), the
// service's own read and write methods lifted out of database.service.ts, the
// screens' SQL lifted out of their components as text, and the classification
// helpers lifted out of supplier-ledger.util.ts. Nothing is a restatement, so
// the paths under test are the ones the app runs.
//
// What is proved:
//   A. DERIVED, NOT STORED — the payable equals SUM(credit - debit) through
//      every door (getSupplierPayable, getAllSuppliersWithBalance, the ledger
//      screen's own rows), and NO column in the schema claims to be it.
//   B. THE RECONCILIATION IDENTITY, asserted as arithmetic after every single
//      mutation:
//          purchased + other_charges - paid - returned == SUM(credit - debit)
//      The right-hand side is summed independently off credit/debit, so this is
//      a real check of the buckets against the payable and not a tautology.
//   C. SQL == COMPONENT. The per-supplier figures from
//      `getAllSuppliersWithBalance()` equal the figures `supplierTotals()`
//      computes from the rows on screen. Two code paths reach these numbers and
//      this codebase has been bitten by a screen and its resolver disagreeing.
//   D. THE ACCOUNT on every row: a payment voucher's line reports the account
//      the VOUCHER named; a cash-paid purchase order's debit reports the
//      ORDER's account; an unpaid order and a manual payment report Cash.
//   E. THE RETURN TRAP, twice over. A purchase return carries a purchase_id in
//      `reference_id`, so (1) it must not borrow that order's bank account, and
//      (2) it must not be counted as money paid.
//   F. A payment voucher reduces the payable by exactly its amount; deleting it
//      restores the payable exactly, and takes the account attribution with it.
//   G. REFUSALS still hold: a reference_type='purchase' row and a voucher-tagged
//      row are both refused by deleteSupplierLedgerEntry(), and a refusal writes
//      nothing.
//   H. FARM SCOPING: a second farm's supplier never appears in farm 1's summary
//      or its by-account roll-up, including when the ids collide.
//   I. SCREEN SQL: every new read runs against the real schema with a distinct
//      sentinel per parameter position — TypeScript cannot see a placeholder
//      count or a parameter ORDER that stopped matching the column list.
//   J. THE SCREENS' OWN GETTERS, lifted and run: the Supplier Ledger list and
//      detail views and the Distribution report's section each equal the SQL.
//      Section C tests the util; this tests that the screens still call it,
//      which is the part that can rot without anything failing to compile.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const UTIL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'supplier-ledger.util.ts'), 'utf8')
const SL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'account-ledger', 'supplier-ledger', 'supplier-ledger.component.ts'), 'utf8')
const PV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'payment-voucher', 'payment-voucher.component.ts'), 'utf8')
const PO_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'purchase-orders', 'purchase-orders.component.ts'), 'utf8')
const DIST_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'distribution-report', 'distribution-report.component.ts'), 'utf8')

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

/** An exported top-level function out of a util module. */
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
// PostgreSQL engine supplied by the scratch harness.


// Read off the real declaration rather than restated.
const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()
const DatabaseService = { BANK_SOURCES }

async function rows(sql, params = []) {
  const result = await db.get(sql, params)
  if (!result.success) throw new Error(result.error)
  return result.data
}

// ── The util under test ─────────────────────────────────────────────────────
//
// The classification the screens use, lifted rather than restated: if a bucket
// predicate changes on one side only, these comparisons break.

// `num` is module-private in the util and every helper closes over it. Lifted
// from its own source line rather than restated, so a change to how a blank or
// a string amount is coerced is a change on both sides at once.
const NUM_AT = UTIL_SRC.indexOf('const num =')
const NUM_SRC = UTIL_SRC.slice(NUM_AT, UTIL_SRC.indexOf('\n', NUM_AT))
const num = eval('(' + ts.transpileModule(
  NUM_SRC.replace(/^const num =/, '').replace(/;\s*$/, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }
).outputText.trim().replace(/;$/, '') + ')')
global.num = num
const numLifted = typeof num === 'function' && num('3') === 3 && num(null) === 0

// ── The screens' own getters ────────────────────────────────────────────────
//
// Lifted rather than approximated, so this file proves the SCREENS agree with
// the SQL, not merely that the util they are supposed to call does. A getter
// that stopped calling `supplierTotals()` and started adding up `debit` itself
// would pass every check in this file if the util alone were tested.

/** `get totals()` on the Supplier Ledger detail view. */
const screenTotals = loadGetter(SL_SRC, 'totals')
/** `get paymentHistory()` — the money-out rows the history table lists. */
const screenPaymentHistory = loadGetter(SL_SRC, 'paymentHistory')
/** The list view's column sums. */
const screenTotalPurchased = loadFrom(SL_SRC, 'getTotalPurchased')
const screenTotalPaid = loadFrom(SL_SRC, 'getTotalPaid')
const screenTotalPayable = loadFrom(SL_SRC, 'getTotalPayable')
/** And the distribution report's section totals. */
const reportActiveSuppliers = loadGetter(DIST_SRC, 'activeSuppliers')
const reportSupplierPurchased = loadGetter(DIST_SRC, 'totalSupplierPurchased')
const reportSupplierPaid = loadGetter(DIST_SRC, 'totalSupplierPaid')
const reportSupplierReturned = loadGetter(DIST_SRC, 'totalSupplierReturned')
const reportSupplierPayable = loadGetter(DIST_SRC, 'totalSupplierPayable')

const supplierRowKind = loadUtil('supplierRowKind')
const purchasedOf = loadUtil('purchasedOf')
const otherChargeOf = loadUtil('otherChargeOf')
const paidOf = loadUtil('paidOf')
const returnedOf = loadUtil('returnedOf')
const isSupplierPayment = loadUtil('isSupplierPayment')
const supplierTotals = loadUtil('supplierTotals')
const supplierRowLabel = loadUtil('supplierRowLabel')
global.supplierRowKind = supplierRowKind
global.purchasedOf = purchasedOf
global.otherChargeOf = otherChargeOf
global.paidOf = paidOf
global.returnedOf = returnedOf
global.isSupplierPayment = isSupplierPayment
global.supplierTotals = supplierTotals
global.supplierRowLabel = supplierRowLabel

// `paymentSourceLabel()` from bank-source.util.ts — the ONLY way a row's
// account may be rendered. A `cash ? : 'Credit'` test is what this replaced.
const BANK_UTIL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bank-source.util.ts'), 'utf8')
const bankNameOf = loadFrom(BANK_UTIL_SRC, 'bankNameOf', 'export function ')
global.bankNameOf = bankNameOf
const paymentSourceLabel = loadFrom(BANK_UTIL_SRC, 'paymentSourceLabel', 'export function ')

// `filterByDateRange()` from date-range.util.ts, which the screen's
// `visibleEntries` getter calls. The From/To filter narrows the LISTED rows
// only — `totals` and the payable are still read over the full history — and
// `paymentHistory` now reads `visibleEntries`, so a context built for it has
// to carry the real getter rather than a stand-in. Lifted, not restated: a
// filter that stopped admitting an unfiltered row would otherwise pass here
// and hide rows on the screen.
const RANGE_UTIL_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'date-range.util.ts'), 'utf8')
const dayOf = loadFrom(RANGE_UTIL_SRC, 'dayOf', 'export function ')
global.dayOf = dayOf
const inDateRange = loadFrom(RANGE_UTIL_SRC, 'inDateRange', 'export function ')
global.inDateRange = inDateRange
// Generic, so the name carries its type parameter here — the idiom
// `transaction<T>` already uses elsewhere.
const filterByDateRange = loadFrom(RANGE_UTIL_SRC, 'filterByDateRange<T>', 'export function ')
const screenVisibleEntries = loadGetter(SL_SRC, 'visibleEntries')

/**
 * A Supplier Ledger detail context over `rows`, with the real `visibleEntries`
 * getter on it, so a lifted getter that reads it behaves as it does on screen.
 * `from`/`to` default to unfiltered, which is the state every assertion in
 * this file is written against.
 */
function supplierLedgerContext(rows, from = '', to = '') {
  const ctx = { ledgerEntries: rows, dateFrom: from, dateTo: to }
  Object.defineProperty(ctx, 'visibleEntries', { get: screenVisibleEntries })
  return ctx
}

// ── The service under test ──────────────────────────────────────────────────

const svc = {
  toLocalDateString: () => '2025-06-01',
  async get(sql, params = []) { return db.get(sql, params) },
  async run(sql, params = []) { return db.run(sql, params) },
  async runBatch(ops) { return db.batch(ops) },

  // The bank mechanism the payment voucher rides on.
  bankBalanceSql:            loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql:  loadMethod('nextTransactionNumberSql', 'private '),
  rebuildBankBalanceOp:      loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:              loadMethod('bankEntryOps', 'private '),
  bankReversalOps:           loadMethod('bankReversalOps', 'private '),
  bankSource:                loadMethod('bankSource', 'private '),
  bankIdOf:                  loadMethod('bankIdOf', 'private '),
  bankSourceExisting:        loadMethod('bankSourceExisting', 'private async '),
  bankSourceInsertOps:       loadMethod('bankSourceInsertOps'),
  bankRebuildOps:            loadMethod('bankRebuildOps'),

  // The save-time balance guard. These scripts bind the real method bodies onto
  // this one object, so a new `this.` dependency has to be registered here or
  // the method under test throws instead of running.
  bankAmountText:            loadMethod('bankAmountText', 'private '),
  bankSourceDelta:           loadMethod('bankSourceDelta', 'private '),
  checkBankBalances:         loadMethod('checkBankBalances', 'async '),
  checkBankSourceInserts:    loadMethod('checkBankSourceInserts', 'async '),
  deleteBankSourced:         loadMethod('deleteBankSourced', 'async '),
  getBankAccounts:           loadMethod('getBankAccounts', 'async '),
  getHouseBankAccounts:      loadMethod('getHouseBankAccounts', 'async '),
  addBankAccount:            loadMethod('addBankAccount', 'async '),
  addBankLedgerEntry:        loadMethod('addBankLedgerEntry', 'async '),

  // The supplier side: the reads this change adds, and the writes they read.
  supplierLedgerEntryOp:      loadMethod('supplierLedgerEntryOp', 'private '),
  addSupplierLedgerEntry:     loadMethod('addSupplierLedgerEntry', 'async '),
  getSupplierPayable:         loadMethod('getSupplierPayable', 'async '),
  getAllSuppliersWithBalance: loadMethod('getAllSuppliersWithBalance', 'async '),
  getSupplierLedgerWithBalance: loadMethod('getSupplierLedgerWithBalance', 'async '),
  getSupplierPaymentsByAccount: loadMethod('getSupplierPaymentsByAccount', 'async '),
  deleteSupplierLedgerEntry:  loadMethod('deleteSupplierLedgerEntry', 'async '),
  savePaymentVoucher:         loadMethod('savePaymentVoucher', 'async '),
  deletePaymentVoucher:       loadMethod('deletePaymentVoucher', 'async ')
}
global.toLocalDateString = svc.toLocalDateString
const call = (name, ...args) => svc[name].apply(svc, args)

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

const one = async (sql, params = []) => Number((await rows(sql, params))[0].v)

/** THE canonical payable. Every other figure is measured against this one. */
const payableOf = async (supplierId) => (await one(
  `SELECT COALESCE(SUM(COALESCE(credit,0) - COALESCE(debit,0)), 0) v
   FROM supplier_ledger WHERE supplier_id = ?`, [supplierId]))

const FARM = 1

const summaryRow = async (supplierId, farmId = FARM) =>
  ((await call('getAllSuppliersWithBalance', farmId)).data || [])
    .find(s => Number(s.supplier_id) === Number(supplierId))

const ledgerRows = async (supplierId, farmId = FARM) =>
  (await call('getSupplierLedgerWithBalance', supplierId, farmId)).data || []

/**
 * THE SUPPLIER INVARIANT, asserted after every mutation.
 *
 * Three things at once, because they are three derivations of one number:
 *   - the four buckets reconcile to the payable (B);
 *   - every door onto the payable agrees — getSupplierPayable, the summary
 *     row's outstanding_balance, and the screen's own rows (A);
 *   - the SQL buckets equal what `supplierTotals()` computes from those rows,
 *     so the list view and the detail view cannot drift (C).
 */
async function invariant(label, supplierId, farmId = FARM) {
  const canonical = (await payableOf(supplierId))
  const row = await summaryRow(supplierId, farmId)
  const direct = Number((await call('getSupplierPayable', supplierId)).data[0].payable)
  const entries = await ledgerRows(supplierId, farmId)
  const fromRows = supplierTotals(entries)

  const sql = {
    purchased: Number(row.total_purchased) || 0,
    other: Number(row.other_charges) || 0,
    paid: Number(row.total_paid) || 0,
    returned: Number(row.total_returned) || 0,
    outstanding: Number(row.outstanding_balance) || 0
  }

  // B — the identity, as arithmetic.
  const reconciled = sql.purchased + sql.other - sql.paid - sql.returned
  const idOk = Math.abs(reconciled - canonical) < 0.005
  if (!idOk) failures++
  console.log(`  ${idOk ? 'PASS' : 'FAIL'}  IDENTITY after ${label}: ` +
    `purchased ${sql.purchased} + other ${sql.other} - paid ${sql.paid} - returned ${sql.returned} ` +
    `= ${reconciled}, SUM(credit-debit) = ${canonical}`)

  // A — every door onto the payable agrees with the rows.
  const doorsOk = sql.outstanding === canonical && direct === canonical &&
                  Math.abs(fromRows.outstanding - canonical) < 0.005
  if (!doorsOk) failures++
  console.log(`  ${doorsOk ? 'PASS' : 'FAIL'}  DERIVED after ${label}: ` +
    `list=${sql.outstanding} getSupplierPayable=${direct} screen rows=${fromRows.outstanding} ` +
    `canonical=${canonical}`)

  // C — SQL buckets == the component's own arithmetic over the same rows.
  const sameOk = Math.abs(fromRows.purchased - sql.purchased) < 0.005 &&
                 Math.abs(fromRows.otherCharges - sql.other) < 0.005 &&
                 Math.abs(fromRows.paid - sql.paid) < 0.005 &&
                 Math.abs(fromRows.returned - sql.returned) < 0.005
  if (!sameOk) failures++
  console.log(`  ${sameOk ? 'PASS' : 'FAIL'}  SQL == COMPONENT after ${label}: ` +
    `sql(${sql.purchased}/${sql.other}/${sql.paid}/${sql.returned}) vs ` +
    `util(${fromRows.purchased}/${fromRows.otherCharges}/${fromRows.paid}/${fromRows.returned})`)

  return canonical
}

/** The account a row reports, exactly as the screens render it. */
const accountOn = (entries, ledgerId) => {
  const row = entries.find(e => Number(e.ledger_id) === Number(ledgerId))
  if (!row) return '(missing)'
  return isSupplierPayment(row) ? paymentSourceLabel(row) : '—'
}

// ── The screens' own statements, with a sentinel per parameter ──────────────

const PV_INSERT = liftSql(PV_SRC, 'INSERT INTO payment_vouchers')
const PO_INSERT = liftSql(PO_SRC, 'INSERT INTO purchase_orders (farm_id, supplier_id, product_id')

const SELECTS = [
  { what: 'supplier ledger screen: the supplier row',
    sql: liftSql(SL_SRC, 'SELECT * FROM suppliers WHERE supplier_id = ? AND farm_id = ?'),
    params: [1, 1] },
  { what: 'distribution report: purchases with the account',
    sql: liftSql(DIST_SRC, 'LEFT JOIN bank_accounts b ON b.bank_id = po.bank_id'),
    params: [1] }
]

const scratch = await createScratchDb('supplier_tracking')
db = scratch.db
try {

  // ── A. DERIVED, NOT STORED ───────────────────────────────────────────────
  console.log('=== A. the payable is derived, and no column claims to be it ===')

  const supplierCols = (await rows(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'suppliers' ORDER BY ordinal_position`)).map(r => r.name)
  console.log(`        suppliers columns: ${supplierCols.join(', ')}`)
  checkTrue('suppliers has NO outstanding_balance column',
    !supplierCols.includes('outstanding_balance'))
  checkTrue('suppliers has no balance-shaped column of any name',
    !supplierCols.some(c => /balance|payable|outstanding|owed/i.test(c)))

  // No table on the SUPPLIER side may hold it either — a "cache table" is the
  // same bug with an extra join. `supplier_ledger.balance` is the running
  // statement line (the balance AT that row), not the payable, so it is
  // excluded by name.
  const everyTable = (await rows(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
  )).map(r => r.name)
  const claimants = []
  for (const table of everyTable.filter(t => /supplier|purchase/i.test(t))) {
    for (const col of (await rows(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`, [table])).map(r => r.name)) {
      if (col === 'balance' && table === 'supplier_ledger') continue
      if (/outstanding|payable|owed|balance/i.test(col)) claimants.push(`${table}.${col}`)
    }
  }
  check(`no supplier-side table claims to store the payable (${claimants.join(', ') || 'none'})`,
    claimants.length, 0)

  // The CUSTOMER side is the deliberate counter-example, and the reason this
  // whole section exists: `customers.outstanding_balance` IS cached, and every
  // path that touches a bill has to rebuild it by hand (see
  // `rebuildCustomerBalanceOp`, and `deleteCustomerLedgerEntry`, where a delete
  // that forgot it left a balance stuck at a figure no row supported). Asserted
  // as still present, so this check cannot quietly start passing because the
  // customer column was removed and the comparison lost its meaning.
  checkTrue('(for contrast) the CUSTOMER side really does cache its balance',
    (await rows(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'customers' ORDER BY ordinal_position`))
      .some(c => c.name === 'outstanding_balance'))

  // And no source line writes one. Catches a column added by ALTER as well as
  // by createTables, since the write would have to exist to be useful.
  const writesAStoredBalance =
    /UPDATE\s+suppliers\s+SET[^;`']*(outstanding|payable)/i.test(SVC_SRC) ||
    /ALTER\s+TABLE\s+suppliers\s+ADD/i.test(DB_SRC) ||
    /CREATE\s+TRIGGER/i.test(DB_SRC)
  checkTrue('no source writes a stored supplier balance, and there is no trigger',
    !writesAStoredBalance)

  checkTrue('the util own number coercion was lifted, not restated', numLifted)
  checkTrue('getSupplierPayable() derives it with SUM(credit - debit)',
    /SUM\(COALESCE\(credit, 0\) - COALESCE\(debit, 0\)\)/.test(
      String(svc.getSupplierPayable)))
  checkTrue('getAllSuppliersWithBalance() derives outstanding_balance the same way',
    /SUM\(credit - debit\)[\s\S]*as outstanding_balance/.test(
      String(svc.getAllSuppliersWithBalance)))

  // ── I. SCREEN SQL ────────────────────────────────────────────────────────
  console.log('\n=== I. every new read runs on the real schema, with its parameters in order ===')

  for (const st of SELECTS) {
    let threw = null
    try { await rows(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes`, threw === null)
    if (threw) console.log(`        ${threw}`)
    check(`${st.what} placeholder count matches its parameter list`,
      (st.sql.match(/\?/g) || []).length, st.params.length)
  }

  // The service reads, through their real signatures, before any data exists.
  for (const [what, run] of [
    ['getAllSuppliersWithBalance', () => call('getAllSuppliersWithBalance', FARM)],
    ['getSupplierLedgerWithBalance', () => call('getSupplierLedgerWithBalance', 1, FARM)],
    ['getSupplierPaymentsByAccount (all suppliers)', () => call('getSupplierPaymentsByAccount', FARM)],
    ['getSupplierPaymentsByAccount (one supplier)', () => call('getSupplierPaymentsByAccount', FARM, 1)]
  ]) {
    const res = await run()
    checkTrue(`${what} executes on an empty database`, res.success === true)
    if (!res.success) console.log(`        ${res.error}`)
  }

  // ── Fixture ──────────────────────────────────────────────────────────────
  await runSql(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'), (2,'Other','x')`)
  await runSql(`INSERT INTO suppliers (supplier_id, farm_id, supplier_name, phone)
          VALUES (1,1,'Agri Supplies','0300'),
                 (2,1,'Feed Mill','0301'),
                 (3,2,'Other Farm Supplier','0302')`)
  await runSql(`INSERT INTO products (product_id, farm_id, product_name, cost_price, selling_price)
          VALUES (1,1,'Feed Bag',2000,2400)`)

  await call('addBankAccount', { farm_id: 1, bank_name: 'House Main', account_number: 'H-1', opening_balance: 500000 })
  await call('addBankAccount', { farm_id: 1, bank_name: 'House Second', account_number: 'H-2', opening_balance: 200000 })
  const HOUSE_A = (await rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'House Main'`))[0].bank_id
  const HOUSE_B = (await rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'House Second'`))[0].bank_id

  let poSeq = 0
  /**
   * A purchase order, through the SCREEN's own INSERT and the service's own
   * ledger write — `addToSupplierLedger()`'s shape, which for a CASH order puts
   * the credit AND an equal debit on one row. That single row being both a
   * charge and a payment is what the whole bucket split turns on.
   */
  async function purchaseOrder(supplierId, amount, {
    paid = false, bankId = null, date = '2025-06-02'
  } = {}) {
    const paymentType = paid ? 'cash' : 'credit'
    const source = paid && bankId ? 'bank' : 'cash'
    const res = await svc.run(PO_INSERT, [
      FARM, supplierId, 1, date, 1, amount, amount, paymentType,
      source, paid ? bankId : null, 'note', null
    ])
    if (!res.success) throw new Error('purchase order insert failed: ' + res.error)
    const purchaseId = res.lastId
    await call('addSupplierLedgerEntry', {
      supplier_id: supplierId,
      transaction_date: date,
      description: `Purchase Order #${purchaseId}`,
      debit: paid ? amount : 0,
      credit: amount,
      reference_type: 'purchase',
      reference_id: purchaseId
    })
    return { purchaseId, ledgerId: (await rows(`SELECT MAX(ledger_id) v FROM supplier_ledger`))[0].v }
  }

  /** A purchase return, exactly as purchase-returns.component.ts posts it. */
  async function purchaseReturn(supplierId, purchaseId, amount, { date = '2025-06-03' } = {}) {
    await call('addSupplierLedgerEntry', {
      supplier_id: supplierId,
      transaction_date: date,
      description: `Return PRET-001 - Purchase #${purchaseId}`,
      debit: amount,
      credit: 0,
      reference_type: 'return',
      reference_id: purchaseId
    })
    return (await rows(`SELECT MAX(ledger_id) v FROM supplier_ledger`))[0].v
  }

  /** The Supplier Ledger screen's own payment: a debit, cash, no account. */
  async function manualPayment(supplierId, amount, { date = '2025-06-04', note = 'Payment made' } = {}) {
    await call('addSupplierLedgerEntry', {
      supplier_id: supplierId,
      transaction_date: date,
      description: note,
      debit: amount,
      reference_type: 'payment'
    })
    return (await rows(`SELECT MAX(ledger_id) v FROM supplier_ledger`))[0].v
  }

  let pvSeq = 0
  /** A payment voucher, through the real savePaymentVoucher(). */
  async function paymentVoucher(supplierId, amount, { bankId = null, date = '2025-06-05' } = {}) {
    const number = 'PV-' + String(++pvSeq).padStart(3, '0')
    const source = bankId ? 'bank' : 'cash'
    return call('savePaymentVoucher', {
      sql: PV_INSERT,
      params: [FARM, supplierId, number, date, amount, source, bankId, null, null]
    }, {
      supplier_id: supplierId,
      amount,
      date,
      description: `Payment Voucher ${number}`,
      bank_description: `Payment Voucher ${number} — Supplier`,
      payment_source: source,
      bank_id: bankId
    })
  }

  const lastVoucher = async () => (await rows(`SELECT MAX(voucher_id) v FROM payment_vouchers`))[0].v

  // ── B / C. THE IDENTITY, THROUGH EVERY ROW SHAPE ─────────────────────────
  console.log('\n=== B/C. the identity and the two code paths, after every mutation ===')

  check('a supplier with no history owes nothing', (await payableOf(1)), 0)
  await invariant('no history', 1)

  // 1. an UNPAID order — a pure charge.
  const credit1 = await purchaseOrder(1, 12000)
  check('an unpaid order puts the whole amount on the payable', (await payableOf(1)), 12000)
  await invariant('an unpaid purchase order', 1)

  // 2. a CASH order — one row, charge and payment together.
  const paid1 = await purchaseOrder(1, 5000, { paid: true, bankId: HOUSE_A })
  check('a cash order adds nothing to the payable', (await payableOf(1)), 12000)
  let row1 = await summaryRow(1)
  check('  but it DID add to purchased', Number(row1.total_purchased), 17000)
  check('  and it DID add to paid', Number(row1.total_paid), 5000)
  await invariant('a cash purchase order', 1)

  // 3. a RETURN — reduces the payable, and is NOT a payment.
  const return1 = await purchaseReturn(1, credit1.purchaseId, 2000)
  check('a return reduces the payable', (await payableOf(1)), 10000)
  row1 = await summaryRow(1)
  check('  returned is its own figure', Number(row1.total_returned), 2000)
  check('  and paid did NOT move', Number(row1.total_paid), 5000)
  await invariant('a purchase return', 1)

  // 4. a MANUAL payment — cash, no account.
  const manual1 = await manualPayment(1, 3000)
  check('a manual payment reduces the payable', (await payableOf(1)), 7000)
  row1 = await summaryRow(1)
  check('  and increases paid', Number(row1.total_paid), 8000)
  await invariant('a manual ledger payment', 1)

  // 5. a PAYMENT VOUCHER — the bank-attributed door.
  const payableBefore = (await payableOf(1))
  const pv1 = await paymentVoucher(1, 4000, { bankId: HOUSE_B })
  checkTrue('the payment voucher saved', pv1.success === true)
  check('F: the voucher reduced the payable by EXACTLY its amount',
    (await payableOf(1)), payableBefore - 4000)
  row1 = await summaryRow(1)
  check('  and it counts as paid', Number(row1.total_paid), 12000)
  await invariant('a payment voucher', 1)

  // ── E. THE RETURN TRAP (the arithmetic half) ─────────────────────────────
  console.log('\n=== E. SUM(all debits) is NOT "paid" — a return is stock, not money ===')

  const allDebits = (await one(`SELECT COALESCE(SUM(debit),0) v FROM supplier_ledger WHERE supplier_id = 1`))
  const sqlPaid = Number((await summaryRow(1)).total_paid)
  check('SUM(every debit) overstates what was paid', allDebits, sqlPaid + 2000)
  check('total_paid excludes the return', sqlPaid, allDebits - 2000)
  checkTrue('the naive figure and the honest one really do differ here',
    allDebits !== sqlPaid)

  // And the roll-up agrees with the summary column, to the rupee.
  const accounts1 = (await call('getSupplierPaymentsByAccount', FARM, 1)).data || []
  check('the by-account roll-up sums to total_paid',
    accounts1.reduce((s, a) => s + (Number(a.total_paid) || 0), 0), sqlPaid)
  check('and its payment count matches the money-out rows',
    accounts1.reduce((s, a) => s + (Number(a.payment_count) || 0), 0),
    (await ledgerRows(1)).filter(e => isSupplierPayment(e)).length)

  // ── D / E. THE ACCOUNT ON EVERY ROW ──────────────────────────────────────
  console.log('\n=== D/E. which account each row reports ===')

  let entries = await ledgerRows(1)
  const pvLedgerId = (await rows(
    `SELECT ledger_id v FROM supplier_ledger WHERE voucher_id = ?`, [(await lastVoucher())]))[0].v

  checkStr('a voucher line reports the account the VOUCHER named',
    accountOn(entries, pvLedgerId), 'Bank · House Second')
  checkStr('a cash-paid order reports the ORDER\'s account',
    accountOn(entries, paid1.ledgerId), 'Bank · House Main')
  checkStr('an unpaid order reports no account at all',
    accountOn(entries, credit1.ledgerId), '—')
  checkStr('a manual payment reports Cash',
    accountOn(entries, manual1), 'Cash')

  // THE TRAP: a return's reference_id IS a purchase_id. Ungated, it would
  // borrow that order's bank account and print a withdrawal that never was.
  const returnRow = entries.find(e => Number(e.ledger_id) === Number(return1))
  checkStr('a return does NOT borrow the order\'s account',
    returnRow.bank_name === null ? 'null' : returnRow.bank_name, 'null')
  checkTrue('  nor its payment_source', returnRow.payment_source === null)
  checkStr('  and it renders as no account', accountOn(entries, return1), '—')

  // Proof the trap is real: the order the return points at IS bank-attributed.
  const returnsOrder = (await rows(
    `SELECT po.payment_source, b.bank_name FROM purchase_orders po
     LEFT JOIN bank_accounts b ON b.bank_id = po.bank_id
     WHERE po.purchase_id = ?`, [returnRow.reference_id]))[0]
  checkTrue('  (the return points at a real purchase order)', !!returnsOrder)

  // A return pointing at a BANK-paid order is the SHARP form of the trap: the
  // order it names really does have an account, so an ungated join resolves a
  // real bank name onto a row that moved no money through it.
  //
  // Asserted on the RAW columns, not on the rendered label. The label is '—'
  // for any non-payment row whatever the query returned, so testing it alone
  // would pass even with both gates removed — it tests the util's exclusion,
  // not the SQL's.
  //
  // Mutation-tested, and the result is worth writing down: the query gates the
  // `purchase_orders` join TWICE, in the JOIN condition and again in each CASE,
  // and either one alone is sufficient — removing just one changes no output.
  // These assertions fire when BOTH go, which is the regression that matters.
  // The redundancy is kept deliberately: the JOIN condition stops the rows
  // matching at all, and the CASE additionally carries the `debit > 0` rule,
  // which the join cannot express (an unpaid order's row must resolve no
  // account even though the join matches it).
  const paidReturn = await purchaseReturn(1, paid1.purchaseId, 500)
  entries = await ledgerRows(1)
  const paidReturnRow = entries.find(e => Number(e.ledger_id) === Number(paidReturn))
  const paidOrder = (await rows(
    `SELECT po.payment_source, b.bank_name FROM purchase_orders po
     LEFT JOIN bank_accounts b ON b.bank_id = po.bank_id
     WHERE po.purchase_id = ?`, [paid1.purchaseId]))[0]
  checkStr('  (the order it points at IS bank-attributed, so there is something to borrow)',
    `${paidOrder.payment_source}/${paidOrder.bank_name}`, 'bank/House Main')
  checkTrue('a return against a BANK-paid order resolves NO payment_source',
    paidReturnRow.payment_source === null)
  checkTrue('  and NO bank_name — it does not borrow "House Main"',
    paidReturnRow.bank_name === null)
  checkTrue('  nor a bank_id', paidReturnRow.bank_id === null)
  checkStr('  so it still renders as no account', accountOn(entries, paidReturn), '—')
  check('  and still does not count as paid',
    Number((await summaryRow(1)).total_paid), 12000)
  check('  nor does it reach the by-account roll-up',
    ((await call('getSupplierPaymentsByAccount', FARM, 1)).data || [])
      .reduce((s, a) => s + Number(a.payment_count || 0), 0),
    entries.filter(e => isSupplierPayment(e)).length)
  await invariant('a return against a bank-paid order', 1)

  // Labels, so a user can tell the rows apart at all.
  const labelOf = (id) => supplierRowLabel(entries.find(e => Number(e.ledger_id) === Number(id)))
  checkStr('the unpaid order labels as a purchase', labelOf(credit1.ledgerId), 'Purchase')
  checkStr('the cash order labels as paid', labelOf(paid1.ledgerId), 'Purchase (paid)')
  checkStr('the return labels as a return', labelOf(paidReturn), 'Return')
  checkStr('the manual payment labels as a payment', labelOf(manual1), 'Payment')
  checkStr('the voucher line labels as a voucher', labelOf(pvLedgerId), 'Payment voucher')

  // The roll-up names both accounts and cash separately.
  const byAccount = (await call('getSupplierPaymentsByAccount', FARM, 1)).data || []
  const named = byAccount.map(a => `${paymentSourceLabel(a)}=${a.total_paid}`).sort().join(', ')
  checkStr('the roll-up splits cash and each account',
    named, 'Bank · House Main=5000, Bank · House Second=4000, Cash=3000')

  // ── F. DELETE RESTORES THE PAYABLE ───────────────────────────────────────
  console.log('\n=== F. deleting the payment voucher restores the payable exactly ===')

  const beforeDelete = (await payableOf(1))
  const paidBeforeDelete = Number((await summaryRow(1)).total_paid)
  const bankBefore = (await one(
    `SELECT COALESCE(current_balance,0) v FROM bank_accounts WHERE bank_id = ?`, [HOUSE_B]))

  const del = await call('deletePaymentVoucher', (await lastVoucher()))
  checkTrue('the voucher deleted', del.success === true)
  check('the payable went back up by exactly the voucher amount',
    (await payableOf(1)), beforeDelete + 4000)
  check('paid went back down by exactly the voucher amount',
    Number((await summaryRow(1)).total_paid), paidBeforeDelete - 4000)
  check('the bank account got its money back',
    (await one(`SELECT COALESCE(current_balance,0) v FROM bank_accounts WHERE bank_id = ?`, [HOUSE_B])),
    bankBefore + 4000)
  check('the voucher\'s ledger line is gone',
    (await one(`SELECT COUNT(*) v FROM supplier_ledger WHERE voucher_id IS NOT NULL`)), 0)
  check('and its account no longer appears in the roll-up',
    ((await call('getSupplierPaymentsByAccount', FARM, 1)).data || [])
      .filter(a => Number(a.bank_id) === Number(HOUSE_B)).length, 0)
  await invariant('deleting the payment voucher', 1)

  // Re-enter and re-delete: the figures must land on the same numbers.
  const snapshot = (await payableOf(1))
  const pv2 = await paymentVoucher(1, 1500, { bankId: HOUSE_A })
  checkTrue('a second voucher saves', pv2.success === true)
  check('  reducing the payable', (await payableOf(1)), snapshot - 1500)
  await invariant('a re-entered voucher', 1)
  await call('deletePaymentVoucher', (await lastVoucher()))
  check('  and its delete restores it', (await payableOf(1)), snapshot)
  await invariant('re-deleting it', 1)

  // ── G. REFUSALS ──────────────────────────────────────────────────────────
  console.log('\n=== G. the rows this screen may not delete ===')

  const pv3 = await paymentVoucher(1, 1000, { bankId: HOUSE_A })
  checkTrue('a voucher exists to try to half-delete', pv3.success === true)
  const voucherLine = (await rows(`SELECT ledger_id v FROM supplier_ledger WHERE voucher_id IS NOT NULL`))[0].v

  const beforeRefusals = JSON.stringify((await rows(
    `SELECT ledger_id, debit, credit, reference_type, reference_id, voucher_id
     FROM supplier_ledger ORDER BY ledger_id`)))
  const payableBeforeRefusals = (await payableOf(1))

  const refusePurchase = await call('deleteSupplierLedgerEntry', credit1.ledgerId)
  checkTrue('a purchase mirror is REFUSED', refusePurchase.success === false)
  checkTrue('  and says to use Purchase Orders',
    /Purchase Orders/.test(refusePurchase.error || ''))

  const refuseVoucher = await call('deleteSupplierLedgerEntry', voucherLine)
  checkTrue('a voucher line is REFUSED', refuseVoucher.success === false)
  checkTrue('  and says to use the Payment Voucher screen',
    /Payment Voucher/.test(refuseVoucher.error || ''))

  const refuseGone = await call('deleteSupplierLedgerEntry', 999999)
  checkTrue('a row that does not exist is refused, not silently "deleted"',
    refuseGone.success === false)

  checkStr('a refusal wrote NOTHING', JSON.stringify((await rows(
    `SELECT ledger_id, debit, credit, reference_type, reference_id, voucher_id
     FROM supplier_ledger ORDER BY ledger_id`))), beforeRefusals)
  check('and moved no figure', (await payableOf(1)), payableBeforeRefusals)
  await invariant('three refused deletes', 1)

  // A manual payment IS deletable, and removing the row IS the reversal —
  // there is no bills table behind it to put anything back on.
  const manual2 = await manualPayment(1, 250)
  const payableWithManual = (await payableOf(1))
  const okDelete = await call('deleteSupplierLedgerEntry', manual2)
  checkTrue('a manual payment deletes', okDelete.success === true)
  check('and removing the row IS the reversal', (await payableOf(1)), payableWithManual + 250)
  await invariant('deleting a manual payment', 1)

  await call('deletePaymentVoucher', (await lastVoucher()))

  // ── H. FARM SCOPING ──────────────────────────────────────────────────────
  console.log('\n=== H. farm scoping, including the colliding id ===')

  // Farm 2's supplier gets a ledger of its own, on purpose with figures that
  // would be obvious if they leaked.
  await call('addSupplierLedgerEntry', {
    supplier_id: 3, transaction_date: '2025-06-02',
    description: 'Other farm purchase', debit: 0, credit: 777777,
    reference_type: 'purchase', reference_id: 9001
  })
  await call('addSupplierLedgerEntry', {
    supplier_id: 3, transaction_date: '2025-06-03',
    description: 'Other farm payment', debit: 111111,
    reference_type: 'payment'
  })

  const farm1List = (await call('getAllSuppliersWithBalance', FARM)).data || []
  check('farm 1 sees only its own suppliers', farm1List.length, 2)
  checkTrue('  and not the other farm\'s',
    !farm1List.some(s => Number(s.supplier_id) === 3))
  check('no farm-1 figure contains the other farm\'s purchase',
    farm1List.filter(s => Number(s.total_purchased) === 777777).length, 0)

  const farm2List = (await call('getAllSuppliersWithBalance', 2)).data || []
  check('farm 2 sees exactly its own one supplier', farm2List.length, 1)
  check('  with its own purchased', Number(farm2List[0].total_purchased), 777777)
  check('  its own paid', Number(farm2List[0].total_paid), 111111)
  check('  and its own payable', Number(farm2List[0].outstanding_balance), 666666)

  check('the by-account roll-up is farm-scoped too',
    ((await call('getSupplierPaymentsByAccount', FARM)).data || [])
      .reduce((s, a) => s + (Number(a.total_paid) || 0), 0),
    farm1List.reduce((s, x) => s + (Number(x.total_paid) || 0), 0))
  check('  and the other farm\'s payment is not in it',
    ((await call('getSupplierPaymentsByAccount', FARM)).data || [])
      .filter(a => Number(a.total_paid) === 111111).length, 0)

  // The statement read refuses a supplier that is not this farm's, even though
  // the id exists — the id is the thing an attacker or a stale route has.
  check('the statement read refuses another farm\'s supplier id',
    (await ledgerRows(3, FARM)).length, 0)
  checkTrue('  while the owning farm reads it fine',
    (await ledgerRows(3, 2)).length === 2)

  await invariant('the other farm\'s ledger existing', 1)
  await invariant('the other farm\'s own books', 3, 2)

  // ── J. THE SCREENS' OWN GETTERS ──────────────────────────────────────────
  console.log('\n=== J. the screens\' own getters agree with the SQL ===')

  const farm1Rows = (await call('getAllSuppliersWithBalance', FARM)).data || []
  const s1Rows = await ledgerRows(1)
  const s1Sql = farm1Rows.find(s => Number(s.supplier_id) === 1)

  // The Supplier Ledger DETAIL view, through its real `get totals()`.
  const detail = screenTotals.call({ ledgerEntries: s1Rows })
  check('detail view purchased == SQL', detail.purchased, Number(s1Sql.total_purchased))
  check('detail view paid == SQL', detail.paid, Number(s1Sql.total_paid))
  check('detail view returned == SQL', detail.returned, Number(s1Sql.total_returned))
  check('detail view other charges == SQL', detail.otherCharges, Number(s1Sql.other_charges))
  check('detail view payable == SUM(credit - debit)', detail.outstanding, (await payableOf(1)))

  // Its payment history lists exactly the money-out rows, newest first.
  const history = screenPaymentHistory.call(supplierLedgerContext(s1Rows))
  check('the payment history lists every money-out row',
    history.length, s1Rows.filter(e => isSupplierPayment(e)).length)
  check('  and nothing else',
    history.filter(e => !isSupplierPayment(e)).length, 0)
  check('  excluding returns',
    history.filter(e => supplierRowKind(e) === 'return').length, 0)
  check('  its amounts sum to total_paid',
    history.reduce((s, e) => s + Number(e.debit), 0), Number(s1Sql.total_paid))
  checkTrue('  newest first',
    history.every((e, i) => i === 0 || Number(history[i - 1].ledger_id) >= Number(e.ledger_id)))
  checkTrue('  and every row in it names an account',
    history.every(e => !!paymentSourceLabel(e)))

  // ── THE FROM / TO FILTER ─────────────────────────────────────────────────
  //
  // It narrows the LISTED ROWS and must narrow nothing else. The client asked
  // for the range; what he must not get with it is a "Total Payable" that
  // means "payable within October", because a payable is what is owed NOW and
  // the summary block is an identity:
  //
  //     purchased + other charges - paid - returned = payable
  //
  // Filtering four of those five terms would break it on screen; filtering all
  // five would print a payable he cannot reconcile against what the supplier
  // says he is owed. So `totals` and the payable stay over the full history and
  // only `visibleEntries` moves. See `date-range.util.ts`.
  {
    const dates = s1Rows.map(e => dayOf(e.transaction_date)).sort()
    const earliest = dates[0]
    const latest = dates[dates.length - 1]

    const unfiltered = screenVisibleEntries.call(supplierLedgerContext(s1Rows))
    check('unfiltered, every row is listed', unfiltered.length, s1Rows.length)

    // The whole span admits everything — both bounds are inclusive, so a row
    // dated on the From day or the To day stays in its own range.
    const whole = screenVisibleEntries.call(supplierLedgerContext(s1Rows, earliest, latest))
    check('the full span admits every row', whole.length, s1Rows.length)

    // A window before everything admits nothing...
    const before = screenVisibleEntries.call(supplierLedgerContext(s1Rows, '1900-01-01', '1900-01-02'))
    check('a window before all of it lists nothing', before.length, 0)

    // ...and the totals are UNMOVED by either, which is the point.
    const narrowed = supplierLedgerContext(s1Rows, '1900-01-01', '1900-01-02')
    const narrowedTotals = screenTotals.call(narrowed)
    check('a narrowed range leaves purchased alone', narrowedTotals.purchased, detail.purchased)
    check('  and paid alone', narrowedTotals.paid, detail.paid)
    check('  and returned alone', narrowedTotals.returned, detail.returned)
    check('  and THE PAYABLE alone', narrowedTotals.outstanding, (await payableOf(1)))

    // The row's own running balance is computed in SQL over every earlier row,
    // so a listed row keeps showing the true balance as at its own date even
    // when the rows before it are hidden. That is what makes a printed period
    // statement correct rather than merely plausible.
    const onlyLatest = screenVisibleEntries.call(supplierLedgerContext(s1Rows, latest, latest))
    checkTrue('a filtered row keeps its all-history running balance',
      onlyLatest.every(e => {
        const full = s1Rows.find(r => r.ledger_id === e.ledger_id)
        return Number(e.balance) === Number(full.balance)
      }))

    // And the payment history follows the filter, since it is the same rows.
    const narrowedHistory = screenPaymentHistory.call(narrowed)
    check('the payment history follows the filter', narrowedHistory.length, 0)
  }

  // The LIST view's column sums.
  const list = { filteredSuppliers: farm1Rows }
  check('list view purchased == SQL sum', screenTotalPurchased.call(list),
    farm1Rows.reduce((s, r) => s + Number(r.total_purchased || 0), 0))
  check('list view paid == SQL sum', screenTotalPaid.call(list),
    farm1Rows.reduce((s, r) => s + Number(r.total_paid || 0), 0))
  check('list view payable == SQL sum', screenTotalPayable.call(list),
    farm1Rows.reduce((s, r) => s + Number(r.outstanding_balance || 0), 0))

  // The DISTRIBUTION REPORT's section, through its real getters.
  const report = { supplierBalances: farm1Rows }
  report.activeSuppliers = reportActiveSuppliers.call(report)
  const active = report.activeSuppliers
  check('the report lists only suppliers with history', active.length, 1)
  check('  report purchased == SQL sum', reportSupplierPurchased.call(report),
    active.reduce((s, r) => s + Number(r.total_purchased || 0), 0))
  check('  report paid == SQL sum', reportSupplierPaid.call(report),
    active.reduce((s, r) => s + Number(r.total_paid || 0), 0))
  check('  report returned == SQL sum', reportSupplierReturned.call(report),
    active.reduce((s, r) => s + Number(r.total_returned || 0), 0))
  check('  report payable == SQL sum', reportSupplierPayable.call(report),
    active.reduce((s, r) => s + Number(r.outstanding_balance || 0), 0))
  check('  and the report payable equals the ledger itself',
    reportSupplierPayable.call(report), (await payableOf(1)) + (await payableOf(2)))

  // The report's own identity, on the figures it prints.
  check('the report section reconciles too',
    reportSupplierPurchased.call(report)
      + active.reduce((s, r) => s + Number(r.other_charges || 0), 0)
      - reportSupplierPaid.call(report)
      - reportSupplierReturned.call(report),
    reportSupplierPayable.call(report))

  // And the report's by-account roll-up ties to its Paid column.
  check('the report by-account total == its Paid total',
    ((await call('getSupplierPaymentsByAccount', FARM)).data || [])
      .reduce((s, a) => s + Number(a.total_paid || 0), 0),
    reportSupplierPaid.call(report))

  // ── The end state ────────────────────────────────────────────────────────
  console.log('\n=== the end state ===')

  for (const [supplierId, farmId] of [[1, 1], [2, 1], [3, 2]]) {
    await invariant(`end state, supplier ${supplierId}`, supplierId, farmId)
  }

  // Nothing in this change may have written to supplier_ledger outside the
  // paths above: every row is attributable to a supplier that still exists.
  check('no orphaned ledger rows',
    (await one(`SELECT COUNT(*) v FROM supplier_ledger l
         WHERE NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.supplier_id = l.supplier_id)`)), 0)
  check('no ledger row names a voucher that is gone',
    (await one(`SELECT COUNT(*) v FROM supplier_ledger l
         WHERE l.voucher_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM payment_vouchers v WHERE v.voucher_id = l.voucher_id)`)), 0)
  check('every bank account\'s cached balance still equals its own ledger',
    (await one(`SELECT COUNT(*) v FROM bank_accounts ba
         WHERE COALESCE(ba.current_balance,0) <> (
           SELECT COALESCE(SUM(COALESCE(bl.debit,0) - COALESCE(bl.credit,0)),0)
           FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)`)), 0)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
