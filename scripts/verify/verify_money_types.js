// Every money value must reach JavaScript as a NUMBER, and arithmetic on it
// must be arithmetic.
//
// WHY THIS EXISTS (docs/DECISIONS.md D4)
// --------------------------------------
// Every money column is SQLite REAL today, and the app does plain JS arithmetic
// on the values it reads back — `row.amount + x` — in hundreds of places. In
// PostgreSQL, `node-postgres` returns `numeric` and `bigint` as **strings** to
// avoid precision loss. Map money to `numeric` and every one of those additions
// silently becomes string concatenation: 1000 + 500 = "1000500". No error, no
// stack trace, no failed request — just wrong money in an accounting system.
//
// This is the cheapest possible guard against the single highest-impact risk in
// the conversion. It passes trivially today. In Phase 1 it is re-pointed at
// PostgreSQL, where it fails loudly the moment someone picks the wrong type.
//
// PHASE 1: replace `openDatabase()` below with the PostgreSQL driver and keep
// every assertion. Nothing else in this file should need to change.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const REF = path.join(ROOT, 'Talha Farm')

// Phase 0 runs against the frozen reference app's sql.js. Phase 1 replaces this
// with the repository's own `pg` dependency.
const initSqlJs = require(path.join(REF, 'node_modules', 'sql.js'))

const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')

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

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')

// The shape under test must be the shape a fresh install actually ends up with:
// createTables(), then the alterStatements loop, then the one migration that
// changes structure. createTables alone is one REAL column short, and an
// inventory that silently misses a money column is worse than no inventory.
const migrateVaccinations = eval(
  '(' + extractFn(DB_SRC, 'migrateVaccinationsNullableBatchId', 'function ') + ')'
)
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// ── harness ────────────────────────────────────────────────
let passed = 0
const failures = []

function check(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

async function openDatabase() {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(REF, 'node_modules', 'sql.js', 'dist', f),
  })
  const db = new SQL.Database()
  createTables(db)
  // try/catch per statement is how the app itself detects "already applied":
  // a duplicate-column error is the signal, not a failure.
  for (const sql of alterStatements) { try { db.run(sql) } catch { /* already applied */ } }
  try { migrateVaccinations(db) } catch { /* best effort */ }
  return db
}

function rows(db, sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0]
}

// ── A. inventory ───────────────────────────────────────────
// Enumerate every REAL column in the schema. This is the surface Phase 1 must
// keep returning as numbers; a new money table added later shows up here.
function inventory(db) {
  console.log('\n=== A. money-column inventory ===')

  const tables = rows(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).map((r) => r.name)

  const realColumns = []
  for (const t of tables) {
    for (const c of rows(db, `PRAGMA table_info(${t})`)) {
      if (String(c.type).toUpperCase() === 'REAL') realColumns.push(`${t}.${c.name}`)
    }
  }

  check(`schema built — ${tables.length} tables`, tables.length >= 55, `got ${tables.length}`)
  check(
    `REAL columns found — ${realColumns.length} across the schema`,
    realColumns.length >= 50,
    `got ${realColumns.length}`
  )

  // Spot-check that the columns the money flows actually run through are REAL.
  // If one of these is ever changed to INTEGER or TEXT, that is a real defect.
  const mustBeReal = [
    'sales.total_amount',
    'expenses.amount',
    'income.amount',
    'bills.total_amount',
    'bills.amount_paid',
    'bills.subtotal',
    'egg_sales.total_amount',
    'hen_sales.total_amount',
    'bank_ledger.debit',
    'bank_ledger.credit',
    'bank_ledger.balance',
    'bank_accounts.current_balance',
    'loans.principal',
    'loan_payments.amount',
    'purchase_orders.total_amount',
    'sales_orders.total_amount',
    'product_batches.quantity',
  ]
  const missing = mustBeReal.filter((c) => !realColumns.includes(c))
  check('every core money column is REAL', missing.length === 0, missing.join(', '))

  return realColumns
}

// ── B. round-trip ──────────────────────────────────────────
// Insert known values, read them back the way the app does, and assert both the
// TYPE and that arithmetic on them is arithmetic.
function roundTrip(db) {
  console.log('\n=== B. round-trip through the real money paths ===')

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'T','x')`)
  db.run(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date) VALUES (1,1,'F','2026-01-01')`)
  db.run(`INSERT INTO batches (batch_id, farm_id, batch_name, start_date, initial_birds) VALUES (1,1,'B','2026-01-01',100)`)
  db.run(`INSERT INTO bank_accounts (bank_id, farm_id, bank_name, opening_balance, current_balance) VALUES (1,1,'Meezan',1000.5,1000.5)`)

  db.run(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount) VALUES (1,1,'2026-01-02',250.75,1000.5)`)
  db.run(`INSERT INTO expenses (expense_id, flock_id, date, amount) VALUES (1,1,'2026-01-02',300.25)`)
  db.run(`INSERT INTO income (income_id, flock_id, date, amount) VALUES (1,1,'2026-01-02',200.25)`)
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, bill_date, subtotal, total_amount, amount_paid) VALUES (1,1,'B-1','2026-01-02',900.5,1000.5,400.25)`)
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, bill_date, subtotal, total_amount, amount_paid) VALUES (2,1,'B-2','2026-01-03',500,500,700)`)
  db.run(`INSERT INTO egg_sales (egg_sale_id, batch_id, date, quantity, rate_per_egg, total_amount) VALUES (1,1,'2026-01-02',100,12.5,1250)`)
  db.run(`INSERT INTO bank_ledger (ledger_id, bank_id, transaction_date, debit, credit, balance) VALUES (1,1,'2026-01-02',0,1000.5,1000.5)`)
  db.run(`INSERT INTO loans (loan_id, farm_id, direction, party_name, date, principal) VALUES (1,1,'given','A','2026-01-02',5000.5)`)
  db.run(`INSERT INTO loan_payments (payment_id, loan_id, farm_id, date, amount) VALUES (1,1,1,'2026-01-03',1500.25)`)

  // Plain column reads.
  const scalars = [
    ['sales.total_amount', `SELECT total_amount AS v FROM sales WHERE sale_id=1`, 1000.5],
    ['sales.rate', `SELECT rate AS v FROM sales WHERE sale_id=1`, 250.75],
    ['expenses.amount', `SELECT amount AS v FROM expenses WHERE expense_id=1`, 300.25],
    ['income.amount', `SELECT amount AS v FROM income WHERE income_id=1`, 200.25],
    ['bills.amount_paid', `SELECT amount_paid AS v FROM bills WHERE bill_id=1`, 400.25],
    ['egg_sales.rate_per_egg', `SELECT rate_per_egg AS v FROM egg_sales WHERE egg_sale_id=1`, 12.5],
    ['bank_ledger.credit', `SELECT credit AS v FROM bank_ledger WHERE ledger_id=1`, 1000.5],
    ['bank_accounts.current_balance', `SELECT current_balance AS v FROM bank_accounts WHERE bank_id=1`, 1000.5],
    ['loans.principal', `SELECT principal AS v FROM loans WHERE loan_id=1`, 5000.5],
    ['loan_payments.amount', `SELECT amount AS v FROM loan_payments WHERE payment_id=1`, 1500.25],
  ]

  for (const [label, sql, expected] of scalars) {
    const v = one(db, sql).v
    check(`${label} is a number`, isNumber(v), `got ${typeof v} ${JSON.stringify(v)}`)
    check(`${label} round-trips its value`, v === expected, `got ${JSON.stringify(v)}`)
  }

  // Aggregate shapes the app actually uses.
  console.log('\n--- aggregates ---')

  const sum = one(db, `SELECT COALESCE(SUM(amount),0) AS v FROM expenses`).v
  check('COALESCE(SUM(..),0) is a number', isNumber(sum), `got ${typeof sum}`)

  const empty = one(db, `SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE 1=0`).v
  check('COALESCE over no rows is a number', isNumber(empty), `got ${typeof empty}`)
  check('COALESCE over no rows is 0', empty === 0, `got ${JSON.stringify(empty)}`)

  // The app's one definition of a debt. MAX(..,0) is what stops an overpaid
  // bill contributing a negative, so an overpayment must not reduce the total.
  const debt = one(
    db,
    `SELECT COALESCE(SUM(MAX(total_amount - amount_paid, 0)),0) AS v FROM bills WHERE farm_id=1`
  ).v
  check('SUM(MAX(total-paid,0)) is a number', isNumber(debt), `got ${typeof debt}`)
  check('overpaid bill does not reduce the debt', debt === 600.25, `got ${JSON.stringify(debt)}`)

  // ── the actual failure mode ──────────────────────────────
  // This is what `numeric` breaks. If these values arrive as strings, `+` is
  // concatenation and every total in the app is silently wrong.
  console.log('\n--- arithmetic is arithmetic ---')

  const a = one(db, `SELECT total_amount AS v FROM sales WHERE sale_id=1`).v
  const b = one(db, `SELECT amount AS v FROM expenses WHERE expense_id=1`).v

  check('JS addition adds', a + b === 1300.75, `got ${JSON.stringify(a + b)}`)
  check('JS addition is not concatenation', typeof (a + b) === 'number', `got ${typeof (a + b)}`)
  check('JS subtraction subtracts', a - b === 700.25, `got ${JSON.stringify(a - b)}`)

  // reduce() over rows is how most screens total a list.
  const total = rows(db, `SELECT amount FROM expenses`).reduce((s, r) => s + r.amount, 0)
  check('reduce() over rows totals correctly', total === 300.25, `got ${JSON.stringify(total)}`)

  // A whole-number money value must still be a number, not a string or bigint.
  const whole = one(db, `SELECT total_amount AS v FROM bills WHERE bill_id=2`).v
  check('a whole-number amount is still a number', isNumber(whole), `got ${typeof whole}`)
  check('a whole-number amount is not a bigint', typeof whole !== 'bigint', `got ${typeof whole}`)
}

// ── run ────────────────────────────────────────────────────
;(async () => {
  console.log('Money-type check — every money value must reach JS as a number')
  console.log('='.repeat(62))

  const db = await openDatabase()
  const realColumns = inventory(db)
  roundTrip(db)

  console.log('\n' + '='.repeat(62))
  if (failures.length > 0) {
    console.log(`FAILED — ${failures.length} check(s):`)
    for (const f of failures) console.log(`  - ${f}`)
    console.log(
      '\nIf this fails against PostgreSQL, the cause is almost certainly a money\n' +
      'column mapped to `numeric` instead of `double precision`. See\n' +
      'docs/DECISIONS.md D4 — node-postgres returns numeric as a STRING.'
    )
    process.exit(1)
  }

  console.log(`ALL CHECKS PASSED — ${passed} checks over ${realColumns.length} REAL columns`)
})().catch((err) => {
  console.error('\nThrew:', err && err.stack ? err.stack : err)
  process.exit(1)
})
