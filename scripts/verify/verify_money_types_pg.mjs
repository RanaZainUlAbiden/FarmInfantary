// Money must reach JavaScript as a NUMBER — proven against real PostgreSQL.
//
// The sql.js sibling (verify_money_types.js) inventories the SOURCE schema.
// This one tests the TARGET: what node-postgres actually hands back.
//
// WHY IT MATTERS (docs/DECISIONS.md D4, risk 1)
// --------------------------------------------
// node-postgres returns `numeric` and `bigint` as JavaScript STRINGS, to avoid
// losing precision it cannot represent. The app does plain `row.amount + x`
// arithmetic in hundreds of places. If money is typed `numeric`, every one of
// those additions silently becomes string concatenation — no error, no failed
// request, just wrong totals in an accounting system.
//
// Section D does not assume that: it queries a `numeric` and a `bigint` in the
// same database and shows what comes back. A guard whose failure mode has never
// been demonstrated is a guard nobody should trust.
//
// Skips (exit 0) when no database is configured, so the suite still runs on a
// machine without PostgreSQL.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

// .env is gitignored and holds local credentials.
const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const url = process.env.DATABASE_URL
if (!url) {
  console.log('SKIP — no DATABASE_URL configured (set it in .env)')
  process.exit(0)
}

let pg
try {
  pg = require(join(ROOT, 'server', 'node_modules', 'pg'))
} catch {
  console.log('SKIP — pg driver not installed (npm --prefix server install)')
  process.exit(0)
}

let passed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

const client = new pg.Client({ connectionString: url })
await client.connect()

try {
  console.log('Money types against real PostgreSQL')
  console.log('='.repeat(62))

  // ── A. the schema really is double precision ─────────────
  console.log('\n=== A. schema types ===')

  const { rows: types } = await client.query(`
    SELECT data_type, count(*)::int AS n
      FROM information_schema.columns
     WHERE table_schema='public'
     GROUP BY data_type ORDER BY n DESC`)
  const byType = Object.fromEntries(types.map((r) => [r.data_type, r.n]))

  check(`money columns are double precision — ${byType['double precision'] ?? 0}`,
    (byType['double precision'] ?? 0) === 86, `got ${byType['double precision'] ?? 0}, expected 86`)
  check('no numeric columns exist anywhere',
    !byType['numeric'], `found ${byType['numeric'] ?? 0} numeric column(s)`)
  check('no foreign key constraints (D6)',
    (await client.query(`SELECT count(*)::int AS n FROM information_schema.table_constraints
                          WHERE table_schema='public' AND constraint_type='FOREIGN KEY'`)).rows[0].n === 0)

  // ── B. round-trip ────────────────────────────────────────
  console.log('\n=== B. round-trip through the real money paths ===')

  await client.query('BEGIN')
  await client.query(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'T','x')`)
  await client.query(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date) VALUES (1,1,'F','2026-01-01')`)
  await client.query(`INSERT INTO batches (batch_id, farm_id, batch_name, start_date, initial_birds) VALUES (1,1,'B','2026-01-01',100)`)
  await client.query(`INSERT INTO bank_accounts (bank_id, farm_id, bank_name, opening_balance, current_balance) VALUES (1,1,'Meezan',1000.5,1000.5)`)
  await client.query(`INSERT INTO sales (sale_id, flock_id, date, rate, total_amount) VALUES (1,1,'2026-01-02',250.75,1000.5)`)
  await client.query(`INSERT INTO expenses (expense_id, flock_id, date, amount) VALUES (1,1,'2026-01-02',300.25)`)
  await client.query(`INSERT INTO bills (bill_id, farm_id, bill_number, bill_date, subtotal, total_amount, amount_paid) VALUES (1,1,'B-1','2026-01-02',900.5,1000.5,400.25)`)
  await client.query(`INSERT INTO bills (bill_id, farm_id, bill_number, bill_date, subtotal, total_amount, amount_paid) VALUES (2,1,'B-2','2026-01-03',500,500,700)`)
  await client.query(`INSERT INTO loans (loan_id, farm_id, direction, party_name, date, principal) VALUES (1,1,'given','A','2026-01-02',5000.5)`)

  const one = async (sql) => (await client.query(sql)).rows[0]

  for (const [label, sql, expected] of [
    ['sales.total_amount', `SELECT total_amount AS v FROM sales WHERE sale_id=1`, 1000.5],
    ['sales.rate', `SELECT rate AS v FROM sales WHERE sale_id=1`, 250.75],
    ['expenses.amount', `SELECT amount AS v FROM expenses WHERE expense_id=1`, 300.25],
    ['bills.amount_paid', `SELECT amount_paid AS v FROM bills WHERE bill_id=1`, 400.25],
    ['bank_accounts.current_balance', `SELECT current_balance AS v FROM bank_accounts WHERE bank_id=1`, 1000.5],
    ['loans.principal', `SELECT principal AS v FROM loans WHERE loan_id=1`, 5000.5],
  ]) {
    const v = (await one(sql)).v
    check(`${label} is a number`, isNumber(v), `got ${typeof v} ${JSON.stringify(v)}`)
    check(`${label} round-trips`, v === expected, `got ${JSON.stringify(v)}`)
  }

  // ── C. aggregates, including the app's debt definition ───
  console.log('\n=== C. aggregates ===')

  // SUM() over double precision returns double precision. Over numeric it
  // would return numeric — i.e. a string. This is where totals break first.
  const sum = (await one(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses`)).v
  check('COALESCE(SUM(..),0) is a number', isNumber(sum), `got ${typeof sum}`)

  const empty = (await one(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE 1=0`)).v
  check('COALESCE over no rows is a number', isNumber(empty), `got ${typeof empty}`)
  check('COALESCE over no rows is 0', empty === 0, `got ${JSON.stringify(empty)}`)

  // The app's ONE definition of a debt. SQLite's MAX(a,b) is GREATEST(a,b) in
  // PostgreSQL — a scalar/aggregate name collision that is easy to miss,
  // because MAX(x) with one argument is valid in both and means something else.
  const debt = (await one(
    `SELECT COALESCE(SUM(GREATEST(total_amount - amount_paid, 0)),0) AS v FROM bills WHERE farm_id=1`
  )).v
  check('SUM(GREATEST(total-paid,0)) is a number', isNumber(debt), `got ${typeof debt}`)
  check('overpaid bill does not reduce the debt', debt === 600.25, `got ${JSON.stringify(debt)}`)

  const a = (await one(`SELECT total_amount AS v FROM sales WHERE sale_id=1`)).v
  const b = (await one(`SELECT amount AS v FROM expenses WHERE expense_id=1`)).v
  check('JS addition adds', a + b === 1300.75, `got ${JSON.stringify(a + b)}`)
  check('JS subtraction subtracts', a - b === 700.25, `got ${JSON.stringify(a - b)}`)

  const total = (await client.query(`SELECT amount FROM expenses`)).rows
    .reduce((s, r) => s + r.amount, 0)
  check('reduce() over rows totals correctly', total === 300.25, `got ${JSON.stringify(total)}`)

  // ── D. the guard has teeth ───────────────────────────────
  // Not an assumption: ask this database for a numeric and a bigint.
  console.log('\n=== D. what numeric/bigint would actually do ===')

  const bad = await one(`SELECT 1000.5::numeric AS num, 300.25::numeric AS num2, 9007199254740993::bigint AS big`)

  check('numeric comes back as a STRING (the whole reason for D4)',
    typeof bad.num === 'string', `got ${typeof bad.num}`)
  check('bigint comes back as a STRING',
    typeof bad.big === 'string', `got ${typeof bad.big}`)
  check('adding two numerics concatenates instead of adding',
    bad.num + bad.num2 === '1000.5300.25', `got ${JSON.stringify(bad.num + bad.num2)}`)

  console.log(`\n  numeric 1000.5 + numeric 300.25  ->  ${JSON.stringify(bad.num + bad.num2)}`)
  console.log(`  double  1000.5 + double  300.25  ->  ${JSON.stringify(a + b)}`)
  console.log('  That is the defect this file exists to prevent.')

  await client.query('ROLLBACK')
} finally {
  await client.end()
}

console.log('\n' + '='.repeat(62))
if (failures.length) {
  console.log(`FAILED — ${failures.length} check(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`ALL CHECKS PASSED — ${passed} checks against PostgreSQL`)
