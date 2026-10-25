// Receive Voucher and Payment Voucher: shortcuts onto settlement paths that
// already existed, which must therefore land in exactly the state those paths
// would have landed in — plus the bank movement.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, the atomic writer from runBatch(), the
// settlement and voucher methods lifted out of database.service.ts, the two
// screens' own SQL lifted out of their components as text, and submitPayment()
// lifted out of customer-ledger.component.ts. Nothing is a copy, so the paths
// under test are the ones the app runs.
//
// What is proved:
//   A. SCREEN SQL — every statement the two screens build runs against the real
//      schema, with the right placeholder count AND the right parameter order.
//      Bound with a distinct sentinel per position, because TypeScript cannot
//      see a column list that stopped matching its params.
//   B. THE INVARIANT — bills-derived balance == customer_ledger running total
//      == cached customers.outstanding_balance. Asserted after every mutation.
//   C. EQUIVALENCE, the headline. A receive voucher of X leaves `bills`,
//      `customer_ledger` and `customers` in the same state as the Customer
//      Ledger screen's own payment of X, so the two doors onto the settlement
//      cannot report different revenue. Distribution revenue is on the
//      COLLECTED basis (only bills.amount_paid counts), so a settlement is
//      SUPPOSED to move it — what must not happen is the two paths moving it
//      differently. That is what this section pins.
//   D. MONEY IN lands on the named house account: that account rises by the
//      amount, every other account is untouched, and the sum of all balances
//      rises by exactly the amount — a receipt is money in, not a transfer.
//   E. A payment voucher reduces the supplier payable by exactly the amount,
//      and the withdrawal is written on the account the voucher names.
//   F. DELETE reverses every side — bills, ledger lines, bank entry — and
//      returns the database to its pre-voucher figures.
//   G. The customer-deposit axis on sales-orders (reference_type 'payment' with
//      a NULL reference_id, on a CUSTOMER's account) is untouched, and no
//      voucher ever writes one.
//   H. Overpayment is refused on both sides, and refusal writes NOTHING.
//   I. A spill across several bills is settled and unwound off every bill.
//   J. A voucher's ledger line cannot be half-deleted from the Customer or
//      Supplier Ledger screen — that would leave the bank entry standing.
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
const CUST_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'account-ledger', 'customer-ledger', 'customer-ledger.component.ts'), 'utf8')
const RV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'receive-voucher', 'receive-voucher.component.ts'), 'utf8')
const PV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'payment-voucher', 'payment-voucher.component.ts'), 'utf8')

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
 * lines start with `*`) or a `this.`-qualified call site. A public sync method
 * carries no keyword to disambiguate it, so this is the only way to find one.
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

/**
 * The SQL string literal containing `marker`, lifted out of a component as
 * text. This is the only way to test a statement a component builds inline —
 * which is this codebase's convention — from a node script that cannot load
 * Angular.
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

// Read off the real declaration rather than restated, so a renamed
// reference_type or a flipped direction breaks this file instead of passing.
const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()
const DatabaseService = { BANK_SOURCES }

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

  // The bank mechanism the vouchers ride on.
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
  linkCustomerToBank:        loadMethod('linkCustomerToBank', 'async '),
  addBankLedgerEntry:        loadMethod('addBankLedgerEntry', 'async '),
  getCustomerBankAccount:    loadMethod('getCustomerBankAccount', 'async '),
  deductCustomerBank:        loadMethod('deductCustomerBank', 'async '),

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

  supplierLedgerEntryOp:     loadMethod('supplierLedgerEntryOp', 'private '),
  addSupplierLedgerEntry:    loadMethod('addSupplierLedgerEntry', 'async '),
  getSupplierPayable:        loadMethod('getSupplierPayable', 'async '),
  getAllSuppliersWithBalance: loadMethod('getAllSuppliersWithBalance', 'async '),
  getSupplierLedgerWithBalance: loadMethod('getSupplierLedgerWithBalance', 'async '),
  deleteSupplierLedgerEntry: loadMethod('deleteSupplierLedgerEntry', 'async '),

  // The vouchers themselves.
  saveReceiveVoucher:        loadMethod('saveReceiveVoucher', 'async '),
  savePaymentVoucher:        loadMethod('savePaymentVoucher', 'async '),
  deleteReceiveVoucher:      loadMethod('deleteReceiveVoucher', 'async '),
  deletePaymentVoucher:      loadMethod('deletePaymentVoucher', 'async ')
}
global.toLocalDateString = svc.toLocalDateString
const call = (name, ...args) => svc[name].apply(svc, args)

// ── The Customer Ledger screen under test ───────────────────────────────────
//
// The real submitPayment(), so section C compares the voucher against the path
// it is a shortcut for rather than against a restatement of it.
global.friendlySqlError = (err, fallback) => (err ? String(err) : fallback)

const screen = {
  db: svc,
  cdr: { detectChanges: () => {} },
  selectedCustomer: null,
  unpaidBills: [],
  customerBills: [],
  ledgerEntries: [],
  selectedBillId: null,
  paymentAmount: 0,
  paymentDate: '2025-06-01',
  paymentNote: '',
  isSubmitting: false,
  errorMessage: '',
  showDeleteDialog: false,
  deletingEntryId: null,
  closePaymentForm() { this.selectedBillId = null; this.paymentAmount = 0 },
  getCustomerBalance() { return Number(this.selectedCustomer.outstanding_balance) || 0 },

  async loadCustomerDetail(customerId) {
    this.selectedCustomer = rows(
      `SELECT c.*, (SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)), 0)
                    FROM bills WHERE customer_id = c.customer_id) AS outstanding_balance
       FROM customers c WHERE c.customer_id = ?`, [customerId])[0]
    this.ledgerEntries = (await svc.getCustomerLedgerWithBalance.call(svc, customerId)).data
    this.unpaidBills = (await svc.getUnpaidBills.call(svc, customerId)).data
  },

  submitPayment: loadFrom(CUST_SRC, 'submitPayment', 'async ')
}

async function payOnLedgerScreen(customerId, amount, { billId = null, note = '' } = {}) {
  await screen.loadCustomerDetail(customerId)
  screen.paymentAmount = amount
  screen.selectedBillId = billId
  screen.paymentNote = note
  screen.errorMessage = ''
  await screen.submitPayment()
  await screen.loadCustomerDetail(customerId)
  return screen.errorMessage
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
const bankLedgerSum = (bankId) => one(
  `SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)), 0) v
   FROM bank_ledger WHERE bank_id = ?`, [bankId])
const allBankBalances = () => one(
  `SELECT COALESCE(SUM(COALESCE(current_balance,0)), 0) v FROM bank_accounts`)
const supplierPayable = (supplierId) => one(
  `SELECT COALESCE(SUM(COALESCE(credit,0) - COALESCE(debit,0)), 0) v
   FROM supplier_ledger WHERE supplier_id = ?`, [supplierId])

/** The figure Overview and the Distribution report actually read as revenue. */
const collectedRevenue = (farmId) => one(
  `SELECT COALESCE(SUM(MIN(MAX(COALESCE(amount_paid,0), 0), COALESCE(total_amount,0))), 0) v
   FROM bills WHERE farm_id = ?`, [farmId])

const entryFor = (key, id) => rows(
  'SELECT * FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
  [BANK_SOURCES[key].ref, id])[0] || null

/**
 * THE CUSTOMER INVARIANT, asserted after every mutation. The statement a
 * customer reads and the debt the app bills them for are two derivations of the
 * same money; they must land on the same number, and the cached column — the
 * figure Sales Orders and the reports read — with both.
 */
async function invariant(label, customerId) {
  const fromBills = billsOutstanding(customerId)
  const fromLedger = ledgerOutstanding(customerId)
  const cached = cachedOutstanding(customerId)
  const listed = ((await call('getAllCustomersWithBalance', 1)).data || [])
    .find(c => Number(c.customer_id) === customerId)
  const ok = fromBills === fromLedger && cached === fromBills &&
             Number(listed.outstanding_balance) === fromBills
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  INVARIANT after ${label}: ` +
    `bills=${fromBills} ledger=${fromLedger} cached=${cached} list=${listed.outstanding_balance}`)
  return fromBills
}

/**
 * THE BANK INVARIANT: every bank-sourced voucher has exactly one entry, every
 * voucher entry points at a voucher that still exists, and every account's
 * cached balance equals the ledger it caches. Driven off BANK_SOURCES, so a
 * table added there without being handled here fails rather than passing.
 */
function bankInvariant(label) {
  for (const key of ['receive_vouchers', 'payment_vouchers']) {
    const spec = BANK_SOURCES[key]
    const unmirrored = one(
      `SELECT COUNT(*) v FROM ${spec.table} s
       WHERE s.payment_source = 'bank'
         AND (SELECT COUNT(*) FROM bank_ledger bl
              WHERE bl.reference_type = ? AND bl.reference_id = s.${spec.pk}) <> 1`,
      [spec.ref])
    const orphaned = one(
      `SELECT COUNT(*) v FROM bank_ledger bl
       WHERE bl.reference_type = ?
         AND NOT EXISTS (SELECT 1 FROM ${spec.table} s WHERE s.${spec.pk} = bl.reference_id)`,
      [spec.ref])
    check(`${label} — ${spec.table} with no entry`, unmirrored, 0)
    check(`${label} — entries with no ${spec.table} row`, orphaned, 0)
  }
  const drifted = one(
    `SELECT COUNT(*) v FROM bank_accounts ba
     WHERE COALESCE(ba.current_balance, 0) <> (
       SELECT COALESCE(SUM(COALESCE(bl.debit,0) - COALESCE(bl.credit,0)), 0)
       FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)`)
  check(`${label} — accounts whose cached balance drifted`, drifted, 0)
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextBillId = 1
function raiseBill(customerId, total, date, { paid = 0 } = {}) {
  const id = nextBillId++
  const num = `BILL-${String(id).padStart(3, '0')}`
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (?,1,?,?,'Customer',?,?,?,?,'cash')`, [id, num, customerId, date, total, total, paid])
  return { id, num }
}

/** The bill's ledger debit, exactly as sales-orders.component.ts writes it. */
async function postBillToLedger(customerId, bill, total, date) {
  await call('addCustomerLedgerEntry', {
    customer_id: customerId, transaction_date: date,
    description: `Bill #${bill.num}`, debit: total, credit: 0,
    reference_type: 'bill', reference_id: bill.id
  })
  await call('updateCustomerOutstandingBalance', customerId)
}

// ── The screens' own statements ─────────────────────────────────────────────
//
// For each: the file it lives in, a marker unique to it, and the parameter list
// AS THE SCREEN BUILDS IT, with a distinct sentinel per position.

const BANK = 7777
const RV_INSERT = liftSql(RV_SRC, 'INSERT INTO receive_vouchers')
const PV_INSERT = liftSql(PV_SRC, 'INSERT INTO payment_vouchers')

const INSERTS = [
  { what: 'receive voucher INSERT', table: 'receive_vouchers', pk: 'voucher_id',
    party: 'customer_id', partyValue: 4242, sql: RV_INSERT,
    params: [1, 4242, 'RV-001', '2025-05-01', 12345, 'bank', BANK, 'CHQ-9', 'a note'] },
  { what: 'payment voucher INSERT', table: 'payment_vouchers', pk: 'voucher_id',
    party: 'supplier_id', partyValue: 3131, sql: PV_INSERT,
    params: [1, 3131, 'PV-001', '2025-05-02', 54321, 'bank', BANK, 'CHQ-8', 'other note'] }
]

const SELECTS = [
  { what: 'receive voucher customer list',
    sql: liftSql(RV_SRC, 'FROM customers c\n         WHERE c.farm_id = ?'), params: [1] },
  { what: 'receive voucher list', sql: liftSql(RV_SRC, 'FROM receive_vouchers rv'),
    params: [1, '2025-01-01', '2025-12-31'] },
  { what: 'receive voucher next number',
    sql: liftSql(RV_SRC, "FROM receive_vouchers WHERE farm_id = ? AND voucher_number LIKE 'RV-%'"),
    params: [1] },
  { what: 'receive voucher print', sql: liftSql(RV_SRC, 'FROM customer_ledger cl'), params: [1] },
  { what: 'payment voucher list', sql: liftSql(PV_SRC, 'FROM payment_vouchers pv'),
    params: [1, '2025-01-01', '2025-12-31'] },
  { what: 'payment voucher next number',
    sql: liftSql(PV_SRC, "FROM payment_vouchers WHERE farm_id = ? AND voucher_number LIKE 'PV-%'"),
    params: [1] },
  { what: 'payment voucher print', sql: liftSql(PV_SRC, 'FROM supplier_ledger sl'), params: [1] }
]

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  // ── A. SCREEN SQL ────────────────────────────────────────────────────────
  console.log('=== A. every statement the two screens build runs on the real schema ===')

  for (const st of SELECTS) {
    let threw = null
    try { rows(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes`, threw === null)
    if (threw) console.log(`        ${threw}`)
    check(`${st.what} placeholder count matches its parameter list`,
      (st.sql.match(/\?/g) || []).length, st.params.length)
  }

  // Own-farm customers must be filtered out of the voucher's customer picker.
  checkTrue('the customer picker excludes own-farm customers',
    /customer_type/.test(SELECTS[0].sql) && /own_farm/.test(SELECTS[0].sql))

  for (const st of INSERTS) {
    checkTrue(`${st.what} carries payment_source`, /payment_source/.test(st.sql))
    checkTrue(`${st.what} carries bank_id`, /bank_id/.test(st.sql))
    check(`${st.what} placeholder count matches its parameter list`,
      (st.sql.match(/\?/g) || []).length, st.params.length)

    let threw = null
    try { db.run(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes against the real schema`, threw === null)
    if (threw) { console.log(`        ${threw}`); continue }

    const row = rows(
      `SELECT payment_source, bank_id, ${st.party}, amount, voucher_number, date, reference, notes
       FROM ${st.table} ORDER BY ${st.pk} DESC LIMIT 1`)[0]
    // Not merely the right count: a swapped parameter order is silent, and
    // would file a bank_id into `amount` or a date into `payment_source`.
    checkStr(`${st.what} -> payment_source`, row.payment_source, 'bank')
    check(`${st.what} -> bank_id`, row.bank_id, BANK)
    check(`${st.what} -> ${st.party}`, row[st.party], st.partyValue)
    check(`${st.what} -> amount`, row.amount, st.params[4])
    checkStr(`${st.what} -> voucher_number`, row.voucher_number, st.params[2])
    checkStr(`${st.what} -> date`, row.date, st.params[3])
    checkStr(`${st.what} -> reference`, row.reference, st.params[7])
    checkStr(`${st.what} -> notes`, row.notes, st.params[8])
    db.run(`DELETE FROM ${st.table}`)
  }

  console.log('\n=== a cash voucher names no account ===')
  for (const st of INSERTS) {
    const params = st.params.map(p => (p === 'bank' ? 'cash' : (p === BANK ? null : p)))
    db.run(st.sql, params)
    const row = rows(`SELECT payment_source, bank_id FROM ${st.table} ORDER BY ${st.pk} DESC LIMIT 1`)[0]
    checkStr(`${st.what} cash -> payment_source`, row.payment_source, 'cash')
    checkTrue(`${st.what} cash -> bank_id is null`, row.bank_id === null)
    db.run(`DELETE FROM ${st.table}`)
  }

  // ── Fixture ──────────────────────────────────────────────────────────────
  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x')`)
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type)
          VALUES (1,1,'Voucher Customer','external'),
                 (2,1,'Ledger Customer','external'),
                 (3,1,'Spill Customer','external'),
                 (4,1,'Own Farm Unit','own_farm'),
                 (5,1,'Deposit Axis','external')`)
  db.run(`INSERT INTO suppliers (supplier_id, farm_id, supplier_name)
          VALUES (1,1,'Agri Supplies'), (2,1,'Feed Mill')`)

  await call('addBankAccount', { farm_id: 1, bank_name: 'House Main', account_number: 'H-1', opening_balance: 100000 })
  await call('addBankAccount', { farm_id: 1, bank_name: 'House Second', account_number: 'H-2', opening_balance: 50000 })
  await call('addBankAccount', { farm_id: 1, bank_name: 'Customer Acct', account_number: 'C-1', opening_balance: 9000, customer_id: 5 })
  const HOUSE_A = rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'House Main'`)[0].bank_id
  const HOUSE_B = rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'House Second'`)[0].bank_id
  const CUST_BANK = rows(`SELECT bank_id FROM bank_accounts WHERE bank_name = 'Customer Acct'`)[0].bank_id

  checkTrue('the house accounts are house accounts',
    rows(`SELECT customer_id FROM bank_accounts WHERE bank_id IN (?,?)`, [HOUSE_A, HOUSE_B])
      .every(r => r.customer_id === null))
  const houseList = (await call('getHouseBankAccounts', 1)).data || []
  checkTrue('and getHouseBankAccounts returns only those',
    houseList.length === 2 && !houseList.some(b => Number(b.bank_id) === CUST_BANK))
  bankInvariant('the fixture')

  /** Records a receive voucher the way the screen does. */
  let rvSeq = 0
  async function receiveVoucher(customerId, amount, { bankId = null, date = '2025-06-01',
                                                      reference = null, notes = null } = {}) {
    const number = 'RV-' + String(++rvSeq).padStart(3, '0')
    const source = bankId ? 'bank' : 'cash'
    return call('saveReceiveVoucher', {
      sql: RV_INSERT,
      params: [1, customerId, number, date, amount, source, bankId, reference, notes]
    }, {
      customer_id: customerId,
      amount,
      date,
      description: reference ? `Receive Voucher ${number} — ${reference}` : `Receive Voucher ${number}`,
      bank_description: `Receive Voucher ${number} — Customer`,
      payment_source: source,
      bank_id: bankId
    })
  }

  let pvSeq = 0
  async function paymentVoucher(supplierId, amount, { bankId = null, date = '2025-06-01',
                                                      reference = null, notes = null } = {}) {
    const number = 'PV-' + String(++pvSeq).padStart(3, '0')
    const source = bankId ? 'bank' : 'cash'
    return call('savePaymentVoucher', {
      sql: PV_INSERT,
      params: [1, supplierId, number, date, amount, source, bankId, reference, notes]
    }, {
      supplier_id: supplierId,
      amount,
      date,
      description: reference ? `Payment Voucher ${number} — ${reference}` : `Payment Voucher ${number}`,
      bank_description: `Payment Voucher ${number} — Supplier`,
      payment_source: source,
      bank_id: bankId,
      // The screen passes this (payment-voucher.component.ts), and this helper
      // did not — so the note reached `payment_vouchers` here and the ledger
      // row it writes never carried one, which is why nothing in this file
      // noticed that the screen's own READ was dropping the column too.
      notes
    })
  }

  const lastVoucher = (table) => rows(`SELECT MAX(voucher_id) AS id FROM ${table}`)[0].id

  // ── C. EQUIVALENCE ───────────────────────────────────────────────────────
  console.log('\n=== C. a receive voucher settles exactly as the Customer Ledger screen does ===')

  // Two customers, identical bills. One settled by voucher, one by the screen.
  const v1 = raiseBill(1, 30000, '2025-05-01')
  const v2 = raiseBill(1, 50000, '2025-05-20')
  await postBillToLedger(1, v1, 30000, '2025-05-01')
  await postBillToLedger(1, v2, 50000, '2025-05-20')

  const l1 = raiseBill(2, 30000, '2025-05-01')
  const l2 = raiseBill(2, 50000, '2025-05-20')
  await postBillToLedger(2, l1, 30000, '2025-05-01')
  await postBillToLedger(2, l2, 50000, '2025-05-20')

  check('voucher customer owes 80,000', await invariant('the charges', 1), 80000)
  check('ledger customer owes 80,000', await invariant('the charges', 2), 80000)
  const revenueBeforeSettlement = collectedRevenue(1)

  const rvRes = await receiveVoucher(1, 45000, { bankId: HOUSE_A, reference: 'CHQ-100' })
  checkTrue('the voucher saved', rvRes.success === true)
  if (!rvRes.success) console.log(`        ${rvRes.error}`)
  check('voucher customer now owes 35,000', await invariant('the voucher', 1), 35000)

  const ledgerErr = await payOnLedgerScreen(2, 45000)
  checkTrue('the ledger payment saved', ledgerErr === '')
  check('ledger customer now owes 35,000', await invariant('the ledger payment', 2), 35000)

  // The two must agree bill for bill, line for line, and on the cached column.
  check('same amount_paid on the older bill', amountPaid(v1.id), amountPaid(l1.id))
  check('same amount_paid on the newer bill', amountPaid(v2.id), amountPaid(l2.id))
  check('the older bill was cleared first, both ways', amountPaid(v1.id), 30000)
  check('and the remainder went to the newer one', amountPaid(v2.id), 15000)
  check('same bills-derived balance', billsOutstanding(1), billsOutstanding(2))
  check('same ledger running total', ledgerOutstanding(1), ledgerOutstanding(2))
  check('same cached outstanding_balance', cachedOutstanding(1), cachedOutstanding(2))
  check('same number of ledger lines',
    one(`SELECT COUNT(*) v FROM customer_ledger WHERE customer_id = 1`),
    one(`SELECT COUNT(*) v FROM customer_ledger WHERE customer_id = 2`))
  check('same total credit on the statement',
    one(`SELECT COALESCE(SUM(credit),0) v FROM customer_ledger WHERE customer_id = 1`),
    one(`SELECT COALESCE(SUM(credit),0) v FROM customer_ledger WHERE customer_id = 2`))
  check('and each line is tagged to a real bill, both ways',
    one(`SELECT COUNT(*) v FROM customer_ledger
         WHERE customer_id IN (1,2) AND reference_type = 'payment'
           AND reference_id NOT IN (SELECT bill_id FROM bills)`), 0)

  // The figure the reports read moved by the settlement — as it must, on the
  // collected basis — and moved by the SAME amount for both doors.
  check('collected-basis revenue rose by both settlements',
    collectedRevenue(1), revenueBeforeSettlement + 90000)
  bankInvariant('the equivalent settlements')

  // ── D. MONEY IN ──────────────────────────────────────────────────────────
  console.log('\n=== D. the deposit lands on the named house account, and nowhere else ===')
  const rv1 = lastVoucher('receive_vouchers')
  const dep = entryFor('receive_vouchers', rv1)
  checkTrue('the voucher wrote exactly one bank entry', dep !== null)
  check('as a DEBIT — money arriving', dep.debit, 45000)
  check('credit is zero', dep.credit, 0)
  checkTrue('numbered DEP-, not WD-', /^DEP-\d{4}$/.test(dep.transaction_number || ''))
  check('on the account the voucher names', dep.bank_id, HOUSE_A)
  check('House A rose by the amount', bankBalance(HOUSE_A), 100000 + 45000)
  check('and its cached balance equals its own ledger', bankBalance(HOUSE_A), bankLedgerSum(HOUSE_A))
  check('House B is untouched', bankBalance(HOUSE_B), 50000)
  check('the customer account is untouched', bankBalance(CUST_BANK), 9000)

  // A receipt is money IN, not a transfer between accounts: the sum over every
  // account rises by exactly the amount received.
  const sumBefore = allBankBalances()
  await receiveVoucher(1, 5000, { bankId: HOUSE_B })
  check('a second receipt rose House B by its amount', bankBalance(HOUSE_B), 50000 + 5000)
  check('House A unchanged by it', bankBalance(HOUSE_A), 145000)
  check('the sum of ALL balances rose by exactly the amount', allBankBalances(), sumBefore + 5000)
  check('voucher customer now owes 30,000', await invariant('the second voucher', 1), 30000)
  bankInvariant('two deposits on two accounts')

  console.log('\n=== a cash voucher settles the same and touches no account ===')
  const bankSumBeforeCash = allBankBalances()
  const cashRes = await receiveVoucher(1, 10000)
  checkTrue('the cash voucher saved', cashRes.success === true)
  check('it settled the debt', await invariant('a cash voucher', 1), 20000)
  check('and no bank balance moved', allBankBalances(), bankSumBeforeCash)
  checkTrue('it wrote no bank entry',
    entryFor('receive_vouchers', lastVoucher('receive_vouchers')) === null)
  bankInvariant('a cash voucher')

  // ── E. PAYMENT VOUCHER ───────────────────────────────────────────────────
  console.log('\n=== E. a payment voucher reduces the payable by exactly the amount ===')
  await call('addSupplierLedgerEntry', {
    supplier_id: 1, transaction_date: '2025-05-01', description: 'Purchase PO-1',
    credit: 60000, reference_type: 'purchase', reference_id: 1
  })
  check('the supplier is owed 60,000', supplierPayable(1), 60000)
  checkTrue('and nothing is stored on suppliers to disagree with it',
    !/outstanding_balance/.test(
      DB_SRC.slice(DB_SRC.indexOf('CREATE TABLE IF NOT EXISTS suppliers'),
                   DB_SRC.indexOf('CREATE TABLE IF NOT EXISTS suppliers') + 400)))

  const houseBBefore = bankBalance(HOUSE_B)
  const houseABefore = bankBalance(HOUSE_A)
  const pvRes = await paymentVoucher(1, 25000, {
    bankId: HOUSE_B, reference: 'CHQ-77',
    // The note the client types on the voucher. It is asserted all the way
    // through to the screen's own read below, because reaching
    // `supplier_ledger` was never the half that failed: the row carried it and
    // `getSupplierLedgerWithBalance()` — which names its columns explicitly —
    // did not select it, so the statement, the payment history and the printed
    // report all showed a dash on every line.
    notes: 'Cheque 40213, collected by Asif'
  })
  checkTrue('the payment voucher saved', pvRes.success === true)
  if (!pvRes.success) console.log(`        ${pvRes.error}`)

  check('the payable fell by exactly the amount', supplierPayable(1), 60000 - 25000)
  check('and the derived read agrees',
    Number((await call('getSupplierPayable', 1)).data[0].payable), 35000)
  check('as does the list the screen reads',
    Number(((await call('getAllSuppliersWithBalance', 1)).data || [])
      .find(s => Number(s.supplier_id) === 1).outstanding_balance), 35000)

  const pv1 = lastVoucher('payment_vouchers')
  const wd = entryFor('payment_vouchers', pv1)
  checkTrue('it wrote exactly one bank entry', wd !== null)
  check('as a CREDIT — money leaving', wd.credit, 25000)
  check('debit is zero', wd.debit, 0)
  checkTrue('numbered WD-', /^WD-\d{4}$/.test(wd.transaction_number || ''))
  check('ON THE ACCOUNT THE VOUCHER NAMES', wd.bank_id, HOUSE_B)
  check('House B fell by the amount', bankBalance(HOUSE_B), houseBBefore - 25000)
  check('House A is untouched', bankBalance(HOUSE_A), houseABefore)
  check('the customer account is untouched', bankBalance(CUST_BANK), 9000)
  bankInvariant('a payment voucher')

  console.log('\n=== and the supplier ledger carries it as one debit line ===')
  const supLines = rows(
    `SELECT * FROM supplier_ledger WHERE supplier_id = 1 ORDER BY ledger_id ASC`)
  check('two lines: the purchase and the payment', supLines.length, 2)
  check('the payment is a debit', supLines[1].debit, 25000)
  check('and names its voucher', supLines[1].voucher_id, pv1)
  checkStr('tagged as a payment', supLines[1].reference_type, 'payment')
  checkStr('the voucher note is ON the ledger row',
    supLines[1].notes, 'Cheque 40213, collected by Asif')

  // THE READ, which is where it was lost. The screen never looks at
  // `supplier_ledger` directly — both its tables and its PDF read
  // `getSupplierLedgerWithBalance()` — so the note existing in the table
  // proves nothing on its own.
  const screenRows = (await call('getSupplierLedgerWithBalance', 1, 1)).data || []
  const screenPayment = screenRows.find(r => Number(r.ledger_id) === Number(supLines[1].ledger_id))
  checkTrue('the screen read returns the payment row', !!screenPayment)
  checkStr('AND CARRIES ITS NOTE', screenPayment && screenPayment.notes,
    'Cheque 40213, collected by Asif')
  checkStr('the purchase row, which has none, reads back null',
    screenRows.find(r => Number(r.ledger_id) === Number(supLines[0].ledger_id)).notes, 'null')

  // ── H. OVERPAYMENT REFUSED ───────────────────────────────────────────────
  console.log('\n=== H. overpayment is refused, and refusal writes nothing ===')
  const before = {
    bills: billsOutstanding(1), ledger: ledgerOutstanding(1), cached: cachedOutstanding(1),
    banks: allBankBalances(), rvCount: one(`SELECT COUNT(*) v FROM receive_vouchers`),
    clCount: one(`SELECT COUNT(*) v FROM customer_ledger`)
  }
  const tooMuch = await receiveVoucher(1, before.bills + 1, { bankId: HOUSE_A })
  checkTrue('a receipt larger than the debt is refused', tooMuch.success === false)
  checkTrue('and says what can be applied', /only owes/.test(tooMuch.error || ''))
  check('no voucher row was written', one(`SELECT COUNT(*) v FROM receive_vouchers`), before.rvCount)
  check('no ledger line was written', one(`SELECT COUNT(*) v FROM customer_ledger`), before.clCount)
  check('no bill moved', billsOutstanding(1), before.bills)
  check('no bank balance moved', allBankBalances(), before.banks)
  await invariant('a refused receipt', 1)

  const payBefore = supplierPayable(1)
  const tooMuchOut = await paymentVoucher(1, payBefore + 1, { bankId: HOUSE_B })
  checkTrue('a payment larger than the payable is refused', tooMuchOut.success === false)
  checkTrue('and says what is owed', /only owed/.test(tooMuchOut.error || ''))
  check('the payable did not move', supplierPayable(1), payBefore)
  check('no bank balance moved', allBankBalances(), before.banks)

  const nothingOwed = await paymentVoucher(2, 100, { bankId: HOUSE_B })
  checkTrue('a payment to a supplier owed nothing is refused', nothingOwed.success === false)
  checkTrue('and says so', /Nothing is owed/.test(nothingOwed.error || ''))

  const noBills = await receiveVoucher(3, 100, { bankId: HOUSE_A })
  checkTrue('a receipt from a customer with no unpaid bills is refused', noBills.success === false)
  checkTrue('and says so', /no unpaid bills/.test(noBills.error || ''))
  bankInvariant('the refusals')

  // ── F. DELETE REVERSES EVERY SIDE ────────────────────────────────────────
  console.log('\n=== F. deleting a receive voucher reverses bills, ledger AND bank ===')
  const preDelete = {
    owed: billsOutstanding(1), bankA: bankBalance(HOUSE_A), banks: allBankBalances(),
    revenue: collectedRevenue(1)
  }
  const delRes = await call('deleteReceiveVoucher', rv1)
  checkTrue('the delete was accepted', delRes.success === true)
  if (!delRes.success) console.log(`        ${delRes.error}`)
  check('the 45,000 is owed again', billsOutstanding(1), preDelete.owed + 45000)
  check('the deposit is gone from the account', bankBalance(HOUSE_A), preDelete.bankA - 45000)
  check('and from the sum of all accounts', allBankBalances(), preDelete.banks - 45000)
  check('its ledger lines are gone',
    one(`SELECT COUNT(*) v FROM customer_ledger WHERE voucher_id = ?`, [rv1]), 0)
  check('its bank entry is gone',
    one(`SELECT COUNT(*) v FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`,
        [BANK_SOURCES.receive_vouchers.ref, rv1]), 0)
  check('the voucher row is gone',
    one(`SELECT COUNT(*) v FROM receive_vouchers WHERE voucher_id = ?`, [rv1]), 0)
  check('collected revenue fell back by the settlement',
    collectedRevenue(1), preDelete.revenue - 45000)
  await invariant('deleting a receive voucher', 1)
  bankInvariant('deleting a receive voucher')

  console.log('\n=== deleting a payment voucher restores the payable and the balance ===')
  const pvPre = { payable: supplierPayable(1), bankB: bankBalance(HOUSE_B) }
  const delPv = await call('deletePaymentVoucher', pv1)
  checkTrue('the delete was accepted', delPv.success === true)
  check('the payable is restored', supplierPayable(1), pvPre.payable + 25000)
  check('the withdrawal is gone', bankBalance(HOUSE_B), pvPre.bankB + 25000)
  check('its ledger line is gone',
    one(`SELECT COUNT(*) v FROM supplier_ledger WHERE voucher_id = ?`, [pv1]), 0)
  check('the voucher row is gone',
    one(`SELECT COUNT(*) v FROM payment_vouchers WHERE voucher_id = ?`, [pv1]), 0)
  checkTrue('a vanished voucher is reported, not silently ignored',
    (await call('deletePaymentVoucher', pv1)).success === false)
  bankInvariant('deleting a payment voucher')

  console.log('\n=== deleting a CASH voucher reverses the settlement and no account ===')
  // The branch with no bank entry to remove: deleteBankSourced() finds no
  // account and runs the caller's deletes alone. Worth pinning because it is
  // the path a cash voucher takes and it shares no code with the bank path.
  const cashOwed = billsOutstanding(1)
  const cashBanks = allBankBalances()
  const cashRv = rows(
    `SELECT voucher_id, amount FROM receive_vouchers
     WHERE customer_id = 1 AND payment_source = 'cash' ORDER BY voucher_id DESC`)[0]
  checkTrue('there is a cash voucher to delete', cashRv !== undefined)
  const cashDel = await call('deleteReceiveVoucher', cashRv.voucher_id)
  checkTrue('the cash delete was accepted', cashDel.success === true)
  check('its settlement was reversed', billsOutstanding(1), cashOwed + Number(cashRv.amount))
  check('and no bank balance moved', allBankBalances(), cashBanks)
  check('the voucher row is gone',
    one(`SELECT COUNT(*) v FROM receive_vouchers WHERE voucher_id = ?`, [cashRv.voucher_id]), 0)
  await invariant('deleting a cash receive voucher', 1)

  const cashPvRes = await paymentVoucher(1, 2000)
  checkTrue('a cash payment voucher saved', cashPvRes.success === true)
  const cashPv = lastVoucher('payment_vouchers')
  const cashPayable = supplierPayable(1)
  const cashBanks2 = allBankBalances()
  checkTrue('it wrote no bank entry', entryFor('payment_vouchers', cashPv) === null)
  const cashPvDel = await call('deletePaymentVoucher', cashPv)
  checkTrue('the cash delete was accepted', cashPvDel.success === true)
  check('the payable is restored', supplierPayable(1), cashPayable + 2000)
  check('and no bank balance moved', allBankBalances(), cashBanks2)
  bankInvariant('deleting cash vouchers')

  // ── I. SPILL ─────────────────────────────────────────────────────────────
  console.log('\n=== I. a receipt spread across several bills is unwound off every one ===')
  const s1 = raiseBill(3, 10000, '2025-04-01')
  const s2 = raiseBill(3, 20000, '2025-04-10')
  const s3 = raiseBill(3, 30000, '2025-04-20')
  await postBillToLedger(3, s1, 10000, '2025-04-01')
  await postBillToLedger(3, s2, 20000, '2025-04-10')
  await postBillToLedger(3, s3, 30000, '2025-04-20')
  check('three bills -> 60,000 owed', await invariant('three charges', 3), 60000)

  const spillRes = await receiveVoucher(3, 45000, { bankId: HOUSE_A })
  checkTrue('the spilling voucher saved', spillRes.success === true)
  const spillId = lastVoucher('receive_vouchers')
  check('45,000 received -> 15,000 owed', await invariant('a spilling voucher', 3), 15000)
  check('oldest bill cleared', amountPaid(s1.id), 10000)
  check('second cleared', amountPaid(s2.id), 20000)
  check('third part-paid', amountPaid(s3.id), 15000)
  check('logged as one tagged line per bill it reached',
    one(`SELECT COUNT(*) v FROM customer_ledger WHERE voucher_id = ?`, [spillId]), 3)
  check('and the allocation it reported matches', (spillRes.allocations || []).length, 3)
  bankInvariant('a spilling voucher')

  const spillDel = await call('deleteReceiveVoucher', spillId)
  checkTrue('deleting it was accepted', spillDel.success === true)
  check('the whole 45,000 came back', await invariant('deleting the spill', 3), 60000)
  check('off the first bill', amountPaid(s1.id), 0)
  check('off the second', amountPaid(s2.id), 0)
  check('off the third', amountPaid(s3.id), 0)
  bankInvariant('deleting a spilling voucher')

  // ── J. A VOUCHER LINE CANNOT BE HALF-DELETED ─────────────────────────────
  console.log('\n=== J. a voucher line is refused by the ledger screens ===')
  const guardRes = await receiveVoucher(3, 10000, { bankId: HOUSE_A })
  checkTrue('a voucher to guard was saved', guardRes.success === true)
  const guardId = lastVoucher('receive_vouchers')
  const guardLine = rows(
    `SELECT ledger_id FROM customer_ledger WHERE voucher_id = ?`, [guardId])[0]
  const guardBefore = { owed: billsOutstanding(3), banks: allBankBalances() }

  const refusedCl = await call('deleteCustomerLedgerEntry', guardLine.ledger_id)
  checkTrue('deleteCustomerLedgerEntry refuses it', refusedCl.success === false)
  checkTrue('and points at the voucher screen', /Receive Voucher screen/.test(refusedCl.error || ''))
  check('nothing moved on the bills', billsOutstanding(3), guardBefore.owed)
  check('nor on the bank', allBankBalances(), guardBefore.banks)
  check('and the line is still there',
    one(`SELECT COUNT(*) v FROM customer_ledger WHERE ledger_id = ?`, [guardLine.ledger_id]), 1)
  bankInvariant('a refused ledger-line delete')

  // A plain (non-voucher) payment row is still deletable, so the guard is not
  // a blanket refusal that would break the screen it lives on.
  await payOnLedgerScreen(3, 5000)
  const plainLine = rows(
    `SELECT ledger_id FROM customer_ledger
     WHERE customer_id = 3 AND reference_type = 'payment' AND voucher_id IS NULL
     ORDER BY ledger_id DESC`)[0]
  const plainOk = await call('deleteCustomerLedgerEntry', plainLine.ledger_id)
  checkTrue('a non-voucher payment line is still deletable', plainOk.success === true)
  await invariant('deleting a plain payment line', 3)

  const pvGuard = await paymentVoucher(1, 1000, { bankId: HOUSE_B })
  checkTrue('a payment voucher to guard was saved', pvGuard.success === true)
  const pvGuardLine = rows(
    `SELECT ledger_id FROM supplier_ledger WHERE voucher_id = ?`,
    [lastVoucher('payment_vouchers')])[0]
  const refusedSl = await call('deleteSupplierLedgerEntry', pvGuardLine.ledger_id)
  checkTrue('deleteSupplierLedgerEntry refuses it', refusedSl.success === false)
  checkTrue('and points at the voucher screen', /Payment Voucher screen/.test(refusedSl.error || ''))
  bankInvariant('a refused supplier-line delete')

  // ── G. THE CUSTOMER-DEPOSIT AXIS IS UNTOUCHED ────────────────────────────
  console.log('\n=== G. the sales-orders customer-deposit axis is untouched ===')
  // That axis is: reference_type 'payment' with a NULL reference_id, written by
  // deductCustomerBank() onto a CUSTOMER's account. Confirmed with its real
  // method, then asserted to be invisible to every voucher path.
  const axisBefore = bankBalance(CUST_BANK)
  const axisRes = await call('deductCustomerBank', 5, 2000, 'Payment - Bill #BILL-X')
  checkTrue('the axis still works', axisRes.success === true)
  const axisRows = rows(
    `SELECT * FROM bank_ledger
     WHERE bank_id = ? AND reference_type = 'payment' AND reference_id IS NULL`, [CUST_BANK])
  check('it wrote its own kind of row', axisRows.length, 1)
  check('on the customer account', bankBalance(CUST_BANK), axisBefore - 2000)

  const axisSnapshot = JSON.stringify(rows(
    `SELECT bank_id, transaction_date, description, debit, credit, reference_type, reference_id
     FROM bank_ledger WHERE reference_type = 'payment' AND reference_id IS NULL
     ORDER BY ledger_id ASC`))

  // Now exercise every voucher path again and prove the axis never moves.
  const axisCustomerBalance = bankBalance(CUST_BANK)
  const rvAfterAxis = await receiveVoucher(3, 4000, { bankId: HOUSE_A })
  checkTrue('a voucher still saves alongside it', rvAfterAxis.success === true)
  await call('deleteReceiveVoucher', lastVoucher('receive_vouchers'))
  const pvAfterAxis = await paymentVoucher(1, 500, { bankId: HOUSE_B })
  checkTrue('and a payment voucher does', pvAfterAxis.success === true)
  await call('deletePaymentVoucher', lastVoucher('payment_vouchers'))

  checkStr('the deposit-axis rows are byte-for-byte unchanged', JSON.stringify(rows(
    `SELECT bank_id, transaction_date, description, debit, credit, reference_type, reference_id
     FROM bank_ledger WHERE reference_type = 'payment' AND reference_id IS NULL
     ORDER BY ledger_id ASC`)), axisSnapshot)
  check('and the customer account never moved', bankBalance(CUST_BANK), axisCustomerBalance)

  check('NO voucher ever wrote a null-reference payment row',
    one(`SELECT COUNT(*) v FROM bank_ledger
         WHERE reference_type = 'payment' AND reference_id IS NULL AND bank_id IN (?,?)`,
        [HOUSE_A, HOUSE_B]), 0)
  check('and no voucher entry ever landed on a customer account',
    one(`SELECT COUNT(*) v FROM bank_ledger
         WHERE reference_type IN (?,?)
           AND bank_id IN (SELECT bank_id FROM bank_accounts WHERE customer_id IS NOT NULL)`,
        [BANK_SOURCES.receive_vouchers.ref, BANK_SOURCES.payment_vouchers.ref]), 0)

  // Own-farm customers: app-owned, settled on the Customer Ledger screen only.
  check('no voucher was ever written against an own-farm customer',
    one(`SELECT COUNT(*) v FROM receive_vouchers rv
         JOIN customers c ON rv.customer_id = c.customer_id
         WHERE COALESCE(c.customer_type,'external') = 'own_farm'`), 0)
  bankInvariant('the end state')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
