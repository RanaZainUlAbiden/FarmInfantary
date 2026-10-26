// [Codex] PostgreSQL port of verify_bank_withdrawals.js.
// Application method bodies come from src/, not the frozen desktop tree.
// Original fixture values and assertions are retained; SQL helpers now await
// the real server query layer. Scratch schemas are removed even on failure.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb } from './lib/pg-harness.mjs'
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

function loadExports(source) {
  const exports = {}
  const code = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
  new Function('exports', code)(exports)
  return exports
}
// Money paid out by bank moves a real bank balance, and un-making it puts the
// money back. Covers both things that can be bank-sourced: asset installments
// and personal expenses.
//
// This is the regression guard for the defect the re-link was asked not to
// rebuild: `payment_source = 'bank'` used to be written and nothing else
// happened, so the recorded bank balance climbed while the real one fell.
//
// Everything here runs REAL source against a real PostgreSQL database — the schema
// from createTables/alterStatements, the atomic writer from runBatch(), and the
// asset/expense/bank methods lifted out of database.service.ts. Nothing is a copy.
//
// What is proved:
//   A. Scoping — customer_id splits one table into house and customer accounts.
//   B. THE INVARIANT — every bank-sourced asset payment AND every bank-sourced
//      personal expense has exactly one matching bank_ledger withdrawal, and
//      every account's cached current_balance equals its own ledger. Asserted
//      after every single mutation below.
//   C. Reversal — deleting a payment, or the whole asset, removes the
//      withdrawals and restores the balance.
//   D. THE SETTLEMENT — the payment a sale writes for the outstanding balance
//      defaults to CASH and never silently reaches a bank account.
//   E. Atomicity — a rejected write leaves nothing behind.
//   F. Deleting an account is refused while a payment still points at it.
//   G. THE EDITABLE PATH — all five transitions on updatePersonalExpense
//      (amount, date, cash->bank, bank->cash, bank A->bank B), each leaving the
//      invariant intact.
//   H. Legacy rows recorded as bank before any of this existed carry no ledger
//      entry: nothing to reverse, nothing to rebuild.
//   I. MONEY IN. Four of the nine source tables are sales and income, so the
//      same mechanism has to post a DEPOSIT (debit, DEP- number) and raise the
//      balance — not a withdrawal with the sign quietly wrong.
//   J. ALL ELEVEN TABLES. Every table in BANK_SOURCES posts, edits and reverses
//      through the shared helpers, with the invariant asserted after each.
//   K. PURCHASE ORDERS PAID -> UNPAID. An unpaid order has moved no money, so
//      marking a paid one unpaid must reverse its withdrawal and write none.
//   L. THE CASCADE. Closing a flock or a batch deletes its expenses, income,
//      sales, labour payments, egg sales and hen sales outright — the one path
//      that never shows a form. Their entries must go with them, and the module
//      guard must keep a flock delete off the COLLIDING batch's deposits.
//   M. An account cannot be deleted while any of the nine still names it.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(src, name, kw, from) {
  // `from` lets a caller anchor the search past anything that merely MENTIONS
  // the name. A doc comment reading `bankRebuildOps()` sits above the real
  // declaration, and a bare indexOf picked the comment and then ran off the end
  // of the file looking for a matching brace.
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
 * A method off the DatabaseService class, with its TypeScript stripped. The
 * `async` in the keyword prefix has to survive the rewrite — dropping it turns
 * every `await` inside the body into a syntax error.
 */
function loadMethod(name, kw = '') {
  const decl = /async/.test(kw) ? 'async function ' : 'function '
  // Anchored on a declaration: a line whose first non-blank text IS the
  // method. That rules out a doc comment mentioning the name (those lines start
  // with `*`) and a `this.`-qualified call site (those start with something
  // else), either of which a bare indexOf would happily pick instead — and then
  // run off the end of the file looking for a matching brace. Indentation is
  // not assumed, because this file has members at column 0 as well as two.
  const needle = `${kw}${name}(`
  let at = -1
  for (let i = SVC_SRC.indexOf(needle); i >= 0; i = SVC_SRC.indexOf(needle, i + 1)) {
    const lineStart = SVC_SRC.lastIndexOf('\n', i) + 1
    // The declaration is the one where nothing but indentation precedes it on
    // its line. A doc-comment line starts with `*`; a call site starts with
    // `this.`, `return`, `...` or similar.
    if (SVC_SRC.slice(lineStart, i).trim() === '') { at = i; break }
  }
  if (at < 0) throw new Error(`${name} not declared as a class member`)
  const raw = extractFn(SVC_SRC, name, kw, at)
  // A `private` / `async` prefix is stripped and replaced by the declaration
  // keyword; a PUBLIC sync method has no prefix to strip, so the keyword is
  // simply prepended. Without this the public helpers the screens call -
  // bankSourceInsertOps and friends - could not be lifted out of real source
  // at all, and this file would be testing a copy.
  const stripped = kw.trim()
    ? raw.replace(new RegExp('^' + kw.trim().replace(/\s+/g, '\\s+') + '\\s+'), '')
    : raw
  const js = ts.transpileModule(decl + stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// The real PostgreSQL writer, savepoints and $lastId handling come from the harness.


// ── The service under test ──────────────────────────────────────────────────

// Read the statics off the real source rather than restating them, so a renamed
// reference_type breaks this file instead of quietly passing.
const ASSET_PAYMENT_REF = SVC_SRC.match(/ASSET_PAYMENT_REF\s*=\s*'([^']+)'/)[1]
// Money IN: the proceeds of selling an asset, deposited into a house account.
const ASSET_SALE_REF = SVC_SRC.match(/ASSET_SALE_REF\s*=\s*'([^']+)'/)[1]
const PERSONAL_EXPENSE_REF = SVC_SRC.match(/PERSONAL_EXPENSE_REF\s*=\s*'([^']+)'/)[1]

// The other seven source tables, lifted from the real declaration rather than
// restated - so adding a table, renaming a reference_type or flipping a
// direction shows up here as a failure instead of quietly passing untested.
const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()

const DatabaseService = { ASSET_PAYMENT_REF, ASSET_SALE_REF, PERSONAL_EXPENSE_REF, BANK_SOURCES }

async function rows(sql, params = []) {
  const result = await db.get(sql, params)
  if (!result.success) throw new Error(result.error)
  return result.data
}

// Every asset/bank method under test, bound onto one context so the `this.`
// calls inside them resolve exactly as they do in the app.
const svc = {
  toLocalDateString: () => '2025-06-01',
  async get(sql, params = []) { return db.get(sql, params) },
  async run(sql, params = []) { return db.run(sql, params) },
  async runBatch(ops) { return db.batch(ops) },

  bankBalanceSql:        loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql: loadMethod('nextTransactionNumberSql', 'private '),
  nextWithdrawalNumberSql: loadMethod('nextWithdrawalNumberSql', 'private '),
  rebuildBankBalanceOp:  loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:          loadMethod('bankEntryOps', 'private '),
  bankWithdrawalOps:     loadMethod('bankWithdrawalOps', 'private '),
  bankReversalOps:       loadMethod('bankReversalOps', 'private '),
  bankIdsForAsset:       loadMethod('bankIdsForAsset', 'private async '),

  // The shared machinery every money screen goes through. The screens supply
  // only their own row's INSERT / UPDATE / DELETE; everything about the bank
  // side is these, so testing them tests all eight screens' bank paths.
  bankSource:            loadMethod('bankSource', 'private '),
  bankIdOf:              loadMethod('bankIdOf', 'private '),
  bankSourceExisting:    loadMethod('bankSourceExisting', 'private async '),
  bankSourceInsertOps:   loadMethod('bankSourceInsertOps'),
  bankRebuildOps:        loadMethod('bankRebuildOps'),
  saveBankSourceEdit:    loadMethod('saveBankSourceEdit', 'async '),
  deleteBankSourced:     loadMethod('deleteBankSourced', 'async '),
  bankCascadeReversalOps: loadMethod('bankCascadeReversalOps', 'async '),

  // The save-time balance guard: no account may be taken below zero. Bound
  // here because this file binds the real method bodies onto one object, so a
  // new `this.` dependency has to be registered or the method under test
  // throws instead of running. Its own behaviour is proved in
  // verify_no_negative_bank.js; here it has to be present so every section
  // below still exercises the paths it now sits in front of.
  bankAmountText:        loadMethod('bankAmountText', 'private '),
  bankEntryEffect:       loadMethod('bankEntryEffect', 'private async '),
  bankSourceDelta:       loadMethod('bankSourceDelta', 'private '),
  checkBankBalances:     loadMethod('checkBankBalances', 'async '),
  checkBankSourceInserts: loadMethod('checkBankSourceInserts', 'async '),

  getBankAccounts:       loadMethod('getBankAccounts', 'async '),
  getHouseBankAccounts:  loadMethod('getHouseBankAccounts', 'async '),
  addBankAccount:        loadMethod('addBankAccount', 'async '),
  linkCustomerToBank:    loadMethod('linkCustomerToBank', 'async '),
  deleteBankAccount:     loadMethod('deleteBankAccount', 'async '),
  addBankLedgerEntry:    loadMethod('addBankLedgerEntry', 'async '),

  getAssets:             loadMethod('getAssets', 'async '),
  addAsset:              loadMethod('addAsset', 'async '),
  addAssetPayment:       loadMethod('addAssetPayment', 'async '),
  deleteAssetPayment:    loadMethod('deleteAssetPayment', 'async '),
  sellAsset:             loadMethod('sellAsset', 'async '),
  deleteAsset:           loadMethod('deleteAsset', 'async '),

  personalExpenseLabel:  loadMethod('personalExpenseLabel', 'private '),
  addPersonalExpense:    loadMethod('addPersonalExpense', 'async '),
  updatePersonalExpense: loadMethod('updatePersonalExpense', 'async '),
  deletePersonalExpense: loadMethod('deletePersonalExpense', 'async ')
}
// addBankAccount calls the bare helper, not a method.
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

const bankBalance = async (bankId) =>
  Number((await rows('SELECT current_balance FROM bank_accounts WHERE bank_id = ?', [bankId]))[0].current_balance)

// The two tables that can be bank-sourced, and how a ledger row points back at
// each. Driving the sweep off this list rather than one hand-written query per
// table is what makes it impossible to add a third and forget to check it.
const SOURCED = [
  { what: 'asset payments',    table: 'asset_payments',    pk: 'payment_id',  ref: ASSET_PAYMENT_REF },
  { what: 'personal expenses', table: 'personal_expenses', pk: 'pexpense_id', ref: PERSONAL_EXPENSE_REF },
  // Driven off the real BANK_SOURCES declaration, so a table added there is
  // swept here automatically and a table added WITHOUT being declared there
  // is caught by the orphan half of the invariant.
  ...Object.values(BANK_SOURCES).map(s => ({ what: s.table.replace(/_/g, ' '), ...s }))
]

/**
 * Rows written BEFORE this wiring existed, which are bank-sourced but carry no
 * ledger entry. They are exempt by construction, not by accident — section H
 * creates them deliberately and this is the only way in. A row that is edited
 * afterwards stops being legacy and is removed from here, at which point the
 * full invariant applies to it again.
 */
const legacy = Object.fromEntries(SOURCED.map(s => [s.table, []]))

/**
 * THE INVARIANT, checked after every mutation below rather than once at the
 * end, so a failure names the step that broke it.
 *
 *   1. every bank-sourced row has exactly one withdrawal
 *   2. every withdrawal points at a row that still exists
 *   3. every account's cached balance equals the ledger it caches
 */
async function assertInvariant(step) {
  for (const { what, table, pk, ref } of SOURCED) {
    const exempt = legacy[table]
    const skip = exempt.length ? ` AND s.${pk} NOT IN (${exempt.join(',')})` : ''

    const unmirrored = (await rows(
      `SELECT COUNT(*) AS n FROM ${table} s
       WHERE s.payment_source = 'bank'${skip}
         AND (SELECT COUNT(*) FROM bank_ledger bl
              WHERE bl.reference_type = ? AND bl.reference_id = s.${pk}) <> 1`,
      [ref]))[0].n
    const orphaned = (await rows(
      `SELECT COUNT(*) AS n FROM bank_ledger bl
       WHERE bl.reference_type = ?
         AND NOT EXISTS (SELECT 1 FROM ${table} s WHERE s.${pk} = bl.reference_id)`,
      [ref]))[0].n

    check(`${step} — ${what} with no withdrawal`, unmirrored, 0)
    check(`${step} — withdrawals with no ${what.replace(/s$/, '')}`, orphaned, 0)
  }

  const drifted = (await rows(
    `SELECT COUNT(*) AS n FROM bank_accounts ba
     WHERE ROUND(COALESCE(ba.current_balance, 0)::numeric, 2) <> ROUND(
       (SELECT COALESCE(SUM(bl.debit - bl.credit), 0) FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)::numeric, 2)`))[0].n
  check(`${step} — accounts whose balance drifted from their ledger`, drifted, 0)
}

/** The ledger row mirroring one personal expense, or null. */
const ledgerFor = async (pexpenseId) =>
  (await rows('SELECT * FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
    [PERSONAL_EXPENSE_REF, pexpenseId]))[0] || null

// ── Fixture ─────────────────────────────────────────────────────────────────

const FARM = 1

const scratch = await createScratchDb('bank_withdrawals')
db = scratch.db
try {

  // executeStatement narrates every insert; the test output is the interesting part.
  const realLog = console.log
  const quiet = async (fn) => { console.log = () => {}; try { return await fn() } finally { console.log = realLog } }

  await runSql(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1, 'Talha', 'x', 'all')`)
  await runSql(`INSERT INTO customers (customer_id, farm_id, customer_name) VALUES (1, 1, 'Outside Buyer')`)

  // One house account (no customer) and one customer account, on the same farm.
  const house = await quiet(() => call('addBankAccount', {
    farm_id: FARM, bank_name: 'HBL Main', account_number: '111', opening_balance: 100000
  }))
  const HOUSE = house.lastId
  const cust = await quiet(() => call('addBankAccount', {
    farm_id: FARM, customer_id: 1, bank_name: 'UBL Customer', account_number: '222', opening_balance: 7000
  }))
  const CUST_BANK = cust.lastId

  console.log('\n=== A. customer_id splits one table into house and customer accounts ===')
  const houseOnly = (await call('getBankAccounts', FARM, 'house')).data
  const customerOnly = (await call('getBankAccounts', FARM, 'customer')).data
  const all = (await call('getBankAccounts', FARM)).data
  check('house scope returns 1 account', houseOnly.length, 1)
  checkStr('and it is the one with no customer', houseOnly[0].bank_name, 'HBL Main')
  checkTrue('house account really has customer_id NULL', houseOnly[0].customer_id === null)
  check('customer scope returns 1 account', customerOnly.length, 1)
  checkStr('and it is the customer-linked one', customerOnly[0].bank_name, 'UBL Customer')
  check('unscoped returns both (Account Ledger total)', all.length, 2)
  check('getHouseBankAccounts agrees', (await call('getHouseBankAccounts', FARM)).data.length, 1)
  check('an account with no customer_id links no customer',
    (await rows('SELECT COUNT(*) AS n FROM customers WHERE bank_id = ?', [HOUSE]))[0].n, 0)
  check('a customer account still links its customer',
    (await rows('SELECT COUNT(*) AS n FROM customers WHERE bank_id = ?', [CUST_BANK]))[0].n, 1)
  check('house opening balance', (await bankBalance(HOUSE)), 100000)

  console.log('\n=== B. buying an asset with a bank down payment withdraws it ===')
  await quiet(() => call('addAsset', {
    farm_id: FARM, asset_name: 'Tractor', category: 'Vehicle', purchase_date: '2025-01-10',
    total_price: 500000, payment_source: 'bank', bank_id: HOUSE, initial_payment: 100000
  }))
  const TRACTOR = (await rows(`SELECT asset_id FROM assets WHERE asset_name = 'Tractor'`))[0].asset_id
  check('bank balance fell by the down payment', (await bankBalance(HOUSE)), 0)
  check('one withdrawal was written',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ? AND reference_type = ?`,
      [HOUSE, ASSET_PAYMENT_REF]))[0].n, 1)
  const firstWd = (await rows(
    `SELECT * FROM bank_ledger WHERE bank_id = ? AND reference_type = ?`, [HOUSE, ASSET_PAYMENT_REF]))[0]
  check('as a credit, not a debit', firstWd.credit, 100000)
  check('debit is zero', firstWd.debit, 0)
  checkStr('numbered like a withdrawal', firstWd.transaction_number, 'WD-0001')
  checkStr('dated the purchase date', firstWd.transaction_date, '2025-01-10')
  checkTrue('and it names the asset', String(firstWd.description).includes('Tractor'))
  check('it points at the payment it mirrors',
    (await rows('SELECT COUNT(*) AS n FROM asset_payments WHERE payment_id = ?', [firstWd.reference_id]))[0].n, 1)
  await assertInvariant('after the down payment')

  console.log('\n=== a cash installment moves no bank balance ===')
  await quiet(() => call('addAssetPayment', {
    asset_id: TRACTOR, farm_id: FARM, date: '2025-02-01', amount: 50000,
    payment_source: 'cash', asset_name: 'Tractor'
  }))
  check('bank untouched', (await bankBalance(HOUSE)), 0)
  check('still one withdrawal on the account',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ? AND reference_type = ?`,
      [HOUSE, ASSET_PAYMENT_REF]))[0].n, 1)
  check('but the asset counts both payments',
    (await rows('SELECT SUM(amount) AS s FROM asset_payments WHERE asset_id = ?', [TRACTOR]))[0].s, 150000)
  await assertInvariant('after the cash installment')

  console.log('\n=== a bank installment withdraws again, numbered in sequence ===')
  await quiet(() => call('addBankLedgerEntry', {
    bank_id: HOUSE, transaction_date: '2025-02-10', description: 'Deposit',
    debit: 200000, credit: 0, reference_type: 'deposit', transaction_number: 'DEP-0001'
  }))
  check('deposit landed', (await bankBalance(HOUSE)), 200000)
  await quiet(() => call('addAssetPayment', {
    asset_id: TRACTOR, farm_id: FARM, date: '2025-03-01', amount: 150000,
    payment_source: 'bank', bank_id: HOUSE, asset_name: 'Tractor'
  }))
  check('balance fell by the installment', (await bankBalance(HOUSE)), 50000)
  const secondWd = (await rows(
    `SELECT * FROM bank_ledger WHERE bank_id = ? AND reference_type = ? ORDER BY ledger_id DESC LIMIT 1`,
    [HOUSE, ASSET_PAYMENT_REF]))[0]
  checkStr('numbered after the first, not over it', secondWd.transaction_number, 'WD-0002')
  check('the deposit is untouched',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger WHERE transaction_number = 'DEP-0001'`))[0].n, 1)
  await assertInvariant('after the bank installment')

  console.log('\n=== C. deleting a bank payment puts the money back ===')
  const bankPaymentId = secondWd.reference_id
  await quiet(() => call('deleteAssetPayment', bankPaymentId, FARM))
  check('balance restored', (await bankBalance(HOUSE)), 200000)
  check('its withdrawal is gone',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_id = ? AND reference_type = ?',
      [bankPaymentId, ASSET_PAYMENT_REF]))[0].n, 0)
  check('the OTHER asset payment kept its withdrawal',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ? AND reference_type = ?`,
      [HOUSE, ASSET_PAYMENT_REF]))[0].n, 1)
  check('outstanding went back up',
    (await rows(`SELECT SUM(amount) AS s FROM asset_payments WHERE asset_id = ?`, [TRACTOR]))[0].s, 150000)
  await assertInvariant('after deleting a bank payment')

  console.log('\n=== deleting a cash payment moves no balance ===')
  const cashPaymentId = (await rows(
    `SELECT payment_id FROM asset_payments WHERE asset_id = ? AND payment_source = 'cash'`, [TRACTOR]))[0].payment_id
  await quiet(() => call('deleteAssetPayment', cashPaymentId, FARM))
  check('balance unchanged', (await bankBalance(HOUSE)), 200000)
  await assertInvariant('after deleting a cash payment')

  console.log('\n=== D. the settlement a sale writes defaults to CASH ===')
  // The whole point: 400,000 is still owed on the tractor. Selling it settles
  // that balance, and the settlement must not reach a bank account nobody chose.
  const owedBefore = 500000 - Number(
    (await rows('SELECT COALESCE(SUM(amount),0) AS s FROM asset_payments WHERE asset_id = ?', [TRACTOR]))[0].s)
  check('outstanding before the sale', owedBefore, 400000)
  const balanceBeforeSale = (await bankBalance(HOUSE))
  await quiet(() => call('sellAsset', TRACTOR, '2025-04-01', 450000))
  check('bank balance did NOT move', (await bankBalance(HOUSE)), balanceBeforeSale)
  const settlement = (await rows(
    'SELECT * FROM asset_payments WHERE asset_id = ? AND is_settlement = 1', [TRACTOR]))[0]
  check('a settlement was still written', settlement.amount, 400000)
  checkStr('recorded as cash', settlement.payment_source, 'cash')
  checkTrue('with no bank account on it', settlement.bank_id === null)
  check('and no withdrawal for it',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_id = ? AND reference_type = ?',
      [settlement.payment_id, ASSET_PAYMENT_REF]))[0].n, 0)
  check('outstanding is nonetheless cleared',
    500000 - Number((await rows('SELECT SUM(amount) AS s FROM asset_payments WHERE asset_id = ?', [TRACTOR]))[0].s), 0)
  await assertInvariant('after a cash-settled sale')

  console.log('\n=== ...and DOES withdraw when the seller picks a bank ===')
  await quiet(() => call('addAsset', {
    farm_id: FARM, asset_name: 'Generator', category: 'Equipment', purchase_date: '2025-05-01',
    total_price: 80000, payment_source: 'cash', initial_payment: 20000
  }))
  const GENERATOR = (await rows(`SELECT asset_id FROM assets WHERE asset_name = 'Generator'`))[0].asset_id
  const beforeGenSale = (await bankBalance(HOUSE))
  await quiet(() => call('sellAsset', GENERATOR, '2025-06-01', 95000,
    { payment_source: 'bank', bank_id: HOUSE }))
  check('balance fell by exactly what was owed', (await bankBalance(HOUSE)), beforeGenSale - 60000)
  const genSettlement = (await rows(
    'SELECT * FROM asset_payments WHERE asset_id = ? AND is_settlement = 1', [GENERATOR]))[0]
  checkStr('settlement recorded as bank', genSettlement.payment_source, 'bank')
  check('on the account chosen', genSettlement.bank_id, HOUSE)
  const genWd = (await rows('SELECT * FROM bank_ledger WHERE reference_id = ? AND reference_type = ?',
    [genSettlement.payment_id, ASSET_PAYMENT_REF]))[0]
  check('one withdrawal, for the settled amount', genWd.credit, 60000)
  checkStr('dated the sale date, not today', genWd.transaction_date, '2025-06-01')
  await assertInvariant('after a bank-settled sale')

  console.log('\n=== D2. the PROCEEDS of a sale: money IN, the other direction ===')
  // Selling an asset brings money in, and until the Sell form grew its own
  // Cash/Bank selector it brought it in nowhere: sale_amount was recorded and
  // no balance moved. The proceeds are a DEPOSIT (debit, DEP-) keyed to the
  // ASSET's id, under their own reference_type — asset_payments on the same
  // asset are withdrawals, and one shared type would make the pair
  // indistinguishable to every reversal in this file.
  await quiet(() => call('addAsset', {
    farm_id: FARM, asset_name: 'Chiller', category: 'Equipment', purchase_date: '2025-07-01',
    total_price: 30000, payment_source: 'cash', initial_payment: 30000
  }))
  const CHILLER = (await rows(`SELECT asset_id FROM assets WHERE asset_name = 'Chiller'`))[0].asset_id
  const beforeChiller = (await bankBalance(HOUSE))
  await quiet(() => call('sellAsset', CHILLER, '2025-07-10', 44000, undefined,
    { payment_source: 'bank', bank_id: HOUSE }))
  check('balance ROSE by exactly the sale amount', (await bankBalance(HOUSE)), beforeChiller + 44000)
  const chillerDep = (await rows('SELECT * FROM bank_ledger WHERE reference_id = ? AND reference_type = ?',
    [CHILLER, ASSET_SALE_REF]))[0]
  check('one deposit, for the sale amount', chillerDep.debit, 44000)
  check('and nothing on the credit side', chillerDep.credit, 0)
  checkStr('dated the sale date', chillerDep.transaction_date, '2025-07-10')
  checkTrue('numbered DEP-, not WD-', String(chillerDep.transaction_number).startsWith('DEP-'))
  checkStr('and the asset records where it went',
    (await rows('SELECT sale_payment_source FROM assets WHERE asset_id = ?', [CHILLER]))[0].sale_payment_source, 'bank')
  check('on the account chosen',
    (await rows('SELECT sale_bank_id FROM assets WHERE asset_id = ?', [CHILLER]))[0].sale_bank_id, HOUSE)
  await assertInvariant('after a sale received into a bank')

  console.log('\n=== ...a CASH sale writes no entry, which is how it reaches cash ===')
  await quiet(() => call('addAsset', {
    farm_id: FARM, asset_name: 'Pump', purchase_date: '2025-07-02',
    total_price: 9000, payment_source: 'cash', initial_payment: 9000
  }))
  const PUMP = (await rows(`SELECT asset_id FROM assets WHERE asset_name = 'Pump'`))[0].asset_id
  const beforePump = (await bankBalance(HOUSE))
  await quiet(() => call('sellAsset', PUMP, '2025-07-11', 12000))
  check('no balance moved', (await bankBalance(HOUSE)), beforePump)
  check('and no deposit exists for it',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_id = ? AND reference_type = ?',
      [PUMP, ASSET_SALE_REF]))[0].n, 0)
  checkStr('recorded as cash',
    (await rows('SELECT sale_payment_source FROM assets WHERE asset_id = ?', [PUMP]))[0].sale_payment_source, 'cash')
  await assertInvariant('after a cash sale')

  console.log('\n=== ...a bank sale with no account is REFUSED, not downgraded ===')
  await quiet(() => call('addAsset', {
    farm_id: FARM, asset_name: 'Crate', purchase_date: '2025-07-03',
    total_price: 1000, payment_source: 'cash', initial_payment: 1000
  }))
  const CRATE = (await rows(`SELECT asset_id FROM assets WHERE asset_name = 'Crate'`))[0].asset_id
  const beforeCrate = (await rows('SELECT COUNT(*) AS n FROM bank_ledger'))[0].n
  const crateBad = await quiet(() => call('sellAsset', CRATE, '2025-07-12', 1500, undefined,
    { payment_source: 'bank', bank_id: null }))
  checkTrue('refused', crateBad.success === false)
  checkStr('asset is still active',
    (await rows('SELECT status FROM assets WHERE asset_id = ?', [CRATE]))[0].status, 'active')
  check('and nothing was written', (await rows('SELECT COUNT(*) AS n FROM bank_ledger'))[0].n, beforeCrate)

  console.log('\n=== ...and deleting the asset takes its deposit with it ===')
  const beforeChillerDelete = (await bankBalance(HOUSE))
  await quiet(() => call('deleteAsset', CHILLER))
  check('balance fell back by the deposit', (await bankBalance(HOUSE)), beforeChillerDelete - 44000)
  check('the deposit is gone',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_id = ? AND reference_type = ?',
      [CHILLER, ASSET_SALE_REF]))[0].n, 0)
  await assertInvariant('after deleting a sold-into-bank asset')

  console.log('\n=== E. a rejected write leaves nothing behind ===')
  await quiet(() => call('addAsset', {
    farm_id: FARM, asset_name: 'Trailer', purchase_date: '2025-06-05',
    total_price: 40000, payment_source: 'cash', initial_payment: 10000
  }))
  const TRAILER = (await rows(`SELECT asset_id FROM assets WHERE asset_name = 'Trailer'`))[0].asset_id
  const ledgerRowsBefore = (await rows('SELECT COUNT(*) AS n FROM bank_ledger'))[0].n
  const bad = await quiet(() => call('sellAsset', TRAILER, '2025-06-10', 50000,
    { payment_source: 'bank', bank_id: null }))
  checkTrue('sale with bank chosen but no account is refused', bad.success === false)
  checkStr('asset is still active', (await rows('SELECT status FROM assets WHERE asset_id = ?', [TRAILER]))[0].status, 'active')
  check('no settlement was written',
    (await rows('SELECT COUNT(*) AS n FROM asset_payments WHERE asset_id = ? AND is_settlement = 1', [TRAILER]))[0].n, 0)
  check('no ledger row was written', (await rows('SELECT COUNT(*) AS n FROM bank_ledger'))[0].n, ledgerRowsBefore)
  const badPay = await quiet(() => call('addAssetPayment', {
    asset_id: TRAILER, farm_id: FARM, date: '2025-06-11', amount: 5000, payment_source: 'bank', bank_id: null
  }))
  checkTrue('payment with bank chosen but no account is refused', badPay.success === false)
  check('and no payment was written',
    (await rows('SELECT COUNT(*) AS n FROM asset_payments WHERE asset_id = ?', [TRAILER]))[0].n, 1)
  await assertInvariant('after two refused writes')

  console.log('\n=== F. an account cannot be deleted out from under a payment ===')
  const refused = await quiet(() => call('deleteBankAccount', HOUSE))
  checkTrue('delete refused while payments reference it', refused.success === false)
  checkTrue('and it says why', /asset payment/.test(refused.error || ''))
  check('the account is still there',
    (await rows('SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_id = ?', [HOUSE]))[0].n, 1)

  console.log('\n=== deleting the asset reverses every withdrawal it made ===')
  const beforeGenDelete = (await bankBalance(HOUSE))
  const genPaid = Number((await rows(
    `SELECT COALESCE(SUM(amount),0) AS s FROM asset_payments
     WHERE asset_id = ? AND payment_source = 'bank'`, [GENERATOR]))[0].s)
  check('the generator had 60,000 of bank payments', genPaid, 60000)
  await quiet(() => call('deleteAsset', GENERATOR))
  check('balance restored by exactly that', (await bankBalance(HOUSE)), beforeGenDelete + 60000)
  check('its payments are gone',
    (await rows('SELECT COUNT(*) AS n FROM asset_payments WHERE asset_id = ?', [GENERATOR]))[0].n, 0)
  check('and so is the asset',
    (await rows('SELECT COUNT(*) AS n FROM assets WHERE asset_id = ?', [GENERATOR]))[0].n, 0)
  await assertInvariant('after deleting a bank-funded asset')

  // ── G. THE EDITABLE PATH ──────────────────────────────────────────────────
  // Personal expenses are the one bank-backed row that can change after the
  // money moved. Every field the withdrawal is built from is editable, so each
  // of the five transitions gets its own step here.

  console.log('\n=== G. a personal expense paid by bank withdraws it ===')
  await runSql(`INSERT INTO expense_categories (category_id, farm_id, category_name) VALUES (1, 1, 'Household')`)
  const HOUSE_B = (await quiet(() => call('addBankAccount', {
    farm_id: FARM, bank_name: 'MCB Second', account_number: '333', opening_balance: 300000
  }))).lastId
  check('second house account opened', (await bankBalance(HOUSE_B)), 300000)

  const balA0 = (await bankBalance(HOUSE))
  await quiet(() => call('addPersonalExpense', {
    farm_id: FARM, date: '2025-01-05', category_id: 1, category: 'Household',
    description: 'Groceries', amount: 10000, payment_source: 'bank', bank_id: HOUSE
  }))
  const PE = (await rows(`SELECT pexpense_id FROM personal_expenses WHERE description = 'Groceries'`))[0].pexpense_id
  check('balance fell by the expense', (await bankBalance(HOUSE)), balA0 - 10000)
  let wd = (await ledgerFor(PE))
  check('one withdrawal, for the amount', wd.credit, 10000)
  checkStr('dated the expense date', wd.transaction_date, '2025-01-05')
  checkTrue('labelled with category and description',
    /Household/.test(wd.description) && /Groceries/.test(wd.description))
  const firstNumber = wd.transaction_number
  await assertInvariant('after a bank-paid personal expense')

  console.log('\n=== a cash personal expense moves no balance ===')
  const beforeCashPe = (await bankBalance(HOUSE))
  await quiet(() => call('addPersonalExpense', {
    farm_id: FARM, date: '2025-01-06', category_id: 1, category: 'Household',
    description: 'Milk', amount: 500, payment_source: 'cash'
  }))
  const PE_CASH = (await rows(`SELECT pexpense_id FROM personal_expenses WHERE description = 'Milk'`))[0].pexpense_id
  check('balance unchanged', (await bankBalance(HOUSE)), beforeCashPe)
  checkTrue('and it has no withdrawal', (await ledgerFor(PE_CASH)) === null)
  await assertInvariant('after a cash personal expense')

  console.log('\n=== G1. amount changed, same account -> net movement is the delta ===')
  await quiet(() => call('updatePersonalExpense', PE, { amount: 25000 }))
  check('balance reflects the NEW amount, not both', (await bankBalance(HOUSE)), balA0 - 25000)
  wd = (await ledgerFor(PE))
  check('still exactly one withdrawal',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
      [PERSONAL_EXPENSE_REF, PE]))[0].n, 1)
  check('at the new amount', wd.credit, 25000)
  checkStr('and it kept its transaction number', wd.transaction_number, firstNumber)
  checkStr('a partial update kept the row date', wd.transaction_date, '2025-01-05')
  check('the row itself was updated',
    (await rows('SELECT amount FROM personal_expenses WHERE pexpense_id = ?', [PE]))[0].amount, 25000)
  await assertInvariant('G1 amount changed')

  console.log('\n=== G2. date changed -> the withdrawal moves with it ===')
  await quiet(() => call('updatePersonalExpense', PE, { date: '2025-02-20' }))
  check('balance unchanged by a date edit', (await bankBalance(HOUSE)), balA0 - 25000)
  wd = (await ledgerFor(PE))
  checkStr('withdrawal re-dated to match the expense', wd.transaction_date, '2025-02-20')
  check('amount untouched by a date-only edit', wd.credit, 25000)
  checkStr('and it still kept its number', wd.transaction_number, firstNumber)
  await assertInvariant('G2 date changed')

  console.log('\n=== G3. bank A -> bank B: A is restored, B is charged, both rebuilt ===')
  const balB0 = (await bankBalance(HOUSE_B))
  await quiet(() => call('updatePersonalExpense', PE, { payment_source: 'bank', bank_id: HOUSE_B }))
  check('A got its money back in full', (await bankBalance(HOUSE)), balA0)
  check('B was charged', (await bankBalance(HOUSE_B)), balB0 - 25000)
  wd = (await ledgerFor(PE))
  check('the withdrawal now sits on B', wd.bank_id, HOUSE_B)
  check('and there is still only one', (await rows(
    'SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
    [PERSONAL_EXPENSE_REF, PE]))[0].n, 1)
  check('nothing of it is left on A', (await rows(
    'SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ? AND reference_type = ? AND reference_id = ?',
    [HOUSE, PERSONAL_EXPENSE_REF, PE]))[0].n, 0)
  checkStr("it took a number from B's own sequence", wd.transaction_number, 'WD-0001')
  check('the row records the new account',
    (await rows('SELECT bank_id FROM personal_expenses WHERE pexpense_id = ?', [PE]))[0].bank_id, HOUSE_B)
  await assertInvariant('G3 bank A -> bank B')

  console.log('\n=== G4. bank -> cash: the withdrawal is reversed outright ===')
  await quiet(() => call('updatePersonalExpense', PE, { payment_source: 'cash', bank_id: null }))
  check('B restored', (await bankBalance(HOUSE_B)), balB0)
  check('A still whole', (await bankBalance(HOUSE)), balA0)
  checkTrue('no withdrawal left anywhere', (await ledgerFor(PE)) === null)
  const asCash = (await rows('SELECT payment_source, bank_id FROM personal_expenses WHERE pexpense_id = ?', [PE]))[0]
  checkStr('row recorded as cash', asCash.payment_source, 'cash')
  checkTrue('with no account on it', asCash.bank_id === null)
  check('the expense itself survives',
    (await rows('SELECT amount FROM personal_expenses WHERE pexpense_id = ?', [PE]))[0].amount, 25000)
  await assertInvariant('G4 bank -> cash')

  console.log('\n=== G5. cash -> bank: a withdrawal is posted from nothing ===')
  await quiet(() => call('updatePersonalExpense', PE, { payment_source: 'bank', bank_id: HOUSE }))
  check('A charged again', (await bankBalance(HOUSE)), balA0 - 25000)
  wd = (await ledgerFor(PE))
  check('exactly one withdrawal', (await rows(
    'SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
    [PERSONAL_EXPENSE_REF, PE]))[0].n, 1)
  check('for the current amount', wd.credit, 25000)
  checkStr('on the current date', wd.transaction_date, '2025-02-20')
  check('on account A', wd.bank_id, HOUSE)
  await assertInvariant('G5 cash -> bank')

  console.log('\n=== all three at once: amount + date + account compose ===')
  await quiet(() => call('updatePersonalExpense', PE, {
    amount: 40000, date: '2025-03-15', payment_source: 'bank', bank_id: HOUSE_B
  }))
  check('A restored in full', (await bankBalance(HOUSE)), balA0)
  check('B charged the new amount', (await bankBalance(HOUSE_B)), balB0 - 40000)
  wd = (await ledgerFor(PE))
  check('one withdrawal, new amount', wd.credit, 40000)
  checkStr('new date', wd.transaction_date, '2025-03-15')
  check('new account', wd.bank_id, HOUSE_B)
  await assertInvariant('combined edit')

  console.log('\n=== naming only bank_id moves the account, it does not mean "cash" ===')
  // The screen always sends both fields, but a caller that sends one must not
  // silently reverse the withdrawal and record the entry as cash.
  await quiet(() => call('updatePersonalExpense', PE, { bank_id: HOUSE }))
  const movedBack = (await rows('SELECT payment_source, bank_id FROM personal_expenses WHERE pexpense_id = ?', [PE]))[0]
  checkStr('still recorded as bank', movedBack.payment_source, 'bank')
  check('on the account named', movedBack.bank_id, HOUSE)
  check('A charged', (await bankBalance(HOUSE)), balA0 - 40000)
  check('B restored', (await bankBalance(HOUSE_B)), balB0)
  check('one withdrawal, on A', (await ledgerFor(PE)).bank_id, HOUSE)
  await assertInvariant('bank_id alone')

  // Put it back on B so the teardown below reads the same either way.
  await quiet(() => call('updatePersonalExpense', PE, { payment_source: 'bank', bank_id: HOUSE_B }))

  console.log('\n=== an edit that touches no bank on either side is a plain update ===')
  await quiet(() => call('updatePersonalExpense', PE_CASH, { amount: 900, description: 'Milk and bread' }))
  check('no ledger rows appeared', (await rows(
    'SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
    [PERSONAL_EXPENSE_REF, PE_CASH]))[0].n, 0)
  check('the row still updated',
    (await rows('SELECT amount FROM personal_expenses WHERE pexpense_id = ?', [PE_CASH]))[0].amount, 900)
  await assertInvariant('cash-only edit')

  console.log('\n=== deleting a bank-paid expense puts the money back ===')
  await quiet(() => call('deletePersonalExpense', PE))
  check('B restored', (await bankBalance(HOUSE_B)), balB0)
  checkTrue('withdrawal gone', (await ledgerFor(PE)) === null)
  check('expense gone',
    (await rows('SELECT COUNT(*) AS n FROM personal_expenses WHERE pexpense_id = ?', [PE]))[0].n, 0)
  await assertInvariant('after deleting a bank-paid expense')

  console.log('\n=== an expense holds an account open too ===')
  await quiet(() => call('addPersonalExpense', {
    farm_id: FARM, date: '2025-04-02', category_id: 1, category: 'Household',
    description: 'School fees', amount: 15000, payment_source: 'bank', bank_id: HOUSE_B
  }))
  const PE_FEES = (await rows(`SELECT pexpense_id FROM personal_expenses WHERE description = 'School fees'`))[0].pexpense_id
  const refusedB = await quiet(() => call('deleteBankAccount', HOUSE_B))
  checkTrue('delete refused', refusedB.success === false)
  checkTrue('and it names personal expenses', /personal expense/.test(refusedB.error || ''))
  await quiet(() => call('deletePersonalExpense', PE_FEES))
  check('once the expense goes, B is whole again', (await bankBalance(HOUSE_B)), balB0)
  const goneB = await quiet(() => call('deleteBankAccount', HOUSE_B))
  checkTrue('and the account can be deleted', goneB.success === true)
  await assertInvariant('after clearing account B')

  // ── H. LEGACY ROWS ────────────────────────────────────────────────────────

  console.log('\n=== H. a row recorded as bank before this wiring has no entry ===')
  // Written straight to the table, the way the old addPersonalExpense would
  // have left it if it had recorded a source at all: bank_id set, no ledger row.
  await runSql(`INSERT INTO personal_expenses (farm_id, date, category_id, category, description, amount, payment_source, bank_id)
          VALUES (1, '2024-06-01', 1, 'Household', 'Old bank payment', 12000, 'bank', ?)`, [HOUSE])
  const PE_LEGACY = (await rows(`SELECT pexpense_id FROM personal_expenses WHERE description = 'Old bank payment'`))[0].pexpense_id
  legacy.personal_expenses.push(PE_LEGACY)
  const balBeforeLegacy = (await bankBalance(HOUSE))
  checkTrue('it genuinely has no withdrawal', (await ledgerFor(PE_LEGACY)) === null)

  await runSql(`INSERT INTO personal_expenses (farm_id, date, category_id, category, description, amount, payment_source, bank_id)
          VALUES (1, '2024-06-02', 1, 'Household', 'Old, to be deleted', 3000, 'bank', ?)`, [HOUSE])
  const PE_LEGACY_DEL = (await rows(`SELECT pexpense_id FROM personal_expenses WHERE description = 'Old, to be deleted'`))[0].pexpense_id
  legacy.personal_expenses.push(PE_LEGACY_DEL)

  await quiet(() => call('deletePersonalExpense', PE_LEGACY_DEL))
  check('deleting a legacy row rebuilds nothing and moves no balance',
    (await bankBalance(HOUSE)), balBeforeLegacy)
  check('the row is gone all the same',
    (await rows('SELECT COUNT(*) AS n FROM personal_expenses WHERE pexpense_id = ?', [PE_LEGACY_DEL]))[0].n, 0)
  legacy.personal_expenses = legacy.personal_expenses.filter(id => id !== PE_LEGACY_DEL)
  await assertInvariant('after deleting a legacy row')

  console.log('\n=== editing a legacy row starts posting from then on ===')
  await quiet(() => call('updatePersonalExpense', PE_LEGACY, { amount: 12500 }))
  // No longer legacy: it has been through the wiring, so the full invariant
  // applies to it from here.
  legacy.personal_expenses = legacy.personal_expenses.filter(id => id !== PE_LEGACY)
  const legacyWd = (await ledgerFor(PE_LEGACY))
  checkTrue('it now has a withdrawal', legacyWd !== null)
  check('for the corrected amount, not the old one', legacyWd.credit, 12500)
  check('charged once, not twice', (await bankBalance(HOUSE)), balBeforeLegacy - 12500)
  await assertInvariant('after editing a legacy row')


  // == I-M. THE OTHER SEVEN SOURCE TABLES ===================================
  //
  // Everything above is assets and personal expenses, which only ever pay money
  // OUT and are only ever created and destroyed. The seven tables below are the
  // money screens: four of them receive money rather than pay it, all seven are
  // editable, and two of them are deleted wholesale when a flock or a batch is
  // closed. The shared helpers are what they all go through, so they are what
  // is tested here - a screen supplies only its own row's INSERT/UPDATE/DELETE.

  // One account for this whole block, kept away from HOUSE so the arithmetic in
  // the sections above still reads straight.
  const houseC = await quiet(() => call('addBankAccount', {
    farm_id: FARM, bank_name: 'MCB Sales', account_number: '333', opening_balance: 50000
  }))
  const BANK_C = houseC.lastId
  const BANK_D = (await quiet(() => call('addBankAccount', {
    farm_id: FARM, bank_name: 'Alfalah Second', account_number: '444', opening_balance: 20000
  }))).lastId

  // A broiler flock and a layer batch, deliberately created so their ids
  // COLLIDE - separate AUTOINCREMENT sequences both starting at 1. This is the
  // defect the module guards exist for, and section L turns on it.
  await runSql(`INSERT INTO flocks (farm_id, flock_name, start_date, unit_id) VALUES (1, 'F#1', '2025-01-01', 1)`)
  await runSql(`INSERT INTO batches (farm_id, batch_name, start_date, initial_birds, unit_id) VALUES (1, 'B#1', '2025-01-01', 500, 1)`)
  const FLOCK = (await rows(`SELECT flock_id FROM flocks WHERE flock_name = 'F#1'`))[0].flock_id
  const BATCH = (await rows(`SELECT batch_id FROM batches WHERE batch_name = 'B#1'`))[0].batch_id
  check('the flock and the batch really do collide on id', FLOCK, BATCH)

  await runSql(`INSERT INTO labour (farm_id, labour_name) VALUES (1, 'Rashid')`)
  const WORKER = (await rows(`SELECT labour_id FROM labour WHERE labour_name = 'Rashid'`))[0].labour_id
  await runSql(`INSERT INTO products (farm_id, product_name) VALUES (1, 'Feed Bag')`)
  const PRODUCT = (await rows(`SELECT product_id FROM products WHERE product_name = 'Feed Bag'`))[0].product_id
  await runSql(`INSERT INTO suppliers (farm_id, supplier_name) VALUES (1, 'Agri Supplies')`)
  const SUPPLIER = (await rows(`SELECT supplier_id FROM suppliers WHERE supplier_name = 'Agri Supplies'`))[0].supplier_id

  /**
   * What every money screen's multi-row save does: the row's own INSERT, then
   * its bank entry keyed to it with `{ $lastId: -1 }`, then the balance rebuilt
   * once at the end. Returns the new row's id.
   */
  const screenSave = async (key, sql, params, bank) => {
    const ops = [{ sql, params }]
    ops.push(...call('bankSourceInsertOps', key, bank))
    ops.push(...call('bankRebuildOps', [bank.bank_id]))
    const res = await runBatch(ops)
    if (!res.success) throw new Error(`${key} save failed: ${res.error}`)
    return (await rows(`SELECT MAX(${BANK_SOURCES[key].pk}) AS id FROM ${BANK_SOURCES[key].table}`))[0].id
  }

  /** The ledger row mirroring one source row, or null. */
  const entryFor = async (key, id) => (await rows(
    'SELECT * FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
    [BANK_SOURCES[key].ref, id]))[0] || null

  console.log('\n=== I. money IN writes a deposit, not a withdrawal with the sign wrong ===')
  const cBefore = (await bankBalance(BANK_C))
  const SALE = await screenSave('sales',
    `INSERT INTO sales (flock_id, date, vehicle_number, broker, bird_weight, rate, total_amount, payment_type, payment_source, bank_id, module_type)
     VALUES (?, '2025-05-01', 'LHR-1234', 'Akram', 1200, 250, 300000, 'bank', 'bank', ?, 'broiler')`,
    [FLOCK, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-01', description: 'Broiler sale', amount: 300000 })
  const saleEntry = (await entryFor('sales', SALE))
  checkTrue('a sale banked wrote one entry', saleEntry !== null)
  check('as a DEBIT - money arriving', saleEntry.debit, 300000)
  check('credit is zero', saleEntry.credit, 0)
  check('and the balance ROSE', (await bankBalance(BANK_C)), cBefore + 300000)
  checkTrue('numbered DEP-, not WD-', /^DEP-\d{4}$/.test(saleEntry.transaction_number || ''))
  checkStr('first deposit on the account', saleEntry.transaction_number, 'DEP-0001')
  await assertInvariant('after a banked sale')

  console.log('\n=== DEP- and WD- are independent sequences on one account ===')
  const EXP = await screenSave('expenses',
    `INSERT INTO expenses (flock_id, date, category, description, amount, payment_type, payment_source, bank_id, module_type)
     VALUES (?, '2025-05-02', 'Diesel', 'Generator', 8000, 'bank', 'bank', ?, 'broiler')`,
    [FLOCK, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-02', description: 'Expense - Diesel', amount: 8000 })
  const expEntry = (await entryFor('expenses', EXP))
  check('an expense paid by bank is a CREDIT', expEntry.credit, 8000)
  check('debit is zero', expEntry.debit, 0)
  checkStr('and takes the WD- sequence', expEntry.transaction_number, 'WD-0001')
  check('the balance fell by it', (await bankBalance(BANK_C)), cBefore + 300000 - 8000)
  const SALE2 = await screenSave('sales',
    `INSERT INTO sales (flock_id, date, vehicle_number, broker, bird_weight, rate, total_amount, payment_type, payment_source, bank_id, module_type)
     VALUES (?, '2025-05-03', 'LHR-9999', 'Akram', 100, 250, 25000, 'bank', 'bank', ?, 'broiler')`,
    [FLOCK, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-03', description: 'Broiler sale 2', amount: 25000 })
  checkStr('the next deposit continues DEP-, unaffected by the WD- row',
    (await entryFor('sales', SALE2)).transaction_number, 'DEP-0002')
  await assertInvariant('after mixing deposits and withdrawals on one account')

  console.log('\n=== J. every table in BANK_SOURCES posts through the same helpers ===')
  // One bank-sourced row per remaining table, each asserted to carry exactly
  // one entry pointing the right way. Driving this off BANK_SOURCES means a
  // table added to that map without being handled here fails the sweep.
  const posted = { sales: SALE, expenses: EXP }
  const balBeforeJ = (await bankBalance(BANK_C))
  let expectedJ = balBeforeJ

  posted.egg_sales = await screenSave('egg_sales',
    `INSERT INTO egg_sales (batch_id, date, customer_name, grade, quantity, rate_per_egg, total_amount, payment_type, payment_source, bank_id)
     VALUES (?, '2025-05-04', 'Shop A', 'mixed', 1000, 12, 12000, 'bank', 'bank', ?)`,
    [BATCH, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-04', description: 'Egg sale', amount: 12000 })
  expectedJ += 12000

  posted.hen_sales = await screenSave('hen_sales',
    `INSERT INTO hen_sales (batch_id, date, customer_name, quantity, rate_per_hen, total_amount, payment_type, payment_source, bank_id)
     VALUES (?, '2025-05-05', 'Shop B', 50, 900, 45000, 'bank', 'bank', ?)`,
    [BATCH, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-05', description: 'Hen sale', amount: 45000 })
  expectedJ += 45000

  posted.income = await screenSave('income',
    `INSERT INTO income (flock_id, date, description, amount, source, payment_source, bank_id, module_type)
     VALUES (?, '2025-05-06', 'Sawdust', 5000, 'manual', 'bank', ?, 'broiler')`,
    [FLOCK, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-06', description: 'Income: Sawdust', amount: 5000 })
  expectedJ += 5000

  posted.labour_payments = await screenSave('labour_payments',
    `INSERT INTO labour_payments (labour_id, flock_id, date, description, amount, payment_type, payment_source, bank_id, module_type)
     VALUES (?, ?, '2025-05-07', 'Wages', 20000, 'bank', 'bank', ?, 'broiler')`,
    [WORKER, FLOCK, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-07', description: 'Labour payment', amount: 20000 })
  expectedJ -= 20000

  posted.purchase_orders = await screenSave('purchase_orders',
    `INSERT INTO purchase_orders (farm_id, supplier_id, product_id, date, quantity, cost_price, total_amount, payment_type, payment_source, bank_id)
     VALUES (1, ?, ?, '2025-05-08', 10, 3000, 30000, 'cash', 'bank', ?)`,
    [SUPPLIER, PRODUCT, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-08', description: 'Purchase order', amount: 30000 })
  expectedJ -= 30000

  // The two vouchers. Only their BANK side is exercised here, which is all this
  // file is about: the settlement each one drives — the FIFO allocation across
  // bills, the supplier debit — is `verify_vouchers.js`. A bare voucher row is
  // therefore enough, and keeps this sweep testing one thing.
  posted.receive_vouchers = await screenSave('receive_vouchers',
    `INSERT INTO receive_vouchers (farm_id, customer_id, voucher_number, date, amount, payment_source, bank_id)
     VALUES (1, 1, 'RV-001', '2025-05-09', 17000, 'bank', ?)`,
    [BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-09', description: 'Receive voucher', amount: 17000 })
  expectedJ += 17000

  posted.payment_vouchers = await screenSave('payment_vouchers',
    `INSERT INTO payment_vouchers (farm_id, supplier_id, voucher_number, date, amount, payment_source, bank_id)
     VALUES (1, ?, 'PV-001', '2025-05-10', 9000, 'bank', ?)`,
    [SUPPLIER, BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-10', description: 'Payment voucher', amount: 9000 })
  expectedJ -= 9000

  // The distribution business's own running costs. Its `payment_type` is paid
  // vs unpaid rather than a source, so Cash/Bank is its own field here — the
  // purchase_orders shape.
  posted.expense_ledger = await screenSave('expense_ledger',
    `INSERT INTO expense_ledger (farm_id, transaction_date, description, amount, category, payment_type, payment_source, bank_id)
     VALUES (1, '2025-05-11', 'Office rent', 11000, 'Rent', 'cash', 'bank', ?)`,
    [BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-11', description: 'Expense - Office rent', amount: 11000 })
  expectedJ -= 11000

  for (const key of Object.keys(BANK_SOURCES)) {
    const spec = BANK_SOURCES[key]
    checkTrue(`${key} is covered by this section`, posted[key] !== undefined)
    const e = (await entryFor(key, posted[key]))
    checkTrue(`${key} wrote exactly one entry`, e !== null)
    if (e) {
      const incoming = spec.dir === 'in'
      check(`${key} points ${spec.dir}`, incoming ? e.credit : e.debit, 0)
      checkTrue(`${key} carries the ${incoming ? 'DEP' : 'WD'}- sequence`,
        new RegExp('^' + (incoming ? 'DEP' : 'WD') + '-').test(e.transaction_number || ''))
    }
  }
  check('and the balance is the sum of every movement', (await bankBalance(BANK_C)), expectedJ)
  await assertInvariant('after posting through every declared table')

  // The two vouchers and the distribution expense ledger are ACCOUNT-scoped,
  // not flock- or batch-scoped, so neither cascade below reaches them and
  // section P's "back to opening balance" claim would be out by their net if
  // they were left standing. That is the correct semantics — closing a flock
  // must not reverse a customer receipt or the business's rent — so they are
  // cleared here, through the same shared reversal every other table uses.
  for (const key of ['receive_vouchers', 'payment_vouchers', 'expense_ledger']) {
    const spec = BANK_SOURCES[key]
    await quiet(() => call('deleteBankSourced', key, posted[key],
      [{ sql: `DELETE FROM ${spec.table} WHERE ${spec.pk} = ?`, params: [posted[key]] }]))
    checkTrue(`${key} reverses through the shared helper`, (await entryFor(key, posted[key])) === null)
  }
  check('and the account is back to where the flock/batch-scoped tables left it',
    (await bankBalance(BANK_C)), expectedJ - 17000 + 9000 + 11000)
  await assertInvariant('after clearing the account-scoped rows')

  console.log('\n=== K. the five edit transitions, on money IN and money OUT ===')
  const editOne = async (key, id, sets, next) => {
    const spec = BANK_SOURCES[key]
    const cols = Object.keys(sets).map(c => `${c} = ?`).join(', ')
    return call('saveBankSourceEdit', key, id,
      { sql: `UPDATE ${spec.table} SET ${cols} WHERE ${spec.pk} = ?`,
        params: [...Object.values(sets), id] },
      next)
  }

  // 1. amount changed, same account: the net movement is the DIFFERENCE.
  const kBefore = (await bankBalance(BANK_C))
  const saleNumber = (await entryFor('sales', SALE)).transaction_number
  await quiet(() => editOne('sales', SALE,
    { total_amount: 320000, payment_source: 'bank', bank_id: BANK_C },
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-01', description: 'Broiler sale', amount: 320000 }))
  check('a deposit edited up moves the balance by the difference only',
    (await bankBalance(BANK_C)), kBefore + 20000)
  check('still exactly one entry',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE reference_type = ? AND reference_id = ?',
      [BANK_SOURCES.sales.ref, SALE]))[0].n, 1)
  checkStr('and it keeps the number it had', (await entryFor('sales', SALE)).transaction_number, saleNumber)
  await assertInvariant('after editing a deposit amount')

  // 2. date changed: the entry moves with the record it mirrors.
  await quiet(() => editOne('sales', SALE,
    { date: '2025-05-20', payment_source: 'bank', bank_id: BANK_C },
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-20', description: 'Broiler sale', amount: 320000 }))
  checkStr('the entry is re-posted on the new date', (await entryFor('sales', SALE)).transaction_date, '2025-05-20')
  check('and no money moved', (await bankBalance(BANK_C)), kBefore + 20000)
  await assertInvariant('after editing a deposit date')

  // 3. bank -> cash: the entry goes, the record stays.
  const beforeToCash = (await bankBalance(BANK_C))
  await quiet(() => editOne('expenses', EXP,
    { payment_source: 'cash', bank_id: null },
    { payment_source: 'cash', bank_id: null, date: '2025-05-02', description: 'Expense - Diesel', amount: 8000 }))
  checkTrue('its withdrawal is gone', (await entryFor('expenses', EXP)) === null)
  check('the account is made whole', (await bankBalance(BANK_C)), beforeToCash + 8000)
  check('and the expense itself is untouched',
    (await rows('SELECT amount FROM expenses WHERE expense_id = ?', [EXP]))[0].amount, 8000)
  await assertInvariant('after bank -> cash')

  // 4. cash -> bank: nothing to delete, one entry written.
  await quiet(() => editOne('expenses', EXP,
    { payment_source: 'bank', bank_id: BANK_C },
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-02', description: 'Expense - Diesel', amount: 8000 }))
  checkTrue('a withdrawal reappears', (await entryFor('expenses', EXP)) !== null)
  check('charged once', (await bankBalance(BANK_C)), beforeToCash)
  await assertInvariant('after cash -> bank')

  // 5. bank A -> bank B: A restored IN FULL, B charged, both rebuilt.
  const aBefore = (await bankBalance(BANK_C)), dBefore = (await bankBalance(BANK_D))
  await quiet(() => editOne('expenses', EXP,
    { payment_source: 'bank', bank_id: BANK_D },
    { payment_source: 'bank', bank_id: BANK_D, date: '2025-05-02', description: 'Expense - Diesel', amount: 8000 }))
  check('A restored in full', (await bankBalance(BANK_C)), aBefore + 8000)
  check('B charged', (await bankBalance(BANK_D)), dBefore - 8000)
  check('the entry now sits on B', (await entryFor('expenses', EXP)).bank_id, BANK_D)
  checkTrue('with a fresh number from B\'s own sequence',
    /^WD-0001$/.test((await entryFor('expenses', EXP)).transaction_number || ''))
  await assertInvariant('after bank A -> bank B')

  console.log('\n=== K2. a deposit moved between accounts is a deposit on both ===')
  const sBefore = (await bankBalance(BANK_C)), sdBefore = (await bankBalance(BANK_D))
  await quiet(() => editOne('sales', SALE,
    { payment_source: 'bank', bank_id: BANK_D },
    { payment_source: 'bank', bank_id: BANK_D, date: '2025-05-20', description: 'Broiler sale', amount: 320000 }))
  check('the deposit is taken back off A', (await bankBalance(BANK_C)), sBefore - 320000)
  check('and added to B - not subtracted', (await bankBalance(BANK_D)), sdBefore + 320000)
  check('still a debit', (await entryFor('sales', SALE)).debit, 320000)
  await assertInvariant('after moving a deposit between accounts')
  // Put it back so the rest of the block reads off one account.
  await quiet(() => editOne('sales', SALE,
    { payment_source: 'bank', bank_id: BANK_C },
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-20', description: 'Broiler sale', amount: 320000 }))
  await quiet(() => editOne('expenses', EXP,
    { payment_source: 'bank', bank_id: BANK_C },
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-05-02', description: 'Expense - Diesel', amount: 8000 }))
  await assertInvariant('after restoring both onto A')

  console.log('\n=== L. a purchase order marked UNPAID has taken no money out ===')
  // payment_type on that screen is a settlement status, so Paid -> Unpaid has
  // to reverse the withdrawal and write none - the supplier is simply owed.
  const PO = posted.purchase_orders
  const poBefore = (await bankBalance(BANK_C))
  await quiet(() => editOne('purchase_orders', PO,
    { payment_type: 'credit', payment_source: 'cash', bank_id: null },
    { payment_source: 'cash', bank_id: null, date: '2025-05-08', description: 'Purchase order', amount: 30000 }))
  checkTrue('its withdrawal is gone', (await entryFor('purchase_orders', PO)) === null)
  check('the account is made whole', (await bankBalance(BANK_C)), poBefore + 30000)
  check('the order itself survives, now unpaid',
    (await rows('SELECT COUNT(*) AS n FROM purchase_orders WHERE purchase_id = ? AND payment_type = ?',
      [PO, 'credit']))[0].n, 1)
  await assertInvariant('after paid -> unpaid')

  console.log('\n=== M. deleting a row takes its entry and rebuilds the balance ===')
  const delBefore = (await bankBalance(BANK_C))
  const henAmount = 45000
  await quiet(() => call('deleteBankSourced', 'hen_sales', posted.hen_sales,
    [{ sql: 'DELETE FROM hen_sales WHERE hen_sale_id = ?', params: [posted.hen_sales] }]))
  checkTrue('the deposit is gone', (await entryFor('hen_sales', posted.hen_sales)) === null)
  check('the money it claimed is taken back off the balance',
    (await bankBalance(BANK_C)), delBefore - henAmount)
  check('and the sale is gone',
    (await rows('SELECT COUNT(*) AS n FROM hen_sales WHERE hen_sale_id = ?', [posted.hen_sales]))[0].n, 0)
  await assertInvariant('after deleting a banked hen sale')

  console.log('\n=== N. THE CASCADE: closing a flock cannot touch the colliding batch ===')
  // Both sides file into `expenses` with the SAME id in `flock_id`, told apart
  // only by module_type. An unguarded cascade reversal would delete the layer
  // batch's entry along with the flock's - across accounts, with no form in
  // sight. This is the trap the module guard exists for.
  const LAYER_EXP = await screenSave('expenses',
    `INSERT INTO expenses (flock_id, date, category, description, amount, payment_source, bank_id, module_type)
     VALUES (?, '2025-06-01', 'Repairs', 'Layer shed', 11000, 'bank', ?, 'layer')`,
    [BATCH, BANK_D],
    { payment_source: 'bank', bank_id: BANK_D, date: '2025-06-01', description: 'Layer expense', amount: 11000 })
  const BROILER_EXP = await screenSave('expenses',
    `INSERT INTO expenses (flock_id, date, category, description, amount, payment_source, bank_id, module_type)
     VALUES (?, '2025-06-02', 'Repairs', 'Broiler shed', 7000, 'bank', ?, 'broiler')`,
    [FLOCK, BANK_D],
    { payment_source: 'bank', bank_id: BANK_D, date: '2025-06-02', description: 'Broiler expense', amount: 7000 })
  await assertInvariant('with a colliding pair in place')

  const dBeforeCascade = (await bankBalance(BANK_D))
  const broilerScope = `COALESCE(module_type, 'broiler') = 'broiler'`

  // Exactly what flock-management.component.ts does: read the accounts first,
  // then reverse and delete in ONE batch, both scoped by the same clause.
  const revs = []
  for (const key of ['expenses', 'income', 'sales', 'labour_payments']) {
    const r = await call('bankCascadeReversalOps', key, `flock_id = ? AND ${broilerScope}`, [FLOCK])
    checkTrue(`${key} reversal ops read cleanly`, r.success === true)
    revs.push(...(r.ops || []))
  }
  const cascade = await quiet(() => runBatch([
    ...revs,
    { sql: `DELETE FROM expenses        WHERE flock_id = ? AND ${broilerScope}`, params: [FLOCK] },
    { sql: `DELETE FROM income          WHERE flock_id = ? AND ${broilerScope}`, params: [FLOCK] },
    { sql: `DELETE FROM sales           WHERE flock_id = ? AND ${broilerScope}`, params: [FLOCK] },
    { sql: `DELETE FROM labour_payments WHERE flock_id = ? AND ${broilerScope}`, params: [FLOCK] },
    { sql: `DELETE FROM flocks          WHERE flock_id = ?`, params: [FLOCK] }
  ]))
  checkTrue('the cascade committed', cascade.success === true)

  check('the broiler expense is gone',
    (await rows('SELECT COUNT(*) AS n FROM expenses WHERE expense_id = ?', [BROILER_EXP]))[0].n, 0)
  checkTrue('and so is its withdrawal', (await entryFor('expenses', BROILER_EXP)) === null)
  check('THE LAYER BATCH KEEPS ITS EXPENSE',
    (await rows('SELECT COUNT(*) AS n FROM expenses WHERE expense_id = ?', [LAYER_EXP]))[0].n, 1)
  checkTrue('AND ITS WITHDRAWAL', (await entryFor('expenses', LAYER_EXP)) !== null)
  check('B is restored by the broiler row only - 7000, not 18000',
    (await bankBalance(BANK_D)), dBeforeCascade + 7000)
  check('no bank_ledger row survives pointing at a deleted expense',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger bl
          WHERE bl.reference_type = ?
            AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.expense_id = bl.reference_id)`,
      [BANK_SOURCES.expenses.ref]))[0].n, 0)
  await assertInvariant('after the flock cascade')

  console.log('\n=== the batch cascade is the mirror image ===')
  const dBeforeBatch = (await bankBalance(BANK_D))
  const cBeforeBatch = (await bankBalance(BANK_C))
  const layerScope = `module_type = 'layer'`
  const brevs = []
  for (const [key, scope] of [
    ['egg_sales', 'batch_id = ?'],
    ['hen_sales', 'batch_id = ?'],
    ['expenses', `flock_id = ? AND ${layerScope}`],
    ['income', `flock_id = ? AND ${layerScope}`],
    ['labour_payments', `flock_id = ? AND ${layerScope}`]
  ]) {
    const r = await call('bankCascadeReversalOps', key, scope, [BATCH])
    checkTrue(`${key} batch reversal ops read cleanly`, r.success === true)
    brevs.push(...(r.ops || []))
  }
  const batchCascade = await quiet(() => runBatch([
    ...brevs,
    { sql: `DELETE FROM egg_sales       WHERE batch_id = ?`, params: [BATCH] },
    { sql: `DELETE FROM hen_sales       WHERE batch_id = ?`, params: [BATCH] },
    { sql: `DELETE FROM expenses        WHERE flock_id = ? AND ${layerScope}`, params: [BATCH] },
    { sql: `DELETE FROM income          WHERE flock_id = ? AND ${layerScope}`, params: [BATCH] },
    { sql: `DELETE FROM labour_payments WHERE flock_id = ? AND ${layerScope}`, params: [BATCH] },
    { sql: `DELETE FROM batches         WHERE batch_id = ?`, params: [BATCH] }
  ]))
  checkTrue('the batch cascade committed', batchCascade.success === true)
  check('the layer expense is gone now',
    (await rows('SELECT COUNT(*) AS n FROM expenses WHERE expense_id = ?', [LAYER_EXP]))[0].n, 0)
  check('B restored by the layer row - 11000', (await bankBalance(BANK_D)), dBeforeBatch + 11000)
  check('the egg sale deposit is taken back off A',
    (await bankBalance(BANK_C)), cBeforeBatch - 12000)
  await assertInvariant('after the batch cascade')

  console.log('\n=== O. a legacy row in a new table has no entry either ===')
  // Written straight to the table, exactly as every row saved before this
  // change looks: payment_type says 'bank' but payment_source carries its
  // 'cash' column default, because no deposit was ever posted. The exemption
  // is therefore structural - there is no list to keep.
  await runSql(`INSERT INTO expenses (flock_id, date, category, description, amount, payment_type, module_type)
          VALUES (99, '2024-01-01', 'Diesel', 'Old bank expense', 4000, 'bank', 'broiler')`)
  const LEGACY_EXP = (await rows(`SELECT expense_id FROM expenses WHERE description = 'Old bank expense'`))[0].expense_id
  const legacyRow = (await rows('SELECT payment_source, bank_id FROM expenses WHERE expense_id = ?', [LEGACY_EXP]))[0]
  checkStr('payment_source took its cash default', legacyRow.payment_source, 'cash')
  checkTrue('bank_id is null', legacyRow.bank_id === null)
  checkTrue('and it carries no entry', (await entryFor('expenses', LEGACY_EXP)) === null)

  const legacyBal = (await bankBalance(BANK_C))
  await quiet(() => call('deleteBankSourced', 'expenses', LEGACY_EXP,
    [{ sql: 'DELETE FROM expenses WHERE expense_id = ?', params: [LEGACY_EXP] }]))
  check('deleting it rebuilds nothing and moves no balance', (await bankBalance(BANK_C)), legacyBal)
  check('the row is gone all the same',
    (await rows('SELECT COUNT(*) AS n FROM expenses WHERE expense_id = ?', [LEGACY_EXP]))[0].n, 0)
  await assertInvariant('after deleting a legacy row in a new table')

  console.log('\n=== P. the two cascades together left the accounts exactly as found ===')
  // Every row posted in this block belonged to that flock or that batch, so
  // between them the two cascades have reversed all of it. The accounts are
  // back to their opening balances - which is the whole claim: closing a flock
  // or a batch moves a bank balance by exactly what its own rows put there, and
  // by nothing else.
  check('A is back to its opening balance', (await bankBalance(BANK_C)), 50000)
  check('B is back to its opening balance', (await bankBalance(BANK_D)), 20000)
  check('A has nothing left but its opening entry',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ? AND reference_type <> 'opening'`,
      [BANK_C]))[0].n, 0)
  check('B likewise',
    (await rows(`SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ? AND reference_type <> 'opening'`,
      [BANK_D]))[0].n, 0)
  // The purchase order is the one row the cascades did NOT touch - it is scoped
  // by farm, not by flock - and it is still there, unpaid and cash, holding no
  // entry. Correct: marking it unpaid is what released the account.
  check('the unpaid purchase order survives both cascades',
    (await rows('SELECT COUNT(*) AS n FROM purchase_orders WHERE purchase_id = ?',
      [posted.purchase_orders]))[0].n, 1)
  await assertInvariant('after both cascades')

  console.log('\n=== Q. an account cannot be deleted while any of the nine names it ===')
  // One fresh bank-sourced row per table, to prove each is in the refusal.
  const holders = []
  holders.push(['expenses', await screenSave('expenses',
    `INSERT INTO expenses (flock_id, date, category, description, amount, payment_source, bank_id, module_type)
     VALUES (99, '2025-07-01', 'Misc', 'Holder', 100, 'bank', ?, 'broiler')`,
    [BANK_C],
    { payment_source: 'bank', bank_id: BANK_C, date: '2025-07-01', description: 'Holder', amount: 100 })])

  const refusedC = await quiet(() => call('deleteBankAccount', BANK_C))
  checkTrue('refused while an expense names it', refusedC.success === false)
  checkTrue('and it names what is blocking', /expense/.test(refusedC.error || ''))

  // Now each remaining table in turn, so none can be left out of the query.
  const holderRows = {
    sales: [`INSERT INTO sales (flock_id, date, bird_weight, rate, total_amount, payment_source, bank_id, module_type)
             VALUES (99, '2025-07-02', 1, 1, 1, 'bank', ?, 'broiler')`, /sale/],
    egg_sales: [`INSERT INTO egg_sales (batch_id, date, quantity, rate_per_egg, total_amount, payment_source, bank_id)
                 VALUES (99, '2025-07-03', 1, 1, 1, 'bank', ?)`, /egg sale/],
    hen_sales: [`INSERT INTO hen_sales (batch_id, date, quantity, rate_per_hen, total_amount, payment_source, bank_id)
                 VALUES (99, '2025-07-04', 1, 1, 1, 'bank', ?)`, /hen sale/],
    income: [`INSERT INTO income (flock_id, date, amount, source, payment_source, bank_id, module_type)
              VALUES (99, '2025-07-05', 1, 'manual', 'bank', ?, 'broiler')`, /income/],
    labour_payments: [`INSERT INTO labour_payments (labour_id, flock_id, date, amount, payment_source, bank_id, module_type)
                       VALUES (?, 99, '2025-07-06', 1, 'bank', ?, 'broiler')`, /labour/],
    purchase_orders: [`INSERT INTO purchase_orders (farm_id, product_id, date, quantity, cost_price, total_amount, payment_type, payment_source, bank_id)
                       VALUES (1, ?, '2025-07-07', 1, 1, 1, 'cash', 'bank', ?)`, /purchase order/],
    receive_vouchers: [`INSERT INTO receive_vouchers (farm_id, customer_id, voucher_number, date, amount, payment_source, bank_id)
                        VALUES (1, 1, 'RV-900', '2025-07-08', 1, 'bank', ?)`, /receive voucher/],
    payment_vouchers: [`INSERT INTO payment_vouchers (farm_id, supplier_id, voucher_number, date, amount, payment_source, bank_id)
                        VALUES (1, ?, 'PV-900', '2025-07-09', 1, 'bank', ?)`, /payment voucher/]
  }
  for (const key of Object.keys(holderRows)) {
    const [sql, pattern] = holderRows[key]
    const spec = BANK_SOURCES[key]
    const params = key === 'labour_payments' ? [WORKER, BANK_D]
                 : key === 'purchase_orders' ? [PRODUCT, BANK_D]
                 : key === 'payment_vouchers' ? [SUPPLIER, BANK_D]
                 : [BANK_D]
    const id = await screenSave(key, sql, params,
      { payment_source: 'bank', bank_id: BANK_D, date: '2025-07-01', description: `Holder ${key}`, amount: 1 })
    const refused = await quiet(() => call('deleteBankAccount', BANK_D))
    checkTrue(`refused while a ${key} row names it`, refused.success === false)
    checkTrue(`and the message names ${key}`, pattern.test(refused.error || ''))
    await quiet(() => call('deleteBankSourced', key, id,
      [{ sql: `DELETE FROM ${spec.table} WHERE ${spec.pk} = ?`, params: [id] }]))
    await assertInvariant(`after clearing the ${key} holder`)
  }

  for (const [key, id] of holders) {
    const spec = BANK_SOURCES[key]
    await quiet(() => call('deleteBankSourced', key, id,
      [{ sql: `DELETE FROM ${spec.table} WHERE ${spec.pk} = ?`, params: [id] }]))
  }
  // The leftover unpaid purchase order is cash, so it blocks nothing.
  const goneC = await quiet(() => call('deleteBankAccount', BANK_C))
  checkTrue('then the account deletes', goneC.success === true)
  const goneD = await quiet(() => call('deleteBankAccount', BANK_D))
  checkTrue('and so does the second', goneD.success === true)
  check('their ledgers went with them - no orphans',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id IN (?, ?)', [BANK_C, BANK_D]))[0].n, 0)
  await assertInvariant('after deleting both new accounts')

  console.log('\n=== once nothing points at it, the account and its ledger go together ===')
  await quiet(() => call('deleteAsset', TRACTOR))
  await quiet(() => call('deleteAsset', TRAILER))
  await quiet(() => call('deletePersonalExpense', PE_LEGACY))
  await quiet(() => call('deletePersonalExpense', PE_CASH))
  const gone = await quiet(() => call('deleteBankAccount', HOUSE))
  checkTrue('delete now succeeds', gone.success === true)
  check('account removed', (await rows('SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_id = ?', [HOUSE]))[0].n, 0)
  check('its ledger removed with it — no orphans',
    (await rows('SELECT COUNT(*) AS n FROM bank_ledger WHERE bank_id = ?', [HOUSE]))[0].n, 0)
  check('the customer account is untouched', (await bankBalance(CUST_BANK)), 7000)
  await assertInvariant('after deleting the account')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
