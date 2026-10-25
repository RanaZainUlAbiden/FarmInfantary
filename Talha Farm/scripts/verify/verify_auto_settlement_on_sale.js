// AUTO-SETTLEMENT ON A BANK SALE — the owner's farm clearing what it owes his
// distribution business at the moment the sale lands in his account.
//
// Distribution billed the flock for feed (an own-farm bill); the flock carried
// the cost and the debt; the flock sold its birds into one of the owner's own
// bank accounts. Until now the debt was cleared by hand on the Internal
// Settlement screen. Now the sale can clear it in the SAME batch, as a
// SAME-ACCOUNT internal settlement — which is the whole reason this file
// exists, because a same-account settlement writes ZERO bank_ledger rows and
// anything else would move the account by the wrong amount.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, the atomic writer from runBatch(), the
// settlement/reversal/bank methods lifted out of database.service.ts, the
// consolidation queries lifted out of overview.service.ts, the three sale
// screens' own INSERTs lifted out of their components as text, and the broiler
// screen's real `autoSettleTargetFor()` / `autoSettlePreview` — which ARE the
// checkbox's visibility rule. Nothing is a restatement.
//
// What is proved:
//   A. THE TWO INVARIANTS. After a bank sale that auto-settles:
//        - the sale's account moved by exactly the SALE amount, not by
//          sale - settlement;
//        - the sum of ALL bank balances moved by exactly the sale amount, so
//          the settlement moved no money anywhere;
//        - not one bank_ledger row carries either settlement reference_type;
//        - the own-farm customer's outstanding fell by exactly the settled
//          amount, on all three derivations of it;
//        - distribution's collected-basis revenue rose by exactly that amount;
//        - and OVERVIEW PROFIT IS IDENTICAL, field by field, because an
//          own-farm bill is eliminated on its whole total_amount regardless of
//          what has been settled. That is the double-counting guard: the owner
//          must not be able to manufacture profit by billing himself and then
//          paying himself.
//   B. MULTI-BILL FIFO — oldest bill first, and the allocation is identical to
//      the one a RECEIVE VOUCHER produces for the same input, bill for bill and
//      ledger row for ledger row. Two doors onto one settlement must not
//      disagree about what a customer owes.
//   C. THE BOUNDS — sale < debt (partial), sale = debt (exact), sale > debt
//      (full, extra stays in the account), each asserted on both invariants.
//   D. OPT-OUT — unticked writes no settlement at all: the sale saves with only
//      its own deposit and the debt is untouched.
//   E. CASH SALE — no settlement, and the bar does not appear.
//   F. NO OWN-FARM CUSTOMER / NO DEBT — nothing to settle, and the real
//      preview getter returns null, which is what hides the checkbox.
//   G. DELETION — deleting the sale reverses both sides: the deposit goes, the
//      settlement is un-made, and the debt comes back.
//   H. THE THREE SCREENS — broiler, egg and hen write the same settlement row
//      shape and hold the same invariants, each keyed to its own table so a
//      colliding sale id in another table is never touched.
//   I. SCREEN SQL + PARAMETER ORDER — the three sale INSERTs and the real
//      settlement INSERT executed against the real schema with a distinct
//      sentinel per parameter, because TypeScript cannot see a placeholder
//      count or an order that stopped matching the column list. Plus: each
//      screen really does call buildAutoSettleOps / deleteAutoSettlementFor
//      with its OWN source string, and really does guard the call on the
//      checkbox.
//   J. THE CASCADE. Closing a flock or a batch deletes its sales and reverses
//      their deposits, and MUST take their auto-settlements with them: the
//      settlement wrote no bank row, so the sale is the only thing that ever
//      funded it, and leaving it standing would clear a debt from nothing —
//      account back where it started, debt still paid. An auto-settlement is
//      SALE-scoped, not account-scoped, which is what puts it in a cascade
//      when no hand-entered settlement or voucher belongs in one; this section
//      pins both halves of that, the shared give-back across two settlements
//      that drew on one bill, and the colliding flock/batch ids.
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
const OV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')
const SALE_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'sale', 'sale.component.ts'), 'utf8')
const EGG_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'egg-sales', 'egg-sales.component.ts'), 'utf8')
const HEN_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'hen-sales', 'hen-sales.component.ts'), 'utf8')
const RV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'receive-voucher', 'receive-voucher.component.ts'), 'utf8')
const SALE_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'sale', 'sale.component.html'), 'utf8')
const EGG_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'egg-sales', 'egg-sales.component.html'), 'utf8')
const HEN_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'hen-sales', 'hen-sales.component.html'), 'utf8')

// Two utils are transpiled and eval'd WHOLE so the lifted screen getters bind
// to the real functions rather than to a restatement: bill-source.util.ts for
// the distribution-only filter inside Overview's bill queries, and
// bank-source.util.ts for `bankSourceFields()` / `bankOptionLabel()`, which the
// screens' own auto-settle logic calls. Function declarations in a direct eval
// reach module scope the way `var` does.
for (const util of ['bill-source.util.ts', 'bank-source.util.ts']) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'utils', util), 'utf8')
  eval(ts.transpileModule(src.replace(/^export /gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText)
}

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

// The engine. runBatch and executeStatement close over module-level state in
// database.js, so those names are declared here for the eval'd copies to bind
// to — this is the real writer, savepoints, $lastId resolution and all.
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

// Read off the real declarations rather than restated, so a renamed
// reference_type or a flipped direction breaks this file instead of passing.
const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()

const AUTO_SETTLE_TABLES = (() => {
  const start = SVC_SRC.indexOf('private static readonly AUTO_SETTLE_TABLES')
  if (start < 0) throw new Error('AUTO_SETTLE_TABLES not found')
  const open = SVC_SRC.indexOf('{', SVC_SRC.indexOf('=', start))
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()

const AUTO_SETTLE_OWNERS = (() => {
  const start = SVC_SRC.indexOf('private static readonly AUTO_SETTLE_OWNERS = {')
  if (start < 0) throw new Error('AUTO_SETTLE_OWNERS not found')
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
  AUTO_SETTLE_OWNERS,
  AUTO_SETTLE_TABLES,
  INTERNAL_SETTLEMENT_OUT_REF,
  INTERNAL_SETTLEMENT_IN_REF
}

function rows(sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

// ── The service under test ──────────────────────────────────────────────────

const svc = {
  toLocalDateString: () => '2025-06-01',
  async get(sql, params = []) {
    try { return { success: true, data: rows(sql, params) } }
    catch (err) { return { success: false, error: err.message } }
  },
  async run(sql, params = []) {
    try { return { success: true, ...executeStatement(sql, params) } }
    catch (err) { return { success: false, error: err.message } }
  },
  async runBatch(ops) { return runBatch(ops) },

  // The bank mechanism the sale's own deposit rides on.
  bankBalanceSql:            loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql:  loadMethod('nextTransactionNumberSql', 'private '),
  rebuildBankBalanceOp:      loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:              loadMethod('bankEntryOps', 'private '),
  bankWithdrawalOps:         loadMethod('bankWithdrawalOps', 'private '),
  bankReversalOps:           loadMethod('bankReversalOps', 'private '),
  bankSource:                loadMethod('bankSource', 'private '),
  bankIdOf:                  loadMethod('bankIdOf', 'private '),
  bankSourceExisting:        loadMethod('bankSourceExisting', 'private async '),
  bankSourceInsertOps:       loadMethod('bankSourceInsertOps'),
  bankSourceDelta:           loadMethod('bankSourceDelta', 'private '),
  bankRebuildOps:            loadMethod('bankRebuildOps'),
  bankCascadeReversalOps:    loadMethod('bankCascadeReversalOps', 'async '),
  deleteBankSourced:         loadMethod('deleteBankSourced', 'async '),

  // The save-time balance guard. These scripts bind the real method bodies onto
  // this one object, so a new `this.` dependency has to be registered here or
  // the method under test throws instead of running.
  bankAmountText:            loadMethod('bankAmountText', 'private '),
  checkBankBalances:         loadMethod('checkBankBalances', 'async '),
  checkBankSourceInserts:    loadMethod('checkBankSourceInserts', 'async '),
  getBankAccounts:           loadMethod('getBankAccounts', 'async '),
  getHouseBankAccounts:      loadMethod('getHouseBankAccounts', 'async '),
  addBankAccount:            loadMethod('addBankAccount', 'async '),
  linkCustomerToBank:        loadMethod('linkCustomerToBank', 'async '),

  // The settlement, its reversal, and the reads around them.
  rebuildCustomerBalanceOp:  loadMethod('rebuildCustomerBalanceOp', 'private '),
  updateCustomerOutstandingBalance: loadMethod('updateCustomerOutstandingBalance', 'async '),
  getUnpaidBills:            loadMethod('getUnpaidBills', 'async '),
  customerSettlementOps:     loadMethod('customerSettlementOps'),
  customerUnwindOps:         loadMethod('customerUnwindOps', 'private async '),
  deleteCustomerLedgerEntry: loadMethod('deleteCustomerLedgerEntry', 'async '),
  getAllCustomersWithBalance: loadMethod('getAllCustomersWithBalance', 'async '),
  addCustomerLedgerEntry:    loadMethod('addCustomerLedgerEntry', 'async '),
  settlementBankId:          loadMethod('settlementBankId', 'private '),
  saveInternalSettlement:    loadMethod('saveInternalSettlement', 'async '),
  deleteInternalSettlement:  loadMethod('deleteInternalSettlement', 'async '),

  // The other door onto the same FIFO, for the equivalence check in section B.
  saveReceiveVoucher:        loadMethod('saveReceiveVoucher', 'async '),

  // THIS CHANGE.
  nextSettlementNumberSql:   loadMethod('nextSettlementNumberSql', 'private '),
  getOwnFarmDebtByOwner:     loadMethod('getOwnFarmDebtByOwner', 'async '),
  buildAutoSettleOps:        loadMethod('buildAutoSettleOps', 'async '),
  deleteAutoSettlementFor:   loadMethod('deleteAutoSettlementFor', 'async '),
  autoSettlementCascadeReversalOps: loadMethod('autoSettlementCascadeReversalOps', 'async ')
}
// addBankAccount() calls the module-scope toLocalDateString() of the real
// service file, which an eval'd copy cannot see.
global.toLocalDateString = svc.toLocalDateString
const call = (name, ...args) => svc[name].apply(svc, args)

// The broiler screen's REAL target rule and REAL preview getter — the checkbox's
// visibility and its figure are component code, so they are lifted too and
// bound onto a stand-in for the component. `bankSourceFields` and
// `bankOptionLabel` resolve to the real utils eval'd above.
const screen = {
  currentFlock: null,
  pendingRows: [],
  houseBanks: [],
  autoSettle: true,
  autoSettleTargets: new Map(),
  getRowBirdWeight: loadFrom(SALE_SRC, 'getRowBirdWeight'),
  getRowTotal: loadFrom(SALE_SRC, 'getRowTotal'),
  bankNameOf: loadFrom(SALE_SRC, 'bankNameOf'),
  bankOptionLabelFor: loadFrom(SALE_SRC, 'bankOptionLabelFor', 'private '),
  autoSettleTargetFor: loadFrom(SALE_SRC, 'autoSettleTargetFor'),
  autoSettlePreview: loadFrom(SALE_SRC, 'autoSettlePreview', 'get ')
}
const preview = () => screen.autoSettlePreview()
const targetFor = (row) => screen.autoSettleTargetFor.call(screen, row)

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

const one = (sql, params = []) => Number(rows(sql, params)[0].v)

const billsOutstanding = (customerId) => one(
  `SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)), 0) v
   FROM bills WHERE customer_id = ?`, [customerId])
const ledgerOutstanding = (customerId) => one(
  `SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)), 0) v
   FROM customer_ledger WHERE customer_id = ?`, [customerId])
const cachedOutstanding = (customerId) => one(
  `SELECT COALESCE(outstanding_balance, 0) v FROM customers WHERE customer_id = ?`, [customerId])
const amountPaid = (billId) => one(
  `SELECT COALESCE(amount_paid,0) v FROM bills WHERE bill_id = ?`, [billId])
const bankBalance = (bankId) => one(
  `SELECT COALESCE(current_balance,0) v FROM bank_accounts WHERE bank_id = ?`, [bankId])
const allBankBalances = () => one(
  `SELECT COALESCE(SUM(COALESCE(current_balance,0)), 0) v FROM bank_accounts`)
const settlementBankRows = () => one(
  `SELECT COUNT(*) v FROM bank_ledger WHERE reference_type IN (?, ?)`,
  [INTERNAL_SETTLEMENT_OUT_REF, INTERNAL_SETTLEMENT_IN_REF])

/** The figure Overview and the Distribution report actually read as revenue. */
const collectedRevenue = (farmId) => one(
  `SELECT COALESCE(SUM(MIN(MAX(COALESCE(amount_paid,0), 0), COALESCE(total_amount,0))), 0) v
   FROM bills WHERE farm_id = ?`, [farmId])

/**
 * THE CUSTOMER INVARIANT, asserted after every mutation. The statement the farm
 * reads and the debt it is billed for are two derivations of the same money;
 * they must land on the same number, and the cached column — what Sales Orders
 * and the reports read — with both.
 */
async function customerInvariant(label, customerId) {
  const fromBills = billsOutstanding(customerId)
  const fromLedger = ledgerOutstanding(customerId)
  const cached = cachedOutstanding(customerId)
  const listed = ((await call('getAllCustomersWithBalance', 1)).data || [])
    .find(c => Number(c.customer_id) === customerId)
  const ok = fromBills === fromLedger && cached === fromBills &&
             (!listed || Number(listed.outstanding_balance) === fromBills)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  CUSTOMER INVARIANT after ${label}: ` +
    `bills=${fromBills} ledger=${fromLedger} cached=${cached}`)
}

/**
 * THE BANK INVARIANT — the heart of section A.
 *
 * A bank sale that auto-settles moves the account by the SALE AMOUNT ONLY: the
 * settlement names the same account at both ends, so no money crossed an
 * account boundary and nothing at all is written for it. `sale - settled` would
 * be the wrong answer, and so would any bank_ledger row carrying a settlement
 * reference_type.
 */
function bankInvariant(label, beforeAll, beforeOne, bankId, saleAmount) {
  check(`${label} — account ${bankId} moved by the SALE amount`,
    Math.round((bankBalance(bankId) - beforeOne) * 100) / 100, saleAmount)
  check(`${label} — ALL bank balances moved by the sale amount`,
    Math.round((allBankBalances() - beforeAll) * 100) / 100, saleAmount)
  check(`${label} — bank_ledger rows written for the settlement`, settlementBankRows(), 0)
  const drifted = one(
    `SELECT COUNT(*) v FROM bank_accounts ba
     WHERE COALESCE(ba.current_balance, 0) <> (
       SELECT COALESCE(SUM(COALESCE(bl.debit,0) - COALESCE(bl.credit,0)), 0)
       FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)`)
  check(`${label} — accounts whose cached balance drifted`, drifted, 0)
}

/**
 * Everything the Overview dashboard derives from these tables, as one object,
 * so two states can be compared field by field. This is the account-level
 * picture the internal elimination holds still: settling a debt the owner owes
 * himself must not move any of it.
 */
function overviewSnapshot(farmId, range = {}) {
  const one_ = (spec) => {
    const [sql, params] = spec
    return rows(sql, params)[0] || {}
  }
  const sumUnits = (spec) => {
    const [sql, params] = spec
    return rows(sql, params).reduce((s, r) => s + Number(r.amount || 0), 0)
  }

  const distributionRevenue = Number(one_(ctx.qDistributionBills.call(ctx, farmId, range)).amount || 0)
  const distributionUnpaid = Number(one_(ctx.qDistributionUnpaid.call(ctx, farmId, range)).amount || 0)
  const cogs = Number(one_(ctx.qDistributionCogs.call(ctx, farmId, range)).amount || 0)
  const distExpenses = Number(one_(ctx.qDistributionExpenses.call(ctx, farmId, range)).amount || 0)

  const broilerFeed = sumUnits(ctx.qTraderEntries.call(ctx, farmId, range, 'broiler', 'feed'))
  const broilerMedicine = sumUnits(ctx.qTraderEntries.call(ctx, farmId, range, 'broiler', 'medicine'))
  const broilerGeneral = sumUnits(ctx.qExpenses.call(ctx, farmId, range, 'broiler'))

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

const FARM = 1
const UNIT_BROILER = 1        // farm unit the flock sits in
const UNIT_LAYER = 2          // farm unit the batch sits in
const UNIT_ORPHAN = 3         // a unit with NO own-farm customer (section F)
const FLOCK = 1               // flock_id 1 and batch_id 1 COLLIDE, deliberately
const BATCH = 1
const FLOCK_ORPHAN = 2
const OWN_BROILER = 500       // own-farm customer for UNIT_BROILER
const OWN_LAYER = 501         // own-farm customer for UNIT_LAYER
const MIRROR = 502            // an identical farm, settled by voucher (section B)
const OUTSIDE = 600           // a real outside customer, so every figure is non-zero
const BANK_A = 10
const BANK_B = 11
const BANK_CUST = 12          // a CUSTOMER's account: must never be touched
let nextBillId = 1

/**
 * An own-farm bill in the shape sales-orders.component.ts writes today: billed
 * to a real `customers` row of `customer_type = 'own_farm'`, `payment_type =
 * 'internal'`, unpaid, with the farm-side cost row at the SELLING price and the
 * `internal_transfers` join row that lets Overview eliminate both sides.
 */
function internalBill(customerId, total, date, flockId) {
  const id = nextBillId++
  const num = `BILL-${String(id).padStart(3, '0')}`
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (?,1,?,?,'Own Farm',?,?,?,0,'internal')`, [id, num, customerId, date, total, total])
  db.run(`INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (?,100,'Starter Feed',?,1000,?)`, [id, total / 1000, total])
  db.run(`INSERT INTO batch_transactions (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
          VALUES (200,100,'sale',?,?,?,'Sale order')`, [total / 1000, date, id])
  db.run(`INSERT INTO feed_traders (trader_id, flock_id, trader_name, module_type)
          VALUES (?,?,'Internal Distribution','broiler')`, [id, flockId])
  db.run(`INSERT INTO feed_entries (entry_id, trader_id, flock_id, date, feed_name, quantity,
                                    price_per_unit, total_amount, module_type, bill_id, bill_number)
          VALUES (?,?,?,?,'Starter Feed',?,1000,?,'broiler',?,?)`,
    [id, id, flockId, date, total / 1000, total, id, num])
  db.run(`INSERT INTO internal_transfers (bill_id, target_module, target_flock_id, target_type, reference_id)
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

// ── The screens' own statements ─────────────────────────────────────────────
//
// Lifted as text, executed for real. The parameter arrays below are the ones
// the screens build, in the screens' order.

const SALE_INSERT = liftSql(SALE_SRC, 'INSERT INTO sales (flock_id, date, vehicle_number')
const EGG_INSERT = liftSql(EGG_SRC, 'INSERT INTO egg_sales (batch_id, date, customer_id')
const HEN_INSERT = liftSql(HEN_SRC, 'INSERT INTO hen_sales (batch_id, date, customer_id')
const RV_INSERT = liftSql(RV_SRC, 'INSERT INTO receive_vouchers')

/** How each screen spells its own sale row, and which BANK_SOURCES key it is. */
const SCREENS = {
  broiler_sale: {
    key: 'sales', pk: 'sale_id', table: 'sales', owner: 'flock', ownerId: FLOCK,
    label: 'Broiler Sale', sql: SALE_INSERT,
    params: (row, bank) => [FLOCK, row.date, 'LEB-1234', 'Driver', '0300',
      'Broker One', 0, row.amount, row.amount, 1, row.amount,
      row.payment_type, bank.payment_source, bank.bank_id, null, 'broiler'],
    // The broiler screen omits `referenceId` and takes the default {$lastId:-1}.
    deposit: (bank, row) => ({ ...bank, date: row.date, description: 'Broiler sale', amount: row.amount })
  },
  egg_sale: {
    key: 'egg_sales', pk: 'egg_sale_id', table: 'egg_sales', owner: 'batch', ownerId: BATCH,
    label: 'Egg Sale', sql: EGG_INSERT,
    params: (row, bank) => [BATCH, row.date, null, '', 'mixed', row.amount, 1, row.amount,
      row.payment_type, bank.payment_source, bank.bank_id, 'per_egg', null, 360],
    deposit: (bank, row, saleOp) => ({ ...bank, date: row.date, description: 'Egg sale',
      amount: row.amount, referenceId: { $lastId: saleOp } })
  },
  hen_sale: {
    key: 'hen_sales', pk: 'hen_sale_id', table: 'hen_sales', owner: 'batch', ownerId: BATCH,
    label: 'Hen Sale', sql: HEN_INSERT,
    params: (row, bank) => [BATCH, row.date, null, '', 1, row.amount, null, 'per_hen',
      row.amount, row.payment_type, bank.payment_source, bank.bank_id],
    deposit: (bank, row, saleOp) => ({ ...bank, date: row.date, description: 'Hen sale',
      amount: row.amount, referenceId: { $lastId: saleOp } })
  }
}

/**
 * ONE SAVE, in the shape all three screens build it: the sale row, its deposit
 * keyed to that row, each row's auto-settlement spliced in after its deposit,
 * and one balance rebuild per account at the end. The unpaid list is threaded
 * from row to row exactly as the screens thread it.
 *
 * `autoSettle` is the checkbox. Unticked, `buildAutoSettleOps` is never called
 * — which is what section D asserts.
 */
async function saveSale(source, pendingRows, { autoSettle = true } = {}) {
  const spec = SCREENS[source]
  const targetsRes = await call('getOwnFarmDebtByOwner', FARM, spec.owner,
    pendingRows.map(() => spec.ownerId))
  const targets = new Map((targetsRes.data || []).map(t => [t.owner_id, t]))

  const settleBills = new Map()
  const ops = []
  const banksTouched = []
  const built = []

  for (const row of pendingRows) {
    const bank = bankSourceFields(row)
    const saleOp = ops.length
    ops.push({ sql: spec.sql, params: spec.params(row, bank) })
    ops.push(...call('bankSourceInsertOps', spec.key, spec.deposit(bank, row, saleOp)))
    banksTouched.push(bank.bank_id)

    const target = autoSettle && bank.bank_id ? targets.get(spec.ownerId) : null
    if (target && target.outstanding > 0) {
      const auto = await call('buildAutoSettleOps', {
        farm_id: FARM,
        from_bank_id: bank.bank_id,
        customer_id: target.customer_id,
        max_amount: row.amount,
        date: row.date,
        reference: `Auto-settled from ${spec.label} #`,
        bank_label: 'HBL Main — Mian Ahmed',
        source,
        source_id: { $lastId: saleOp },
        base_index: ops.length,
        bills: settleBills.get(target.customer_id)
      })
      if (!auto.success) throw new Error(auto.error)
      settleBills.set(target.customer_id, auto.bills)
      ops.push(...auto.ops)
      built.push(auto)
    }
  }
  ops.push(...call('bankRebuildOps', banksTouched))

  const res = await call('runBatch', ops)
  if (!res.success) throw new Error(res.error)
  const saleId = one(`SELECT MAX(${spec.pk}) v FROM ${spec.table}`)
  return { saleId, settled: built.reduce((s, a) => s + a.settledAmount, 0), built, ops }
}

/** The sale delete both paths run: its auto-settlement first, then the row + deposit. */
async function deleteSale(source, saleId) {
  const spec = SCREENS[source]
  const undone = await call('deleteAutoSettlementFor', source, saleId)
  if (!undone.success) throw new Error(undone.error)
  const res = await call('deleteBankSourced', spec.key, saleId, [
    { sql: `DELETE FROM ${spec.table} WHERE ${spec.pk} = ?`, params: [saleId] }
  ])
  if (!res.success) throw new Error(res.error)
}

const settlementsFor = (source, saleId) => rows(
  `SELECT * FROM internal_settlements WHERE auto_source_table = ? AND auto_source_id = ?`,
  [source, saleId])

// ── Setup ───────────────────────────────────────────────────────────────────

async function setup() {
  const SQL = await initSqlJs()
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) {
    try { db.run(sql) } catch (e) { /* duplicate column = already applied */ }
  }

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type)
          VALUES (1,'Talha','x','all')`)
  db.run(`INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name)
          VALUES (?,1,'broiler','Shed A'), (?,1,'layer','Shed B'), (?,1,'broiler','Shed C')`,
    [UNIT_BROILER, UNIT_LAYER, UNIT_ORPHAN])
  // flock_id 1 and batch_id 1 collide, and sit in DIFFERENT farm units — the
  // collision this codebase keeps rediscovering, here to prove the owner
  // lookup never crosses from one to the other.
  db.run(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id)
          VALUES (?,1,'Flock 1','2025-01-01',?), (?,1,'Flock 2','2025-01-01',?)`,
    [FLOCK, UNIT_BROILER, FLOCK_ORPHAN, UNIT_ORPHAN])
  db.run(`INSERT INTO batches (batch_id, farm_id, batch_name, start_date, initial_birds, unit_id)
          VALUES (?,1,'Batch 1','2025-01-01',1000,?)`, [BATCH, UNIT_LAYER])

  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, unit_id, customer_type, outstanding_balance)
          VALUES (?,1,'Own Farm - Shed A',?,'own_farm',0),
                 (?,1,'Own Farm - Shed B',?,'own_farm',0),
                 (?,1,'Own Farm - Mirror',NULL,'own_farm',0)`,
    [OWN_BROILER, UNIT_BROILER, OWN_LAYER, UNIT_LAYER, MIRROR])
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type, outstanding_balance)
          VALUES (?,1,'Outside Buyer','external',0)`, [OUTSIDE])

  db.run(`INSERT INTO products (product_id, farm_id, product_name, category, cost_price, selling_price)
          VALUES (100,1,'Starter Feed','feed',800,1000)`)
  db.run(`INSERT INTO product_batches (batch_id, product_id, farm_id, batch_code,
                                       manufacturing_date, expiry_date, quantity, purchase_price)
          VALUES (200,100,1,'B-1','2025-01-01','2030-01-01',1000,800)`)

  db.run(`INSERT INTO bank_accounts (bank_id, farm_id, bank_name, account_holder, account_number, current_balance)
          VALUES (?,1,'HBL Main','Mian Ahmed','111',0), (?,1,'UBL','Talha','222',0)`, [BANK_A, BANK_B])
  db.run(`INSERT INTO bank_accounts (bank_id, farm_id, bank_name, customer_id, current_balance)
          VALUES (?,1,'Customer Deposit',?,0)`, [BANK_CUST, OUTSIDE])

  // An ordinary outside bill, so no figure under test is trivially zero.
  const outsideId = nextBillId++
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (?,1,'BILL-OUT',?,'Outside Buyer','2025-02-01',90000,90000,0,'credit')`,
    [outsideId, OUTSIDE])
  await call('addCustomerLedgerEntry', {
    customer_id: OUTSIDE, transaction_date: '2025-02-01', description: 'Bill #BILL-OUT',
    debit: 90000, credit: 0, reference_type: 'bill', reference_id: outsideId
  })
  await call('updateCustomerOutstandingBalance', OUTSIDE)

  screen.currentFlock = { flock_id: FLOCK, farm_id: FARM }
  screen.houseBanks = (await call('getHouseBankAccounts', FARM)).data || []
}

/** Two unpaid own-farm bills for one farm: 30,000 (older) then 20,000. */
async function giveDebt(customerId, flockId) {
  const b1 = internalBill(customerId, 30000, '2025-03-01', flockId)
  const b2 = internalBill(customerId, 20000, '2025-04-01', flockId)
  await postBillToLedger(customerId, b1, '2025-03-01')
  await postBillToLedger(customerId, b2, '2025-04-01')
  return { b1, b2 }
}

/** The screen's own state, as it would be with one pending row on screen. */
function pendingRow(amount, { bank = BANK_A, type = 'bank', date = '2025-05-01' } = {}) {
  return { date, amount, payment_type: type, bank_id: type === 'bank' ? bank : null,
           empty_weight: 0, load_weight: amount, rate: 1 }
}

// ── Sections ────────────────────────────────────────────────────────────────

async function sectionA() {
  console.log('\nA. THE INVARIANTS — a 150,000 bank sale against a 50,000 own-farm debt')
  const { b1, b2 } = await giveDebt(OWN_BROILER, FLOCK)

  const beforeDebt = billsOutstanding(OWN_BROILER)
  const beforeRevenue = collectedRevenue(FARM)
  const beforeOverview = overviewSnapshot(FARM)
  const beforeAll = allBankBalances()
  const beforeA = bankBalance(BANK_A)
  check('debt before', beforeDebt, 50000)

  const { saleId, settled } = await saveSale('broiler_sale', [pendingRow(150000)])
  check('settled amount', settled, 50000)

  bankInvariant('sale 150,000 / debt 50,000', beforeAll, beforeA, BANK_A, 150000)
  check('own-farm outstanding moved by -settled',
    Math.round((billsOutstanding(OWN_BROILER) - beforeDebt) * 100) / 100, -50000)
  check('distribution collected revenue rose by the settled amount',
    Math.round((collectedRevenue(FARM) - beforeRevenue) * 100) / 100, 50000)
  compareOverview('after an auto-settling bank sale', beforeOverview, overviewSnapshot(FARM))
  await customerInvariant('an auto-settling bank sale', OWN_BROILER)

  check('oldest bill fully paid', amountPaid(b1.id), 30000)
  check('newer bill fully paid', amountPaid(b2.id), 20000)
  check("the customer's own deposit account untouched", bankBalance(BANK_CUST), 0)
  check('the other house account untouched', bankBalance(BANK_B), 0)

  const row = settlementsFor('broiler_sale', saleId)[0] || {}
  checkStr('settlement FROM account', row.from_account, 'bank')
  checkStr('settlement TO account', row.to_account, 'bank')
  check('settlement FROM = TO (same account, so no money moved)',
    Number(row.from_bank_id) === Number(row.to_bank_id) ? 1 : 0, 1)
  check('settlement names the sale account', row.from_bank_id, BANK_A)
  checkStr('settlement reference carries the real sale id', row.reference,
    `Auto-settled from Broiler Sale #${saleId}`)
  checkStr('settlement number', String(row.settlement_number).slice(0, 3), 'IS-')

  // The credit rows the settlement wrote are one side of a compound event, so
  // the Customer Ledger screen must refuse to delete them on their own — the
  // precondition that already guards a hand-entered settlement.
  const creditId = one(
    `SELECT MAX(ledger_id) v FROM customer_ledger WHERE internal_settlement_id = ?`,
    [row.settlement_id])
  const refused = await call('deleteCustomerLedgerEntry', creditId)
  checkTrue('a settlement credit line cannot be deleted from the Customer Ledger',
    refused.success === false && /internal settlement/i.test(refused.error || ''))

  return { saleId, b1, b2 }
}

async function sectionB() {
  console.log('\nB. MULTI-BILL FIFO — the same allocation a Receive Voucher produces')
  // Two farms, identical bills. One settles through the sale, the other through
  // a receive voucher. The two must land on byte-identical bill and ledger
  // state, because they are the same function reached through two doors.
  const auto = await giveDebt(OWN_LAYER, FLOCK)
  const mirror = await giveDebt(MIRROR, FLOCK)

  const { saleId, settled } = await saveSale('egg_sale', [pendingRow(40000, { bank: BANK_B })])
  check('settled through the sale', settled, 40000)

  const voucher = await call('saveReceiveVoucher',
    { sql: RV_INSERT, params: [FARM, MIRROR, 'RV-001', '2025-05-01', 40000, 'cash', null, null, null] },
    { customer_id: MIRROR, amount: 40000, date: '2025-05-01',
      description: 'Payment received', bank_description: 'Receipt',
      payment_source: 'cash', bank_id: null })
  checkTrue('the receive voucher saved', voucher.success === true)

  check('FIFO — oldest bill cleared first', amountPaid(auto.b1.id), 30000)
  check('FIFO — remainder on the newer bill', amountPaid(auto.b2.id), 10000)
  check('same allocation as the voucher, oldest bill',
    amountPaid(auto.b1.id), amountPaid(mirror.b1.id))
  check('same allocation as the voucher, newer bill',
    amountPaid(auto.b2.id), amountPaid(mirror.b2.id))
  check('same outstanding as the voucher',
    billsOutstanding(OWN_LAYER), billsOutstanding(MIRROR))

  // The two farms hold different bill ids, so the credits are compared with
  // each reference_id reduced to WHICH of that farm's bills it names — the
  // allocation, which is the thing under test, rather than the id.
  const creditRows = (customerId, own) => rows(
    `SELECT COALESCE(credit,0) credit, reference_type, reference_id
     FROM customer_ledger WHERE customer_id = ? AND COALESCE(credit,0) > 0
     ORDER BY ledger_id ASC`, [customerId])
    .map(r => ({
      credit: Number(r.credit),
      reference_type: r.reference_type,
      bill: Number(r.reference_id) === own.b1.id ? 'older'
          : Number(r.reference_id) === own.b2.id ? 'newer' : 'OTHER'
    }))
  checkStr('the same ledger credits as the voucher, bill for bill',
    JSON.stringify(creditRows(OWN_LAYER, auto)), JSON.stringify(creditRows(MIRROR, mirror)))
  checkTrue('and every credit names a bill belonging to that own-farm customer',
    creditRows(OWN_LAYER, auto).every(r => r.bill !== 'OTHER'))
  await customerInvariant('the FIFO spill', OWN_LAYER)
  await customerInvariant('the mirror voucher', MIRROR)

  await deleteSale('egg_sale', saleId)
  return auto
}

async function sectionC() {
  console.log('\nC. THE BOUNDS — sale < debt, sale = debt, sale > debt')
  for (const [label, sale, expectSettled, expectLeft] of [
    ['sale 30,000 < debt 50,000', 30000, 30000, 20000],
    ['sale 50,000 = debt 50,000', 50000, 50000, 0],
    ['sale 90,000 > debt 50,000', 90000, 50000, 0]
  ]) {
    db.run(`DELETE FROM bills WHERE customer_id = ?`, [OWN_BROILER])
    db.run(`DELETE FROM customer_ledger WHERE customer_id = ?`, [OWN_BROILER])
    await giveDebt(OWN_BROILER, FLOCK)

    const beforeAll = allBankBalances()
    const beforeA = bankBalance(BANK_A)
    const beforeOverview = overviewSnapshot(FARM)

    const { saleId, settled } = await saveSale('broiler_sale', [pendingRow(sale)])
    check(`${label} — settled`, settled, expectSettled)
    check(`${label} — debt left`, billsOutstanding(OWN_BROILER), expectLeft)
    bankInvariant(label, beforeAll, beforeA, BANK_A, sale)
    compareOverview(label, beforeOverview, overviewSnapshot(FARM))
    await customerInvariant(label, OWN_BROILER)
    await deleteSale('broiler_sale', saleId)
  }
}

async function sectionD() {
  console.log('\nD. OPT-OUT — the checkbox unticked writes no settlement')
  const beforeDebt = billsOutstanding(OWN_BROILER)
  const beforeAll = allBankBalances()
  const beforeA = bankBalance(BANK_A)
  const beforeSettlements = one(`SELECT COUNT(*) v FROM internal_settlements`)

  const { saleId, settled } = await saveSale('broiler_sale', [pendingRow(70000)], { autoSettle: false })
  check('nothing settled', settled, 0)
  check('no settlement row written',
    one(`SELECT COUNT(*) v FROM internal_settlements`), beforeSettlements)
  check('the debt is untouched', billsOutstanding(OWN_BROILER), beforeDebt)
  check('the sale still banked its own money',
    Math.round((bankBalance(BANK_A) - beforeA) * 100) / 100, 70000)
  check('only the sale moved the bank',
    Math.round((allBankBalances() - beforeAll) * 100) / 100, 70000)
  check('one deposit for the sale and nothing else',
    one(`SELECT COUNT(*) v FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`,
      [BANK_SOURCES.sales.ref, saleId]), 1)
  await customerInvariant('an opted-out sale', OWN_BROILER)

  // And the box itself: the bar is rendered, so the client can still tick it.
  screen.pendingRows = [pendingRow(70000)]
  screen.autoSettleTargets = new Map(
    ((await call('getOwnFarmDebtByOwner', FARM, 'flock', [FLOCK])).data || [])
      .map(t => [t.owner_id, t]))
  screen.autoSettle = false
  checkTrue('the bar is still shown while the box is unticked', preview() !== null)
  screen.autoSettle = true

  await deleteSale('broiler_sale', saleId)
}

async function sectionE() {
  console.log('\nE. CASH SALE — no settlement, and no bar')
  const beforeDebt = billsOutstanding(OWN_BROILER)
  const beforeAll = allBankBalances()
  const beforeSettlements = one(`SELECT COUNT(*) v FROM internal_settlements`)

  const { saleId, settled } = await saveSale('broiler_sale', [pendingRow(80000, { type: 'cash' })])
  check('nothing settled', settled, 0)
  check('no settlement row written',
    one(`SELECT COUNT(*) v FROM internal_settlements`), beforeSettlements)
  check('the debt is untouched', billsOutstanding(OWN_BROILER), beforeDebt)
  check('no bank balance moved', allBankBalances(), beforeAll)
  check('no bank_ledger row at all for a cash sale',
    one(`SELECT COUNT(*) v FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`,
      [BANK_SOURCES.sales.ref, saleId]), 0)

  screen.pendingRows = [pendingRow(80000, { type: 'cash' })]
  checkTrue('a cash row offers no auto-settlement', targetFor(screen.pendingRows[0]) === null)
  checkTrue('the bar does not appear for a cash sale', preview() === null)

  // The helper itself refuses to build anything without an account.
  const noAccount = await call('buildAutoSettleOps', {
    farm_id: FARM, from_bank_id: 0, customer_id: OWN_BROILER, max_amount: 80000,
    date: '2025-05-01', reference: 'x #', bank_label: 'x', source: 'broiler_sale',
    source_id: 1, base_index: 0
  })
  check('buildAutoSettleOps with no account returns no ops', noAccount.ops.length, 0)

  await deleteSale('broiler_sale', saleId)
}

async function sectionF() {
  console.log('\nF. NO OWN-FARM CUSTOMER, AND NO DEBT — nothing to offer')
  const orphan = await call('getOwnFarmDebtByOwner', FARM, 'flock', [FLOCK_ORPHAN])
  check('a flock whose unit has no own-farm customer resolves to nothing',
    orphan.data.length, 0)

  screen.currentFlock = { flock_id: FLOCK_ORPHAN, farm_id: FARM }
  screen.pendingRows = [pendingRow(50000)]
  screen.autoSettleTargets = new Map(
    (orphan.data || []).map(t => [t.owner_id, t]))
  checkTrue('no target for that flock', targetFor(screen.pendingRows[0]) === null)
  checkTrue('the bar does not appear', preview() === null)

  // A farm that owes nothing: the customer exists, the debt does not.
  screen.currentFlock = { flock_id: FLOCK, farm_id: FARM }
  db.run(`DELETE FROM bills WHERE customer_id = ?`, [OWN_BROILER])
  db.run(`DELETE FROM customer_ledger WHERE customer_id = ?`, [OWN_BROILER])
  await call('updateCustomerOutstandingBalance', OWN_BROILER)
  const settled = await call('getOwnFarmDebtByOwner', FARM, 'flock', [FLOCK])
  check('the own-farm customer is found', settled.data.length, 1)
  check('and owes nothing', settled.data[0].outstanding, 0)
  screen.autoSettleTargets = new Map((settled.data || []).map(t => [t.owner_id, t]))
  checkTrue('a farm with no debt offers no auto-settlement',
    targetFor(screen.pendingRows[0]) === null)
  checkTrue('and the bar does not appear', preview() === null)

  const nothing = await call('buildAutoSettleOps', {
    farm_id: FARM, from_bank_id: BANK_A, customer_id: OWN_BROILER, max_amount: 50000,
    date: '2025-05-01', reference: 'x #', bank_label: 'x', source: 'broiler_sale',
    source_id: 1, base_index: 0
  })
  check('buildAutoSettleOps with no debt returns no ops', nothing.ops.length, 0)
  check('and settles nothing', nothing.settledAmount, 0)

  // Put the debt back for the sections that follow.
  await giveDebt(OWN_BROILER, FLOCK)
}

async function sectionG() {
  console.log('\nG. DELETION — the sale and its settlement are reversed together')
  const beforeDebt = billsOutstanding(OWN_BROILER)
  const beforeAll = allBankBalances()
  const beforeA = bankBalance(BANK_A)
  const beforeOverview = overviewSnapshot(FARM)

  const { saleId, settled } = await saveSale('broiler_sale', [pendingRow(150000)])
  check('settled on the way in', settled, 50000)
  check('one settlement row for this sale', settlementsFor('broiler_sale', saleId).length, 1)

  await deleteSale('broiler_sale', saleId)
  check('the settlement row is gone', settlementsFor('broiler_sale', saleId).length, 0)
  check('its ledger lines are gone',
    one(`SELECT COUNT(*) v FROM customer_ledger WHERE internal_settlement_id IS NOT NULL`), 0)
  check('the debt came back', billsOutstanding(OWN_BROILER), beforeDebt)
  check('the account is back where it was', bankBalance(BANK_A), beforeA)
  check('every bank balance is back where it was', allBankBalances(), beforeAll)
  check('the deposit is gone',
    one(`SELECT COUNT(*) v FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`,
      [BANK_SOURCES.sales.ref, saleId]), 0)
  compareOverview('after deleting an auto-settling sale', beforeOverview, overviewSnapshot(FARM))
  await customerInvariant('the delete', OWN_BROILER)

  // Deleting the settlement by hand first must not leave the sale undeletable.
  const second = await saveSale('broiler_sale', [pendingRow(150000)])
  const row = settlementsFor('broiler_sale', second.saleId)[0]
  checkTrue('hand-deleting the settlement first succeeds',
    (await call('deleteInternalSettlement', row.settlement_id)).success === true)
  await deleteSale('broiler_sale', second.saleId)
  check('the sale still deletes cleanly afterwards',
    one(`SELECT COUNT(*) v FROM sales WHERE sale_id = ?`, [second.saleId]), 0)
  check('and the debt is back', billsOutstanding(OWN_BROILER), beforeDebt)
  await customerInvariant('a hand-deleted settlement then the sale', OWN_BROILER)
}

async function sectionH() {
  console.log('\nH. THE THREE SCREENS — one shape, three tables')
  const shapes = {}
  for (const source of ['broiler_sale', 'egg_sale', 'hen_sale']) {
    const spec = SCREENS[source]
    const customer = spec.owner === 'flock' ? OWN_BROILER : OWN_LAYER
    db.run(`DELETE FROM bills WHERE customer_id = ?`, [customer])
    db.run(`DELETE FROM customer_ledger WHERE customer_id = ?`, [customer])
    await giveDebt(customer, FLOCK)

    const beforeAll = allBankBalances()
    const beforeA = bankBalance(BANK_A)
    const beforeOverview = overviewSnapshot(FARM)
    const beforeDebt = billsOutstanding(customer)

    const { saleId, settled } = await saveSale(source, [pendingRow(150000)])
    check(`${source} — settled`, settled, 50000)
    bankInvariant(`${source} 150,000 sale`, beforeAll, beforeA, BANK_A, 150000)
    check(`${source} — debt cleared`, billsOutstanding(customer), beforeDebt - 50000)
    compareOverview(`${source} auto-settlement`, beforeOverview, overviewSnapshot(FARM))
    await customerInvariant(`${source}`, customer)

    const row = settlementsFor(source, saleId)[0] || {}
    shapes[source] = {
      from_account: row.from_account, to_account: row.to_account,
      same: Number(row.from_bank_id) === Number(row.to_bank_id),
      customer: Number(row.customer_id) === customer,
      tagged: row.auto_source_table === source,
      sourceId: Number(row.auto_source_id) === Number(saleId)
    }
    // The three sale tables have colliding ids — section A's broiler sale #1
    // and a hen sale #1 are different sales. A lookup under either of the
    // other two sources must never return THIS settlement, whatever those
    // tables hold of their own.
    const mine = Number(row.settlement_id)
    for (const other of ['broiler_sale', 'egg_sale', 'hen_sale']) {
      if (other === source) continue
      check(`${source} #${saleId} — never returned by a ${other} lookup`,
        settlementsFor(other, saleId).filter(r => Number(r.settlement_id) === mine).length, 0)
    }
    await deleteSale(source, saleId)
    check(`${source} — debt back after delete`, billsOutstanding(customer), beforeDebt)
  }

  for (const source of Object.keys(shapes)) {
    const s = shapes[source]
    checkTrue(`${source} wrote the same settlement shape`,
      s.from_account === 'bank' && s.to_account === 'bank' && s.same &&
      s.customer && s.tagged && s.sourceId)
  }
}

async function sectionI() {
  console.log('\nI. SCREEN SQL AND PARAMETER ORDER — sentinels through the real schema')

  // Each screen's own sale INSERT, with a distinct sentinel per position, read
  // back column by column. A placeholder count or an order that stopped
  // matching the column list is invisible to TypeScript.
  const sentinelChecks = [
    ['sales', SALE_INSERT, 'sale_id',
      [FLOCK, '2031-01-01', 'SENT-VEH', 'SENT-DRV', 'SENT-PHN', 'SENT-BRK',
       9001, 9002, 9003, 9004, 9005, 'SENT-PT', 'cash', null, 'SENT-IMG', 'broiler'],
      { vehicle_number: 'SENT-VEH', driver_name: 'SENT-DRV', driver_phone: 'SENT-PHN',
        broker: 'SENT-BRK', empty_weight: 9001, load_weight: 9002, bird_weight: 9003,
        rate: 9004, total_amount: 9005, payment_type: 'SENT-PT', receipt_image: 'SENT-IMG',
        module_type: 'broiler', date: '2031-01-01' }],
    ['egg_sales', EGG_INSERT, 'egg_sale_id',
      [BATCH, '2031-01-02', OUTSIDE, 'SENT-CUST', 'SENT-GRADE', 9011, 9012, 9013,
       'SENT-PT', 'cash', null, 'SENT-MODE', 9014, 9015],
      { customer_id: OUTSIDE, customer_name: 'SENT-CUST', grade: 'SENT-GRADE',
        quantity: 9011, rate_per_egg: 9012, total_amount: 9013, payment_type: 'SENT-PT',
        sale_mode: 'SENT-MODE', carton_count: 9014, eggs_per_carton: 9015,
        date: '2031-01-02' }],
    ['hen_sales', HEN_INSERT, 'hen_sale_id',
      [BATCH, '2031-01-03', OUTSIDE, 'SENT-CUST', 9021, 9022, 9023, 'SENT-MODE',
       9024, 'SENT-PT', 'cash', null],
      { customer_id: OUTSIDE, customer_name: 'SENT-CUST', quantity: 9021,
        rate_per_hen: 9022, total_weight: 9023, pricing_mode: 'SENT-MODE',
        total_amount: 9024, payment_type: 'SENT-PT', date: '2031-01-03' }]
  ]
  for (const [table, sql, pk, params, expected] of sentinelChecks) {
    const res = await call('run', sql, params)
    checkTrue(`${table} INSERT runs against the real schema`, res.success === true)
    const row = rows(`SELECT * FROM ${table} WHERE ${pk} = ?`, [res.lastId])[0] || {}
    let ok = true
    for (const [col, want] of Object.entries(expected)) {
      if (String(row[col]) !== String(want)) {
        ok = false
        failures++
        console.log(`  FAIL  ${table}.${col}: got "${row[col]}", expected "${want}"`)
      }
    }
    if (ok) console.log(`  PASS  ${table} — every parameter landed in its own column`)
    db.run(`DELETE FROM ${table} WHERE ${pk} = ?`, [res.lastId])
  }

  // The settlement INSERT the service builds, the same way: distinctive values
  // in, every column read back.
  db.run(`DELETE FROM bills WHERE customer_id = ?`, [OWN_BROILER])
  db.run(`DELETE FROM customer_ledger WHERE customer_id = ?`, [OWN_BROILER])
  await giveDebt(OWN_BROILER, FLOCK)
  const auto = await call('buildAutoSettleOps', {
    farm_id: 9101, from_bank_id: BANK_B, customer_id: OWN_BROILER, max_amount: 12345,
    date: '2031-02-02', reference: 'SENT-REF #', bank_label: 'SENT-LABEL',
    source: 'egg_sale', source_id: 9109, base_index: 0
  })
  checkTrue('buildAutoSettleOps produced ops', auto.ops.length > 0)
  check('op[0] is the settlement row',
    /INSERT INTO internal_settlements/.test(auto.ops[0].sql) ? 1 : 0, 1)
  check('the ledger credits name op[0] through $lastId',
    auto.ops.filter(o => JSON.stringify(o.params || []).includes('"$lastId":0')).length > 0 ? 1 : 0, 1)
  const batch = await call('runBatch', auto.ops)
  checkTrue('the settlement batch runs against the real schema', batch.success === true)

  const srow = rows(`SELECT * FROM internal_settlements WHERE auto_source_id = 9109`)[0] || {}
  const expectRow = {
    farm_id: 9101, customer_id: OWN_BROILER, date: '2031-02-02', amount: 12345,
    from_account: 'bank', from_bank_id: BANK_B, to_account: 'bank', to_bank_id: BANK_B,
    reference: 'SENT-REF #9109', auto_source_table: 'egg_sale', auto_source_id: 9109
  }
  let ok = true
  for (const [col, want] of Object.entries(expectRow)) {
    if (String(srow[col]) !== String(want)) {
      ok = false
      failures++
      console.log(`  FAIL  internal_settlements.${col}: got "${srow[col]}", expected "${want}"`)
    }
  }
  if (ok) console.log('  PASS  internal_settlements — every parameter landed in its own column')
  checkTrue('notes is left null', srow.notes === null)
  checkStr('the number is generated in SQL', String(srow.settlement_number).slice(0, 3), 'IS-')
  checkStr('the statement line names the account',
    rows(`SELECT description FROM customer_ledger WHERE internal_settlement_id = ? LIMIT 1`,
      [srow.settlement_id])[0].description,
    'Settlement from SENT-LABEL (internal)')

  // Two settlements in ONE batch must take DIFFERENT numbers: the number is
  // computed in SQL precisely because TypeScript cannot see the sibling INSERT.
  const a1 = await call('buildAutoSettleOps', {
    farm_id: FARM, from_bank_id: BANK_A, customer_id: OWN_BROILER, max_amount: 10,
    date: '2031-03-01', reference: 'x #', bank_label: 'L', source: 'broiler_sale',
    source_id: 9201, base_index: 0
  })
  const a2 = await call('buildAutoSettleOps', {
    farm_id: FARM, from_bank_id: BANK_A, customer_id: OWN_BROILER, max_amount: 10,
    date: '2031-03-01', reference: 'x #', bank_label: 'L', source: 'broiler_sale',
    source_id: 9202, base_index: a1.ops.length, bills: a1.bills
  })
  const combined = await call('runBatch', [...a1.ops, ...a2.ops])
  checkTrue('two settlements in one batch both save', combined.success === true)
  check('and take different numbers',
    one(`SELECT COUNT(DISTINCT settlement_number) v FROM internal_settlements
         WHERE auto_source_id IN (9201, 9202)`), 2)
  db.run(`DELETE FROM customer_ledger WHERE internal_settlement_id IS NOT NULL`)
  db.run(`DELETE FROM internal_settlements WHERE auto_source_id IN (9109, 9201, 9202)`)
  db.run(`UPDATE bills SET amount_paid = 0 WHERE customer_id = ?`, [OWN_BROILER])
  await call('updateCustomerOutstandingBalance', OWN_BROILER)

  // And the call sites themselves: each screen's own source string, its own
  // delete lookup, and the checkbox guard — none of which the SQL above sees.
  for (const [label, src, source] of [
    ['sale.component.ts', SALE_SRC, 'broiler_sale'],
    ['egg-sales.component.ts', EGG_SRC, 'egg_sale'],
    ['hen-sales.component.ts', HEN_SRC, 'hen_sale']
  ]) {
    checkTrue(`${label} calls buildAutoSettleOps`, /buildAutoSettleOps\(\{/.test(src))
    checkTrue(`${label} passes source: '${source}'`,
      new RegExp(`source:\\s*'${source}'`).test(src))
    checkTrue(`${label} keys its settlement to the sale with $lastId`,
      /source_id:\s*\{\s*\$lastId:\s*saleOp\s*\}/.test(src))
    checkTrue(`${label} names its own batch position`, /base_index:\s*ops\.length/.test(src))
    checkTrue(`${label} threads the bill list across rows`,
      /bills:\s*settleBills\.get\(target\.customer_id\)/.test(src))
    checkTrue(`${label} guards the call on the checkbox`,
      /this\.autoSettle\s*\?\s*this\.autoSettleTargetFor\(row\)\s*:\s*null/.test(src))
    checkTrue(`${label} reverses it on delete`,
      new RegExp(`deleteAutoSettlementFor\\('${source}'`).test(src))
  }
  for (const [label, html] of [
    ['sale.component.html', SALE_HTML],
    ['egg-sales.component.html', EGG_HTML],
    ['hen-sales.component.html', HEN_HTML]
  ]) {
    checkTrue(`${label} renders the bar, gated on the preview`,
      /class="autosettle-bar"[^>]*\*ngIf="autoSettlePreview as preview"/.test(html))
    checkTrue(`${label} binds the checkbox`,
      /\[\(ngModel\)\]="autoSettle"/.test(html))
    // The bar must sit OUTSIDE every table: a cell added to a table is the one
    // defect no script in this repo can see.
    const bar = html.indexOf('class="autosettle-bar"')
    const openTable = html.lastIndexOf('<table', bar)
    const closeTable = html.lastIndexOf('</table>', bar)
    checkTrue(`${label} keeps the bar outside every table`,
      bar >= 0 && (openTable < 0 || closeTable > openTable))
  }
}

async function sectionJ() {
  console.log('\nJ. THE CASCADE — the debt a banked sale cleared comes back with that sale')
  //
  // THE BUG THIS SECTION EXISTS FOR. A same-account settlement writes no
  // bank_ledger row, so the only thing that ever funded it is the sale. Close
  // the flock and the sale goes and its deposit is reversed — the account is
  // back where it started. If the settlement stood, the debt would be cleared
  // by a sale that no longer exists and by money that never left any account:
  //   HBL = X, owes 50,000
  //   bank sale 150,000      HBL = X + 150,000, owes 50,000
  //   auto-settlement        HBL = X + 150,000, owes 0      (no bank row)
  //   flock closed           HBL = X,           owes 0      <-- paid from nothing
  // An auto-settlement is SALE-scoped, not account-scoped, so it follows the
  // sale into the cascade. A hand-entered settlement and a receive voucher are
  // account-scoped and stay out of every cascade, which this section also pins.
  db.run(`DELETE FROM bills WHERE customer_id = ?`, [OWN_BROILER])
  db.run(`DELETE FROM customer_ledger WHERE customer_id = ?`, [OWN_BROILER])
  const { b1, b2 } = await giveDebt(OWN_BROILER, FLOCK)

  const openingA = bankBalance(BANK_A)
  const openingDebt = billsOutstanding(OWN_BROILER)
  check('the farm owes 50,000 to start', openingDebt, 50000)

  // TWO banked sales, so both the reversal and its shared `takenBack` are
  // exercised: the first clears bill 1 and part of bill 2, the second clears
  // the rest, so BOTH settlements drew on bill 2 and each must give back only
  // what it actually took.
  const first = await saveSale('broiler_sale', [pendingRow(35000)])
  const second = await saveSale('broiler_sale', [pendingRow(60000)])
  check('first sale settled', first.settled, 35000)
  check('second sale settled the rest', second.settled, 15000)
  check('both settlements drew on the newer bill', amountPaid(b2.id), 20000)
  check('the debt is cleared', billsOutstanding(OWN_BROILER), 0)
  check('the account holds both sales', bankBalance(BANK_A), openingA + 95000)

  // A hand-entered settlement on another farm, which the cascade must leave
  // alone: it is account-scoped and no sale funded it.
  const byHand = await call('saveInternalSettlement',
    { sql: `INSERT INTO internal_settlements
              (farm_id, customer_id, settlement_number, date, amount,
               from_account, from_bank_id, to_account, to_bank_id, reference, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [FARM, MIRROR, 'IS-HAND', '2025-05-02', 10000, 'bank', BANK_A, 'bank', BANK_A, null, null] },
    { customer_id: MIRROR, amount: 10000, date: '2025-05-02',
      description: 'Internal Settlement IS-HAND',
      bank_description_out: 'out', bank_description_in: 'in',
      from_account: 'bank', from_bank_id: BANK_A, to_account: 'bank', to_bank_id: BANK_A })
  checkTrue('a hand-entered settlement saved', byHand.success === true)
  const handId = one(
    `SELECT settlement_id v FROM internal_settlements WHERE settlement_number = 'IS-HAND'`)
  const handSettled = billsOutstanding(MIRROR)

  // The flock delete's own clauses, module guard included — the identical ones
  // flock-management.component.ts reverses and then deletes by.
  const scope = `flock_id = ? AND COALESCE(module_type,'broiler') = 'broiler'`
  const bankedSales = one(
    `SELECT COALESCE(SUM(total_amount), 0) v FROM sales
     WHERE flock_id = ? AND COALESCE(module_type,'broiler') = 'broiler'
       AND payment_source = 'bank' AND bank_id = ?`, [FLOCK, BANK_A])
  const beforeA = bankBalance(BANK_A)

  const deposits = await call('bankCascadeReversalOps', 'sales', scope, [FLOCK])
  checkTrue('the cascade read the deposits', deposits.success === true)
  const settlements = await call('autoSettlementCascadeReversalOps', 'broiler_sale', scope, [FLOCK])
  checkTrue('the cascade read the auto-settlements', settlements.success === true)
  checkTrue('and found something to reverse', (settlements.ops || []).length > 0)

  const res = await call('runBatch', [
    ...(deposits.ops || []),
    ...(settlements.ops || []),
    { sql: `DELETE FROM sales WHERE ${scope}`, params: [FLOCK] }
  ])
  checkTrue('the cascade ran as one batch', res.success === true)

  check('the sales are gone',
    one(`SELECT COUNT(*) v FROM sales WHERE flock_id = ?`, [FLOCK]), 0)
  check('their deposits are gone with them',
    one(`SELECT COUNT(*) v FROM bank_ledger WHERE reference_type = ?`,
      [BANK_SOURCES.sales.ref]), 0)
  check('the account gave every one of those sales back',
    bankBalance(BANK_A), beforeA - bankedSales)

  // THE FIX, asserted from both ends.
  check('no auto-settlement of those sales survives',
    one(`SELECT COUNT(*) v FROM internal_settlements WHERE auto_source_table = 'broiler_sale'`), 0)
  check('their ledger lines are gone',
    one(`SELECT COUNT(*) v FROM customer_ledger
         WHERE internal_settlement_id IS NOT NULL AND customer_id = ?`, [OWN_BROILER]), 0)
  check('THE DEBT CAME BACK IN FULL', billsOutstanding(OWN_BROILER), openingDebt)
  check('the older bill is unpaid again', amountPaid(b1.id), 0)
  check('the newer bill is unpaid again — the shared takenBack held', amountPaid(b2.id), 0)
  check('and nothing was given back twice',
    one(`SELECT COUNT(*) v FROM bills WHERE COALESCE(amount_paid,0) < 0`), 0)
  await customerInvariant('the flock cascade', OWN_BROILER)

  // And the account-scoped settlement is untouched, which is the older rule.
  check('the hand-entered settlement still stands',
    one(`SELECT COUNT(*) v FROM internal_settlements WHERE settlement_id = ?`, [handId]), 1)
  check('and what it settled stays settled', billsOutstanding(MIRROR), handSettled)
  await customerInvariant('the untouched hand-entered settlement', MIRROR)

  // The layer side, by its own clause, including the colliding id: batch_id 1
  // and flock_id 1 are different owners in different farm units, and a batch
  // close must not reach the broiler flock's settlements or vice versa.
  for (const customer of [OWN_LAYER, OWN_BROILER]) {
    db.run(`DELETE FROM bills WHERE customer_id = ?`, [customer])
    db.run(`DELETE FROM customer_ledger WHERE customer_id = ?`, [customer])
    await giveDebt(customer, FLOCK)
  }
  const layerSale = await saveSale('egg_sale', [pendingRow(20000)])
  const broilerSale = await saveSale('broiler_sale', [pendingRow(20000)])
  check('the layer sale settled', layerSale.settled, 20000)
  check('the broiler sale settled', broilerSale.settled, 20000)

  const layerDebtBefore = billsOutstanding(OWN_LAYER)
  const broilerDebtBefore = billsOutstanding(OWN_BROILER)
  const eggRev = await call('autoSettlementCascadeReversalOps', 'egg_sale', `batch_id = ?`, [BATCH])
  const henRev = await call('autoSettlementCascadeReversalOps', 'hen_sale', `batch_id = ?`, [BATCH])
  checkTrue('both layer sources read', eggRev.success === true && henRev.success === true)
  check('the hen pass finds nothing to do', (henRev.ops || []).length, 0)
  const layerRes = await call('runBatch', [
    ...(eggRev.ops || []), ...(henRev.ops || []),
    { sql: `DELETE FROM egg_sales WHERE batch_id = ?`, params: [BATCH] },
    { sql: `DELETE FROM hen_sales WHERE batch_id = ?`, params: [BATCH] }
  ])
  checkTrue('the batch cascade ran', layerRes.success === true)
  check('the layer farm debt came back', billsOutstanding(OWN_LAYER), layerDebtBefore + 20000)
  check('and the COLLIDING broiler flock was not touched',
    billsOutstanding(OWN_BROILER), broilerDebtBefore)
  check('the broiler flock own settlement still stands',
    settlementsFor('broiler_sale', broilerSale.saleId).length, 1)
  await customerInvariant('the batch cascade', OWN_LAYER)
  await customerInvariant('the colliding broiler flock', OWN_BROILER)

  // The call sites: both cascades really do run this, by the same clause they
  // then delete the sales with, and ahead of those deletes in the same batch.
  const FM_SRC = fs.readFileSync(
    path.join(ROOT, 'src', 'app', 'flock-management', 'flock-management.component.ts'), 'utf8')
  const BM_SRC = fs.readFileSync(
    path.join(ROOT, 'src', 'app', 'batch-management', 'batch-management.component.ts'), 'utf8')
  checkTrue('flock-management reverses auto-settlements by its sales clause',
    /autoSettlementCascadeReversalOps\(\s*'broiler_sale', `flock_id = \? AND \$\{broiler\}`/.test(FM_SRC))
  checkTrue('flock-management deletes sales by that same clause',
    /DELETE FROM sales\s+WHERE flock_id = \? AND \$\{broiler\}/.test(FM_SRC))
  checkTrue('batch-management reverses both layer sources by its sales clause',
    /\['egg_sale', 'hen_sale'\] as const/.test(BM_SRC) &&
    /autoSettlementCascadeReversalOps\(\s*source, `batch_id = \?`/.test(BM_SRC))
  checkTrue('batch-management deletes those sales by that same clause',
    /DELETE FROM egg_sales\s+WHERE batch_id = \?/.test(BM_SRC) &&
    /DELETE FROM hen_sales\s+WHERE batch_id = \?/.test(BM_SRC))
  for (const [label, src] of [['flock-management', FM_SRC], ['batch-management', BM_SRC]]) {
    checkTrue(`${label} runs the reversal ahead of its deletes, in the one batch`,
      src.indexOf('autoSettlementCascadeReversalOps') <
      src.indexOf('const result = await this.db.runBatch'))
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('AUTO-SETTLEMENT ON A BANK SALE — verifying against real source\n' +
              '='.repeat(78))
  await setup()
  const first = await sectionA()
  await sectionB()
  await sectionC()
  await sectionD()
  await sectionE()
  await sectionF()
  await sectionG()
  await sectionH()
  await sectionI()
  await sectionJ()

  console.log('\n' + '='.repeat(78))
  console.log(failures === 0
    ? 'RESULT: every assertion holds. A bank sale clears the own-farm debt, the\n' +
      '        account moves by the sale alone, and Overview profit does not move.'
    : `RESULT: ${failures} assertion(s) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('\nFATAL: ' + err.message)
  console.error(err.stack)
  process.exit(1)
})
