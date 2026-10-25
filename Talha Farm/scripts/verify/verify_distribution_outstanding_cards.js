// Distribution Report — the two outstanding cards at the top.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, the two balance reads lifted out of
// database.service.ts, and the getters lifted out of
// distribution-report.component.ts. Nothing is a restatement.
//
// What is proved:
//   A. The customer card equals the sum of the per-customer outstanding the
//      rest of the app reads — getAllCustomersWithBalance()'s
//      SUM(MAX(total_amount - amount_paid, 0)) — not a second definition.
//   B. Own-farm customers are excluded from it, and excluded by exactly the
//      amount their own bills carry.
//   C. The supplier card equals SUM(credit - debit) over supplier_ledger,
//      summed across suppliers, and equals the Supplier Payables section's own
//      total on the same screen.
//   D. A negative bill line can never push a customer's contribution below
//      zero (the MAX(...,0) is per bill, so an overpayment is floored).
//   E. The cards are BALANCES AS AT TODAY: a date range changes them by
//      nothing, matching the Supplier Payables section beside them, while the
//      rows such a range would slice really do differ. A real settlement does
//      move them, so they are live — just not period-scoped.
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
const RP_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'distribution-report', 'distribution-report.component.ts'), 'utf8')

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

const toJs = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText.trim().replace(/;$/, '')

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// The two balance reads, exactly as the app issues them.
function loadServiceMethod(name) {
  const body = extractFn(DS_SRC, name, 'async ').replace(/^async\s+/, 'async function ')
  return eval('(' + toJs(body) + ')')
}
const getAllCustomersWithBalance = loadServiceMethod('getAllCustomersWithBalance')
const getAllSuppliersWithBalance = loadServiceMethod('getAllSuppliersWithBalance')

// The getters under test, lifted whole out of the component and bound onto one
// object so their `this.` resolves the way it does on the real component.
const GETTERS = ['totalCustomerOutstanding', 'totalSupplierOutstanding',
                'totalSupplierPayable', 'activeSuppliers', 'totalOutstandingBalance']
const reportProto = (() => {
  // A bare `get x() {}` is not a statement, so the lifted getters are
  // reassembled into one class — which is what they are on the component —
  // and transpiled together. Their `this.` then resolves between them exactly
  // as it does in the app.
  const cls = [
    'class LiftedReport {',
    ...GETTERS.map(g => '  ' + extractFn(RP_SRC, g, 'get ')),
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
const check = (label, actual, expected) => {
  const ok = Number(actual) === Number(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
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

  const FARM = 1
  const OTHER = 2
  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type)
          VALUES (?,?,?,?), (?,?,?,?)`,
    [FARM, 'Talha', 'x', 'all', OTHER, 'Someone Else', 'x', 'all'])

  // ── Seed ────────────────────────────────────────────────────────────────
  //
  // Three external customers, one own-farm customer, one customer on ANOTHER
  // account (which must never be counted), and four suppliers.
  const cust = (id, name, type, farm) => db.run(
    `INSERT INTO customers (customer_id, farm_id, customer_name, customer_type)
     VALUES (?,?,?,?)`, [id, farm, name, type])
  cust(1, 'Asif Traders', 'external', FARM)
  cust(2, 'Rana Poultry', null, FARM)          // legacy NULL reads as external
  cust(3, 'Nadeem Shop', 'external', FARM)
  cust(4, 'Own Farm A', 'own_farm', FARM)
  cust(5, 'Other account cust', 'external', OTHER)

  let billId = 0
  const bill = (customerId, total, paid, date, farm) => {
    billId++
    db.run(`INSERT INTO bills (bill_id, farm_id, customer_id, bill_number, bill_date,
                               subtotal, total_amount, amount_paid)
            VALUES (?,?,?,?,?,?,?,?)`,
      [billId, farm || FARM, customerId, 'B-' + billId, date, total, total, paid])
  }
  bill(1, 100000, 40000, '2026-01-10')   // 60000 outstanding
  bill(1, 50000, 50000, '2026-02-05')    // settled
  bill(2, 80000, 0, '2026-03-01')        // 80000
  bill(3, 25000, 30000, '2026-03-20')    // OVERPAID — contributes 0, not -5000
  bill(4, 900000, 100000, '2026-02-14')  // own farm: 800000, must be excluded
  bill(5, 70000, 0, '2026-03-02', OTHER) // other account

  const EXPECTED_EXTERNAL = 60000 + 80000 + 0
  const EXPECTED_OWN_FARM = 800000

  const supp = (id, name, farm) => db.run(
    `INSERT INTO suppliers (supplier_id, farm_id, supplier_name) VALUES (?,?,?)`,
    [id, farm || FARM, name])
  supp(1, 'Feed Mill')
  supp(2, 'Medicine Co')
  supp(3, 'Settled Supplier')
  supp(4, 'Other account supplier', OTHER)

  let ledId = 0
  // `supplier_ledger` carries no farm_id — it is scoped through its supplier,
  // which is exactly how getAllSuppliersWithBalance() reaches it.
  const sled = (supplierId, credit, debit, date, refType) => {
    ledId++
    db.run(`INSERT INTO supplier_ledger (ledger_id, supplier_id, transaction_date,
                                         credit, debit, reference_type)
            VALUES (?,?,?,?,?,?)`,
      [ledId, supplierId, date, credit, debit, refType])
  }
  sled(1, 300000, 0, '2026-01-15', 'purchase')
  sled(1, 0, 120000, '2026-02-01', 'payment')   // 180000 owed
  sled(2, 95000, 0, '2026-03-05', 'purchase')
  sled(2, 0, 15000, '2026-03-18', 'payment')    // 80000 owed
  sled(3, 40000, 0, '2026-01-02', 'purchase')
  sled(3, 0, 40000, '2026-01-03', 'payment')    // settled, still "active"
  sled(4, 500000, 0, '2026-03-01', 'purchase')

  const EXPECTED_PAYABLE = 180000 + 80000 + 0

  // ── The screen, loaded the way loadData() loads it ──────────────────────
  const screen = Object.create(reportProto)
  screen.customers = (await getAllCustomersWithBalance.call(dbShim, FARM)).data
  screen.supplierBalances = (await getAllSuppliersWithBalance.call(dbShim, FARM)).data
  screen.dateFrom = ''
  screen.dateTo = ''

  // ── A. the customer card IS the app's own per-customer outstanding ──────
  console.log('\n=== A. Customer card reuses the one outstanding definition ===')
  const perCustomer = screen.customers
    .filter(c => (c.customer_type || 'external') !== 'own_farm')
    .reduce((s, c) => s + Number(c.outstanding_balance || 0), 0)
  check('card == sum of per-customer outstanding',
    screen.totalCustomerOutstanding, perCustomer)
  check('card == hand-computed external debt',
    screen.totalCustomerOutstanding, EXPECTED_EXTERNAL)

  // The same figure read straight off `bills` by the documented expression —
  // a second route to the same number, not a second definition in the app.
  const direct = rows(db,
    `SELECT COALESCE(SUM(MAX(COALESCE(b.total_amount,0) - COALESCE(b.amount_paid,0), 0)), 0) AS amt
       FROM bills b JOIN customers c ON c.customer_id = b.customer_id
      WHERE c.farm_id = ? AND COALESCE(c.customer_type,'external') <> 'own_farm'`, [FARM])[0].amt
  check('card == SUM(MAX(total_amount - amount_paid, 0)) over external bills',
    screen.totalCustomerOutstanding, direct)

  // ── B. own-farm exclusion ───────────────────────────────────────────────
  console.log('\n=== B. Own-farm customers are excluded ===')
  const ownFarmRow = screen.customers.find(c => c.customer_type === 'own_farm')
  check('own-farm customer does carry a debt',
    Number(ownFarmRow.outstanding_balance), EXPECTED_OWN_FARM)
  check('the inclusive figure (totalOutstandingBalance) counts it',
    screen.totalOutstandingBalance, EXPECTED_EXTERNAL + EXPECTED_OWN_FARM)
  check('the card differs from it by exactly the own-farm debt',
    screen.totalOutstandingBalance - screen.totalCustomerOutstanding, EXPECTED_OWN_FARM)
  check('another account customer is not read at all',
    screen.customers.filter(c => c.customer_id === 5).length, 0)

  // ── C. the supplier card IS SUM(credit - debit) ─────────────────────────
  console.log('\n=== C. Supplier card is SUM(credit - debit) over supplier_ledger ===')
  const ledgerDirect = rows(db,
    `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS amt
       FROM supplier_ledger l JOIN suppliers s ON s.supplier_id = l.supplier_id
      WHERE s.farm_id = ?`, [FARM])[0].amt
  check('card == SUM(credit - debit)', screen.totalSupplierOutstanding, ledgerDirect)
  check('card == hand-computed payable', screen.totalSupplierOutstanding, EXPECTED_PAYABLE)
  check('card == the Supplier Payables section total on the same screen',
    screen.totalSupplierOutstanding, screen.totalSupplierPayable)

  // ── D. an overpaid bill floors at zero ──────────────────────────────────
  console.log('\n=== D. An overpaid bill contributes zero, never a negative ===')
  const overpaid = screen.customers.find(c => c.customer_id === 3)
  check('overpaid customer contributes 0', Number(overpaid.outstanding_balance), 0)
  check('card is not reduced by the overpayment',
    screen.totalCustomerOutstanding, 60000 + 80000)

  // ── E. the cards are balances as at today ───────────────────────────────
  //
  // Matching the Supplier Payables section they sit above: a payable or a
  // receivable is what is owed NOW, not a flow sliced out of a period. The
  // date filter the sections use must therefore move neither card — while the
  // rows a range would slice really are different, so the check has teeth.
  console.log('\n=== E. A date range moves neither card ===')
  const beforeC = screen.totalCustomerOutstanding
  const beforeS = screen.totalSupplierOutstanding
  screen.dateFrom = '2026-03-01'
  screen.dateTo = '2026-03-31'
  check('customer card unchanged under a range', screen.totalCustomerOutstanding, beforeC)
  check('supplier card unchanged under a range', screen.totalSupplierOutstanding, beforeS)

  const inRange = rows(db,
    `SELECT COUNT(*) AS n FROM bills WHERE farm_id = ? AND bill_date BETWEEN ? AND ?`,
    [FARM, '2026-03-01', '2026-03-31'])[0].n
  const allBills = rows(db,
    `SELECT COUNT(*) AS n FROM bills WHERE farm_id = ?`, [FARM])[0].n
  const teeth = inRange > 0 && inRange < allBills
  if (!teeth) failures++
  console.log(`  ${teeth ? 'PASS' : 'FAIL'}  the range really does slice the rows: ` +
              `${inRange} of ${allBills} bills inside it`)

  // A settlement DOES move the card, because it changes what is owed today —
  // the cards are live, just not period-scoped.
  db.run(`UPDATE bills SET amount_paid = amount_paid + 30000 WHERE bill_id = 3`)
  screen.customers = (await getAllCustomersWithBalance.call(dbShim, FARM)).data
  check('a payment of 30000 lowers the customer card by 30000',
    screen.totalCustomerOutstanding, beforeC - 30000)

  sled(1, 0, 50000, '2026-03-25', 'payment')
  screen.supplierBalances = (await getAllSuppliersWithBalance.call(dbShim, FARM)).data
  check('paying a supplier 50000 lowers the supplier card by 50000',
    screen.totalSupplierOutstanding, beforeS - 50000)

  console.log(failures === 0
    ? '\nAll outstanding-card checks passed.'
    : `\n${failures} CHECK(S) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error(e); process.exit(1) })
