// Runs the NEW overview asset queries, extracted from the real
// overview.service.ts source, against a database built by the real
// createTables/alterStatements/migrations from electron/database.js.
//
// The thing under test is positional-parameter ordering: qAssetOutstanding
// builds its SQL with a correlated subquery whose `?` appears textually BEFORE
// the outer `a.farm_id = ?`, so the params array has to be pushed in that same
// order. A mismatch there does not fail the build and does not throw — it
// silently returns wrong money.
//
// Both queries return a single `amount` and nothing else. They used to carry a
// `row_count` (qAssetOutstanding) and a `cash_amount` split by payment_source
// (qAssetPayments); neither is read by the dashboard and both have since gone.
// The checks below assert the returned shape so that stays deliberate — a
// missing column reads as `undefined`, which compares equal to nothing and
// would otherwise fail here for a reason nobody could see from the output.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')

// Repo root: these live in scripts/verify/ but read the real source files.
const ROOT = path.join(__dirname, '..', '..')

const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

function extractFn(src, name, kw) {
  const start = src.indexOf(`${kw}${name}(`)
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

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const backfillAssetInstallments = eval('(' + extractFn(DB_SRC, 'backfillAssetInstallments', 'function ') + ')')
const backfillExpenseCategories = eval('(' + extractFn(DB_SRC, 'backfillExpenseCategories', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// Strip TypeScript annotations from the two query builders and run them for real.
function loadQuery(name) {
  let body = extractFn(OV_SRC, name, 'private ')
  body = body
    .replace(/^private\s+/, 'function ')
    .replace(/\(farmId: number, range: OverviewDateRange\)/, '(farmId, range)')
    .replace(/: \[string, any\[\]\]/g, '')
    .replace(/const (params|paidParams|assetParams): any\[\]/g, 'const $1')
  return eval('(' + body + ')')
}
const qAssetPayments = loadQuery('qAssetPayments')
const qAssetOutstanding = loadQuery('qAssetOutstanding')

// The real dateClause, copied verbatim from overview.service.ts.
const ctx = {
  dateClause(column, range, params) {
    let sql = ''
    if (range.from) { sql += ` AND ${column} >= ?`; params.push(range.from) }
    if (range.to) { sql += ` AND ${column} <= ?`; params.push(range.to) }
    return sql
  }
}

function rows(db, sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

initSqlJs().then(SQL => {
  const db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }
  backfillAssetInstallments(db)
  backfillExpenseCategories(db)

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)

  // farm 1: a part-paid tractor, a fully-paid shed, an overpaid oddity, and a
  //         sold-but-still-owing van. The van's rows are written raw here —
  //         selling through sellAsset() would settle it, which is
  //         verify_asset_settlement.js's job, not this file's.
  // farm 2: its own asset, to prove farm scoping.
  db.run(`INSERT INTO assets (asset_id, farm_id, asset_name, purchase_date, total_price, purchase_amount, payment_source, status)
          VALUES (1,1,'Tractor','2025-01-10',1000000,1000000,'cash','active'),
                 (2,1,'Shed','2025-02-01',300000,300000,'bank','active'),
                 (3,1,'Van','2025-03-01',500000,500000,'cash','sold'),
                 (4,2,'Generator','2025-01-20',200000,200000,'cash','active'),
                 (5,1,'Overpaid Rig','2025-05-01',100000,100000,'cash','active')`)
  db.run(`UPDATE assets SET sale_date='2025-06-01', sale_amount=450000 WHERE asset_id=3`)
  db.run(`INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source)
          VALUES (1,1,'2025-01-10',400000,'cash'),
                 (1,1,'2025-04-15',200000,'bank'),
                 (2,1,'2025-02-01',300000,'bank'),
                 (3,1,'2025-03-01',100000,'cash'),
                 (4,2,'2025-01-20',50000,'cash'),
                 (5,1,'2025-05-01',130000,'cash')`)

  let failures = 0
  const check = (label, actual, expected) => {
    const ok = Number(actual) === Number(expected)
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
  }
  /** The columns a query hands the dashboard — asserted, so a drop is deliberate. */
  const checkShape = (label, row, expected) => {
    const got = Object.keys(row).sort().join(',')
    const want = expected.slice().sort().join(',')
    const ok = got === want
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: returns [${got}], expected [${want}]`)
  }

  console.log('=== qAssetOutstanding, farm 1, all time ===')
  // Tractor 1,000,000 - 600,000 = 400,000 | Shed square | Van 500,000 - 100,000 = 400,000
  // | Overpaid Rig excluded, NOT netted off (see the query's doc comment).
  let [sql, params] = qAssetOutstanding.call(ctx, 1, {})
  let r = rows(db, sql, params)[0]
  check('outstanding amount', r.amount, 800000)
  checkShape('qAssetOutstanding shape', r, ['amount'])

  console.log('\n=== an overpaid asset cannot mask another asset\'s debt ===')
  // Netting the Rig's 30,000 credit off would report 770,000 and hide real debt.
  check('overpaid credit is not netted off', r.amount, 800000)
  check('the Rig really is overpaid by 30,000',
    rows(db, `SELECT COALESCE(SUM(p.amount),0) - a.total_price d
              FROM assets a JOIN asset_payments p ON p.asset_id = a.asset_id
              WHERE a.asset_id = 5`)[0].d, 30000)

  console.log('\n=== qAssetOutstanding, farm 2 (scoping) ===')
  ;[sql, params] = qAssetOutstanding.call(ctx, 2, {})
  r = rows(db, sql, params)[0]
  check('farm 2 outstanding', r.amount, 150000)

  console.log('\n=== qAssetOutstanding as at 2025-03-31 (upper bound) ===')
  // Van bought 2025-03-01 and paid 100,000 by then -> owes 400,000.
  // Tractor: only the 400,000 January payment counts by then -> owes 600,000.
  // Shed square. Rig not bought yet. Total 1,000,000.
  ;[sql, params] = qAssetOutstanding.call(ctx, 1, { to: '2025-03-31' })
  r = rows(db, sql, params)[0]
  check('outstanding as at 2025-03-31', r.amount, 1000000)

  console.log('\n=== qAssetPayments, farm 1, all time ===')
  ;[sql, params] = qAssetPayments.call(ctx, 1, {})
  r = rows(db, sql, params)[0]
  check('total paid', r.amount, 1130000)           // 400 + 200 + 300 + 100 + 130 (thousands)
  checkShape('qAssetPayments shape', r, ['amount'])

  console.log('\n=== qAssetPayments, farm 1, Q1 only ===')
  ;[sql, params] = qAssetPayments.call(ctx, 1, { from: '2025-01-01', to: '2025-03-31' })
  r = rows(db, sql, params)[0]
  check('paid in Q1', r.amount, 800000)            // 400,000 + 300,000 + 100,000

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error('HARNESS FAILED:', e); process.exit(1) })
