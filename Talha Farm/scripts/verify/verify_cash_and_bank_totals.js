// Cash in Hand and Total Bank Balance — the two cards on the Overview
// dashboard, the Farm Report and the Distribution Report.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, and the whole of CashPositionService
// lifted out of cash-position.service.ts — `cashSql()`, `readComponents()`,
// `readBankTotal()` and `getCashPosition()` — bound onto one hand-built object
// so their `this.db` resolves the way it does in the app. The derivation under
// test is never restated here.
//
// The bank side's own machinery is lifted too: `rebuildBankBalanceOp()` and
// `bankBalanceSql()` come out of database.service.ts, so when this script
// posts a bank_ledger row and rebuilds the account it rebuilds it exactly the
// way every real write path does. (verify_bank_withdrawals.js is what asserts
// that `bank_accounts.current_balance` and the ledger agree after every real
// mutation; this script takes that as given and tests what the two TOTALS do.)
//
// What is proved:
//   A. An account with nothing recorded shows Cash = 0 and Bank = 0.
//   B. Every money-IN cash table moves cash in hand by exactly +amount.
//   C. Every money-OUT cash table moves it by exactly -amount.
//   D. Rows that moved NO money move neither total: a credit sale, an unpaid
//      wage, an unpaid purchase order, a cheque expense, an income mirror row,
//      and a legacy `payment_type = 'bank'` row with no account.
//   E. A bank transaction moves TOTAL BANK by exactly its amount and leaves
//      cash in hand alone — in both directions.
//   F. Deleting a transaction reverses its effect on both totals, exactly.
//   G. Internal settlements, all five shapes. Bank->Cash lowers bank and
//      raises cash by the amount with their SUM unchanged; Cash->Bank the
//      reverse; Bank->Bank leaves both unchanged for DIFFERENT accounts and —
//      the case that writes no ledger row at all — for the SAME account.
//   H. A receive voucher is counted ONCE, not twice alongside the
//      `bills.amount_paid` it raised.
//   I. A bill received into a house account, one settled out of a customer's
//      deposit, and a bank refund on a return all leave cash alone.
//   J. Another login account's rows are never counted, and neither is the
//      colliding layer batch's — flock #1 and batch #1 are different money.
//   K. The term list is complete: the component keys are exactly the expected
//      set, so a dropped or renamed term fails here rather than silently
//      removing a table from the client's cash position.
//   L. The `asOf` cut-off, which the Farm Report's closing footer prints: it
//      is INCLUSIVE of its own day, it is a range-TO only, a date before
//      everything shows 0 and 0, a date after everything is identical to the
//      undated call, and a receipt dated after the cut-off is not counted.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const DS_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const CP_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'cash-position.service.ts'), 'utf8')

function extractFn(src, name, kw) {
  const start = src.indexOf(`${kw}${name}(`)
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

// `cashSql()` closes over this module-level constant, so the lifted class has
// to find it in THIS script's scope. Taken out of the source rather than
// retyped, so a renamed token fails here instead of silently binding a farm_id
// where the cut-off belongs.
const AS_OF_PARAM = (CP_SRC.match(/export const AS_OF_PARAM = '([^']*)'/) || [])[1]
if (!AS_OF_PARAM) throw new Error('AS_OF_PARAM not found in cash-position.service.ts')

// `farmCashSql()` closes over this one the same way. Also taken out of the
// source, for the same reason.
const UNIT_PARAM = (CP_SRC.match(/export const UNIT_PARAM = '([^']*)'/) || [])[1]
if (!UNIT_PARAM) throw new Error('UNIT_PARAM not found in cash-position.service.ts')

const toJs = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText.trim().replace(/;$/, '')

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// ── The service under test, lifted whole ───────────────────────────────────
//
// Reassembled into one class — which is what it is — so the methods' `this.`
// resolves between them exactly as it does in the app. `private` and the type
// annotations are stripped by the transpiler.
const cashProto = (() => {
  const cls = [
    'class LiftedCashPosition {',
    '  ' + extractFn(CP_SRC, 'getCashPosition', 'async '),
    '  ' + extractFn(CP_SRC, 'readBankTotal', 'private async '),
    '  ' + extractFn(CP_SRC, 'readComponents', 'private async '),
    '  ' + extractFn(CP_SRC, 'cashSql', '\n  ').trim(),
    '  ' + extractFn(CP_SRC, 'getFarmCashPosition', 'async ').trim(),
    '  ' + extractFn(CP_SRC, 'farmCashSql', '\n  ').trim(),
    '}'
  ].join('\n')
  return eval('(' + toJs(cls) + ')').prototype
})()

// ── The bank balance rebuild, lifted out of the real write path ────────────
const bankProto = (() => {
  const cls = [
    'class LiftedBank {',
    '  ' + extractFn(DS_SRC, 'rebuildBankBalanceOp', 'private ').trim(),
    '  ' + extractFn(DS_SRC, 'bankBalanceSql', 'private ').trim(),
    '}'
  ].join('\n')
  return eval('(' + toJs(cls) + ')').prototype
})()

function rows(db, sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

let failures = 0
const EPS = 0.005
const check = (label, actual, expected) => {
  const ok = Math.abs(Number(actual) - Number(expected)) < EPS
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}
const checkText = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}:\n        got      ${actual}\n        expected ${expected}`)
}

initSqlJs().then(async SQL => {
  const db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  const dbShim = {
    async get(sql, params) {
      try { return { success: true, data: rows(db, sql, params) } }
      catch (e) { return { success: false, error: e.message } }
    }
  }

  const service = Object.create(cashProto)
  service.db = dbShim

  const bank = Object.create(bankProto)

  const FARM = 1
  const OTHER = 2

  /** Both figures, through the real public entry point. */
  const pos = async (farmId = FARM, asOf = null) => {
    const p = await service.getCashPosition(farmId, asOf)
    if (p.warnings.length) {
      failures++
      console.log(`  FAIL  unexpected warnings: ${p.warnings.join(' | ')}`)
    }
    return p
  }

  /** The real rebuild, run the way a runBatch would run it. */
  const rebuild = (bankId) => {
    const op = bank.rebuildBankBalanceOp(bankId)
    db.run(op.sql, op.params)
  }

  let ledId = 0
  /**
   * One bank_ledger row plus the rebuild of its account — the pair every real
   * bank-sourced write path emits together.
   */
  const entry = (bankId, refType, refId, debit, credit, date = '2026-05-01') => {
    ledId++
    db.run(`INSERT INTO bank_ledger (ledger_id, bank_id, transaction_date, description,
                                     debit, credit, reference_type, reference_id)
            VALUES (?,?,?,?,?,?,?,?)`,
      [ledId, bankId, date, refType, debit, credit, refType, refId])
    rebuild(bankId)
    return ledId
  }
  const dropEntry = (id, bankId) => {
    db.run(`DELETE FROM bank_ledger WHERE ledger_id = ?`, [id])
    rebuild(bankId)
  }

  // ── Seed: two accounts, with a deliberate flock/batch id collision ───────
  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type)
          VALUES (?,?,?,?), (?,?,?,?)`,
    [FARM, 'Talha', 'x', 'all', OTHER, 'Someone Else', 'x', 'all'])

  db.run(`INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name)
          VALUES (1,?,'broiler','Farm A'), (2,?,'layer','Farm B'), (3,?,'broiler','Their Farm')`,
    [FARM, FARM, OTHER])

  // flocks.flock_id 1 and batches.batch_id 1 COLLIDE — separate AUTOINCREMENT
  // sequences that both start at 1, which is the whole reason the shared
  // tables need their module_type guard. Flock 2 belongs to the OTHER account.
  db.run(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id)
          VALUES (1,?,'Flock 1','2026-01-01',1), (2,?,'Their Flock','2026-01-01',3)`,
    [FARM, OTHER])
  db.run(`INSERT INTO batches (batch_id, farm_id, batch_name, start_date, initial_birds, unit_id)
          VALUES (1,?,'Batch 1','2026-01-01',5000,2)`, [FARM])

  // Two HOUSE accounts for this farm, one CUSTOMER deposit account, and a
  // house account on the other login that must never be counted.
  db.run(`INSERT INTO bank_accounts (bank_id, farm_id, customer_id, bank_name, account_holder)
          VALUES (1,?,NULL,'HBL Main','Mian Ahmed'),
                 (2,?,NULL,'UBL Second','Mian Ahmed'),
                 (3,?,1,'Customer Deposit','Asif Traders'),
                 (4,?,NULL,'Their Bank','Them')`,
    [FARM, FARM, FARM, OTHER])

  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name, customer_type, bank_id)
          VALUES (1,?,'Asif Traders','external',3), (2,?,'Own Farm A','own_farm',NULL)`,
    [FARM, FARM])
  db.run(`INSERT INTO suppliers (supplier_id, farm_id, supplier_name) VALUES (1,?,'Feed Mill')`, [FARM])
  db.run(`INSERT INTO labour (labour_id, farm_id, labour_name) VALUES (1,?,'Akram'), (2,?,'Sacked')`,
    [FARM, FARM])
  db.run(`INSERT INTO products (product_id, farm_id, product_name) VALUES (1,?,'Feed Bag')`, [FARM])
  db.run(`INSERT INTO assets (asset_id, farm_id, asset_name, purchase_date, total_price, purchase_amount)
          VALUES (1,?,'Tractor','2026-02-01',900000,900000)`, [FARM])

  // ── A. nothing recorded ──────────────────────────────────────────────────
  console.log('\n=== A. An empty account shows zero and zero ===')
  {
    const p = await pos()
    check('cash in hand', p.cashInHand, 0)
    check('total bank balance', p.totalBankBalance, 0)
    const n = p.components.length
    const ok = n > 0
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  the derivation really ran: ${n} terms, all zero`)
  }

  // ── K. the term list ─────────────────────────────────────────────────────
  //
  // Asserted BEFORE anything is seeded, while every term is zero, so this is
  // purely about which terms exist. A dropped term would otherwise show up
  // only as a wrong total on one client's database.
  console.log('\n=== K. Every declared term is present, and no others ===')
  {
    const EXPECTED_KEYS = [
      'broiler_sales_in', 'egg_sales_in', 'hen_sales_in',
      'broiler_income_in', 'layer_income_in', 'asset_sales_in', 'bills_paid_in',
      'broiler_expenses_out', 'layer_expenses_out',
      'broiler_labour_out', 'layer_labour_out',
      'purchase_orders_out', 'expense_ledger_out', 'payment_vouchers_out',
      'asset_payments_out', 'personal_expenses_out',
      'internal_settlements_out',
      'loans_given_out', 'loans_received_in',
      'loan_repayments_in', 'loan_repayments_out',
      'bill_house_receipt_banked', 'customer_deposit_paid',
      'customer_bank_refund', 'receive_voucher_banked',
      'internal_settlement_to_bank', 'bills_paid_after_asof',
      'bank_manual_deposit_out', 'bank_manual_withdrawal_in'
    ]
    const keys = (await pos()).components.map(c => c.key)
    checkText('component keys', keys.join(','), EXPECTED_KEYS.join(','))

    const [sql, params] = service.cashSql()
    check('every ? in the statement is bound',
      (sql.match(/\?/g) || []).length, params.length)
  }

  // ── B. money in ──────────────────────────────────────────────────────────
  console.log('\n=== B. Each recorded cash receipt raises cash by exactly its amount ===')

  /** Runs `write`, then asserts the exact deltas on both totals. */
  const movement = async (label, write, dCash, dBank) => {
    const before = await pos()
    write()
    const after = await pos()
    check(`${label} — cash`, after.cashInHand - before.cashInHand, dCash)
    check(`${label} — bank`, after.totalBankBalance - before.totalBankBalance, dBank)
    return { before, after }
  }

  await movement('broiler sale, cash 50000', () => db.run(
    `INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, module_type)
     VALUES (1,1,'2026-05-02',200,50000,'cash','cash','broiler')`), 50000, 0)

  await movement('egg sale, cash 12000', () => db.run(
    `INSERT INTO egg_sales (egg_sale_id, batch_id, date, quantity, rate_per_egg, total_amount, payment_type, payment_source)
     VALUES (1,1,'2026-05-02',1000,12,12000,'cash','cash')`), 12000, 0)

  await movement('hen sale, cash 8000', () => db.run(
    `INSERT INTO hen_sales (hen_sale_id, batch_id, date, quantity, rate_per_hen, total_amount, payment_type, payment_source)
     VALUES (1,1,'2026-05-02',20,400,8000,'cash','cash')`), 8000, 0)

  await movement('manual broiler income, cash 3000', () => db.run(
    `INSERT INTO income (income_id, flock_id, date, description, amount, source, module_type, payment_source)
     VALUES (1,1,'2026-05-03','Scrap sale',3000,'manual','broiler','cash')`), 3000, 0)

  await movement('manual layer income, cash 4000', () => db.run(
    `INSERT INTO income (income_id, flock_id, date, description, amount, source, module_type, payment_source)
     VALUES (2,1,'2026-05-03','Manure',4000,'manual','layer','cash')`), 4000, 0)

  // SELLING AN ASSET. `sale_payment_source` is the sale's own, never
  // `assets.payment_source`, which records how the asset was PAID FOR — the
  // other direction entirely. A bank sale writes a bank_ledger deposit and so
  // raises the bank total instead; here only the cash case is asserted, the
  // bank one living in verify_bank_withdrawals.js where the ledger is.
  await movement('asset sold for cash, 44000', () => db.run(
    `INSERT INTO assets (asset_id, farm_id, asset_name, purchase_date, total_price,
                         purchase_amount, status, sale_date, sale_amount, sale_payment_source)
     VALUES (900,?,'Chiller','2026-01-01',30000,30000,'sold','2026-05-04',44000,'cash')`,
    [FARM]), 44000, 0)

  // A LEGACY sold asset — every one sold before the Sell form had a selector —
  // has a NULL source and reads as cash, which is true: no deposit was ever
  // posted for it. The exemption is the value itself, not a list of ids.
  await movement('asset sold before the selector existed, 9000', () => db.run(
    `INSERT INTO assets (asset_id, farm_id, asset_name, purchase_date, total_price,
                         purchase_amount, status, sale_date, sale_amount)
     VALUES (901,?,'Old pump','2026-01-01',5000,5000,'sold','2026-05-04',9000)`,
    [FARM]), 9000, 0)

  // And one still OWNED contributes nothing, whatever sale_amount holds.
  await movement('an asset still owned is not a sale', () => db.run(
    `INSERT INTO assets (asset_id, farm_id, asset_name, purchase_date, total_price,
                         purchase_amount, status)
     VALUES (902,?,'Tractor','2026-01-01',500000,500000,'active')`,
    [FARM]), 0, 0)

  await movement('cash bill, 25000 collected', () => db.run(
    `INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, bill_date, subtotal,
                        total_amount, amount_paid, payment_type, payment_source, source)
     VALUES (1,?,'BILL-001',1,'2026-05-04',25000,25000,25000,'cash','cash','distribution')`,
    [FARM]), 25000, 0)

  // ── C. money out ─────────────────────────────────────────────────────────
  console.log('\n=== C. Each recorded cash payment lowers cash by exactly its amount ===')

  // THE DISTRIBUTION BUSINESS'S OWN COSTS. Its `payment_type` is paid vs
  // unpaid, so an unpaid one must move nothing — asserted three ways here.
  await movement('distribution expense, cash 2500', () => db.run(
    `INSERT INTO expense_ledger (expense_id, farm_id, transaction_date, description, amount,
                                 category, payment_type, payment_source)
     VALUES (500,?,'2026-05-05','Office rent',2500,'Rent','cash','cash')`,
    [FARM]), -2500, 0)

  await movement('distribution expense on CREDIT moves nothing', () => db.run(
    `INSERT INTO expense_ledger (expense_id, farm_id, transaction_date, description, amount,
                                 category, payment_type, payment_source)
     VALUES (501,?,'2026-05-05','Unpaid salary',9000,'Salary','credit','cash')`,
    [FARM]), 0, 0)

  // A LEGACY row: 'bank' in payment_type, no account, no entry ever posted.
  // In NEITHER total, which is honest — nothing left the drawer and no balance
  // moved. The exemption is the value itself, not a list of ids.
  await movement('legacy bank-labelled distribution expense is in neither total', () => db.run(
    `INSERT INTO expense_ledger (expense_id, farm_id, transaction_date, description, amount,
                                 category, payment_type)
     VALUES (502,?,'2026-05-05','Old transfer',4000,'Other','bank')`,
    [FARM]), 0, 0)

  await movement('broiler expense, cash 7000', () => db.run(
    `INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
     VALUES (1,1,'2026-05-05','Diesel',7000,'cash','broiler','cash')`), -7000, 0)

  // The layer Expenses screen drives payment_source and leaves payment_type at
  // its 'cash' default — the same table, told apart only by module_type.
  await movement('layer expense, cash 6000', () => db.run(
    `INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
     VALUES (2,1,'2026-05-05','Crates',6000,'cash','layer','cash')`), -6000, 0)

  await movement('broiler wage, cash 5000', () => db.run(
    `INSERT INTO labour_payments (payment_id, labour_id, flock_id, date, amount, payment_type, module_type, payment_source)
     VALUES (1,1,1,'2026-05-06',5000,'cash','broiler','cash')`), -5000, 0)

  await movement('layer wage, cash 4500', () => db.run(
    `INSERT INTO labour_payments (payment_id, labour_id, flock_id, date, amount, payment_type, module_type, payment_source)
     VALUES (2,1,1,'2026-05-06',4500,'cash','layer','cash')`), -4500, 0)

  await movement('purchase order, PAID in cash 9000', () => db.run(
    `INSERT INTO purchase_orders (purchase_id, farm_id, supplier_id, product_id, date,
                                  quantity, cost_price, total_amount, payment_type, payment_source)
     VALUES (1,?,1,1,'2026-05-07',10,900,9000,'cash','cash')`, [FARM]), -9000, 0)

  await movement('payment voucher, cash 3500', () => db.run(
    `INSERT INTO payment_vouchers (voucher_id, farm_id, supplier_id, voucher_number, date, amount, payment_source)
     VALUES (1,?,1,'PV-001','2026-05-08',3500,'cash')`, [FARM]), -3500, 0)

  await movement('asset installment, cash 2500', () => db.run(
    `INSERT INTO asset_payments (payment_id, asset_id, farm_id, date, amount, payment_source)
     VALUES (1,1,?,'2026-05-09',2500,'cash')`, [FARM]), -2500, 0)

  await movement('personal expense, cash 1500', () => db.run(
    `INSERT INTO personal_expenses (pexpense_id, farm_id, date, description, amount, payment_source)
     VALUES (1,?,'2026-05-10','School fees',1500,'cash')`, [FARM]), -1500, 0)

  // A deleted worker's payments must still count — the money really left, and
  // the derivation deliberately never joins `labour`.
  await movement('wage of a worker since deleted, cash 2000', () => {
    db.run(`INSERT INTO labour_payments (payment_id, labour_id, flock_id, date, amount, payment_type, module_type, payment_source)
            VALUES (3,2,1,'2026-05-06',2000,'cash','broiler','cash')`)
    db.run(`DELETE FROM labour WHERE labour_id = 2`)
  }, -2000, 0)

  const AFTER_CASH_ROWS = (await pos()).cashInHand

  // ── D. rows that moved no money ──────────────────────────────────────────
  console.log('\n=== D. A row that moved no money moves neither total ===')

  // Every one of these carries payment_source = 'cash', because
  // bankSourceFields() writes that for anything not bank-sourced. Testing the
  // source alone would count all of them.
  await movement('CREDIT broiler sale (not collected)', () => db.run(
    `INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, module_type)
     VALUES (2,1,'2026-05-11',200,99999,'credit','cash','broiler')`), 0, 0)

  await movement('CREDIT egg sale', () => db.run(
    `INSERT INTO egg_sales (egg_sale_id, batch_id, date, quantity, rate_per_egg, total_amount, payment_type, payment_source)
     VALUES (2,1,'2026-05-11',1000,12,88888,'credit','cash')`), 0, 0)

  await movement('CREDIT (unpaid) wage', () => db.run(
    `INSERT INTO labour_payments (payment_id, labour_id, flock_id, date, amount, payment_type, module_type, payment_source)
     VALUES (4,1,1,'2026-05-11',77777,'credit','broiler','cash')`), 0, 0)

  await movement('UNPAID purchase order', () => db.run(
    `INSERT INTO purchase_orders (purchase_id, farm_id, supplier_id, product_id, date,
                                  quantity, cost_price, total_amount, payment_type, payment_source)
     VALUES (2,?,1,1,'2026-05-11',10,900,66666,'credit','cash')`, [FARM]), 0, 0)

  await movement('CHEQUE expense (no account named)', () => db.run(
    `INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
     VALUES (3,1,'2026-05-11','Cheque feed',55555,'cheque','broiler','cash')`), 0, 0)

  // The daily mirror of a sale. Banking or counting it would take the same
  // money twice — the sale table already has it.
  await movement('income MIRROR row (source = sale)', () => db.run(
    `INSERT INTO income (income_id, flock_id, date, description, amount, source, module_type, payment_source)
     VALUES (3,1,'2026-05-02','Sales mirror',50000,'sale','broiler','cash')`), 0, 0)

  // The structural exemption every pre-mechanism row relies on: labelled bank,
  // no account, no entry was ever posted. Not cash, and not in the bank total.
  await movement('LEGACY bank-labelled expense with no account', () => db.run(
    `INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
     VALUES (4,1,'2025-06-01','Old bank expense',44444,'bank','broiler','cash')`), 0, 0)

  // ── J. the other login, and the colliding batch ──────────────────────────
  console.log('\n=== J. Another account, and the colliding batch, are never counted ===')

  await movement('the OTHER account records a cash sale, an expense and a bill', () => {
    db.run(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, module_type)
            VALUES (3,2,'2026-05-12',200,111111,'cash','cash','broiler')`)
    db.run(`INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
            VALUES (5,2,'2026-05-12','Theirs',222222,'cash','broiler','cash')`)
    db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, bill_date, subtotal, total_amount, amount_paid, source)
            VALUES (2,?,'BILL-T',  '2026-05-12',333333,333333,333333,'distribution')`, [OTHER])
    entry(4, 'broiler_sale', 3, 444444, 0)
  }, 0, 0)

  // flock_id 1 and batch_id 1 are the same number on purpose. A broiler-side
  // term reading an expense filed with module_type 'layer' — or the reverse —
  // would double-count it here and nothing on screen would say why.
  {
    const before = await pos()
    const terms = Object.fromEntries(before.components.map(c => [c.key, c.amount]))
    check('broiler expenses term sees only the broiler rows',
      terms['broiler_expenses_out'], -7000)
    check('layer expenses term sees only the layer rows',
      terms['layer_expenses_out'], -6000)
    check('broiler labour term sees only the broiler rows',
      terms['broiler_labour_out'], -(5000 + 2000))
    check('layer labour term sees only the layer rows',
      terms['layer_labour_out'], -4500)
    check('broiler income term sees only the broiler manual row',
      terms['broiler_income_in'], 3000)
    check('layer income term sees only the layer manual row',
      terms['layer_income_in'], 4000)
    check('cash in hand is unchanged by all of section D and J',
      before.cashInHand, AFTER_CASH_ROWS)
  }

  // ── E. bank transactions ─────────────────────────────────────────────────
  console.log('\n=== E. A bank transaction moves the bank total only ===')

  let bankSaleEntry = 0
  await movement('bank sale of 40000 into HBL Main', () => {
    db.run(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, bank_id, module_type)
            VALUES (4,1,'2026-05-13',200,40000,'bank','bank',1,'broiler')`)
    bankSaleEntry = entry(1, 'broiler_sale', 4, 40000, 0)
  }, 0, 40000)

  let bankExpenseEntry = 0
  await movement('bank expense of 15000 out of HBL Main', () => {
    db.run(`INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source, bank_id)
            VALUES (6,1,'2026-05-14','Bank feed',15000,'bank','broiler','bank',1)`)
    bankExpenseEntry = entry(1, 'farm_expense', 6, 0, 15000)
  }, 0, -15000)

  await movement('bank income of 5000 into the SECOND house account', () => {
    db.run(`INSERT INTO income (income_id, flock_id, date, description, amount, source, module_type, payment_source, bank_id)
            VALUES (4,1,'2026-05-15','Rent',5000,'manual','broiler','bank',2)`)
    entry(2, 'farm_income', 4, 5000, 0)
  }, 0, 5000)

  // A customer's deposit account is NOT the owner's money and is excluded from
  // the total — the `customer_id IS NULL` split.
  await movement('a deposit of 30000 into a CUSTOMER account', () => {
    entry(3, 'deposit', null, 30000, 0)
  }, 0, 0)

  // ── N. moving cash between the drawer and a house account ────────────────
  console.log('\n=== N. Banking cash lowers Cash in Hand by exactly what the bank gains ===')
  // The client's report: he transferred cash into the bank, the bank total
  // rose, and Cash in Hand did not move. Overview > Bank was the one money
  // movement in the app with a bank side and no cash side.
  //
  // THE INVARIANT for a transfer: the two totals move by the same amount in
  // opposite directions, so cash + bank is UNCHANGED. The money changed place,
  // not amount.

  const transfer = async (label, write, dCash, dBank) => {
    const before = await pos()
    write()
    const after = await pos()
    check(`${label} — cash`, after.cashInHand - before.cashInHand, dCash)
    check(`${label} — bank`, after.totalBankBalance - before.totalBankBalance, dBank)
    check(`${label} — cash + bank together`,
      (after.cashInHand + after.totalBankBalance) - (before.cashInHand + before.totalBankBalance),
      dCash + dBank)
    return { before, after }
  }

  let manualDeposit = 0
  await transfer('cash 25000 banked into HBL Main', () => {
    manualDeposit = entry(1, 'deposit', null, 25000, 0, '2026-05-20')
  }, -25000, 25000)

  let manualWithdrawal = 0
  await transfer('10000 drawn out of HBL Main as cash', () => {
    manualWithdrawal = entry(1, 'withdrawal', null, 0, 10000, '2026-05-21')
  }, 10000, -10000)

  // Reversing it puts the cash back, the same discipline every other delete
  // in this file is held to.
  await transfer('deleting the deposit', () => dropEntry(manualDeposit, 1), 25000, -25000)
  await transfer('deleting the withdrawal', () => dropEntry(manualWithdrawal, 1), -10000, 10000)

  // AN OPENING BALANCE IS NOT A TRANSFER. It is the account's starting state,
  // so it raises the bank total and must leave the drawer alone — counting it
  // would show an account opened with Rs 500,000 as Rs 500,000 of cash spent.
  const openingRow = entry(2, 'opening', null, 500000, 0, '2026-05-22')
  await transfer('(already written) an opening balance', () => {}, 0, 0)
  {
    const before = await pos()
    dropEntry(openingRow, 2)
    const after = await pos()
    check('an opening balance never touched cash', before.cashInHand - after.cashInHand, 0)
    check('but it did hold the bank total', before.totalBankBalance - after.totalBankBalance, 500000)
  }

  // A row whose reference_type is NULL predates this and its intent is
  // unrecorded, so it is exempt — the structural exemption legacy
  // `payment_source` rows get, rather than a guess about what it meant.
  {
    ledId++
    db.run(`INSERT INTO bank_ledger (ledger_id, bank_id, transaction_date, description,
                                     debit, credit, reference_type, reference_id)
            VALUES (?,?,?,?,?,?,NULL,NULL)`,
      [ledId, 1, '2026-05-23', 'Legacy hand entry', 7000, 0])
    const legacyRow = ledId
    const before = await pos()
    rebuild(1)
    const after = await pos()
    check('a legacy NULL-type entry moves no cash', after.cashInHand - before.cashInHand, 0)
    dropEntry(legacyRow, 1)
  }

  // Every other writer stamps its OWN reference_type and is covered by its own
  // term, so none of them is counted twice here.
  {
    const before = await pos()
    const otherTyped = entry(1, 'asset_payment', 99, 0, 3000, '2026-05-24')
    const after = await pos()
    check('a typed entry from another path is not read as a transfer',
      after.cashInHand - before.cashInHand, 0)
    dropEntry(otherTyped, 1)
  }

  // ── F. deletes reverse ───────────────────────────────────────────────────
  console.log('\n=== F. Deleting a transaction reverses its effect exactly ===')

  await movement('delete the cash broiler sale of 50000', () => db.run(
    `DELETE FROM sales WHERE sale_id = 1`), -50000, 0)

  await movement('delete the cash expense of 7000', () => db.run(
    `DELETE FROM expenses WHERE expense_id = 1`), 7000, 0)

  await movement('delete the cash asset installment of 2500', () => db.run(
    `DELETE FROM asset_payments WHERE payment_id = 1`), 2500, 0)

  await movement('delete the bank sale of 40000 (row + its entry)', () => {
    db.run(`DELETE FROM sales WHERE sale_id = 4`)
    dropEntry(bankSaleEntry, 1)
  }, 0, -40000)

  await movement('delete the bank expense of 15000 (row + its entry)', () => {
    db.run(`DELETE FROM expenses WHERE expense_id = 6`)
    dropEntry(bankExpenseEntry, 1)
  }, 0, 15000)

  // Put the two cash rows back, so later sections run against a populated book
  // rather than one whose history has been unwound.
  db.run(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, module_type)
          VALUES (1,1,'2026-05-02',200,50000,'cash','cash','broiler')`)
  db.run(`INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
          VALUES (1,1,'2026-05-05','Diesel',7000,'cash','broiler','cash')`)

  // ── H. a receive voucher is counted once ─────────────────────────────────
  console.log('\n=== H. A receive voucher is counted once, not twice ===')

  // The debt first: a credit bill the voucher will settle.
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, bill_date, subtotal,
                             total_amount, amount_paid, payment_type, source)
          VALUES (3,?,'BILL-002',1,'2026-05-16',200000,200000,0,'credit','distribution')`, [FARM])

  // A CASH voucher of 60000. The settlement raises bills.amount_paid, which is
  // where the money is counted; the voucher row itself adds nothing on top.
  await movement('cash receive voucher of 60000', () => {
    db.run(`INSERT INTO receive_vouchers (voucher_id, farm_id, customer_id, voucher_number, date, amount, payment_source)
            VALUES (1,?,1,'RV-001','2026-05-16',60000,'cash')`, [FARM])
    db.run(`UPDATE bills SET amount_paid = amount_paid + 60000 WHERE bill_id = 3`)
  }, 60000, 0)

  // A BANK voucher of 50000: the same amount_paid rise, taken straight back
  // off, with the money appearing in the bank instead.
  await movement('bank receive voucher of 50000', () => {
    db.run(`INSERT INTO receive_vouchers (voucher_id, farm_id, customer_id, voucher_number, date, amount, payment_source, bank_id)
            VALUES (2,?,1,'RV-002','2026-05-17',50000,'bank',1)`, [FARM])
    db.run(`UPDATE bills SET amount_paid = amount_paid + 50000 WHERE bill_id = 3`)
    entry(1, 'receive_voucher', 2, 50000, 0)
  }, 0, 50000)

  // ── I. the two bank-attributed bill shapes, and a bank refund ────────────
  console.log('\n=== I. A banked bill receipt, a deposit-paid bill, and a bank refund ===')

  await movement('bill received straight into a HOUSE account, 80000', () => {
    db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, bill_date, subtotal,
                               total_amount, amount_paid, payment_type, payment_source,
                               payment_account_kind, bank_id, source)
            VALUES (4,?,'BILL-003',1,'2026-05-18',80000,80000,80000,'bank','bank','house',1,'distribution')`,
      [FARM])
    entry(1, 'bill_payment_in', 4, 80000, 0)
  }, 0, 80000)

  await movement('bill settled out of the customer\'s own deposit, 35000', () => {
    db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, bill_date, subtotal,
                               total_amount, amount_paid, payment_type, payment_source,
                               payment_account_kind, bank_id, source)
            VALUES (5,?,'BILL-004',1,'2026-05-19',35000,35000,35000,'bank','bank','customer',3,'distribution')`,
      [FARM])
    entry(3, 'payment', null, 0, 35000)
  }, 0, 0)

  // A sales return refunded to the customer's deposit lowers amount_paid, which
  // must NOT come out of the drawer.
  await movement('BANK refund of 10000 on a return', () => {
    db.run(`UPDATE bills SET amount_paid = amount_paid - 10000, total_amount = total_amount - 10000
            WHERE bill_id = 4`)
    entry(3, 'return', 4, 0, 10000)
  }, 0, 0)

  // A CASH refund has no entry, and correctly does reduce cash.
  await movement('CASH refund of 4000 on the cash bill', () => db.run(
    `UPDATE bills SET amount_paid = amount_paid - 4000, total_amount = total_amount - 4000
     WHERE bill_id = 1`), -4000, 0)

  // ── G. internal settlements, all five shapes ─────────────────────────────
  console.log('\n=== G. Internal settlements ===')

  // An own-farm bill for the settlements to clear. One big one is enough —
  // each settlement below raises its amount_paid, exactly as
  // customerSettlementOps() does.
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, bill_date, subtotal,
                             total_amount, amount_paid, payment_type, source)
          VALUES (6,?,'BILL-INT',2,'2026-06-01',1000000,1000000,0,'internal','distribution')`, [FARM])

  let sid = 0
  /**
   * One settlement, written the way saveInternalSettlement() writes it: the
   * row, the FIFO credit onto the bill, and a ledger leg per END THAT IS A
   * BANK — none at all when both ends are the same account, which is the case
   * that proves the deduction is read off the settlement and not off
   * bank_ledger.
   */
  const settle = (amount, from, fromBank, to, toBank) => {
    sid++
    db.run(`INSERT INTO internal_settlements (settlement_id, farm_id, customer_id, settlement_number,
                                              date, amount, from_account, from_bank_id, to_account, to_bank_id)
            VALUES (?,?,2,?,'2026-06-02',?,?,?,?,?)`,
      [sid, FARM, 'IS-' + sid, amount, from, fromBank, to, toBank])
    db.run(`UPDATE bills SET amount_paid = amount_paid + ? WHERE bill_id = 6`, [amount])
    const legs = []
    const moved = !(from === to && fromBank === toBank)
    if (moved && from === 'bank') legs.push(entry(fromBank, 'internal_settlement_out', sid, 0, amount))
    if (moved && to === 'bank') legs.push(entry(toBank, 'internal_settlement_in', sid, amount, 0))
    return { id: sid, legs, fromBank, toBank }
  }
  const unsettle = (s, amount) => {
    db.run(`UPDATE bills SET amount_paid = amount_paid - ? WHERE bill_id = 6`, [amount])
    db.run(`DELETE FROM internal_settlements WHERE settlement_id = ?`, [s.id])
    for (const l of s.legs) db.run(`DELETE FROM bank_ledger WHERE ledger_id = ?`, [l])
    rebuild(s.fromBank || s.toBank)
    rebuild(s.toBank || s.fromBank)
  }

  /** The general invariant: bank moves by (to is bank) - (from is bank). */
  const settlementCase = async (label, amount, from, fromBank, to, toBank) => {
    const before = await pos()
    const s = settle(amount, from, fromBank, to, toBank)
    const after = await pos()

    const expectBank = (to === 'bank' ? amount : 0) - (from === 'bank' ? amount : 0)
    const expectCash = (to === 'cash' ? amount : 0) - (from === 'cash' ? amount : 0)

    check(`${label} — bank`, after.totalBankBalance - before.totalBankBalance, expectBank)
    check(`${label} — cash`, after.cashInHand - before.cashInHand, expectCash)
    check(`${label} — cash + bank`,
      (after.cashInHand + after.totalBankBalance) - (before.cashInHand + before.totalBankBalance),
      expectCash + expectBank)

    unsettle(s, amount)
    const undone = await pos()
    check(`${label} — delete reverses cash`, undone.cashInHand, before.cashInHand)
    check(`${label} — delete reverses bank`, undone.totalBankBalance, before.totalBankBalance)
  }

  // Bank -> Cash: the amount leaves the bank and enters the drawer, and their
  // SUM is unchanged.
  await settlementCase('Bank -> Cash, 70000', 70000, 'bank', 1, 'cash', null)
  // Cash -> Bank: the mirror of it.
  await settlementCase('Cash -> Bank, 65000', 65000, 'cash', null, 'bank', 1)
  // Bank -> Bank, two DIFFERENT accounts: two legs that cancel in the total.
  await settlementCase('Bank -> Bank (different accounts), 90000', 90000, 'bank', 1, 'bank', 2)
  // Bank -> Bank, the SAME account: ZERO ledger rows are written, by design.
  await settlementCase('Bank -> Bank (same account), 120000', 120000, 'bank', 1, 'bank', 1)
  // Cash -> Cash: the drawer pays itself; nothing moves anywhere.
  await settlementCase('Cash -> Cash, 45000', 45000, 'cash', null, 'cash', null)

  // ── L. the `asOf` cut-off ────────────────────────────────────────────────
  //
  // The Farm Report's closing footer answers "as of this date you had Rs. X in
  // cash and Rs. Y in bank", so the whole derivation has to be stoppable at a
  // date. Run LAST, over everything the sections above built, because that is
  // the only state in which "a date after all of it equals the undated call"
  // proves anything.
  console.log('\n=== L. As of a date: a range-TO cut-off, inclusive of its own day ===')
  {
    // `bills_paid_in` has no date of its own — it is a running total — so the
    // cut-off reaches it through the `customer_ledger` credits every one of
    // the four doors writes. The sections above raise `bills.amount_paid`
    // directly, which the real app never does without logging the credit, so
    // the statement those rows are missing is written here before the dated
    // assertions. Nothing else reads `customer_ledger`, so this cannot move a
    // figure any earlier section checked.
    const paidToDate = rows(db,
      `SELECT COALESCE(SUM(MAX(COALESCE(amount_paid,0), 0)), 0) AS amount
       FROM bills WHERE farm_id = ?`, [FARM])[0].amount
    db.run(`INSERT INTO customer_ledger (customer_id, transaction_date, description, debit, credit,
                                         reference_type, reference_id)
            VALUES (1,'2026-06-15','Receipts to date',0,?, 'payment', NULL)`, [paidToDate])

    const undated = await pos()

    // A date AFTER everything recorded is the undated figure, both halves.
    // The bank side proves the two readings agree: undated reads the cached
    // `current_balance`, dated sums the ledger the cache is rebuilt from.
    const far = await pos(FARM, '9999-12-30')
    check('as of 9999-12-30 — cash equals the undated figure', far.cashInHand, undated.cashInHand)
    check('as of 9999-12-30 — bank equals the undated figure (cache == ledger)',
      far.totalBankBalance, undated.totalBankBalance)

    // A date BEFORE everything recorded holds nothing at all — which is also
    // the "empty range" case the Farm Report footer has to show as 0/0/0.
    const early = await pos(FARM, '2019-12-31')
    check('as of 2019-12-31 — cash in hand', early.cashInHand, 0)
    check('as of 2019-12-31 — total bank balance', early.totalBankBalance, 0)
    check('as of 2019-12-31 — total money', early.cashInHand + early.totalBankBalance, 0)

    // INCLUSIVE of its own day, on the cash side.
    db.run(`INSERT INTO expenses (flock_id, date, category, description, amount,
                                  payment_type, payment_source, module_type)
            VALUES (1,'2026-07-10','Repairs','Generator',1000,'cash','cash','broiler')`)
    const dayBefore = await pos(FARM, '2026-07-09')
    const sameDay   = await pos(FARM, '2026-07-10')
    check('a cash expense dated 10-07 is not in the figure as of 09-07',
      dayBefore.cashInHand, undated.cashInHand - 0)
    check('and IS in the figure as of 10-07 — the cut-off includes its own day',
      sameDay.cashInHand, undated.cashInHand - 1000)

    // INCLUSIVE of its own day, on the bank side.
    const lateEntry = entry(1, 'broiler_sale', 999, 5000, 0, '2026-07-10')
    const bankBefore = await pos(FARM, '2026-07-09')
    const bankSame   = await pos(FARM, '2026-07-10')
    check('a 5000 deposit dated 10-07 is not in the bank total as of 09-07',
      bankBefore.totalBankBalance, undated.totalBankBalance)
    check('and IS in the bank total as of 10-07',
      bankSame.totalBankBalance, undated.totalBankBalance + 5000)

    // A RECEIPT dated after the cut-off does not raise the cash of an earlier
    // date, even though `bills.amount_paid` is a running total with no date.
    db.run(`UPDATE bills SET amount_paid = amount_paid + 20000 WHERE bill_id = 6`)
    db.run(`INSERT INTO customer_ledger (customer_id, transaction_date, description, debit, credit,
                                         reference_type, reference_id)
            VALUES (2,'2026-07-20','Late settlement',0,20000,'payment',6)`)
    const beforeReceipt = await pos(FARM, '2026-07-10')
    check('a receipt dated 20-07 leaves the figure as of 10-07 alone',
      beforeReceipt.cashInHand, sameDay.cashInHand)
    const withReceipt = await pos()
    check('and does raise the undated figure by its amount',
      withReceipt.cashInHand - undated.cashInHand, 20000 - 1000)

    // Put the database back the way section L found it, so the closing
    // reconciliation below still describes the state the sections above built.
    db.run(`UPDATE bills SET amount_paid = amount_paid - 20000 WHERE bill_id = 6`)
    db.run(`DELETE FROM customer_ledger`)
    db.run(`DELETE FROM expenses WHERE date = '2026-07-10' AND description = 'Generator'`)
    dropEntry(lateEntry, 1)
    const restored = await pos()
    check('section L left both figures where it found them — cash',
      restored.cashInHand, undated.cashInHand)
    check('section L left both figures where it found them — bank',
      restored.totalBankBalance, undated.totalBankBalance)
  }

  // ── The bank total still agrees with the ledger it was rebuilt from ──────
  // ── M ──────────────────────────────────────────────────────────────────
  console.log('\n=== M. THIS FARM\'s own cash: a different figure, named differently ===')
  {
    // A second farm unit and a second flock on it, so "scoped to one farm"
    // means something testable rather than "the whole account by another name".
    db.run(`INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name)
            VALUES (90, ?, 'broiler', 'Farm B')`, [FARM])
    db.run(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id)
            VALUES (90, ?, 'F-B', '2026-01-01', 90)`, [FARM])

    const farmCash = async (module, unitId = null, asOf = null) => {
      const r = await service.getFarmCashPosition(FARM, module, unitId, asOf)
      if (r.warnings.length) {
        failures++
        console.log(`  FAIL  unexpected warnings: ${r.warnings.join(' | ')}`)
      }
      return r
    }

    const [sql, params] = service.farmCashSql('broiler')
    check('every ? in the per-farm statement is bound',
      (sql.match(/\?/g) || []).length, params.length)
    checkText('the broiler terms are exactly the four a farm can be held to',
      (await farmCash('broiler')).components.map(c => c.key).join(','),
      'broiler_sales_in,broiler_income_in,broiler_expenses_out,broiler_labour_out')
    checkText('and the layer terms are its five',
      (await farmCash('layer')).components.map(c => c.key).join(','),
      'egg_sales_in,hen_sales_in,layer_income_in,layer_expenses_out,layer_labour_out')

    // THE POINT OF THE WHOLE SECTION: the per-farm figure is NOT the drawer.
    // Everything account-level — bills collected, purchases, vouchers, assets,
    // personal expenses, the distribution expense ledger — is absent from it,
    // so the two must differ on a database that has any of that. The sections
    // above built exactly such a database.
    const whole = await pos()
    const allBroiler = await farmCash('broiler')
    checkTrue('the per-farm figure is not merely the account figure renamed',
      Math.abs(allBroiler.farmCashInHand - whole.cashInHand) > EPS)
    check('it is the sum of its own terms',
      allBroiler.farmCashInHand,
      allBroiler.components.reduce((s, c) => s + c.amount, 0))

    // One farm at a time. A cash sale on Farm B reaches B's figure and not A's,
    // and reaches the un-scoped (every unit) figure either way.
    const beforeAll = (await farmCash('broiler')).farmCashInHand
    const beforeB = (await farmCash('broiler', 90)).farmCashInHand
    db.run(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, module_type)
            VALUES (900, 90, '2026-05-02', 200, 77000, 'cash', 'cash', 'broiler')`)
    check('a cash sale on Farm B raises Farm B by exactly its amount',
      (await farmCash('broiler', 90)).farmCashInHand - beforeB, 77000)
    check('and raises the all-units figure by the same',
      (await farmCash('broiler')).farmCashInHand - beforeAll, 77000)
    check('while the OTHER unit is untouched',
      (await farmCash('broiler', 1)).farmCashInHand,
      beforeAll - beforeB)

    // A BANKED sale is in neither: no cash moved. Same rule as the drawer.
    const bBefore = (await farmCash('broiler', 90)).farmCashInHand
    db.run(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, bank_id, module_type)
            VALUES (901, 90, '2026-05-03', 200, 50000, 'bank', 'bank', 1, 'broiler')`)
    check('a BANKED sale on Farm B moves its cash figure not at all',
      (await farmCash('broiler', 90)).farmCashInHand, bBefore)

    // The cut-off behaves exactly as it does on the account-wide figure.
    check('a sale dated 02-05 is out of the figure as of 01-05',
      (await farmCash('broiler', 90, '2026-05-01')).farmCashInHand, 0)
    check('and in it as of 02-05 — the cut-off includes its own day',
      (await farmCash('broiler', 90, '2026-05-02')).farmCashInHand, 77000)

    // An expense on Farm B takes its own cash down, nothing else's.
    db.run(`INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
            VALUES (900, 90, '2026-05-04', 'Diesel', 7000, 'cash', 'broiler', 'cash')`)
    check('a cash expense on Farm B lowers only Farm B',
      (await farmCash('broiler', 90)).farmCashInHand, 77000 - 7000)

    // And the ACCOUNT-WIDE figure is still exactly what it always was: adding a
    // per-farm reader must not have touched `cashSql()`.
    check('the account-wide cash moved only by the rows just written',
      (await pos()).cashInHand, whole.cashInHand + 77000 - 7000)

    // Put the database back, so the closing reconciliation still describes the
    // state the sections above built.
    db.run(`DELETE FROM sales WHERE sale_id IN (900, 901)`)
    db.run(`DELETE FROM expenses WHERE expense_id = 900`)
    db.run(`DELETE FROM flocks WHERE flock_id = 90`)
    db.run(`DELETE FROM farm_units WHERE unit_id = 90`)
    check('section M left the account-wide cash where it found it',
      (await pos()).cashInHand, whole.cashInHand)
  }

  console.log('\n=== Closing reconciliation ===')
  {
    const p = await pos()
    const fromLedger = rows(db,
      `SELECT COALESCE(SUM(bl.debit - bl.credit), 0) AS amount
       FROM bank_ledger bl
       JOIN bank_accounts ba ON ba.bank_id = bl.bank_id
       WHERE ba.farm_id = ? AND ba.customer_id IS NULL`, [FARM])[0].amount
    check('total bank balance == SUM(debit - credit) over the house accounts',
      p.totalBankBalance, fromLedger)

    const cached = rows(db,
      `SELECT COALESCE(SUM(current_balance), 0) AS amount
       FROM bank_accounts WHERE farm_id = ? AND customer_id IS NULL`, [FARM])[0].amount
    check('and == the cached column Overview > Bank lists', p.totalBankBalance, cached)

    check('cash in hand == the sum of its own terms',
      p.cashInHand, p.components.reduce((s, c) => s + c.amount, 0))

    // The other login's money is still untouched by any of it.
    const other = await pos(OTHER)
    check('the other account sees only its own cash', other.cashInHand, 111111 - 222222 + 333333)
    check('the other account sees only its own bank', other.totalBankBalance, 444444)
  }

  console.log(failures === 0
    ? '\nAll cash-and-bank checks passed.'
    : `\n${failures} CHECK(S) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error(e); process.exit(1) })
