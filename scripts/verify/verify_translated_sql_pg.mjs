// Real SQL from the app, translated, executed against PostgreSQL.
//
// WHY THIS EXISTS
// ---------------
// The dialect unit tests check the translator against statements someone wrote
// to test it. This runs statements lifted VERBATIM from the app against a real
// server, and it immediately found a defect the unit tests could not:
//
//   SELECT ... WHERE pb.expiry_date >= date('now')
//   -> ... WHERE pb.expiry_date >= CURRENT_DATE
//   ERROR: operator does not exist: text >= date
//
// Dates are stored as TEXT (D5). SQLite compared text to a date happily;
// PostgreSQL has no such operator. The translation was locally correct and
// globally wrong, which is the only kind of bug that survives unit tests.
//
// Every query below is a real one. Add to it whenever a screen's SQL is
// translated for the first time — a query that has never been executed against
// PostgreSQL is a query nobody has verified.
//
// Skips (exit 0) when no database is configured.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const url = process.env.DATABASE_URL
if (!url) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }

let pg, dialect, placeholders
try {
  pg = require(join(ROOT, 'server', 'node_modules', 'pg'))
  dialect = await import(new URL('../../server/src/db/dialect.js', import.meta.url))
  placeholders = await import(new URL('../../server/src/db/placeholders.js', import.meta.url))
} catch (err) {
  console.log(`SKIP — server deps not available (${err.message})`)
  process.exit(0)
}

/**
 * Real statements from the app. `params` are supplied where the original uses
 * `?`, so the placeholder rewrite is exercised too.
 */
const QUERIES = [
  ['overview.service · own-farm debt clamp',
    `SELECT COALESCE(SUM(MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))),0) AS v
       FROM bills bl WHERE bl.farm_id = ?`, [1]],

  ['customer-ledger · outstanding (the debt definition)',
    `SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) AS v
       FROM bills WHERE farm_id = ?`, [1]],

  ['database.service · months until expiry',
    `SELECT CAST((julianday(b.expiry_date) - julianday('now')) / 30.44 AS INTEGER) AS months
       FROM product_batches b WHERE b.farm_id = ?`, [1]],

  ['database.service · expiring soon',
    `SELECT b.batch_id, julianday(b.expiry_date) - julianday('now') AS days_until_expiry
       FROM product_batches b
      WHERE b.farm_id = ?
        AND julianday(b.expiry_date) - julianday('now') <= (? * 30.44)
        AND julianday(b.expiry_date) - julianday('now') > 0`, [1, 3]],

  ['distribution-report · active batches (text vs date)',
    `SELECT COUNT(*) AS v FROM product_batches pb
      WHERE pb.farm_id = ? AND pb.quantity > 0 AND pb.expiry_date >= date('now')`, [1]],

  ['database.service · expired batches',
    `SELECT COUNT(*) AS v FROM product_batches
      WHERE expiry_date < date('now') AND (status IN ('active','expiring') OR status IS NULL OR status = '')`, []],

  ['internal-settlement · flock names',
    `SELECT GROUP_CONCAT(f.flock_name, ', ') AS v FROM flocks f WHERE f.farm_id = ?`, [1]],

  ['expense-ledger · category upsert',
    `INSERT OR IGNORE INTO categories (farm_id, category_name, category_type) VALUES (?, ?, ?)`,
    [1, 'Feed', 'expense']],

  ['distribution-report · app_settings upsert',
    `INSERT INTO app_settings (farm_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`, [1, 'k', 'v']],

  ['broiler module scoping (COALESCE, never a strict =)',
    `SELECT COALESCE(SUM(e.amount),0) AS v FROM expenses e
       JOIN flocks f ON f.flock_id = e.flock_id
      WHERE f.farm_id = ? AND COALESCE(e.module_type,'broiler') = 'broiler'`, [1]],

  ['layer module scoping (flock_id column holds a batch_id)',
    `SELECT COALESCE(SUM(e.amount),0) AS v FROM expenses e
       JOIN batches b ON b.batch_id = e.flock_id
      WHERE b.farm_id = ? AND e.module_type = 'layer'`, [1]],

  ['correlated subquery · placeholder ordering',
    `SELECT (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE flock_id = ?) AS inner_v,
            f.flock_name
       FROM flocks f WHERE f.farm_id = ?`, [1, 1]],
]

let passed = 0
const failures = []

const client = new pg.Client({ connectionString: url })
await client.connect()

console.log('Real app SQL, translated, against PostgreSQL')
console.log('='.repeat(66))

try {
  // Everything runs inside one transaction that is rolled back, so the writes
  // below leave nothing behind.
  await client.query('BEGIN')
  await client.query("SELECT set_config('app.farm_id','1',true)")

  for (const [name, sql, params] of QUERIES) {
    const t = dialect.translate(sql)
    if (t.unhandled.length) {
      console.log(`  FAIL  ${name}\n        untranslated: ${t.unhandled.join('; ')}`)
      failures.push(name)
      continue
    }
    try {
      const { text, values } = placeholders.prepare(t.text, params)
      await client.query(text, values)
      console.log(`  PASS  ${name}${t.applied.length ? `  [${t.applied.join(', ')}]` : ''}`)
      passed++
    } catch (err) {
      console.log(`  FAIL  ${name}\n        ${err.message}\n        ${t.text.replace(/\s+/g, ' ').slice(0, 140)}`)
      failures.push(name)
    }
  }

  // Unlike PREPARE, these assert results. The money ports found that negative
  // SQLite substr starts silently add a zero to generated transaction numbers.
  for (const width of [3, 4]) {
    for (const n of [1, 9, 10, 999, 1000, 9999, 10000]) {
      const name = `number padding width ${width}, value ${n}`
      const sql = `SELECT CASE WHEN length(CAST(n AS TEXT)) >= ${width}
                         THEN CAST(n AS TEXT)
                         ELSE substr('${'0'.repeat(width)}' || CAST(n AS TEXT), -${width}) END AS v
                   FROM (SELECT CAST(? AS INTEGER) AS n) AS source`
      const t = dialect.translate(sql)
      const { text, values } = placeholders.prepare(t.text, [n])
      const actual = (await client.query(text, values)).rows[0].v
      const expected = String(n).padStart(width, '0')
      if (!t.unhandled.length && actual === expected) {
        console.log(`  PASS  ${name}: ${actual}`)
        passed++
      } else {
        console.log(`  FAIL  ${name}: got ${actual}, expected ${expected}`)
        failures.push(name)
      }
    }
  }

  for (const [value, expected] of [
    ['HAND', 0], ['', 0], ['12tail', 12], [' \t-12.9', -12], ['+003', 3],
    ['1e3', 1], ['- 4', 0], [null, null], ['\n42suffix', 42], ['0x10', 0],
  ]) {
    const sql = 'SELECT CAST(substr(?, 1) AS INTEGER) AS v'
    const t = dialect.translate(sql)
    const { text, values } = placeholders.prepare(t.text, [value])
    const raw = (await client.query(text, values)).rows[0].v
    const actual = raw === null ? null : Number(raw)
    const name = `text integer prefix ${JSON.stringify(value)}`
    if (!t.unhandled.length && actual === expected) {
      console.log(`  PASS  ${name}: ${actual}`)
      passed++
    } else {
      console.log(`  FAIL  ${name}: got ${actual}, expected ${expected}`)
      failures.push(name)
    }
  }

  await client.query('ROLLBACK')
} finally {
  await client.end()
}

console.log('\n' + '='.repeat(66))
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${QUERIES.length} real queries:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`ALL CHECKS PASSED — ${passed} real queries and numbering checks executed`)
