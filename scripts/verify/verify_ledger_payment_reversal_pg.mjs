// [Codex] PostgreSQL port of verify_ledger_payment_reversal.js.
// Current application method bodies and original fixture/assertion values.
// Fixture IO throws on failure; service IO retains driver error result objects.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
async function runSqlFor(database, sql, params = []) {
  const result = await database.run(sql, params)
  if (!result.success) throw new Error(result.error)
  return result
}

// Deleting a payment on an account ledger puts the money back.
//
// This is the regression guard for the defect the client reported: a customer's
// balance is derived from `bills` (total_amount - amount_paid), and a payment's
// real effect is the `amount_paid` the settlement writes there. The delete
// removed only the `customer_ledger` row, so the payment vanished from the
// statement while still being counted: charge 940,000, pay 900,000, delete the
// payment, balance stuck at 40,000.
//
// Everything here runs real source against PostgreSQL — the final schema,
// the actual atomic writer from the server query layer, the
// ledger methods lifted out of database.service.ts, and submitPayment() lifted
// out of customer-ledger.component.ts. Nothing is a copy, so the pay path and
// the un-pay path under test are the ones the app runs.
//
// What is proved:
//   A. THE INVARIANT — the ledger's running total and the bills-derived balance
//      agree, and the cached customers.outstanding_balance agrees with both.
//      Asserted after every single mutation below.
//   B. THE REPORTED BUG — the client's exact three steps, ending at 940,000.
//   C. Spill — a settlement spread FIFO across several bills is unwound off
//      every bill it touched, whether it was logged as one tagged entry or one
//      entry per bill.
//   D. Surgical — with two payments recorded, deleting one reverses that one
//      and leaves the other applied.
//   E. Bill-time payments — a payment Sales Orders wrote when the bill was
//      raised reverses the same way.
//   F. Legacy — an untagged payment row (written before entries carried a
//      bill_id) still reverses the full amount, newest bill first.
//   G. Charges are refused — a bill row is the debt itself; removing its mirror
//      would hide what is owed rather than reduce it. Nothing moves.
//   H. Atomicity — a batch that cannot complete leaves the row AND the bills
//      exactly as they were.
//   I. The supplier ledger, which has no bills behind it, keeps working: its
//      payable is the ledger, so a delete restores it and a purchase is refused.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const CUST_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'account-ledger', 'customer-ledger', 'customer-ledger.component.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

/**
 * The first occurrence of `${kw}${name}(` that actually STARTS a line's
 * content, so a mention of the same name inside a doc comment above the
 * declaration is skipped. A plain method carries no keyword to disambiguate it
 * (`customerSettlementOps(`), and its own comment block refers to it by name,
 * so a bare indexOf lifts the comment and slices nonsense.
 */
function findDecl(src, needle) {
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
    const lineStart = src.lastIndexOf('\n', at) + 1
    if (/^\s*$/.test(src.slice(lineStart, at))) return at
  }
  return -1
}

function extractFn(src, name, kw) {
  const start = findDecl(src, `${kw}${name}(`)
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
 * A method off a class, with its TypeScript stripped. The `async` in the keyword
 * prefix has to survive the rewrite — dropping it turns every `await` inside the
 * body into a syntax error.
 */
function loadMethod(src, name, kw) {
  const decl = /async/.test(kw) ? 'async function ' : 'function '
  // A plain method carries no keyword prefix at all (`customerSettlementOps(`),
  // so there is nothing to strip — the declaration is prepended to the start of
  // the slice instead. An empty `^\s+` would match the method's own body
  // indentation rather than a prefix, and never add the `function`.
  const prefix = kw.trim()
  const body = extractFn(src, name, kw)
    .replace(new RegExp('^' + (prefix ? prefix.replace(/\s+/g, '\\s+') + '\\s+' : '')), decl)
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// The engine. runBatch and executeStatement close over module-level state in
// database.js, so those names are declared here for the eval'd copies to bind
// to — this is the real writer, savepoints, $lastId resolution and all.
async function rows(sql, params = []) { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }

// ── The service under test ──────────────────────────────────────────────────

const svc = {
  async get(sql, params = []) { return db.get(sql, params) },
  async run(sql, params = []) { return db.run(sql, params) },
  async runBatch(ops) { return db.batch(ops) },

  rebuildCustomerBalanceOp:        loadMethod(SVC_SRC, 'rebuildCustomerBalanceOp', 'private '),
  updateCustomerOutstandingBalance: loadMethod(SVC_SRC, 'updateCustomerOutstandingBalance', 'async '),
  // The settlement and its reversal, both now factored out of the screen and
  // the delete respectively. submitPayment() below calls the first through
  // `this.db`, and deleteCustomerLedgerEntry() the second, so lifting them is
  // what keeps this harness testing the real path rather than a copy.
  getUnpaidBills:                  loadMethod(SVC_SRC, 'getUnpaidBills', 'async '),
  customerSettlementOps:           loadMethod(SVC_SRC, 'customerSettlementOps', ''),
  customerUnwindOps:               loadMethod(SVC_SRC, 'customerUnwindOps', 'private async '),
  getAllCustomersWithBalance:      loadMethod(SVC_SRC, 'getAllCustomersWithBalance', 'async '),
  getCustomerLedgerWithBalance:    loadMethod(SVC_SRC, 'getCustomerLedgerWithBalance', 'async '),
  addCustomerLedgerEntry:          loadMethod(SVC_SRC, 'addCustomerLedgerEntry', 'async '),
  deleteCustomerLedgerEntry:       loadMethod(SVC_SRC, 'deleteCustomerLedgerEntry', 'async '),

  getAllSuppliersWithBalance:      loadMethod(SVC_SRC, 'getAllSuppliersWithBalance', 'async '),
  // The supplier debit as a batch op, factored out so the Payment Voucher
  // screen can fold it into its own batch. addSupplierLedgerEntry() is now a
  // one-line caller of it and emits the same statement it always did.
  supplierLedgerEntryOp:           loadMethod(SVC_SRC, 'supplierLedgerEntryOp', 'private '),
  addSupplierLedgerEntry:          loadMethod(SVC_SRC, 'addSupplierLedgerEntry', 'async '),
  deleteSupplierLedgerEntry:       loadMethod(SVC_SRC, 'deleteSupplierLedgerEntry', 'async ')
}
const call = (name, ...args) => svc[name].apply(svc, args)

// ── The screen under test ───────────────────────────────────────────────────
//
// The real submitPayment() and onDeleteConfirmed(), bound onto one context so
// every `this.` inside them resolves the way it does in the app. The screen
// plumbing they touch (the form, the reload, change detection) is stubbed; the
// writes are not.
global.friendlySqlError = (err, fallback) => (err ? String(err) : fallback)
global.toLocalDateString = () => '2025-06-01'

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

  // Stands in for the component's own loadCustomerDetail(): the same three
  // reads, so what the screen believes after a write is what the database says.
  async loadCustomerDetail(customerId) {
    this.selectedCustomer = (await rows(
      `SELECT c.*, (SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)), 0)
                    FROM bills WHERE customer_id = c.customer_id) AS outstanding_balance
       FROM customers c WHERE c.customer_id = ?`, [customerId]))[0]
    this.ledgerEntries = (await svc.getCustomerLedgerWithBalance.call(svc, customerId)).data
    this.customerBills = (await rows(
      `SELECT * FROM bills WHERE customer_id = ?
       AND (COALESCE(amount_paid,0) < COALESCE(total_amount,0)) ORDER BY bill_date ASC`, [customerId]))
    this.unpaidBills = this.customerBills.filter(b => (b.amount_paid || 0) < (b.total_amount || 0))
  },

  submitPayment:    loadMethod(CUST_SRC, 'submitPayment', 'async '),
  onDeleteConfirmed: loadMethod(CUST_SRC, 'onDeleteConfirmed', 'async ')
}

/** Records a payment through the screen's real submitPayment(). */
async function pay(customerId, amount, { billId = null, note = '' } = {}) {
  await screen.loadCustomerDetail(customerId)
  screen.paymentAmount = amount
  screen.selectedBillId = billId
  screen.paymentNote = note
  screen.errorMessage = ''
  await screen.submitPayment()
  await screen.loadCustomerDetail(customerId)
  return screen.errorMessage
}

/** Deletes a ledger row through the screen's real onDeleteConfirmed(). */
async function deleteEntry(customerId, ledgerId) {
  await screen.loadCustomerDetail(customerId)
  screen.deletingEntryId = ledgerId
  screen.errorMessage = ''
  await screen.onDeleteConfirmed()
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
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

const billsOutstanding = async (customerId) => Number((await rows(
  `SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)), 0) v
   FROM bills WHERE customer_id = ?`, [customerId]))[0].v)

const ledgerOutstanding = async (customerId) => Number((await rows(
  `SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)), 0) v
   FROM customer_ledger WHERE customer_id = ?`, [customerId]))[0].v)

const cachedOutstanding = async (customerId) => Number((await rows(
  `SELECT COALESCE(outstanding_balance, 0) v FROM customers WHERE customer_id = ?`, [customerId]))[0].v)

const amountPaid = async (billId) =>
  Number((await rows(`SELECT COALESCE(amount_paid,0) v FROM bills WHERE bill_id = ?`, [billId]))[0].v)

/**
 * THE INVARIANT, asserted after every mutation.
 *
 * The statement a customer reads and the debt the app bills them for are two
 * derivations of the same money: the running total down the ledger, and the sum
 * of what is still unpaid across their bills. They have to land on the same
 * number, or the screen is arguing with itself — which is exactly what the
 * unreversed delete made it do. The cached column is checked against both,
 * because that is the figure Sales Orders and the reports read.
 */
async function invariant(label, customerId) {
  const fromBills = (await billsOutstanding(customerId))
  const fromLedger = (await ledgerOutstanding(customerId))
  const cached = (await cachedOutstanding(customerId))
  const listed = ((await call('getAllCustomersWithBalance', 1)).data || [])
    .find(c => Number(c.customer_id) === customerId)

  const ok = fromBills === fromLedger && cached === fromBills &&
             Number(listed.outstanding_balance) === fromBills
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  INVARIANT after ${label}: ` +
    `bills=${fromBills} ledger=${fromLedger} cached=${cached} list=${listed.outstanding_balance}`)
  return fromBills
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

let nextBillId = 1
async function raiseBill(customerId, total, date, { paid = 0, billNumber = null } = {}) {
  const id = nextBillId++
  const num = billNumber || `BILL-${String(id).padStart(3, '0')}`
  await runSqlFor(db, `INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
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

const ledgerRows = async (customerId) => (await rows(
  `SELECT * FROM customer_ledger WHERE customer_id = ? ORDER BY ledger_id ASC`, [customerId]))

const scratch = await createScratchDb('ledger_payment_reversal')
db = scratch.db
try {

  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x')`)
  await runSqlFor(db, `INSERT INTO customers (customer_id, farm_id, customer_name)
          VALUES (1,1,'Reported Case'), (2,1,'Two Bills'), (3,1,'Bill-Time Payer'),
                 (4,1,'Legacy Rows'), (5,1,'Atomicity')`)

  // ── B. THE REPORTED BUG ──────────────────────────────────────────────────
  console.log('=== B. The reported case: 940,000 charged, 900,000 paid, payment deleted ===')
  const b1 = (await raiseBill(1, 940000, '2025-06-01'))
  await postBillToLedger(1, b1, 940000, '2025-06-01')
  check('charge raised -> balance 940,000', await invariant('the charge', 1), 940000)

  await pay(1, 900000)
  check('payment recorded -> balance 40,000', await invariant('the payment', 1), 40000)
  check('and it landed on the bill', (await amountPaid(b1.id)), 900000)

  const payment1 = (await ledgerRows(1)).find(r => r.reference_type === 'payment')
  const err1 = await deleteEntry(1, payment1.ledger_id)
  checkTrue('the delete was accepted', err1 === '')
  check('THE FIX: balance is back to 940,000', await invariant('the delete', 1), 940000)
  check('the bill is unpaid again', (await amountPaid(b1.id)), 0)
  check('and only the charge is left on the statement', (await ledgerRows(1)).length, 1)
  check('the screen agrees', screen.getCustomerBalance(), 940000)

  // ── C. Spill across several bills ────────────────────────────────────────
  console.log('\n=== C. A settlement spread across several bills, unwound off each ===')
  const older = (await raiseBill(2, 30000, '2025-05-01'))
  const newer = (await raiseBill(2, 50000, '2025-05-20'))
  await postBillToLedger(2, older, 30000, '2025-05-01')
  await postBillToLedger(2, newer, 50000, '2025-05-20')
  check('two bills -> 80,000 owed', await invariant('two charges', 2), 80000)

  // No bill picked: the payment distributes FIFO and is logged one entry per
  // bill, each tagged with the bill it actually paid.
  await pay(2, 45000)
  check('45,000 paid -> 35,000 owed', await invariant('the FIFO payment', 2), 35000)
  check('the older bill was cleared first', (await amountPaid(older.id)), 30000)
  check('the remainder went to the newer bill', (await amountPaid(newer.id)), 15000)
  check('logged as two tagged entries', (await ledgerRows(2)).filter(r => r.reference_type === 'payment').length, 2)

  for (const p of (await ledgerRows(2)).filter(r => r.reference_type === 'payment')) {
    await deleteEntry(2, p.ledger_id)
  }
  check('both reversed -> 80,000 owed again', await invariant('both deletes', 2), 80000)
  check('older bill unpaid', (await amountPaid(older.id)), 0)
  check('newer bill unpaid', (await amountPaid(newer.id)), 0)

  // Now the harder shape: ONE entry tagged to the selected bill, carrying more
  // than that bill could take. The reversal has to follow the spill.
  await pay(2, 45000, { billId: older.id })
  check('45,000 against the older bill -> 35,000 owed', await invariant('the tagged payment', 2), 35000)
  check('one entry, not two', (await ledgerRows(2)).filter(r => r.reference_type === 'payment').length, 1)
  check('the older bill took its 30,000', (await amountPaid(older.id)), 30000)
  check('the spill reached the newer bill', (await amountPaid(newer.id)), 15000)

  const spilled = (await ledgerRows(2)).find(r => r.reference_type === 'payment')
  await deleteEntry(2, spilled.ledger_id)
  check('the whole 45,000 came back', await invariant('the spill reversal', 2), 80000)
  check('off the tagged bill', (await amountPaid(older.id)), 0)
  check('and off the bill it spilled onto', (await amountPaid(newer.id)), 0)

  // ── D. Surgical: two payments, one deleted ───────────────────────────────
  console.log('\n=== D. Two payments recorded, one deleted: the other stays applied ===')
  // The first lands wholly on the older bill; the second clears what is left of
  // it and spills onto the newer one, so it is logged as two rows — one per
  // bill, which is what the untagged path does.
  await pay(2, 20000, { note: 'First instalment' })
  await pay(2, 25000, { note: 'Second instalment' })
  check('45,000 paid over two goes -> 35,000 owed', await invariant('two payments', 2), 35000)
  check('the second is logged per bill it reached',
    (await ledgerRows(2)).filter(r => r.description === 'Second instalment').length, 2)

  const first = (await ledgerRows(2)).find(r => r.description === 'First instalment')
  await deleteEntry(2, first.ledger_id)
  check('deleting the first leaves 55,000 owed', await invariant('one delete of two', 2), 80000 - 25000)
  check('both rows of the second payment survive',
    (await ledgerRows(2)).filter(r => r.description === 'Second instalment').length, 2)
  check('and the whole 25,000 is still applied',
    (await ledgerRows(2)).reduce((s, r) => s + Number(r.credit || 0), 0), 25000)

  // ── E. A payment Sales Orders wrote when the bill was raised ─────────────
  console.log('\n=== E. A bill-time payment reverses the same way ===')
  const partPaid = (await raiseBill(3, 12000, '2025-06-02', { paid: 5000 }))
  await postBillToLedger(3, partPaid, 12000, '2025-06-02')
  await call('addCustomerLedgerEntry', {
    customer_id: 3, transaction_date: '2025-06-02',
    description: `Payment - Bill #${partPaid.num}`, debit: 0, credit: 5000,
    reference_type: 'payment', reference_id: partPaid.id
  })
  await call('updateCustomerOutstandingBalance', 3)
  check('billed 12,000 with 5,000 down -> 7,000 owed', await invariant('a part-paid bill', 3), 7000)

  const downPayment = (await ledgerRows(3)).find(r => r.reference_type === 'payment')
  await deleteEntry(3, downPayment.ledger_id)
  check('deleting the down payment -> 12,000 owed', await invariant('deleting it', 3), 12000)
  check('the bill shows nothing paid', (await amountPaid(partPaid.id)), 0)

  // ── F. Legacy untagged rows ──────────────────────────────────────────────
  console.log('\n=== F. An untagged legacy payment still reverses in full ===')
  const legacyOld = (await raiseBill(4, 10000, '2025-04-01', { paid: 10000 }))
  const legacyNew = (await raiseBill(4, 10000, '2025-04-20', { paid: 4000 }))
  await postBillToLedger(4, legacyOld, 10000, '2025-04-01')
  await postBillToLedger(4, legacyNew, 10000, '2025-04-20')
  // The row a pre-fix settlement left behind: a payment with no bill_id on it.
  await call('addCustomerLedgerEntry', {
    customer_id: 4, transaction_date: '2025-04-25',
    description: 'Payment received', debit: 0, credit: 14000,
    reference_type: 'payment', reference_id: null
  })
  await call('updateCustomerOutstandingBalance', 4)
  check('20,000 billed, 14,000 paid -> 6,000 owed', await invariant('a legacy payment', 4), 6000)

  const untagged = (await ledgerRows(4)).find(r => r.reference_id == null)
  await deleteEntry(4, untagged.ledger_id)
  check('the full 14,000 came back', await invariant('deleting it', 4), 20000)
  check('newest bill unwound first, to zero', (await amountPaid(legacyNew.id)), 0)
  check('and the rest off the older one', (await amountPaid(legacyOld.id)), 0)

  // ── G. A charge is refused ───────────────────────────────────────────────
  console.log('\n=== G. The bill row is the debt: deleting the mirror is refused ===')
  const billRow = (await ledgerRows(1)).find(r => r.reference_type === 'bill')
  const beforeRows = (await ledgerRows(1)).length
  const refusal = await deleteEntry(1, billRow.ledger_id)
  checkTrue('refused with an explanation', /Sales Orders/.test(refusal))
  check('the row is still there', (await ledgerRows(1)).length, beforeRows)
  check('nothing moved', await invariant('the refusal', 1), 940000)
  check('the bill is untouched', (await amountPaid(b1.id)), 0)

  // A debit that is NOT a bill mirror never touched `bills`, so it is only
  // history and stays removable.
  await call('addCustomerLedgerEntry', {
    customer_id: 1, transaction_date: '2025-06-03',
    description: 'Manual adjustment', debit: 500, credit: 0,
    reference_type: null, reference_id: null
  })
  const manual = (await ledgerRows(1)).find(r => r.description === 'Manual adjustment')
  const manualErr = await deleteEntry(1, manual.ledger_id)
  checkTrue('a non-bill debit is still deletable', manualErr === '')
  check('and it leaves the bills alone', (await amountPaid(b1.id)), 0)
  check('back to the charge alone', await invariant('deleting a manual debit', 1), 940000)

  // A row that is already gone is reported, not silently treated as success.
  const goneErr = await deleteEntry(1, 99999)
  checkTrue('a vanished row is reported', /no longer exists/.test(goneErr))

  // ── H. Atomicity ─────────────────────────────────────────────────────────
  console.log('\n=== H. A batch that cannot complete changes nothing ===')
  const atomic = (await raiseBill(5, 8000, '2025-06-04'))
  await postBillToLedger(5, atomic, 8000, '2025-06-04')
  await pay(5, 3000)
  check('3,000 paid -> 5,000 owed', await invariant('a payment', 5), 5000)

  const victim = (await ledgerRows(5)).find(r => r.reference_type === 'payment')
  // Make the bills UPDATE — the first statement of the reversal — impossible.
  await scratch.pool.query(`CREATE FUNCTION block_bill_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$; CREATE TRIGGER block_bill_update BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION block_bill_update_fn()`)
  const blocked = await deleteEntry(5, victim.ledger_id)
  await scratch.pool.query('DROP TRIGGER block_bill_update ON bills; DROP FUNCTION block_bill_update_fn()')

  checkTrue('the failure was surfaced, not swallowed', blocked !== '')
  check('the payment row survived', (await ledgerRows(5)).filter(r => r.ledger_id === victim.ledger_id).length, 1)
  check('the bill still holds the payment', (await amountPaid(atomic.id)), 3000)
  check('and the balance never moved', await invariant('the rolled-back delete', 5), 5000)

  // With the trigger gone the same delete goes through, proving the rollback
  // left nothing half-applied behind it.
  const retry = await deleteEntry(5, victim.ledger_id)
  checkTrue('the retry succeeds', retry === '')
  check('8,000 owed again', await invariant('the retry', 5), 8000)
  check('bill unpaid', (await amountPaid(atomic.id)), 0)

  // ── I. The supplier ledger ───────────────────────────────────────────────
  console.log('\n=== I. Supplier ledger: the payable IS the ledger, so a delete restores it ===')
  await runSqlFor(db, `INSERT INTO suppliers (supplier_id, farm_id, supplier_name) VALUES (1,1,'Feed Mill')`)
  const supplierPayable = async () =>
    Number(((await call('getAllSuppliersWithBalance', 1)).data || [])
      .find(s => Number(s.supplier_id) === 1).outstanding_balance)

  await call('addSupplierLedgerEntry', {
    supplier_id: 1, transaction_date: '2025-06-01', description: 'Purchase Order #7',
    debit: 0, credit: 60000, reference_type: 'purchase', reference_id: 7
  })
  check('purchase -> 60,000 payable', await supplierPayable(), 60000)

  await call('addSupplierLedgerEntry', {
    supplier_id: 1, transaction_date: '2025-06-05', description: 'Payment made',
    debit: 25000, credit: 0, reference_type: 'payment'
  })
  check('payment -> 35,000 payable', await supplierPayable(), 35000)

  const supPayment = (await rows(
    `SELECT * FROM supplier_ledger WHERE supplier_id = 1 AND reference_type = 'payment'`))[0]
  const supDel = await call('deleteSupplierLedgerEntry', supPayment.ledger_id)
  checkTrue('the delete was accepted', supDel.success === true)
  check('payable restored to 60,000', await supplierPayable(), 60000)

  const supPurchase = (await rows(
    `SELECT * FROM supplier_ledger WHERE supplier_id = 1 AND reference_type = 'purchase'`))[0]
  const supRefusal = await call('deleteSupplierLedgerEntry', supPurchase.ledger_id)
  checkTrue('a purchase row is refused', supRefusal.success === false &&
    /Purchase Orders/.test(supRefusal.error))
  check('payable unchanged by the refusal', await supplierPayable(), 60000)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
