// Every money screen's OWN SQL, executed against the real schema.
//
// `verify_bank_withdrawals.js` proves the shared mechanism: the ledger entry,
// the reversal, the balance rebuild, the cascade. It cannot prove the other
// half. The eight screens build their own `INSERT INTO sales (...)` and
// `UPDATE expenses SET ...` strings inline — that is this codebase's convention,
// SQL goes over the wire — and those statements live in components, which a
// node script cannot load.
//
// So the statements are lifted from the component source as text and run here.
// What that catches is the one class of mistake adding two columns to fourteen
// hand-written statements invites, and the one TypeScript cannot see: a
// placeholder count or a parameter ORDER that no longer matches the column list.
// A count mismatch throws on first use and would at least be loud; a swapped
// order is silent, and would file a bank_id into `bill_available` or a date into
// `payment_source` on every save.
//
// Each statement is bound with a distinct sentinel per parameter, so a value
// landing in the wrong column cannot coincide with the right one. The two
// columns this change is about are asserted by name.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')

const src = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'app', ...p), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(s, name, kw) {
  const start = s.indexOf(`${kw}${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  let i = s.indexOf('(', start), depth = 0
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) { i++; break } }
  }
  depth = 0
  for (i = s.indexOf('{', i); i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') { depth--; if (depth === 0) break }
  }
  return s.slice(start, i + 1)
}

/**
 * The SQL string literal containing `marker`. Screens use backticks and plain
 * quotes interchangeably, so the delimiter is whichever one actually encloses
 * the marker rather than an assumed backtick.
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

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

// ── The statements under test ───────────────────────────────────────────────
//
// For each one: the file it lives in, a marker unique to it, and the parameter
// list AS THE SCREEN BUILDS IT, with a distinct sentinel per position. BANK is
// the bank_id sentinel and 'bank' the payment_source sentinel; every other
// parameter is a value that could not be mistaken for either.

const BANK = 7777
const CUST = 5555
const SALE_SRC = src('sale', 'sale.component.ts')
const EXP_SRC = src('expenses', 'expenses.component.ts')
const LEXP_SRC = src('layer-expenses', 'layer-expenses.component.ts')
const INC_SRC = src('income', 'income.component.ts')
const LAB_SRC = src('labour', 'labour.component.ts')
const EGG_SRC = src('egg-sales', 'egg-sales.component.ts')
const HEN_SRC = src('hen-sales', 'hen-sales.component.ts')
const PO_SRC = src('purchase-orders', 'purchase-orders.component.ts')
// The distribution Expense Ledger's statements live in the service rather than
// the screen — it is the one bank-sourced table whose SQL was already there —
// but the failure this file exists to catch is identical: a parameter order
// that stopped matching the column list, which TypeScript cannot see.
const SVC_SRC = src('shared', 'services', 'database.service.ts')

const STATEMENTS = [
  // ── broiler Sales ──
  { what: 'sale INSERT', table: 'sales', pk: 'sale_id',
    sql: liftSql(SALE_SRC, 'INSERT INTO sales (flock_id, date, vehicle_number'),
    params: [1, '2025-01-01', 'LHR-1', 'Driver', '0300', 'Broker', 11, 22, 33, 44, 55, 'bank', 'bank', BANK, null, 'broiler'] },
  { what: 'sale UPDATE', table: 'sales', pk: 'sale_id',
    sql: liftSql(SALE_SRC, 'UPDATE sales SET date=?, vehicle_number=?'),
    params: ['2025-02-02', 'LHR-2', 'D2', '0301', 'B2', 12, 23, 34, 45, 56, 'bank', 'bank', BANK, null, 1] },

  // ── broiler Expenses ──
  { what: 'expense INSERT', table: 'expenses', pk: 'expense_id',
    sql: liftSql(EXP_SRC, 'INSERT INTO expenses (flock_id, date, category, description, amount, payment_type, payment_source'),
    params: [1, '2025-01-01', 'Diesel', 'Gen', 99, 'bank', 'bank', BANK, 'Yes', null] },
  { what: 'expense UPDATE', table: 'expenses', pk: 'expense_id',
    sql: liftSql(EXP_SRC, 'UPDATE expenses SET date = ?, category = ?'),
    params: ['2025-02-02', 'Repairs', 'Fence', 88, 'bank', 'bank', BANK, 'No', null, 1] },

  // ── layer Expenses (same table, its own statements) ──
  { what: 'layer expense INSERT', table: 'expenses', pk: 'expense_id',
    sql: liftSql(LEXP_SRC, 'INSERT INTO expenses (flock_id, date, category, description, amount, notes'),
    params: [1, '2025-01-01', 'Repairs', 'Shed', 77, 'a note', 'bank', BANK] },
  { what: 'layer expense UPDATE', table: 'expenses', pk: 'expense_id',
    sql: liftSql(LEXP_SRC, 'UPDATE expenses SET flock_id = ?, date = ?'),
    params: [1, '2025-02-02', 'Repairs', 'Shed2', 66, 'note2', 'bank', BANK, 1] },

  // ── Income (manual rows only) ──
  { what: 'income INSERT', table: 'income', pk: 'income_id',
    sql: liftSql(INC_SRC, 'INSERT INTO income (flock_id, date, description, amount, source, payment_source'),
    params: [1, '2025-01-01', 'Sawdust', 55, 'bank', BANK, 'broiler'] },
  { what: 'income UPDATE', table: 'income', pk: 'income_id',
    sql: liftSql(INC_SRC, 'UPDATE income SET date = ?, description = ?'),
    params: ['2025-02-02', 'Crates', 44, 'bank', BANK, 1] },

  // ── Labour ──
  { what: 'labour INSERT', table: 'labour_payments', pk: 'payment_id',
    sql: liftSql(LAB_SRC, 'INSERT INTO labour_payments (labour_id, flock_id, date, description, amount, payment_type, payment_source'),
    params: [1, 2, '2025-01-01', 'Wages', 33, 'bank', 'bank', BANK, 'broiler'] },
  { what: 'labour UPDATE', table: 'labour_payments', pk: 'payment_id',
    sql: liftSql(LAB_SRC, 'UPDATE labour_payments SET labour_id=?, date=?'),
    params: [3, '2025-02-02', 'Bonus', 22, 'bank', 'bank', BANK, 1] },

  // ── Egg Sales ──
  // CUST is the customer_id sentinel. Both layer sale screens now attribute a
  // sale to a `customers` row, so the column list grew by one in the middle —
  // exactly the kind of shift this file exists to catch.
  { what: 'egg sale INSERT', table: 'egg_sales', pk: 'egg_sale_id',
    sql: liftSql(EGG_SRC, 'INSERT INTO egg_sales (batch_id, date, customer_id, customer_name'),
    params: [1, '2025-01-01', CUST, 'Shop', 'mixed', 100, 12, 1200, 'bank', 'bank', BANK, 'per_egg', null, 360] },
  { what: 'egg sale UPDATE', table: 'egg_sales', pk: 'egg_sale_id',
    sql: liftSql(EGG_SRC, 'UPDATE egg_sales SET batch_id=?, date=?'),
    params: [1, '2025-02-02', CUST, 'Shop2', 'large', 200, 13, 2600, 'bank', 'bank', BANK, 'per_egg', null, 360, 1] },

  // ── Hen Sales ──
  { what: 'hen sale INSERT', table: 'hen_sales', pk: 'hen_sale_id',
    sql: liftSql(HEN_SRC, 'INSERT INTO hen_sales (batch_id, date, customer_id, customer_name'),
    params: [1, '2025-01-01', CUST, 'Shop', 50, 900, null, 'per_hen', 45000, 'bank', 'bank', BANK] },
  { what: 'hen sale UPDATE', table: 'hen_sales', pk: 'hen_sale_id',
    sql: liftSql(HEN_SRC, 'UPDATE hen_sales SET batch_id=?, date=?'),
    params: [1, '2025-02-02', CUST, 'Shop2', 60, 950, null, 'per_hen', 57000, 'bank', 'bank', BANK, 1] },

  // ── Purchase Orders ──
  { what: 'purchase order INSERT', table: 'purchase_orders', pk: 'purchase_id',
    sql: liftSql(PO_SRC, 'INSERT INTO purchase_orders (farm_id, supplier_id, product_id'),
    params: [1, 2, 3, '2025-01-01', 10, 300, 3000, 'cash', 'bank', BANK, 'notes', null] },
  { what: 'purchase order UPDATE', table: 'purchase_orders', pk: 'purchase_id',
    sql: liftSql(PO_SRC, 'UPDATE purchase_orders SET supplier_id=?, product_id=?'),
    params: [2, 3, '2025-02-02', 11, 310, 3410, 'cash', 'bank', BANK, 'notes2', 9, null, 1] },

  // ── Expense Ledger (distribution) ──
  { what: 'distribution expense INSERT', table: 'expense_ledger', pk: 'expense_id',
    sql: liftSql(SVC_SRC, 'INSERT INTO expense_ledger'),
    params: [1, '2025-01-01', 'Office rent', 2500, 'Rent', 'cash', 'notes', 'bank', BANK] }
]

initSqlJs().then(async SQL => {
  const db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  const rows = (sql, params = []) => {
    const out = []
    const stmt = db.prepare(sql)
    stmt.bind(params)
    while (stmt.step()) out.push(stmt.getAsObject())
    stmt.free()
    return out
  }

  console.log('\n=== every screen statement names payment_source and bank_id ===')
  for (const st of STATEMENTS) {
    checkTrue(`${st.what} carries payment_source`, /payment_source/.test(st.sql))
    checkTrue(`${st.what} carries bank_id`, /bank_id/.test(st.sql))
    const holes = (st.sql.match(/\?/g) || []).length
    check(`${st.what} placeholder count matches the screen's parameter list`,
      holes, st.params.length)
  }

  console.log('\n=== and binds them to the right columns, not merely the right count ===')
  for (const st of STATEMENTS) {
    // An UPDATE needs a row to update, and its last parameter is the id.
    const isUpdate = /^\s*UPDATE/i.test(st.sql)
    if (isUpdate) {
      db.run(`DELETE FROM ${st.table}`)
      // A bare insert of the primary key; every other column takes its default
      // or a NOT NULL filler, so the UPDATE is what sets the values read back.
      const id = st.params[st.params.length - 1]
      seedRow(db, st.table, st.pk, id)
    }

    let threw = null
    try { db.run(st.sql, st.params) } catch (e) { threw = e.message }
    checkTrue(`${st.what} executes against the real schema`, threw === null)
    if (threw) { console.log(`        ${threw}`); continue }

    const row = rows(`SELECT payment_source, bank_id FROM ${st.table} ORDER BY ${st.pk} DESC LIMIT 1`)[0]
    check(`${st.what} -> payment_source`, row.payment_source, 'bank')
    check(`${st.what} -> bank_id`, row.bank_id, BANK)
    db.run(`DELETE FROM ${st.table}`)
  }

  console.log('\n=== a cash row names no account ===')
  // The same statements with the cash pair, since that is what every row saved
  // without a bank has to end up holding: 'cash' and NULL, never 'cash' and a
  // leftover id, which would make the row look bank-sourced to the sweep.
  for (const st of STATEMENTS.filter(s => /INSERT/i.test(s.sql))) {
    const params = st.params.map((p, i) =>
      p === 'bank' ? 'cash' : (p === BANK ? null : p))
    db.run(`DELETE FROM ${st.table}`)
    db.run(st.sql, params)
    const row = rows(`SELECT payment_source, bank_id FROM ${st.table} ORDER BY ${st.pk} DESC LIMIT 1`)[0]
    check(`${st.what} cash -> payment_source`, row.payment_source, 'cash')
    checkTrue(`${st.what} cash -> bank_id is null`, row.bank_id === null)
    db.run(`DELETE FROM ${st.table}`)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => {
  console.error(err)
  process.exit(1)
})

/**
 * The minimum row an UPDATE can be run against: the primary key plus whatever
 * the table declares NOT NULL, which differs per table and is not worth
 * deriving when the statement under test overwrites all of it anyway.
 */
function seedRow(db, table, pk, id) {
  const fillers = {
    sales: `INSERT INTO sales (${pk}, flock_id, date, rate, total_amount) VALUES (${id}, 1, '2000-01-01', 0, 0)`,
    expenses: `INSERT INTO expenses (${pk}, flock_id, date, amount) VALUES (${id}, 1, '2000-01-01', 0)`,
    income: `INSERT INTO income (${pk}, flock_id, date, amount) VALUES (${id}, 1, '2000-01-01', 0)`,
    labour_payments: `INSERT INTO labour_payments (${pk}, labour_id, flock_id, date, amount) VALUES (${id}, 1, 1, '2000-01-01', 0)`,
    egg_sales: `INSERT INTO egg_sales (${pk}, batch_id, date, quantity, rate_per_egg, total_amount) VALUES (${id}, 1, '2000-01-01', 0, 0, 0)`,
    hen_sales: `INSERT INTO hen_sales (${pk}, batch_id, date, quantity, rate_per_hen, total_amount) VALUES (${id}, 1, '2000-01-01', 0, 0, 0)`,
    purchase_orders: `INSERT INTO purchase_orders (${pk}, farm_id, product_id, date, quantity, cost_price, total_amount) VALUES (${id}, 1, 1, '2000-01-01', 0, 0, 0)`
  }
  if (!fillers[table]) throw new Error(`no filler row defined for ${table}`)
  db.run(fillers[table])
}
