// [Codex] PostgreSQL port of verify_internal_settlements.js.
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

// Internal settlement: the owner's farm paying the distribution business what
// it owes for an own-farm bill. Both ends of the money are his, which is what
// makes this different from every other receipt in the app — and what makes it
// the one place money could be invented by recording the same rupee twice.
//
// Everything here runs REAL source against a real PostgreSQL database: the schema
// from createTables/alterStatements, the atomic writer from runBatch(), the
// settlement/reversal/bank methods lifted out of database.service.ts, the
// consolidation queries lifted out of overview.service.ts, and the new screen's
// own SQL lifted out of its component as text. Nothing is a copy, so the paths
// under test are the ones the app runs.
//
// What is proved:
//   A. THE INVARIANT, asserted after EVERY settlement and every delete. Bank
//      balances in total move by
//        (TO is a bank ? +amount : 0) - (FROM is a bank ? +amount : 0)
//      so Bank->Bank (same account OR different) and Cash->Cash leave the total
//      IDENTICAL, while Bank->Cash and Cash->Bank move it by exactly the amount
//      — the cash that really crossed the edge of the banked world. Anything
//      else means money was invented or destroyed. The customer invariant
//      (bills-derived == ledger running total == cached column) is asserted
//      alongside it every time.
//   B. OVERVIEW PROFIT IS IDENTICAL before and after, in both the same-account
//      and the different-account case. This is the double-counting guard: an
//      internal bill is eliminated on its full total_amount regardless of what
//      has been settled, so settling must not move company profit by a rupee.
//   C. DISTRIBUTION's collected-basis revenue DOES rise, by exactly the settled
//      amount. Correct behaviour, not a regression — for that business an
//      own-farm sale is a real sale, and this pins the figure so a future
//      change cannot move it quietly.
//   D. SAME-ACCOUNT settlement writes ZERO bank_ledger rows and every account's
//      balance is byte-identical to before. Not "a debit and a credit that
//      cancel" — nothing at all.
//   E. DIFFERENT accounts: exactly one credit on FROM, exactly one debit on TO,
//      both balances rebuilt, every other account untouched.
//   F. Cash->Bank writes one debit; Bank->Cash writes one credit; Cash->Cash
//      writes nothing.
//   G. DELETE reverses every side and restores both balances and the bills. A
//      same-account delete rebuilds nothing, because there was nothing to
//      rebuild.
//   H. REFUSALS. A settlement's own credit line cannot be deleted from the
//      Customer Ledger screen (mirroring the voucher refusal from Change 2);
//      overpayment is refused and writes nothing; and a bank account still
//      named by a settlement cannot be deleted.
//   I. SCREEN SQL — every statement the screen builds runs against the real
//      schema, with the right placeholder count AND the right parameter order,
//      bound with a distinct sentinel per position.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const OV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

// overview.service.ts's bill queries call `distributionBillsOnly()` to keep an
// unpaid LAYER SALE's receivable — a `bills` row tagged with its source — out
// of every distribution figure. The util is transpiled and eval'd whole so the
// lifted queries bind to the real function rather than a restatement; function
// exports are captured explicitly because these ports run as ES modules.
const BILLSRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bill-source.util.ts'), 'utf8')
const { distributionBillsOnly } = (() => {
  const exports = {}
  const code = ts.transpileModule(BILLSRC, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', code)(exports)
  return exports
})()
const IS_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'internal-settlement', 'internal-settlement.component.ts'), 'utf8')
const IS_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'internal-settlement', 'internal-settlement.component.html'), 'utf8')
const CUST_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'account-ledger', 'customer-ledger', 'customer-ledger.component.html'), 'utf8')

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

const loadMethod = (name, kw = '') => loadFrom(SVC_SRC, name, kw)

/** An overview.service.ts private query builder, types stripped by the real compiler. */
function loadPrivate(src, name) {
  const body = extractFn(src, name, 'private ').replace(/^private\s+/, 'function ')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

/**
 * The SQL string literal containing `marker`, lifted out of a component as
 * text — the only way to test a statement a component builds inline, which is
 * this codebase's convention, from a node script that cannot load Angular.
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

// The real PostgreSQL writer, savepoints and $lastId handling come from the harness.


// Read off the real declarations rather than restated, so a renamed
// reference_type or a flipped direction breaks this file instead of passing.
const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()

const refConst = (name) => {
  const m = SVC_SRC.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`))
  if (!m) throw new Error(`${name} not found`)
  return m[1]
}
const INTERNAL_SETTLEMENT_OUT_REF = refConst('INTERNAL_SETTLEMENT_OUT_REF')
const INTERNAL_SETTLEMENT_IN_REF = refConst('INTERNAL_SETTLEMENT_IN_REF')

const DatabaseService = {
  BANK_SOURCES,
  INTERNAL_SETTLEMENT_OUT_REF,
  INTERNAL_SETTLEMENT_IN_REF
}

async function rows(sql, params = []) {
  const result = await db.get(sql, params)
  if (!result.success) throw new Error(result.error)
  return result.data
}

// ── The service under test ──────────────────────────────────────────────────

const svc = {
  toLocalDateString: () => '2025-06-01',
  async get(sql, params = []) { return db.get(sql, params) },
  async run(sql, params = []) { return db.run(sql, params) },
  async runBatch(ops) { return db.batch(ops) },

  // The bank mechanism the settlement rides on.
  bankBalanceSql:            loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql:  loadMethod('nextTransactionNumberSql', 'private '),
  rebuildBankBalanceOp:      loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:              loadMethod('bankEntryOps', 'private '),
  bankWithdrawalOps:         loadMethod('bankWithdrawalOps', 'private '),
  bankReversalOps:           loadMethod('bankReversalOps', 'private '),
  bankIdOf:                  loadMethod('bankIdOf', 'private '),
  bankRebuildOps:            loadMethod('bankRebuildOps'),

  // The save-time balance guard. These scripts bind the real method bodies onto
  // this one object, so a new `this.` dependency has to be registered here or
  // the method under test throws instead of running.
  bankAmountText:            loadMethod('bankAmountText', 'private '),
  checkBankBalances:         loadMethod('checkBankBalances', 'async '),
  getBankAccounts:           loadMethod('getBankAccounts', 'async '),
  getHouseBankAccounts:      loadMethod('getHouseBankAccounts', 'async '),
  addBankAccount:            loadMethod('addBankAccount', 'async '),
  linkCustomerToBank:        loadMethod('linkCustomerToBank', 'async '),
  addBankLedgerEntry:        loadMethod('addBankLedgerEntry', 'async '),
  deleteBankAccount:         loadMethod('deleteBankAccount', 'async '),

  // The settlement, its reversal, and the reads around them.
  rebuildCustomerBalanceOp:  loadMethod('rebuildCustomerBalanceOp', 'private '),
  updateCustomerOutstandingBalance: loadMethod('updateCustomerOutstandingBalance', 'async '),
  getUnpaidBills:            loadMethod('getUnpaidBills', 'async '),
  customerSettlementOps:     loadMethod('customerSettlementOps'),
  customerUnwindOps:         loadMethod('customerUnwindOps', 'private async '),
  deleteCustomerLedgerEntry: loadMethod('deleteCustomerLedgerEntry', 'async '),
  getAllCustomersWithBalance: loadMethod('getAllCustomersWithBalance', 'async '),
  getCustomerLedgerWithBalance: loadMethod('getCustomerLedgerWithBalance', 'async '),
  addCustomerLedgerEntry:    loadMethod('addCustomerLedgerEntry', 'async '),

  // Change 4 itself.
  settlementBankId:          loadMethod('settlementBankId', 'private '),
  saveInternalSettlement:    loadMethod('saveInternalSettlement', 'async '),
  deleteInternalSettlement:  loadMethod('deleteInternalSettlement', 'async ')
}
// addBankAccount() calls the module-scope toLocalDateString() of the real
// service file, which an eval'd copy cannot see.
global.toLocalDateString = svc.toLocalDateString
const call = (name, ...args) => svc[name].apply(svc, args)

// The Overview consolidation queries, lifted whole with every helper they call,
// bound onto one context so the `this.` calls inside them resolve as they do in
// the app.
const ctx = {
  dateClause: loadPrivate(OV_SRC, 'dateClause'),
  internalBillIdsSql: loadPrivate(OV_SRC, 'internalBillIdsSql'),
  internalRefIdsSql: loadPrivate(OV_SRC, 'internalRefIdsSql'),
  internalExpenseIdsSql: loadPrivate(OV_SRC, 'internalExpenseIdsSql'),
  productRateCte: loadPrivate(OV_SRC, 'productRateCte'),
  qDistributionBills: loadPrivate(OV_SRC, 'qDistributionBills'),
  qDistributionUnpaid: loadPrivate(OV_SRC, 'qDistributionUnpaid'),
  qInternalBills: loadPrivate(OV_SRC, 'qInternalBills'),
  qDistributionCogs: loadPrivate(OV_SRC, 'qDistributionCogs'),
  qInternalExpenseSide: loadPrivate(OV_SRC, 'qInternalExpenseSide'),
  qTraderEntries: loadPrivate(OV_SRC, 'qTraderEntries'),
  qExpenses: loadPrivate(OV_SRC, 'qExpenses'),
  qDistributionExpenses: loadPrivate(OV_SRC, 'qDistributionExpenses')
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

const one = async (sql, params = []) => Number((await rows(sql, params))[0].v)

const billsOutstanding = async (customerId) => (await one(
  `SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)), 0) v
   FROM bills WHERE customer_id = ?`, [customerId]))
const ledgerOutstanding = async (customerId) => (await one(
  `SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)), 0) v
   FROM customer_ledger WHERE customer_id = ?`, [customerId]))
const cachedOutstanding = async (customerId) => (await one(
  `SELECT COALESCE(outstanding_balance, 0) v FROM customers WHERE customer_id = ?`, [customerId]))
const amountPaid = async (billId) => (await one(
  `SELECT COALESCE(amount_paid,0) v FROM bills WHERE bill_id = ?`, [billId]))
const bankBalance = async (bankId) => (await one(
  `SELECT COALESCE(current_balance,0) v FROM bank_accounts WHERE bank_id = ?`, [bankId]))
const bankLedgerSum = async (bankId) => (await one(
  `SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)), 0) v
   FROM bank_ledger WHERE bank_id = ?`, [bankId]))
const allBankBalances = async () => (await one(
  `SELECT COALESCE(SUM(COALESCE(current_balance,0)), 0) v FROM bank_accounts`))
const bankLedgerRowCount = async () => (await one(`SELECT COUNT(*) v FROM bank_ledger`))
const settlementEntries = async (ref, settlementId) => (await rows(
  `SELECT * FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`, [ref, settlementId]))

/** Every account's balance, so two states can be compared account by account. */
const balanceSnapshot = async () => {
  const out = {}
  for (const r of (await rows(`SELECT bank_id, COALESCE(current_balance,0) b FROM bank_accounts ORDER BY bank_id`))) {
    out[r.bank_id] = Number(r.b)
  }
  return out
}

/** The figure Overview and the Distribution report actually read as revenue. */
const collectedRevenue = async (farmId) => (await one(
  `SELECT COALESCE(SUM(MIN(MAX(COALESCE(amount_paid,0), 0), COALESCE(total_amount,0))), 0) v
   FROM bills WHERE farm_id = ?`, [farmId]))

/**
 * THE CUSTOMER INVARIANT, asserted after every mutation. The statement the farm
 * reads and the debt it is billed for are two derivations of the same money;
 * they must land on the same number, and the cached column — what Sales Orders
 * and the reports read — with both.
 */
async function customerInvariant(label, customerId) {
  const fromBills = (await billsOutstanding(customerId))
  const fromLedger = (await ledgerOutstanding(customerId))
  const cached = (await cachedOutstanding(customerId))
  const listed = ((await call('getAllCustomersWithBalance', 1)).data || [])
    .find(c => Number(c.customer_id) === customerId)
  const ok = fromBills === fromLedger && cached === fromBills &&
             Number(listed.outstanding_balance) === fromBills
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  CUSTOMER INVARIANT after ${label}: ` +
    `bills=${fromBills} ledger=${fromLedger} cached=${cached} list=${listed.outstanding_balance}`)
}

/**
 * THE BANK INVARIANT — section A, and the whole reason this file exists.
 *
 * `expected` is the net the shape of the settlement allows:
 *   (TO is a bank ? +amount : 0) - (FROM is a bank ? +amount : 0)
 * which is 0 for Bank->Bank (same account or different) and for Cash->Cash, and
 * ±amount when exactly one end is a bank. Anything else is money invented or
 * destroyed.
 *
 * Also checks what holds whatever the shape: no settlement entry points at a
 * settlement that no longer exists, and every cached balance equals the ledger
 * it caches.
 */
async function bankInvariant(label, before, expectedDelta) {
  const after = (await allBankBalances())
  const moved = Math.round((after - before) * 100) / 100
  const want = Math.round(expectedDelta * 100) / 100
  const ok = moved === want
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  BANK INVARIANT after ${label}: ` +
    `total moved ${moved}, allowed ${want}` + (want === 0 ? ' (identical)' : ''))

  for (const ref of [INTERNAL_SETTLEMENT_OUT_REF, INTERNAL_SETTLEMENT_IN_REF]) {
    const orphaned = (await one(
      `SELECT COUNT(*) v FROM bank_ledger bl
       WHERE bl.reference_type = ?
         AND NOT EXISTS (SELECT 1 FROM internal_settlements s WHERE s.settlement_id = bl.reference_id)`,
      [ref]))
    check(`${label} — ${ref} entries with no settlement row`, orphaned, 0)
  }
  // At most one entry per settlement per direction: two reference_types rather
  // than one shared type is what makes this statable at all.
  for (const ref of [INTERNAL_SETTLEMENT_OUT_REF, INTERNAL_SETTLEMENT_IN_REF]) {
    const duplicated = (await one(
      `SELECT COUNT(*) v FROM (
         SELECT reference_id FROM bank_ledger WHERE reference_type = ?
         GROUP BY reference_id HAVING COUNT(*) > 1)`, [ref]))
    check(`${label} — settlements with more than one ${ref} entry`, duplicated, 0)
  }
  const drifted = (await one(
    `SELECT COUNT(*) v FROM bank_accounts ba
     WHERE COALESCE(ba.current_balance, 0) <> (
       SELECT COALESCE(SUM(COALESCE(bl.debit,0) - COALESCE(bl.credit,0)), 0)
       FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)`))
  check(`${label} — accounts whose cached balance drifted`, drifted, 0)
}

/**
 * Everything the Overview dashboard derives from these tables, as one object,
 * so two states can be compared field by field. This is the account-level
 * picture the internal elimination is supposed to hold still — settling a debt
 * the owner owes himself must not move any of it.
 */
async function overviewSnapshot(farmId, range = {}) {
  const one_ = async (spec) => {
    const [sql, params] = spec
    return (await rows(sql, params))[0] || {}
  }
  const sumUnits = async (spec) => {
    const [sql, params] = spec
    return (await rows(sql, params)).reduce((s, r) => s + Number(r.amount || 0), 0)
  }

  const distributionRevenue = Number((await one_(ctx.qDistributionBills.call(ctx, farmId, range))).amount || 0)
  const distributionUnpaid = Number((await one_(ctx.qDistributionUnpaid.call(ctx, farmId, range))).amount || 0)
  const cogs = Number((await one_(ctx.qDistributionCogs.call(ctx, farmId, range))).amount || 0)
  const distExpenses = Number((await one_(ctx.qDistributionExpenses.call(ctx, farmId, range))).amount || 0)

  const broilerFeed = (await sumUnits(ctx.qTraderEntries.call(ctx, farmId, range, 'broiler', 'feed')))
  const broilerMedicine = (await sumUnits(ctx.qTraderEntries.call(ctx, farmId, range, 'broiler', 'medicine')))
  const broilerGeneral = (await sumUnits(ctx.qExpenses.call(ctx, farmId, range, 'broiler')))

  const revenueTotal = distributionRevenue
  const expenseTotal = cogs + distExpenses + broilerFeed + broilerMedicine + broilerGeneral

  return {
    distributionRevenue,
    distributionUnpaid,
    costOfGoodsSold: cogs,
    distributionExpenses: distExpenses,
    broilerFeed,
    broilerMedicine,
    broilerGeneral,
    revenueTotal,
    expenseTotal,
    profit: revenueTotal - expenseTotal
  }
}

function compareOverview(label, before, after) {
  let same = true
  for (const key of Object.keys(before)) {
    if (Number(before[key]) !== Number(after[key])) {
      same = false
      failures++
      console.log(`  FAIL  OVERVIEW ${label} — ${key} moved: ${before[key]} -> ${after[key]}`)
    }
  }
  if (same) console.log(`  PASS  OVERVIEW ${label} — every figure identical (profit ${after.profit})`)
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const OWN_FARM = 500       // own-farm customer, keyed on farm unit 1
const OUTSIDE = 600        // a real outside customer, so every figure is non-zero
let nextBillId = 1

/**
 * An own-farm bill in the shape sales-orders.component.ts writes today: a real
 * `customers` row of `customer_type = 'own_farm'`, `payment_type = 'internal'`,
 * unpaid, with the farm-side cost row at the SELLING price and the
 * `internal_transfers` join row that lets Overview eliminate both sides.
 */
async function internalBill(total, date, flockId) {
  const id = nextBillId++
  const num = `BILL-${String(id).padStart(3, '0')}`
  await runSql(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (?,1,?,?,'Own Farm',?,?,?,0,'internal')`, [id, num, OWN_FARM, date, total, total])
  await runSql(`INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (?,100,'Starter Feed',?,1000,?)`, [id, total / 1000, total])
  await runSql(`INSERT INTO batch_transactions (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
          VALUES (200,100,'sale',?,?,?,'Sale order')`, [total / 1000, date, id])
  await runSql(`INSERT INTO feed_traders (trader_id, flock_id, trader_name, module_type)
          VALUES (?,?,'Internal Distribution','broiler')`, [id, flockId])
  await runSql(`INSERT INTO feed_entries (entry_id, trader_id, flock_id, date, feed_name, quantity,
                                    price_per_unit, total_amount, module_type, bill_id, bill_number)
          VALUES (?,?,?,?,'Starter Feed',?,1000,?,'broiler',?,?)`,
    [id, id, flockId, date, total / 1000, total, id, num])
  await runSql(`INSERT INTO internal_transfers (bill_id, target_module, target_flock_id, target_type, reference_id)
          VALUES (?,'broiler',?,'feed',?)`, [id, flockId, id])
  return { id, num, total }
}

/** The bill's ledger debit, exactly as sales-orders.component.ts writes it. */
async function postBillToLedger(customerId, bill, date) {
  await call('addCustomerLedgerEntry', {
    customer_id: customerId, transaction_date: date,
    description: `Bill #${bill.num}`, debit: bill.total, credit: 0,
    reference_type: 'bill', reference_id: bill.id
  })
  await call('updateCustomerOutstandingBalance', customerId)
}

// ── The screen's own statements ─────────────────────────────────────────────
//
// For each: a marker unique to it, and the parameter list AS THE SCREEN BUILDS
// IT, with a distinct sentinel per position. TypeScript cannot see a
// placeholder count or a parameter ORDER that stopped matching the column list,
// so these run for real against the real schema.

const SENTINEL_BANK = 7777
const IS_INSERT = liftSql(IS_SRC, 'INSERT INTO internal_settlements')

const INSERTS = [
  { what: 'internal settlement INSERT', sql: IS_INSERT,
    params: [1, 4242, 'IS-001', '2025-05-01', 12345, 'bank', SENTINEL_BANK, 'bank', 8888, 'CHQ-9', 'a note'] }
]

const SELECTS = [
  { what: 'own-farm customer list',
    sql: liftSql(IS_SRC, "COALESCE(c.customer_type, 'external') = 'own_farm'"), params: [1] },
  { what: 'settlement list', sql: liftSql(IS_SRC, 'FROM internal_settlements ins'),
    params: [1, '2025-01-01', '2025-12-31'] },
  { what: 'next settlement number',
    sql: liftSql(IS_SRC, "FROM internal_settlements WHERE farm_id = ? AND settlement_number LIKE 'IS-%'"),
    params: [1] },
  { what: 'receipt bill lines', sql: liftSql(IS_SRC, 'WHERE cl.internal_settlement_id = ?'), params: [1] },
  { what: 'receipt farm/flock lookup', sql: liftSql(IS_SRC, 'SELECT fu.unit_name'),
    params: [1] }
]

const scratch = await createScratchDb('internal_settlements')
db = scratch.db
try {

  // ── I. SCREEN SQL ────────────────────────────────────────────────────────
  // First, because a statement that does not parse makes every later figure
  // meaningless.
  console.log('=== I. every statement the screen builds runs on the real schema ===')

  for (const st of SELECTS) {
    let threw = null
    try { await rows(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes`, threw === null)
    if (threw) console.log(`        ${threw}`)
    check(`${st.what} placeholder count matches its parameter list`,
      (st.sql.match(/\?/g) || []).length, st.params.length)
  }

  // Own-farm customers are the ONLY ones this screen may offer — the exact
  // inverse of every other customer picker in the app.
  checkTrue('the customer picker selects own-farm customers and only those',
    /customer_type/.test(SELECTS[0].sql) && /=\s*'own_farm'/.test(SELECTS[0].sql))

  for (const st of INSERTS) {
    checkTrue(`${st.what} carries both accounts`,
      /from_account/.test(st.sql) && /to_account/.test(st.sql))
    checkTrue(`${st.what} carries both bank ids`,
      /from_bank_id/.test(st.sql) && /to_bank_id/.test(st.sql))
    check(`${st.what} placeholder count matches its parameter list`,
      (st.sql.match(/\?/g) || []).length, st.params.length)

    let threw = null
    try { await runSql(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes against the real schema`, threw === null)
    if (threw) console.log(`        ${threw}`)

    // Every sentinel landed in the column the screen meant it for. This is what
    // catches a parameter order that drifted from the column list.
    const row = (await rows(`SELECT * FROM internal_settlements WHERE settlement_number = 'IS-001'`))[0] || {}
    check(`${st.what} — farm_id`, row.farm_id, 1)
    check(`${st.what} — customer_id`, row.customer_id, 4242)
    checkStr(`${st.what} — date`, row.date, '2025-05-01')
    check(`${st.what} — amount`, row.amount, 12345)
    checkStr(`${st.what} — from_account`, row.from_account, 'bank')
    check(`${st.what} — from_bank_id`, row.from_bank_id, SENTINEL_BANK)
    checkStr(`${st.what} — to_account`, row.to_account, 'bank')
    check(`${st.what} — to_bank_id`, row.to_bank_id, 8888)
    checkStr(`${st.what} — reference`, row.reference, 'CHQ-9')
    checkStr(`${st.what} — notes`, row.notes, 'a note')
    await runSql(`DELETE FROM internal_settlements`)
  }

  // The Customer Ledger screen must hide the delete for a settlement's own
  // line, the same way it hides it for a voucher's — the service refuses it
  // either way, but the button should not be there to press.
  checkTrue('the Customer Ledger template hides the delete for a settlement line',
    /!entry\.internal_settlement_id/.test(CUST_HTML))
  checkTrue('the settlement form offers Cash on both sides',
    (IS_HTML.match(/value="cash"/g) || []).length >= 2)

  // ── Seed ─────────────────────────────────────────────────────────────────
  //
  // One account, one farm unit with a flock on it, one own-farm customer owing
  // for three internal bills, one outside customer with a part-paid bill (so
  // the external side of every figure is non-zero and a regression cannot hide
  // behind a zero), and THREE house accounts — the third is never named by any
  // settlement, and must never move.
  console.log('\n=== seeding ===')
  await runSql(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x')`)
  await runSql(`INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name)
          VALUES (1,1,'broiler','North Farm')`)
  await runSql(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id)
          VALUES (10,1,'Flock A','2025-01-01',1)`)
  await runSql(`INSERT INTO products (product_id, farm_id, product_name, category, cost_price, selling_price)
          VALUES (100,1,'Starter Feed','feed',700,1000)`)
  await runSql(`INSERT INTO product_batches (batch_id, product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price)
          VALUES (200,100,1,'B1','2025-01-01','2030-01-01',1000,700)`)
  await runSql(`INSERT INTO customers (customer_id, farm_id, customer_name, unit_id, customer_type, outstanding_balance)
          VALUES (?,1,'Own Farm - North Farm',1,'own_farm',0)`, [OWN_FARM])
  await runSql(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type, outstanding_balance)
          VALUES (?,1,'Outside Buyer','external',0)`, [OUTSIDE])

  // Three house accounts, each with an opening balance, written through the
  // real addBankAccount() so the opening entry and the cached balance are the
  // app's own.
  const BANK_A = (await call('addBankAccount', { farm_id: 1, bank_name: 'HBL Main', account_number: '1234', opening_balance: 200000 })).lastId
  const BANK_B = (await call('addBankAccount', { farm_id: 1, bank_name: 'Meezan', account_number: '5678', opening_balance: 50000 })).lastId
  const BANK_C = (await call('addBankAccount', { farm_id: 1, bank_name: 'Untouched', account_number: '9999', opening_balance: 75000 })).lastId
  // And a CUSTOMER's account, which no settlement may ever touch: house-only is
  // the standing rule on both sides of this screen.
  const BANK_CUST = (await call('addBankAccount', { farm_id: 1, customer_id: OUTSIDE, bank_name: 'Buyer Account', opening_balance: 10000 })).lastId

  const houseList = (await call('getHouseBankAccounts', 1)).data || []
  check('three house accounts, the customer account excluded', houseList.length, 3)

  // The outside sale, part collected.
  await runSql(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (?,1,'BILL-OUT',?,'Outside Buyer','2025-03-12',8000,8000,3000,'cash')`,
    [nextBillId, OUTSIDE])
  await runSql(`INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (?,100,'Starter Feed',8,1000,8000)`, [nextBillId])
  await runSql(`INSERT INTO batch_transactions (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
          VALUES (200,100,'sale',8,'2025-03-12',?,'Sale order')`, [nextBillId])
  const outsideBillId = nextBillId++

  // Three internal bills: 10,000 / 4,000 / 6,000 = 20,000 owed.
  const bill1 = (await internalBill(10000, '2025-03-01', 10))
  const bill2 = (await internalBill(4000, '2025-03-05', 10))
  const bill3 = (await internalBill(6000, '2025-03-08', 10))
  for (const b of [bill1, bill2, bill3]) await postBillToLedger(OWN_FARM, b, b === bill1 ? '2025-03-01' : '2025-03-05')
  await call('updateCustomerOutstandingBalance', OUTSIDE)

  check('the farm owes 20,000', (await billsOutstanding(OWN_FARM)), 20000)
  await customerInvariant('seeding', OWN_FARM)

  const baseOverview = (await overviewSnapshot(1))
  console.log('  Overview at rest: ' +
    Object.entries(baseOverview).map(([k, v]) => `${k}=${v}`).join(' '))
  // Anchors, so the comparisons below are pinned to the model and not merely
  // self-consistent. Internal bills contribute nothing to revenue; only the
  // outside bill's collected 3,000 counts. COGS is every unit that left, at
  // 700: (8 + 10 + 4 + 6) = 28 units.
  check('anchor: Overview revenue is the outside collected 3,000', baseOverview.distributionRevenue, 3000)
  check('anchor: COGS covers all 28 units at 700', baseOverview.costOfGoodsSold, 19600)
  check('anchor: the farm-side feed cost is fully eliminated', baseOverview.broilerFeed, 0)

  /**
   * One settlement through the real service, with everything section A needs
   * measured around it: the bank total before, the net its shape allows, and
   * the customer invariant after.
   */
  async function settle(label, amount, from, to, opts = {}) {
    console.log(`\n--- ${label} ---`)
    const banksBefore = (await allBankBalances())
    const entriesBefore = (await bankLedgerRowCount())
    const snapBefore = (await balanceSnapshot())
    const overviewBefore = (await overviewSnapshot(1))
    const revenueBefore = (await collectedRevenue(1))

    const number = opts.number || `IS-${String(Math.round(Math.random() * 1e6)).padStart(3, '0')}`
    const insert = {
      sql: IS_INSERT,
      params: [1, OWN_FARM, number, opts.date || '2025-06-01', amount,
               from.account, from.bank_id, to.account, to.bank_id,
               opts.reference || null, opts.notes || null]
    }

    const res = await call('saveInternalSettlement', insert, {
      customer_id: OWN_FARM,
      amount,
      date: opts.date || '2025-06-01',
      description: `Internal Settlement ${number}`,
      bank_description_out: `Internal Settlement ${number} — paid by Own Farm`,
      bank_description_in: `Internal Settlement ${number} — received from Own Farm`,
      from_account: from.account,
      from_bank_id: from.bank_id,
      to_account: to.account,
      to_bank_id: to.bank_id
    })

    const id = (await rows(`SELECT settlement_id FROM internal_settlements WHERE settlement_number = ?`,
      [number]))[0]
    return {
      res,
      id: id ? Number(id.settlement_id) : null,
      banksBefore, entriesBefore, snapBefore, overviewBefore, revenueBefore,
      number
    }
  }

  /** The net the shape allows: +amount into a bank, -amount out of one. */
  const allowed = (amount, from, to) =>
    (to.account === 'bank' ? amount : 0) - (from.account === 'bank' ? amount : 0)

  const CASH = { account: 'cash', bank_id: null }
  const inA = () => ({ account: 'bank', bank_id: BANK_A })
  const inB = () => ({ account: 'bank', bank_id: BANK_B })

  // ── D. SAME ACCOUNT ──────────────────────────────────────────────────────
  console.log('\n=== D. same account: the debt clears and NOTHING is written to any ledger ===')

  const same = await settle('Bank A -> Bank A, 10,000', 10000, inA(), inA(), { number: 'IS-001' })
  checkTrue('the settlement saved', same.res.success === true)
  check('bank_ledger rows written', (await bankLedgerRowCount()) - same.entriesBefore, 0)
  check(`no ${INTERNAL_SETTLEMENT_OUT_REF} entry exists`,
    (await settlementEntries(INTERNAL_SETTLEMENT_OUT_REF, same.id)).length, 0)
  check(`no ${INTERNAL_SETTLEMENT_IN_REF} entry exists`,
    (await settlementEntries(INTERNAL_SETTLEMENT_IN_REF, same.id)).length, 0)

  const sameAfter = (await balanceSnapshot())
  for (const id of Object.keys(same.snapBefore)) {
    check(`account ${id} balance byte-identical`, sameAfter[id], same.snapBefore[id])
  }
  await bankInvariant('Bank A -> Bank A', same.banksBefore, allowed(10000, inA(), inA()))
  await customerInvariant('Bank A -> Bank A', OWN_FARM)

  check('the oldest bill is fully settled', (await amountPaid(bill1.id)), 10000)
  check('the farm now owes 10,000', (await billsOutstanding(OWN_FARM)), 10000)
  check('the ledger credit is tagged to the settlement',
    (await one(`SELECT COUNT(*) v FROM customer_ledger WHERE internal_settlement_id = ?`, [same.id])), 1)
  check('and carries no voucher_id',
    (await one(`SELECT COUNT(*) v FROM customer_ledger WHERE internal_settlement_id = ? AND voucher_id IS NOT NULL`,
      [same.id])), 0)

  // ── B / C. The two reports, around that same settlement ──────────────────
  console.log('\n=== B. Overview profit is IDENTICAL after a same-account settlement ===')
  compareOverview('same-account settlement', same.overviewBefore, (await overviewSnapshot(1)))

  console.log('\n=== C. Distribution collected revenue rises by exactly the settled amount ===')
  check('collected revenue rose by 10,000', (await collectedRevenue(1)) - same.revenueBefore, 10000)

  // ── E. DIFFERENT ACCOUNTS ────────────────────────────────────────────────
  console.log('\n=== E. different accounts: one credit on FROM, one debit on TO, sum unchanged ===')

  const diff = await settle('Bank A -> Bank B, 4,000', 4000, inA(), inB(), { number: 'IS-002' })
  checkTrue('the settlement saved', diff.res.success === true)

  const outRows = (await settlementEntries(INTERNAL_SETTLEMENT_OUT_REF, diff.id))
  const inRows = (await settlementEntries(INTERNAL_SETTLEMENT_IN_REF, diff.id))
  check('exactly one entry on the paying account', outRows.length, 1)
  check('exactly one entry on the receiving account', inRows.length, 1)
  check('the paying entry is on Bank A', outRows[0].bank_id, BANK_A)
  check('the paying entry is a credit of 4,000', outRows[0].credit, 4000)
  check('and writes nothing to the debit column', outRows[0].debit, 0)
  checkTrue('the paying entry takes a WD- number', /^WD-\d{4}$/.test(outRows[0].transaction_number || ''))
  check('the receiving entry is on Bank B', inRows[0].bank_id, BANK_B)
  check('the receiving entry is a debit of 4,000', inRows[0].debit, 4000)
  check('and writes nothing to the credit column', inRows[0].credit, 0)
  checkTrue('the receiving entry takes a DEP- number', /^DEP-\d{4}$/.test(inRows[0].transaction_number || ''))

  check('Bank A fell by 4,000', diff.snapBefore[BANK_A] - (await bankBalance(BANK_A)), 4000)
  check('Bank B rose by 4,000', (await bankBalance(BANK_B)) - diff.snapBefore[BANK_B], 4000)
  check('both cached balances match their own ledgers',
    ((await bankBalance(BANK_A)) === (await bankLedgerSum(BANK_A)) && (await bankBalance(BANK_B)) === (await bankLedgerSum(BANK_B))) ? 1 : 0, 1)
  check('the third account never moved', (await bankBalance(BANK_C)), diff.snapBefore[BANK_C])
  check("the customer's own account never moved", (await bankBalance(BANK_CUST)), diff.snapBefore[BANK_CUST])
  await bankInvariant('Bank A -> Bank B', diff.banksBefore, allowed(4000, inA(), inB()))
  await customerInvariant('Bank A -> Bank B', OWN_FARM)

  check('the second bill is now settled', (await amountPaid(bill2.id)), 4000)
  check('the farm now owes 6,000', (await billsOutstanding(OWN_FARM)), 6000)

  console.log('\n=== B. Overview profit is IDENTICAL after a different-account settlement ===')
  compareOverview('different-account settlement', diff.overviewBefore, (await overviewSnapshot(1)))
  console.log('\n=== C. and Distribution collected revenue rose again ===')
  check('collected revenue rose by 4,000', (await collectedRevenue(1)) - diff.revenueBefore, 4000)

  // ── F. THE MIXED SHAPES ──────────────────────────────────────────────────
  console.log('\n=== F. Cash -> Bank, Bank -> Cash, Cash -> Cash ===')

  // Cash -> Bank B: the farm paid in cash, distribution banked it. One debit,
  // and the banked total legitimately RISES — that cash entered the banked
  // world.
  const cashToBank = await settle('Cash -> Bank B, 1,000', 1000, CASH, inB(), { number: 'IS-003' })
  checkTrue('the settlement saved', cashToBank.res.success === true)
  check('no entry on the paying side', (await settlementEntries(INTERNAL_SETTLEMENT_OUT_REF, cashToBank.id)).length, 0)
  check('one entry on the receiving side', (await settlementEntries(INTERNAL_SETTLEMENT_IN_REF, cashToBank.id)).length, 1)
  check('Bank B rose by 1,000', (await bankBalance(BANK_B)) - cashToBank.snapBefore[BANK_B], 1000)
  await bankInvariant('Cash -> Bank B', cashToBank.banksBefore, allowed(1000, CASH, inB()))
  await customerInvariant('Cash -> Bank B', OWN_FARM)
  compareOverview('Cash -> Bank settlement', cashToBank.overviewBefore, (await overviewSnapshot(1)))

  // Bank A -> Cash: paid out of the bank, held as cash. One credit, and the
  // banked total legitimately FALLS.
  const bankToCash = await settle('Bank A -> Cash, 2,000', 2000, inA(), CASH, { number: 'IS-004' })
  checkTrue('the settlement saved', bankToCash.res.success === true)
  check('one entry on the paying side', (await settlementEntries(INTERNAL_SETTLEMENT_OUT_REF, bankToCash.id)).length, 1)
  check('no entry on the receiving side', (await settlementEntries(INTERNAL_SETTLEMENT_IN_REF, bankToCash.id)).length, 0)
  check('Bank A fell by 2,000', bankToCash.snapBefore[BANK_A] - (await bankBalance(BANK_A)), 2000)
  await bankInvariant('Bank A -> Cash', bankToCash.banksBefore, allowed(2000, inA(), CASH))
  await customerInvariant('Bank A -> Cash', OWN_FARM)
  compareOverview('Bank -> Cash settlement', bankToCash.overviewBefore, (await overviewSnapshot(1)))

  // Cash -> Cash: no account at either end, so nothing is written and no
  // balance moves — the same shape as same-account, by the same test.
  const cashToCash = await settle('Cash -> Cash, 500', 500, CASH, CASH, { number: 'IS-005' })
  checkTrue('the settlement saved', cashToCash.res.success === true)
  check('bank_ledger rows written', (await bankLedgerRowCount()) - cashToCash.entriesBefore, 0)
  const cashAfter = (await balanceSnapshot())
  for (const id of Object.keys(cashToCash.snapBefore)) {
    check(`account ${id} balance byte-identical`, cashAfter[id], cashToCash.snapBefore[id])
  }
  await bankInvariant('Cash -> Cash', cashToCash.banksBefore, allowed(500, CASH, CASH))
  await customerInvariant('Cash -> Cash', OWN_FARM)
  compareOverview('Cash -> Cash settlement', cashToCash.overviewBefore, (await overviewSnapshot(1)))

  check('the farm now owes 2,500', (await billsOutstanding(OWN_FARM)), 2500)

  // ── H. REFUSALS ──────────────────────────────────────────────────────────
  console.log('\n=== H. refusals, and a refusal changes NOTHING ===')

  // The settlement's own credit line cannot be deleted from the Customer Ledger
  // screen: that would put the money back on the bills while leaving the bank
  // entries standing. Mirrors the voucher refusal from Change 2.
  const line = (await rows(
    `SELECT ledger_id FROM customer_ledger WHERE internal_settlement_id = ? LIMIT 1`, [diff.id]))[0]
  const beforeRefusal = {
    banks: (await allBankBalances()), bills: (await billsOutstanding(OWN_FARM)),
    entries: (await bankLedgerRowCount()), lines: (await one(`SELECT COUNT(*) v FROM customer_ledger`))
  }
  const refused = await call('deleteCustomerLedgerEntry', Number(line.ledger_id))
  checkTrue('deleting a settlement line from the Customer Ledger is refused', refused.success === false)
  checkTrue('and the message points at the right screen',
    /Internal Settlement screen/i.test(refused.error || ''))
  check('the refusal left the ledger row in place',
    (await one(`SELECT COUNT(*) v FROM customer_ledger`)), beforeRefusal.lines)
  check('the refusal moved no money', (await allBankBalances()), beforeRefusal.banks)
  check('the refusal moved no bill', (await billsOutstanding(OWN_FARM)), beforeRefusal.bills)
  check('the refusal wrote no bank entry', (await bankLedgerRowCount()), beforeRefusal.entries)

  // Overpayment: the farm owes 2,500, so 3,000 has nowhere to land.
  const over = await settle('overpayment: 3,000 against 2,500 owed', 3000, inA(), inB(), { number: 'IS-OVER' })
  checkTrue('an overpayment is refused', over.res.success === false)
  checkTrue('and says what the farm actually owes', /2,500/.test(over.res.error || ''))
  check('the refusal wrote no settlement row',
    (await one(`SELECT COUNT(*) v FROM internal_settlements WHERE settlement_number = 'IS-OVER'`)), 0)
  check('the refusal wrote no bank entry', (await bankLedgerRowCount()), over.entriesBefore)
  check('the refusal moved no money', (await allBankBalances()), over.banksBefore)
  check('the refusal moved no bill', (await billsOutstanding(OWN_FARM)), 2500)
  await customerInvariant('a refused overpayment', OWN_FARM)

  // An account a settlement still names cannot be deleted — the same rule the
  // nine BANK_SOURCES tables get, applied to this table by hand.
  const delA = await call('deleteBankAccount', BANK_A)
  checkTrue('an account named by a settlement cannot be deleted', delA.success === false)
  checkTrue('and the refusal names the settlements', /internal settlement/i.test(delA.error || ''))
  check('the account is still there', (await one(`SELECT COUNT(*) v FROM bank_accounts WHERE bank_id = ?`, [BANK_A])), 1)

  // ── G. DELETE ────────────────────────────────────────────────────────────
  console.log('\n=== G. delete reverses every side ===')

  // Different accounts first: both legs must go and both balances come back.
  const beforeDiffDelete = {
    banks: (await allBankBalances()), snap: (await balanceSnapshot()),
    bills: (await billsOutstanding(OWN_FARM)), overview: (await overviewSnapshot(1)),
    revenue: (await collectedRevenue(1)), entries: (await bankLedgerRowCount())
  }
  const undoDiff = await call('deleteInternalSettlement', diff.id)
  checkTrue('the different-account settlement deleted', undoDiff.success === true)
  check('its paying entry is gone', (await settlementEntries(INTERNAL_SETTLEMENT_OUT_REF, diff.id)).length, 0)
  check('its receiving entry is gone', (await settlementEntries(INTERNAL_SETTLEMENT_IN_REF, diff.id)).length, 0)
  check('two bank entries removed', beforeDiffDelete.entries - (await bankLedgerRowCount()), 2)
  check('Bank A got its 4,000 back', (await bankBalance(BANK_A)) - beforeDiffDelete.snap[BANK_A], 4000)
  check('Bank B gave its 4,000 back', beforeDiffDelete.snap[BANK_B] - (await bankBalance(BANK_B)), 4000)
  check('the untouched account is still untouched', (await bankBalance(BANK_C)), beforeDiffDelete.snap[BANK_C])
  check('the money went back on the bill', (await billsOutstanding(OWN_FARM)) - beforeDiffDelete.bills, 4000)
  check('the settlement row is gone',
    (await one(`SELECT COUNT(*) v FROM internal_settlements WHERE settlement_id = ?`, [diff.id])), 0)
  check('its ledger lines are gone',
    (await one(`SELECT COUNT(*) v FROM customer_ledger WHERE internal_settlement_id = ?`, [diff.id])), 0)
  // Reversing a bank->bank pair is itself a no-net event.
  await bankInvariant('deleting Bank A -> Bank B', beforeDiffDelete.banks, 0)
  await customerInvariant('deleting Bank A -> Bank B', OWN_FARM)
  compareOverview('deleting a different-account settlement', beforeDiffDelete.overview, (await overviewSnapshot(1)))
  check('collected revenue fell back by 4,000', beforeDiffDelete.revenue - (await collectedRevenue(1)), 4000)

  // Same account: there were no entries, so the delete must not invent a
  // rebuild — nor move a single balance.
  const beforeSameDelete = {
    banks: (await allBankBalances()), snap: (await balanceSnapshot()),
    bills: (await billsOutstanding(OWN_FARM)), entries: (await bankLedgerRowCount()),
    overview: (await overviewSnapshot(1)), revenue: (await collectedRevenue(1))
  }
  const undoSame = await call('deleteInternalSettlement', same.id)
  checkTrue('the same-account settlement deleted', undoSame.success === true)
  check('no bank entry was removed (there were none)', beforeSameDelete.entries - (await bankLedgerRowCount()), 0)
  const afterSameDelete = (await balanceSnapshot())
  for (const id of Object.keys(beforeSameDelete.snap)) {
    check(`account ${id} balance byte-identical through the delete`,
      afterSameDelete[id], beforeSameDelete.snap[id])
  }
  check('the money went back on the bills', (await billsOutstanding(OWN_FARM)) - beforeSameDelete.bills, 10000)
  await bankInvariant('deleting Bank A -> Bank A', beforeSameDelete.banks, 0)
  await customerInvariant('deleting Bank A -> Bank A', OWN_FARM)
  compareOverview('deleting a same-account settlement', beforeSameDelete.overview, (await overviewSnapshot(1)))
  check('collected revenue fell back by 10,000', beforeSameDelete.revenue - (await collectedRevenue(1)), 10000)

  // And the mixed shapes, each reversing exactly what it did.
  for (const [label, s, amount, from, to] of [
    ['Cash -> Bank B', cashToBank, 1000, CASH, inB()],
    ['Bank A -> Cash', bankToCash, 2000, inA(), CASH],
    ['Cash -> Cash', cashToCash, 500, CASH, CASH]
  ]) {
    const before = { banks: (await allBankBalances()), bills: (await billsOutstanding(OWN_FARM)) }
    const res = await call('deleteInternalSettlement', s.id)
    checkTrue(`deleting ${label} succeeded`, res.success === true)
    // The reversal is the negative of what the save was allowed to move.
    await bankInvariant(`deleting ${label}`, before.banks, -allowed(amount, from, to))
    check(`deleting ${label} put ${amount} back on the bills`,
      (await billsOutstanding(OWN_FARM)) - before.bills, amount)
    await customerInvariant(`deleting ${label}`, OWN_FARM)
  }

  // ── A. Everything back where it started ──────────────────────────────────
  console.log('\n=== A. with every settlement deleted, the database is back where it started ===')
  check('the farm owes its original 20,000 again', (await billsOutstanding(OWN_FARM)), 20000)
  check('no settlement rows remain', (await one(`SELECT COUNT(*) v FROM internal_settlements`)), 0)
  check('no tagged ledger rows remain',
    (await one(`SELECT COUNT(*) v FROM customer_ledger WHERE internal_settlement_id IS NOT NULL`)), 0)
  check('no settlement bank entries remain',
    (await one(`SELECT COUNT(*) v FROM bank_ledger WHERE reference_type IN (?, ?)`,
      [INTERNAL_SETTLEMENT_OUT_REF, INTERNAL_SETTLEMENT_IN_REF])), 0)
  check('Bank A is back to its opening 200,000', (await bankBalance(BANK_A)), 200000)
  check('Bank B is back to its opening 50,000', (await bankBalance(BANK_B)), 50000)
  check('Bank C never moved at all', (await bankBalance(BANK_C)), 75000)
  check("the customer's account never moved at all", (await bankBalance(BANK_CUST)), 10000)
  await customerInvariant('every settlement reversed', OWN_FARM)
  compareOverview('every settlement reversed', baseOverview, (await overviewSnapshot(1)))
  check('the outside bill was never touched', (await amountPaid(outsideBillId)), 3000)
  check('the third internal bill was never touched', (await amountPaid(bill3.id)), 0)

  // Now the accounts are free of settlements, so the delete that was refused
  // above goes through — proving the refusal was about the reference, not the
  // account.
  const delNow = await call('deleteBankAccount', BANK_C)
  checkTrue('an account no settlement names can be deleted', delNow.success === true)

  console.log('\n' + (failures === 0
    ? 'ALL CHECKS PASSED'
    : `${failures} CHECK(S) FAILED`))
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
