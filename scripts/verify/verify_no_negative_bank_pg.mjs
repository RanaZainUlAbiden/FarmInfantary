// [Codex] PostgreSQL port of verify_no_negative_bank.js.
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

// NO BANK ACCOUNT MAY BE TAKEN BELOW ZERO BY A SAVE.
//
// A bank account holds real money. Paying out more than it holds is not
// something this app can record truthfully: the ledger would show a withdrawal
// the bank never honoured, and every figure derived from the balance —
// Overview's Bank card, the account's own statement, the Distribution report —
// would be wrong from that line on with nothing on screen to say why.
//
// So the guard refuses at the point of SAVE, before the batch runs. It is
// `checkBankBalances()` in database.service.ts, reached by every path that can
// move money out: the nine declared `BANK_SOURCES` tables (insert and edit),
// the two voucher saves, internal settlements, asset payments, personal
// expenses, and a bill's house receipt.
//
// Everything here runs REAL source against a real PostgreSQL database — the schema
// from createTables/alterStatements, the atomic writer from runBatch(), and the
// guard and every path it sits in front of lifted out of database.service.ts.
// Nothing is a copy.
//
// What is proved:
//   A. EXACTLY ZERO IS ALLOWED. Emptying an account is a legitimate thing to
//      do; the refusal starts one paisa past it.
//   B. ONE PAISA OVER IS REFUSED AND NOTHING IS WRITTEN. Not the source row,
//      not the ledger entry, not a moved balance — the batch never runs.
//   C. A DELETE IS NEVER REFUSED, even one that leaves the account negative.
//      Removing a withdrawal puts money back; removing a deposit un-makes a
//      record the user has already decided was wrong, and refusing it would
//      strand a row that cannot be corrected.
//   D. AN ACCOUNT ALREADY NEGATIVE is not blocked from being read, and a
//      deposit into it is accepted and clears it. Balances went below zero
//      before this guard existed and the client keeps them.
//   E. THE WHOLE SAVE IS WEIGHED AT ONCE. Three rows each affordable alone are
//      not affordable together, and they land in one batch.
//   F. THE EDIT PATH nets its reversal against its re-post, over the union of
//      the old and the new account — so lowering an amount is never refused,
//      raising it beyond the balance is, and an edit that moves nothing is
//      allowed through on an account that is already at zero.
//   G. INTERNAL SETTLEMENT: FROM=1000 with 1000 needed succeeds; 1001 is
//      refused. Only the FROM side can go negative, and a settlement that
//      crosses no account boundary cannot overdraw anything.
//   H. THE NAMED PATHS — asset down payments, installments, the settlement a
//      sale writes, and personal expenses (insert and edit) — obey the rule.
//   I. A BILL'S HOUSE RECEIPT. A new bill is money in and is never refused; an
//      EDIT that cuts the receipt below what the account holds is.
//   J. EVERY TABLE IN BANK_SOURCES obeys the rule, driven off the real
//      declaration so a table added there cannot escape this sweep.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(src, name, kw, from) {
  const start = from !== undefined ? from : src.indexOf(`${kw}${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  // Skip the parameter list first: a signature can carry an inline object
  // type, whose braces would otherwise be mistaken for the start of the body.
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
 * A method off the DatabaseService class, with its TypeScript stripped.
 * Anchored on a DECLARATION — a line whose first non-blank text is the method
 * — so a doc comment mentioning the name, or a `this.`-qualified call site,
 * cannot be picked instead and then run off the end of the file looking for a
 * matching brace.
 */
function loadMethod(name, kw = '') {
  const decl = /async/.test(kw) ? 'async function ' : 'function '
  const needle = `${kw}${name}(`
  let at = -1
  for (let i = SVC_SRC.indexOf(needle); i >= 0; i = SVC_SRC.indexOf(needle, i + 1)) {
    const lineStart = SVC_SRC.lastIndexOf('\n', i) + 1
    if (SVC_SRC.slice(lineStart, i).trim() === '') { at = i; break }
  }
  if (at < 0) throw new Error(`${name} not declared as a class member`)
  const raw = extractFn(SVC_SRC, name, kw, at)
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

// Read off real source rather than restated, so a renamed reference_type or a
// flipped direction breaks this file instead of quietly passing.
const ASSET_PAYMENT_REF = SVC_SRC.match(/ASSET_PAYMENT_REF\s*=\s*'([^']+)'/)[1]
const ASSET_SALE_REF = SVC_SRC.match(/ASSET_SALE_REF\s*=\s*'([^']+)'/)[1]
const PERSONAL_EXPENSE_REF = SVC_SRC.match(/PERSONAL_EXPENSE_REF\s*=\s*'([^']+)'/)[1]
const BILL_PAYMENT_IN_REF = SVC_SRC.match(/BILL_PAYMENT_IN_REF\s*=\s*'([^']+)'/)[1]
const IS_OUT_REF = SVC_SRC.match(/INTERNAL_SETTLEMENT_OUT_REF\s*=\s*'([^']+)'/)[1]
const IS_IN_REF = SVC_SRC.match(/INTERNAL_SETTLEMENT_IN_REF\s*=\s*'([^']+)'/)[1]

const BANK_SOURCES = (() => {
  const start = SVC_SRC.indexOf('private static readonly BANK_SOURCES = {')
  if (start < 0) throw new Error('BANK_SOURCES not found')
  const open = SVC_SRC.indexOf('{', start)
  const end = SVC_SRC.indexOf('\n  }', open)
  return eval('(' + SVC_SRC.slice(open, end + 4).replace(/\}\s*as const;?\s*$/, '}') + ')')
})()

const DatabaseService = {
  ASSET_PAYMENT_REF, ASSET_SALE_REF, PERSONAL_EXPENSE_REF, BILL_PAYMENT_IN_REF,
  INTERNAL_SETTLEMENT_OUT_REF: IS_OUT_REF,
  INTERNAL_SETTLEMENT_IN_REF: IS_IN_REF,
  BANK_SOURCES
}

async function rows(sql, params = []) {
  const result = await db.get(sql, params)
  if (!result.success) throw new Error(result.error)
  return result.data
}
const one = async (sql, params = []) => {
  const r = (await rows(sql, params))[0]
  return r ? Number(Object.values(r)[0] || 0) : 0
}

const svc = {
  toLocalDateString: () => '2025-06-01',
  async get(sql, params = []) { return db.get(sql, params) },
  async run(sql, params = []) { return db.run(sql, params) },
  async runBatch(ops) { return db.batch(ops) },

  // THE GUARD, and the pieces it is built out of.
  bankAmountText:          loadMethod('bankAmountText', 'private '),
  bankEntryEffect:         loadMethod('bankEntryEffect', 'private async '),
  checkBankBalances:       loadMethod('checkBankBalances', 'async '),
  bankSourceDelta:         loadMethod('bankSourceDelta', 'private '),
  checkBankSourceInserts:  loadMethod('checkBankSourceInserts', 'async '),
  checkBillHouseReceipt:   loadMethod('checkBillHouseReceipt', 'async '),

  // The primitives the guarded paths are composed of.
  bankBalanceSql:           loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql: loadMethod('nextTransactionNumberSql', 'private '),
  nextWithdrawalNumberSql:  loadMethod('nextWithdrawalNumberSql', 'private '),
  rebuildBankBalanceOp:     loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps:             loadMethod('bankEntryOps', 'private '),
  bankWithdrawalOps:        loadMethod('bankWithdrawalOps', 'private '),
  bankReversalOps:          loadMethod('bankReversalOps', 'private '),
  bankSource:               loadMethod('bankSource', 'private '),
  bankIdOf:                 loadMethod('bankIdOf', 'private '),
  houseBankIdOf:            loadMethod('houseBankIdOf', 'private '),
  bankSourceExisting:       loadMethod('bankSourceExisting', 'private async '),
  bankSourceInsertOps:      loadMethod('bankSourceInsertOps'),
  bankRebuildOps:           loadMethod('bankRebuildOps'),
  saveBankSourceEdit:       loadMethod('saveBankSourceEdit', 'async '),
  deleteBankSourced:        loadMethod('deleteBankSourced', 'async '),
  billHouseReceiptOps:      loadMethod('billHouseReceiptOps'),
  billHouseReversalOps:     loadMethod('billHouseReversalOps', 'async '),

  getBankAccounts:      loadMethod('getBankAccounts', 'async '),
  getHouseBankAccounts: loadMethod('getHouseBankAccounts', 'async '),
  addBankAccount:       loadMethod('addBankAccount', 'async '),
  addBankLedgerEntry:   loadMethod('addBankLedgerEntry', 'async '),

  bankIdsForAsset:       loadMethod('bankIdsForAsset', 'private async '),
  getAssets:             loadMethod('getAssets', 'async '),
  addAsset:              loadMethod('addAsset', 'async '),
  addAssetPayment:       loadMethod('addAssetPayment', 'async '),
  deleteAssetPayment:    loadMethod('deleteAssetPayment', 'async '),
  sellAsset:             loadMethod('sellAsset', 'async '),

  personalExpenseLabel:  loadMethod('personalExpenseLabel', 'private '),
  addPersonalExpense:    loadMethod('addPersonalExpense', 'async '),
  updatePersonalExpense: loadMethod('updatePersonalExpense', 'async '),
  deletePersonalExpense: loadMethod('deletePersonalExpense', 'async '),

  // The internal settlement, and the one settlement implementation it shares
  // with the Customer Ledger and Receive Voucher screens.
  settlementBankId:                 loadMethod('settlementBankId', 'private '),
  rebuildCustomerBalanceOp:         loadMethod('rebuildCustomerBalanceOp', 'private '),
  updateCustomerOutstandingBalance: loadMethod('updateCustomerOutstandingBalance', 'async '),
  getUnpaidBills:                   loadMethod('getUnpaidBills', 'async '),
  customerSettlementOps:            loadMethod('customerSettlementOps'),
  customerUnwindOps:                loadMethod('customerUnwindOps', 'private async '),
  saveInternalSettlement:           loadMethod('saveInternalSettlement', 'async '),
  deleteInternalSettlement:         loadMethod('deleteInternalSettlement', 'async ')
}
// addBankAccount and the customer-balance recompute call bare helpers.
global.toLocalDateString = svc.toLocalDateString

const call = (name, ...args) => svc[name].apply(svc, args)

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const check = (label, actual, expected) => {
  const ok = Math.abs(Number(actual) - Number(expected)) < 0.0001
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

const bankBalance = async (bankId) => (await one(
  `SELECT COALESCE(SUM(bl.debit - bl.credit), 0) FROM bank_ledger bl WHERE bl.bank_id = ?`, [bankId]))

/** Every row count a refused save must have left untouched. */
const snapshot = async (table) => ({
  table: (await one(`SELECT COUNT(*) FROM ${table}`)),
  ledger: (await one('SELECT COUNT(*) FROM bank_ledger')),
  balances: (await rows('SELECT bank_id, COALESCE(current_balance,0) b FROM bank_accounts ORDER BY bank_id'))
    .map(r => `${r.bank_id}:${r.b}`).join(',')
})

/**
 * A refusal has to leave NOTHING behind. Checked on the row count of the table
 * being written, the whole bank_ledger, and every cached balance — the three
 * places a half-run batch would show up.
 */
const checkNothingWritten = async (label, table, before) => {
  const after = (await snapshot(table))
  checkTrue(`${label} — no ${table} row written`, after.table === before.table)
  checkTrue(`${label} — no bank_ledger row written`, after.ledger === before.ledger)
  checkTrue(`${label} — no balance moved`, after.balances === before.balances)
}

/** The guard's refusal names the account and both figures. */
const checkRefusal = (label, res, name) => {
  checkTrue(`${label} — refused`, !!res && res.success === false)
  const msg = String((res && res.error) || '')
  checkTrue(`${label} — names the account ("${name}")`, msg.includes(name))
  checkTrue(`${label} — says what it holds and what was needed`,
    /does not have enough balance\. Current: Rs\. .+, needed: Rs\. .+\./.test(msg))
}

/**
 * The cached balance must equal the ledger it caches, after everything — a
 * refusal included. The guard reads the LEDGER, not the cache, so a refusal
 * that somehow moved one and not the other shows up here.
 */
const checkCacheAgrees = async (label) => {
  // PostgreSQL's two-argument ROUND accepts numeric. This is only the verifier's
  // read-only comparison; production money columns remain double precision.
  const drifted = (await one(
    `SELECT COUNT(*) FROM bank_accounts ba
     WHERE ROUND(COALESCE(ba.current_balance, 0)::numeric, 2) <> ROUND(
       (SELECT COALESCE(SUM(bl.debit - bl.credit), 0) FROM bank_ledger bl
         WHERE bl.bank_id = ba.bank_id)::numeric, 2)`))
  check(`${label} — accounts whose cached balance drifted from their ledger`, drifted, 0)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

const FARM = 1

const scratch = await createScratchDb('no_negative_bank')
db = scratch.db
try {

  // executeStatement narrates every insert; the test output is what matters.
  const realLog = console.log
  const quiet = async (fn) => { console.log = () => {}; try { return await fn() } finally { console.log = realLog } }

  await runSql(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1, 'Talha', 'x', 'all')`)
  await runSql(`INSERT INTO farm_units (unit_id, farm_id, unit_name, module_type) VALUES (1, 1, 'North Farm', 'broiler')`)
  await runSql(`INSERT INTO customers (customer_id, farm_id, customer_name) VALUES (1, 1, 'Outside Buyer')`)
  await runSql(`INSERT INTO customers (customer_id, farm_id, customer_name, unit_id, customer_type, outstanding_balance)
          VALUES (2, 1, 'Own Farm - North Farm', 1, 'own_farm', 0)`)
  const OWN_FARM = 2

  // Two house accounts. MAIN is what almost everything is paid out of; SPARE
  // is empty, so a withdrawal MOVED onto it can be weighed.
  const MAIN = (await quiet(() => call('addBankAccount', {
    farm_id: FARM, bank_name: 'HBL Main', account_number: '1234-5678',
    account_holder: 'Mian Ahmed', opening_balance: 100000
  }))).lastId
  const SPARE = (await quiet(() => call('addBankAccount', {
    farm_id: FARM, bank_name: 'Meezan Spare', account_number: '9999',
    account_holder: 'Mian Ahmed', opening_balance: 0
  }))).lastId

  await runSql(`INSERT INTO flocks (farm_id, flock_name, start_date, unit_id) VALUES (1, 'F#1', '2025-01-01', 1)`)
  await runSql(`INSERT INTO batches (farm_id, batch_name, start_date, initial_birds, unit_id) VALUES (1, 'B#1', '2025-01-01', 500, 1)`)
  const FLOCK = (await one(`SELECT flock_id FROM flocks WHERE flock_name = 'F#1'`))
  const BATCH = (await one(`SELECT batch_id FROM batches WHERE batch_name = 'B#1'`))
  await runSql(`INSERT INTO labour (farm_id, labour_name) VALUES (1, 'Rashid')`)
  const WORKER = (await one(`SELECT labour_id FROM labour WHERE labour_name = 'Rashid'`))
  await runSql(`INSERT INTO products (farm_id, product_name) VALUES (1, 'Feed Bag')`)
  const PRODUCT = (await one(`SELECT product_id FROM products WHERE product_name = 'Feed Bag'`))
  await runSql(`INSERT INTO suppliers (farm_id, supplier_name) VALUES (1, 'Agri Supplies')`)
  const SUPPLIER = (await one(`SELECT supplier_id FROM suppliers WHERE supplier_name = 'Agri Supplies'`))
  await runSql(`INSERT INTO expense_categories (category_id, farm_id, category_name) VALUES (1, 1, 'Household')`)

  check('HBL Main opens at 100,000', (await bankBalance(MAIN)), 100000)

  /**
   * What every money screen's save does, in the order it does it: the GUARD
   * first, and only then the row's own INSERT, its bank entry keyed to it with
   * `{ $lastId: -1 }`, and the balance rebuilt at the end. Returns the refusal,
   * or the new row's id.
   *
   * This is exactly the shape the screens were edited into — guard, then batch
   * — so driving every section through it makes the sections about the real
   * save paths and not about the guard in isolation.
   */
  const screenSave = async (key, sql, params, bank) => {
    const guard = await call('checkBankSourceInserts', key, [bank])
    if (!guard.success) return { refused: guard }
    const ops = [{ sql, params }]
    ops.push(...call('bankSourceInsertOps', key, bank))
    ops.push(...call('bankRebuildOps', [bank.bank_id]))
    const res = await runBatch(ops)
    if (!res.success) throw new Error(`${key} save failed: ${res.error}`)
    return { id: (await one(`SELECT MAX(${BANK_SOURCES[key].pk}) FROM ${BANK_SOURCES[key].table}`)) }
  }

  const expenseRow = (date, desc, amount, bankId) => ({
    sql: `INSERT INTO expenses (flock_id, date, category, description, amount, payment_type, payment_source, bank_id, module_type)
          VALUES (?, ?, 'Diesel', ?, ?, 'bank', 'bank', ?, 'broiler')`,
    params: [FLOCK, date, desc, amount, bankId]
  })

  // ── A ────────────────────────────────────────────────────────────────────
  console.log('\n=== A. a save that leaves the account at EXACTLY ZERO is allowed ===')
  {
    const row = expenseRow('2025-06-01', 'Empties the account', 100000, MAIN)
    const out = await quiet(() => screenSave('expenses', row.sql, row.params,
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-01',
        description: 'Expense - Diesel', amount: 100000 }))
    checkTrue('100,000 out of 100,000 is allowed', out.refused === undefined)
    check('the account is left at exactly zero', (await bankBalance(MAIN)), 0)
    await checkCacheAgrees('after emptying the account')
    // Put it back, so the sections below start from a known 100,000.
    await quiet(() => call('deleteBankSourced', 'expenses', out.id,
      [{ sql: 'DELETE FROM expenses WHERE expense_id = ?', params: [out.id] }]))
    check('and removing it brings the account back', (await bankBalance(MAIN)), 100000)
  }

  // ── B ────────────────────────────────────────────────────────────────────
  console.log('\n=== B. one paisa over is REFUSED, and nothing at all is written ===')
  {
    const before = (await snapshot('expenses'))
    const row = expenseRow('2025-06-02', 'One paisa too much', 100000.01, MAIN)
    const out = await quiet(() => screenSave('expenses', row.sql, row.params,
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-02',
        description: 'Expense - Diesel', amount: 100000.01 }))
    checkRefusal('100,000.01 out of 100,000', out.refused, 'HBL Main')
    await checkNothingWritten('100,000.01 out of 100,000', 'expenses', before)
    check('the balance is untouched', (await bankBalance(MAIN)), 100000)
    await checkCacheAgrees('after a refusal')
  }

  // ── E ────────────────────────────────────────────────────────────────────
  console.log('\n=== E. the WHOLE save is weighed at once, not row by row ===')
  {
    const pending = [40000, 40000, 40000].map(a => ({
      payment_source: 'bank', bank_id: MAIN, date: '2025-06-03',
      description: 'Expense - Diesel', amount: a
    }))
    const each = await call('checkBankSourceInserts', 'expenses', [pending[0]])
    checkTrue('one row of 40,000 against 100,000 is affordable', each.success)
    const all = await call('checkBankSourceInserts', 'expenses', pending)
    checkRefusal('three rows of 40,000 in one batch', all, 'HBL Main')
    checkTrue('and the refusal names the TOTAL needed, not one row',
      String(all.error).includes('120,000'))
    check('nothing moved', (await bankBalance(MAIN)), 100000)
  }

  // ── C and D ─────────────────────────────────────────────────────────────
  console.log('\n=== C. a DELETE is never refused, even one that goes negative ===')
  {
    // A deposit, then the deposit deleted after the money has been spent: the
    // delete takes the account below zero and must still go through.
    const sale = await quiet(() => screenSave('sales',
      `INSERT INTO sales (flock_id, date, vehicle_number, broker, bird_weight, rate, total_amount, payment_type, payment_source, bank_id, module_type)
       VALUES (?, '2025-06-04', 'LHR-1', 'Akram', 100, 300, 30000, 'bank', 'bank', ?, 'broiler')`,
      [FLOCK, MAIN],
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-04',
        description: 'Broiler sale', amount: 30000 }))
    check('a 30,000 deposit lands', (await bankBalance(MAIN)), 130000)

    const spend = expenseRow('2025-06-05', 'Spends the deposit', 130000, MAIN)
    const spent = await quiet(() => screenSave('expenses', spend.sql, spend.params,
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-05',
        description: 'Expense - Diesel', amount: 130000 }))
    check('and all 130,000 is then spent', (await bankBalance(MAIN)), 0)

    const del = await quiet(() => call('deleteBankSourced', 'sales', sale.id,
      [{ sql: 'DELETE FROM sales WHERE sale_id = ?', params: [sale.id] }]))
    checkTrue('deleting the deposit is NOT refused', del.success === true)
    check('even though it leaves the account at -30,000', (await bankBalance(MAIN)), -30000)
    await checkCacheAgrees('after a delete took the account negative')

    console.log('\n=== D. an account already negative is readable, and a deposit clears it ===')
    const listed = ((await call('getHouseBankAccounts', FARM)).data || [])
      .find(b => Number(b.bank_id) === MAIN)
    checkTrue('the overdrawn account is still listed', listed !== undefined)
    check('and reads back negative, which is the red figure on screen',
      Number(listed.current_balance), -30000)

    const deposit = await quiet(() => screenSave('income',
      `INSERT INTO income (flock_id, date, description, amount, source, payment_source, bank_id, module_type)
       VALUES (?, '2025-06-06', 'Top-up', 30000, 'manual', 'bank', ?, 'broiler')`,
      [FLOCK, MAIN],
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-06',
        description: 'Income: Top-up', amount: 30000 }))
    checkTrue('a deposit into an overdrawn account is NOT refused', deposit.refused === undefined)
    check('and it clears the overdraft', (await bankBalance(MAIN)), 0)

    // Being already overdrawn is not a licence to keep drawing.
    const more = expenseRow('2025-06-07', 'One rupee more', 1, MAIN)
    const refused = await quiet(() => screenSave('expenses', more.sql, more.params,
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-07',
        description: 'Expense - Diesel', amount: 1 }))
    checkRefusal('drawing again on an account at zero', refused.refused, 'HBL Main')

    // Back to a clean 100,000 for the sections below.
    await quiet(() => call('deleteBankSourced', 'expenses', spent.id,
      [{ sql: 'DELETE FROM expenses WHERE expense_id = ?', params: [spent.id] }]))
    await quiet(() => call('deleteBankSourced', 'income', deposit.id,
      [{ sql: 'DELETE FROM income WHERE income_id = ?', params: [deposit.id] }]))
    check('reset: HBL Main is back at 100,000', (await bankBalance(MAIN)), 100000)
    await checkCacheAgrees('after the reset')
  }

  // ── F ────────────────────────────────────────────────────────────────────
  console.log('\n=== F. the EDIT nets its reversal against its re-post ===')
  {
    const row = expenseRow('2025-06-08', 'Editable', 90000, MAIN)
    const out = await quiet(() => screenSave('expenses', row.sql, row.params,
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-08',
        description: 'Expense - Diesel', amount: 90000 }))
    const ID = out.id
    check('90,000 out of 100,000 leaves 10,000', (await bankBalance(MAIN)), 10000)

    const editTo = (amount, bankId) => call('saveBankSourceEdit', 'expenses', ID, {
      sql: `UPDATE expenses SET amount = ?, payment_source = 'bank', bank_id = ? WHERE expense_id = ?`,
      params: [amount, bankId, ID]
    }, {
      payment_source: 'bank', bank_id: bankId, date: '2025-06-08',
      description: 'Expense - Diesel', amount
    })

    // LOWERING is money back — never refused, whatever the balance.
    const lower = await quiet(() => editTo(50000, MAIN))
    checkTrue('lowering the amount is never refused', lower.success === true)
    check('and the account rises to 50,000', (await bankBalance(MAIN)), 50000)

    // RAISING past the balance: the net is -60,000 against 50,000.
    const before = (await snapshot('expenses'))
    const raise = await quiet(() => editTo(110000, MAIN))
    checkRefusal('raising 50,000 -> 110,000 against 50,000 left', raise, 'HBL Main')
    await checkNothingWritten('the refused edit', 'expenses', before)
    check('the row still says 50,000', (await one('SELECT amount FROM expenses WHERE expense_id = ?', [ID])), 50000)
    check('and the balance is untouched', (await bankBalance(MAIN)), 50000)

    // RAISING to exactly what is left is allowed — the zero boundary again.
    const exact = await quiet(() => editTo(100000, MAIN))
    checkTrue('raising to exactly the balance is allowed', exact.success === true)
    check('the account is emptied, not overdrawn', (await bankBalance(MAIN)), 0)

    // MOVING THE ACCOUNT: the old one gets its money back, the new one pays.
    // Refused on the NEW account, which holds nothing.
    const move = await quiet(() => editTo(100000, SPARE))
    checkRefusal('moving a 100,000 withdrawal onto an empty account', move, 'Meezan Spare')
    check('HBL Main is unchanged', (await bankBalance(MAIN)), 0)
    check('Meezan Spare is unchanged', (await bankBalance(SPARE)), 0)

    // An edit that moves NO money is allowed even at zero — this is what keeps
    // an already-overdrawn account editable at all.
    const sideways = await quiet(() => call('saveBankSourceEdit', 'expenses', ID, {
      sql: `UPDATE expenses SET description = ?, payment_source = 'bank', bank_id = ? WHERE expense_id = ?`,
      params: ['Renamed only', MAIN, ID]
    }, {
      payment_source: 'bank', bank_id: MAIN, date: '2025-06-08',
      description: 'Expense - Diesel', amount: 100000
    }))
    checkTrue('an edit that moves no money is allowed at zero', sideways.success === true)
    check('and the balance still agrees', (await bankBalance(MAIN)), 0)

    // bank -> CASH takes the withdrawal off entirely: always money back.
    const toCash = await quiet(() => call('saveBankSourceEdit', 'expenses', ID, {
      sql: `UPDATE expenses SET payment_source = 'cash', bank_id = NULL WHERE expense_id = ?`,
      params: [ID]
    }, {
      payment_source: 'cash', bank_id: null, date: '2025-06-08',
      description: 'Expense - Diesel', amount: 100000
    }))
    checkTrue('bank -> cash is never refused', toCash.success === true)
    check('and the money comes back', (await bankBalance(MAIN)), 100000)
    await checkCacheAgrees('after the edit sweep')

    await quiet(() => call('deleteBankSourced', 'expenses', ID,
      [{ sql: 'DELETE FROM expenses WHERE expense_id = ?', params: [ID] }]))
    check('reset: HBL Main is back at 100,000', (await bankBalance(MAIN)), 100000)
  }

  // ── G ────────────────────────────────────────────────────────────────────
  console.log('\n=== G. internal settlement: only the FROM side can go negative ===')
  {
    // The farm owes 5,000 on two own-farm bills, so there is something to
    // settle. The settlement's own overpayment refusal is a different test
    // (verify_internal_settlements.js); here the bills simply cover it.
    await runSql(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                               subtotal, total_amount, amount_paid, payment_type)
            VALUES (900, 1, 'BILL-900', ?, 'Own Farm', '2025-03-01', 3000, 3000, 0, 'internal')`, [OWN_FARM])
    await runSql(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                               subtotal, total_amount, amount_paid, payment_type)
            VALUES (901, 1, 'BILL-901', ?, 'Own Farm', '2025-03-05', 2000, 2000, 0, 'internal')`, [OWN_FARM])
    await quiet(() => call('updateCustomerOutstandingBalance', OWN_FARM))

    // FROM is an account holding exactly 1,000.
    const FROM = (await quiet(() => call('addBankAccount', {
      farm_id: FARM, bank_name: 'Settlement From', account_number: '5555',
      account_holder: 'Mian Ahmed', opening_balance: 1000
    }))).lastId
    check('the FROM account holds exactly 1,000', (await bankBalance(FROM)), 1000)

    const settle = (number, amount, fromBank, toBank) => call('saveInternalSettlement', {
      sql: `INSERT INTO internal_settlements
              (farm_id, customer_id, settlement_number, date, amount,
               from_account, from_bank_id, to_account, to_bank_id, reference, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [1, OWN_FARM, number, '2025-06-10', amount,
               fromBank ? 'bank' : 'cash', fromBank,
               toBank ? 'bank' : 'cash', toBank, null, null]
    }, {
      customer_id: OWN_FARM, amount, date: '2025-06-10',
      description: `Internal Settlement ${number}`,
      bank_description_out: `Internal Settlement ${number} - paid`,
      bank_description_in: `Internal Settlement ${number} - received`,
      from_account: fromBank ? 'bank' : 'cash', from_bank_id: fromBank,
      to_account: toBank ? 'bank' : 'cash', to_bank_id: toBank
    })

    const paidOnBills = async () => (await one(
      'SELECT COALESCE(SUM(amount_paid),0) FROM bills WHERE customer_id = ?', [OWN_FARM]))

    // 1,001 needed out of 1,000 — refused, and nothing written.
    const before = (await snapshot('internal_settlements'))
    const over = await quiet(() => settle('IS-901', 1001, FROM, MAIN))
    checkRefusal('FROM=1,000 with 1,001 needed', over, 'Settlement From')
    await checkNothingWritten('the refused settlement', 'internal_settlements', before)
    check('the bills are untouched', (await paidOnBills()), 0)

    // 1,000 out of 1,000 — allowed, and it empties the account.
    const mainBefore = (await bankBalance(MAIN))
    const exact = await quiet(() => settle('IS-900', 1000, FROM, MAIN))
    checkTrue('FROM=1,000 with 1,000 needed succeeds', exact.success === true)
    check('the FROM account is emptied, not overdrawn', (await bankBalance(FROM)), 0)
    check('and the TO account received it', (await bankBalance(MAIN)), mainBefore + 1000)
    check('the bills took the money', (await paidOnBills()), 1000)
    await checkCacheAgrees('after an exact settlement')

    const SETTLEMENT = (await one(`SELECT settlement_id FROM internal_settlements WHERE settlement_number = 'IS-900'`))
    const undo = await quiet(() => call('deleteInternalSettlement', SETTLEMENT))
    checkTrue('deleting a settlement is never refused', undo.success === true)
    check('the FROM account has its money back', (await bankBalance(FROM)), 1000)
    check('and the TO account gave it up', (await bankBalance(MAIN)), mainBefore)

    // CROSSING NO BOUNDARY writes no ledger row, so it cannot overdraw: a
    // same-account settlement of 5,000 out of an account holding 1,000 is fine,
    // because no money moves.
    const sameAcc = await quiet(() => settle('IS-902', 5000, FROM, FROM))
    checkTrue('a same-account settlement of 5,000 out of 1,000 is allowed', sameAcc.success === true)
    check('because it wrote no bank_ledger row at all',
      (await one(`SELECT COUNT(*) FROM bank_ledger WHERE reference_type IN (?, ?)`, [IS_OUT_REF, IS_IN_REF])), 0)
    check('and the account is unmoved', (await bankBalance(FROM)), 1000)
    await checkCacheAgrees('after a same-account settlement')

    const SAME = (await one(`SELECT settlement_id FROM internal_settlements WHERE settlement_number = 'IS-902'`))
    await quiet(() => call('deleteInternalSettlement', SAME))
    check('reset: the bills are clear again', (await paidOnBills()), 0)
  }

  // ── H ────────────────────────────────────────────────────────────────────
  console.log('\n=== H. the named paths: asset payments and personal expenses ===')
  {
    let before = (await snapshot('assets'))
    const tooBig = await quiet(() => call('addAsset', {
      farm_id: FARM, unit_id: 1, asset_name: 'Tractor', purchase_date: '2025-06-11',
      total_price: 1000000, payment_source: 'bank', bank_id: MAIN, initial_payment: 200000
    }))
    checkRefusal('an asset down payment of 200,000 out of 100,000', tooBig, 'HBL Main')
    await checkNothingWritten('the refused asset', 'assets', before)

    const asset = await quiet(() => call('addAsset', {
      farm_id: FARM, unit_id: 1, asset_name: 'Tractor', purchase_date: '2025-06-11',
      total_price: 1000000, payment_source: 'bank', bank_id: MAIN, initial_payment: 60000
    }))
    checkTrue('a 60,000 down payment is allowed', asset.success === true)
    check('and the account falls to 40,000', (await bankBalance(MAIN)), 40000)
    const ASSET = (await one(`SELECT asset_id FROM assets WHERE asset_name = 'Tractor'`))

    before = (await snapshot('asset_payments'))
    const bigInstall = await quiet(() => call('addAssetPayment', {
      asset_id: ASSET, farm_id: FARM, date: '2025-06-12', amount: 40001,
      payment_source: 'bank', bank_id: MAIN, asset_name: 'Tractor'
    }))
    checkRefusal('an installment of 40,001 out of 40,000', bigInstall, 'HBL Main')
    await checkNothingWritten('the refused installment', 'asset_payments', before)

    const install = await quiet(() => call('addAssetPayment', {
      asset_id: ASSET, farm_id: FARM, date: '2025-06-12', amount: 40000,
      payment_source: 'bank', bank_id: MAIN, asset_name: 'Tractor'
    }))
    checkTrue('exactly 40,000 is allowed', install.success === true)
    check('the account is emptied', (await bankBalance(MAIN)), 0)

    // THE SETTLEMENT A SALE WRITES. 900,000 is still outstanding and the
    // account holds nothing, so settling by bank is refused — which is the
    // point: it is the largest single movement the account ever sees.
    const sellByBank = await quiet(() => call('sellAsset', ASSET, '2025-06-13', 700000,
      { payment_source: 'bank', bank_id: MAIN }))
    checkRefusal('settling 900,000 outstanding out of an empty account', sellByBank, 'HBL Main')
    check('the asset is not marked sold', (await one(
      `SELECT COUNT(*) FROM assets WHERE asset_id = ? AND status = 'sold'`, [ASSET])), 0)

    const sellByCash = await quiet(() => call('sellAsset', ASSET, '2025-06-13', 700000,
      { payment_source: 'cash' }))
    checkTrue('settling the same balance in CASH is allowed', sellByCash.success === true)
    check('and no bank account moved', (await bankBalance(MAIN)), 0)
    await checkCacheAgrees('after the asset sweep')

    // Put 100,000 back through the Bank Ledger screen's own writer, which is
    // deliberately NOT guarded: a manual entry is how the client corrects an
    // account by hand, including one that is already overdrawn.
    await quiet(() => call('addBankLedgerEntry', {
      bank_id: MAIN, transaction_date: '2025-06-14', description: 'Cash deposit',
      debit: 100000, credit: 0, reference_type: 'deposit', reference_id: null
    }))
    check('reset: HBL Main is back at 100,000', (await bankBalance(MAIN)), 100000)

    before = (await snapshot('personal_expenses'))
    const peOver = await quiet(() => call('addPersonalExpense', {
      farm_id: FARM, date: '2025-06-15', category_id: 1, category: 'Household',
      description: 'School fees', amount: 150000, payment_source: 'bank', bank_id: MAIN
    }))
    checkRefusal('a personal expense of 150,000 out of 100,000', peOver, 'HBL Main')
    await checkNothingWritten('the refused personal expense', 'personal_expenses', before)

    const pe = await quiet(() => call('addPersonalExpense', {
      farm_id: FARM, date: '2025-06-15', category_id: 1, category: 'Household',
      description: 'School fees', amount: 80000, payment_source: 'bank', bank_id: MAIN
    }))
    checkTrue('80,000 is allowed', pe.success === true)
    check('the account falls to 20,000', (await bankBalance(MAIN)), 20000)
    const PE = (await one(`SELECT MAX(pexpense_id) FROM personal_expenses`))

    before = (await snapshot('personal_expenses'))
    const peRaise = await quiet(() => call('updatePersonalExpense', PE, { amount: 110000 }))
    checkRefusal('raising it to 110,000 against 20,000 left', peRaise, 'HBL Main')
    await checkNothingWritten('the refused personal-expense edit', 'personal_expenses', before)
    check('the row still says 80,000', (await one('SELECT amount FROM personal_expenses WHERE pexpense_id = ?', [PE])), 80000)

    const peLower = await quiet(() => call('updatePersonalExpense', PE, { amount: 10000 }))
    checkTrue('lowering it is never refused', peLower.success === true)
    check('and the account rises to 90,000', (await bankBalance(MAIN)), 90000)

    const peMove = await quiet(() => call('updatePersonalExpense', PE, { bank_id: SPARE }))
    checkRefusal('moving a 10,000 withdrawal onto an empty account', peMove, 'Meezan Spare')
    check('HBL Main is unchanged', (await bankBalance(MAIN)), 90000)

    const peDel = await quiet(() => call('deletePersonalExpense', PE))
    checkTrue('deleting it is never refused', peDel.success === true)
    check('reset: HBL Main is back at 100,000', (await bankBalance(MAIN)), 100000)
    await checkCacheAgrees('after the personal-expense sweep')
  }

  // ── I ────────────────────────────────────────────────────────────────────
  console.log("\n=== I. a bill's house receipt: money in, but an EDIT can take it out ===")
  {
    const huge = await call('checkBillHouseReceipt', {
      payment_account_kind: 'house', payment_source: 'bank', bank_id: MAIN,
      billId: null, amount: 10000000
    })
    checkTrue('a brand-new receipt of 10,000,000 is allowed', huge.success === true)

    await runSql(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                               subtotal, total_amount, amount_paid, payment_type, payment_source,
                               bank_id, payment_account_kind)
            VALUES (950, 1, 'BILL-950', 1, 'Outside Buyer', '2025-06-16', 90000, 90000, 90000,
                    'bank', 'bank', ?, 'house')`, [MAIN])
    await quiet(() => runBatch(call('billHouseReceiptOps', {
      payment_account_kind: 'house', payment_source: 'bank', bank_id: MAIN,
      billId: 950, date: '2025-06-16', description: 'Bill #BILL-950', amount: 90000
    })))
    check('the receipt takes the account to 190,000', (await bankBalance(MAIN)), 190000)

    // Spend it, so cutting the receipt would overdraw.
    const spend = expenseRow('2025-06-17', 'Spends the receipt', 190000, MAIN)
    const spent = await quiet(() => screenSave('expenses', spend.sql, spend.params,
      { payment_source: 'bank', bank_id: MAIN, date: '2025-06-17',
        description: 'Expense - Diesel', amount: 190000 }))
    check('and it is all spent', (await bankBalance(MAIN)), 0)

    const cut = await call('checkBillHouseReceipt', {
      payment_account_kind: 'house', payment_source: 'bank', bank_id: MAIN,
      billId: 950, amount: 10000
    })
    checkRefusal('cutting a 90,000 receipt to 10,000 on an empty account', cut, 'HBL Main')

    const same = await call('checkBillHouseReceipt', {
      payment_account_kind: 'house', payment_source: 'bank', bank_id: MAIN,
      billId: 950, amount: 90000
    })
    checkTrue('re-saving the same 90,000 receipt is allowed', same.success === true)

    const raised = await call('checkBillHouseReceipt', {
      payment_account_kind: 'house', payment_source: 'bank', bank_id: MAIN,
      billId: 950, amount: 120000
    })
    checkTrue('raising the receipt is allowed', raised.success === true)

    const moved = await call('checkBillHouseReceipt', {
      payment_account_kind: 'house', payment_source: 'bank', bank_id: SPARE,
      billId: 950, amount: 90000
    })
    checkRefusal('moving the receipt off an emptied account', moved, 'HBL Main')

    // Reset.
    await quiet(() => call('deleteBankSourced', 'expenses', spent.id,
      [{ sql: 'DELETE FROM expenses WHERE expense_id = ?', params: [spent.id] }]))
    const rev = await quiet(() => call('billHouseReversalOps', 950))
    await quiet(() => runBatch(rev.ops || []))
    await runSql('DELETE FROM bills WHERE bill_id = 950')
    check('reset: HBL Main is back at 100,000', (await bankBalance(MAIN)), 100000)
    await checkCacheAgrees('after the bill sweep')
  }

  // ── J ────────────────────────────────────────────────────────────────────
  console.log('\n=== J. every table in BANK_SOURCES obeys the rule ===')
  {
    // One row per declared table, sized one paisa past what the account holds,
    // driven off the real declaration — so a table added to BANK_SOURCES
    // without a row here fails the sweep instead of going untested.
    const SQLS = {
      sales: (amt) => [`INSERT INTO sales (flock_id, date, vehicle_number, broker, bird_weight, rate, total_amount, payment_type, payment_source, bank_id, module_type)
         VALUES (?, '2025-07-01', 'LHR-7', 'Akram', 100, 300, ?, 'bank', 'bank', ?, 'broiler')`, [FLOCK, amt, MAIN]],
      egg_sales: (amt) => [`INSERT INTO egg_sales (batch_id, date, customer_name, grade, quantity, rate_per_egg, total_amount, payment_type, payment_source, bank_id)
         VALUES (?, '2025-07-01', 'Shop A', 'mixed', 1000, 12, ?, 'bank', 'bank', ?)`, [BATCH, amt, MAIN]],
      hen_sales: (amt) => [`INSERT INTO hen_sales (batch_id, date, customer_name, quantity, rate_per_hen, total_amount, payment_type, payment_source, bank_id)
         VALUES (?, '2025-07-01', 'Shop B', 50, 900, ?, 'bank', 'bank', ?)`, [BATCH, amt, MAIN]],
      income: (amt) => [`INSERT INTO income (flock_id, date, description, amount, source, payment_source, bank_id, module_type)
         VALUES (?, '2025-07-01', 'Sawdust', ?, 'manual', 'bank', ?, 'broiler')`, [FLOCK, amt, MAIN]],
      expenses: (amt) => [`INSERT INTO expenses (flock_id, date, category, description, amount, payment_type, payment_source, bank_id, module_type)
         VALUES (?, '2025-07-01', 'Diesel', 'Generator', ?, 'bank', 'bank', ?, 'broiler')`, [FLOCK, amt, MAIN]],
      labour_payments: (amt) => [`INSERT INTO labour_payments (labour_id, flock_id, date, description, amount, payment_type, payment_source, bank_id, module_type)
         VALUES (?, ?, '2025-07-01', 'Wages', ?, 'bank', 'bank', ?, 'broiler')`, [WORKER, FLOCK, amt, MAIN]],
      purchase_orders: (amt) => [`INSERT INTO purchase_orders (farm_id, supplier_id, product_id, date, quantity, cost_price, total_amount, payment_type, payment_source, bank_id)
         VALUES (1, ?, ?, '2025-07-01', 1, ?, ?, 'cash', 'bank', ?)`, [SUPPLIER, PRODUCT, amt, amt, MAIN]],
      receive_vouchers: (amt) => [`INSERT INTO receive_vouchers (farm_id, customer_id, voucher_number, date, amount, payment_source, bank_id)
         VALUES (1, 1, 'RV-J', '2025-07-01', ?, 'bank', ?)`, [amt, MAIN]],
      payment_vouchers: (amt) => [`INSERT INTO payment_vouchers (farm_id, supplier_id, voucher_number, date, amount, payment_source, bank_id)
         VALUES (1, ?, 'PV-J', '2025-07-01', ?, 'bank', ?)`, [SUPPLIER, amt, MAIN]],
      expense_ledger: (amt) => [`INSERT INTO expense_ledger (farm_id, transaction_date, description, amount, category, payment_type, payment_source, bank_id)
         VALUES (1, '2025-07-01', 'Office rent', ?, 'Rent', 'cash', 'bank', ?)`, [amt, MAIN]]
    }

    for (const key of Object.keys(BANK_SOURCES)) {
      const spec = BANK_SOURCES[key]
      checkTrue(`${key} is covered by this section`, SQLS[key] !== undefined)
      if (!SQLS[key]) continue

      const amount = 100000.01
      const [sql, params] = SQLS[key](amount)
      const before = (await snapshot(spec.table))
      const out = await quiet(() => screenSave(key, sql, params, {
        payment_source: 'bank', bank_id: MAIN, date: '2025-07-01',
        description: `${key} row`, amount
      }))

      if (spec.dir === 'out') {
        checkRefusal(`${key} (declared 'out') past the balance`, out.refused, 'HBL Main')
        await checkNothingWritten(`${key} refused`, spec.table, before)
      } else {
        checkTrue(`${key} (declared 'in') is money in and is allowed`, out.refused === undefined)
        // Take the deposit straight back off, so the next table in the sweep
        // starts from the same 100,000.
        await quiet(() => call('deleteBankSourced', key, out.id,
          [{ sql: `DELETE FROM ${spec.table} WHERE ${spec.pk} = ?`, params: [out.id] }]))
      }
      check(`${key} — HBL Main is still 100,000`, (await bankBalance(MAIN)), 100000)
    }
    await checkCacheAgrees('after the BANK_SOURCES sweep')

    // A cash row is exempt BY CONSTRUCTION, not by a list: it is exempt
    // precisely because payment_source <> 'bank'.
    const cash = await call('checkBankSourceInserts', 'expenses', [
      { payment_source: 'cash', bank_id: null, amount: 9999999 }
    ])
    checkTrue('a CASH row of any size is never weighed', cash.success === true)
    const labelled = await call('checkBankSourceInserts', 'expenses', [
      { payment_source: 'bank', bank_id: null, amount: 9999999 }
    ])
    checkTrue("a row labelled bank with NO account is not this guard's refusal",
      labelled.success === true)
  }

  console.log('')
  if (failures === 0) console.log('ALL CHECKS PASSED')
  else console.log(`${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
