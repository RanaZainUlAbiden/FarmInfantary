// [Codex] PostgreSQL port of verify_asset_settlement.js.
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
import { backfillAssetInstallments, backfillAssetSaleSettlements } from './lib/reference-asset-backfills.mjs'
const scratchDbs = []
async function createFixture() {
  const scratch = await createScratchDb('asset_settlement')
  scratchDbs.push(scratch)
  return scratch.db
}

// Selling an asset settles whatever is still owed on it.
//
// Three things are checked here, all against REAL source, never a copy:
//   A. sellAsset() from the current database.service.ts, run against PostgreSQL
//      through the actual server batch/back-reference contract — including every
//      edge case (already square, overpaid, never paid at all).
//   B. The Overview's own asset queries from overview.service.ts, run before and
//      after the sale, to prove the cash arithmetic lands on the gain.
//   C. Frozen historical backfill algorithms over three simulated launches,
//      with both current and legacy row values in the final PostgreSQL schema.
//      These test-only fixtures are excluded from production migration under D14.
//
// Uses disposable schemas and does not launch Electron.
const fs = require('fs')
const path = require('path')

// These live in scripts/verify/ but read the real source files at the repo root.
const ROOT = path.join(__dirname, '..', '..')

const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
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



// Strip the TypeScript annotations with the real compiler rather than with
// regexes — the method signatures include multi-line inline object types.
function loadMethod(name, kw = 'async ') {
  const ts = require('typescript')
  // `kw` is whatever precedes the declaration in the real source: 'async ',
  // 'private ', or '\n  ' for a plain public method, which carries no keyword
  // at all. Trimmed first so the indentation that located it does not end up
  // inside the expression.
  let body = extractFn(SVC_SRC, name, kw).trim()
  body = body
    .replace(/^async\s+/, 'async function ')
    .replace(/^private\s+/, 'function ')
  if (!/^(async\s+)?function\s/.test(body)) body = 'function ' + body
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// The overview query builders are private methods returning a [sql, params]
// tuple; the same lightweight strip verify_overview.js uses.
function loadQuery(name) {
  let body = extractFn(OV_SRC, name, 'private ')
  body = body
    .replace(/^private\s+/, 'function ')
    .replace(/\(farmId: number, range: OverviewDateRange\)/, '(farmId, range)')
    .replace(/: \[string, any\[\]\]/g, '')
    .replace(/const (params|paidParams|assetParams): any\[\]/g, 'const $1')
  return eval('(' + body + ')')
}

const methods = {
  getAssets: loadMethod('getAssets'),
  addAsset: loadMethod('addAsset'),
  addAssetPayment: loadMethod('addAssetPayment'),
  getAssetPayments: loadMethod('getAssetPayments'),
  sellAsset: loadMethod('sellAsset'),
  // sellAsset closes its batch with one balance rebuild per account it touched.
  // The fixture here is cash-only, so it is always called with nulls and
  // returns nothing — but it still has to resolve, or the method throws.
  bankRebuildOps: loadMethod('bankRebuildOps', '\n  '),
  rebuildBankBalanceOp: loadMethod('rebuildBankBalanceOp', 'private '),
  bankBalanceSql: loadMethod('bankBalanceSql', 'private ')
}

const queries = {
  qAssetSales: loadQuery('qAssetSales'),
  qAssetPayments: loadQuery('qAssetPayments'),
  qAssetOutstanding: loadQuery('qAssetOutstanding')
}

// The real dateClause, copied verbatim from overview.service.ts.
const ovCtx = {
  dateClause(column, range, params) {
    let sql = ''
    if (range.from) { sql += ` AND ${column} >= ?`; params.push(range.from) }
    if (range.to) { sql += ` AND ${column} <= ?`; params.push(range.to) }
    return sql
  }
}

async function rows(db, sql, params = []) { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkTrue = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? ' — ' + detail : ''}`)
}

// The app's storage interface, backed by the real PostgreSQL query layer.
function makeService(db) {
  const svc = {
    async get(sql, params = []) { return db.get(sql, params) },
    async run(sql, params = []) { return db.run(sql, params) },
    async runBatch(ops) { return db.batch(ops) }
  }
  for (const [name, fn] of Object.entries(methods)) svc[name] = fn.bind(svc)
  return svc
}

// What the Overview dashboard would show for this account over this range.
async function overview(db, farmId, range = {}) {
  const one = async (q) => {
    const [sql, params] = queries[q].call(ovCtx, farmId, range)
    return Number((await rows(db, sql, params))[0].amount) || 0
  }
  const assetSales = (await one('qAssetSales'))
  const assetPayments = (await one('qAssetPayments'))
  const outstanding = (await one('qAssetOutstanding'))
  return { assetSales, assetPayments, outstanding, net: assetSales - assetPayments }
}

function printOverview(label, o) {
  console.log(`  ${label}`)
  console.log(`    money in  (asset sales)      Rs. ${o.assetSales.toLocaleString()}`)
  console.log(`    money out (asset payments)   Rs. ${o.assetPayments.toLocaleString()}`)
  console.log(`    net cash on assets           Rs. ${o.net.toLocaleString()}`)
  console.log(`    outstanding installments     Rs. ${o.outstanding.toLocaleString()}`)
}

// Final PostgreSQL schema, with the original empty-fixture migration flags.
async function freshDb() {
  const db = await createFixture()

  await backfillAssetInstallments(db)
  await backfillAssetSaleSettlements(db)
  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
  return db
}

try {

  // ══════════════════════════════════════════════════════════════════════════
  // A. THE CLIENT'S CASE, end to end
  // ══════════════════════════════════════════════════════════════════════════
  console.log("=== A. the client's case: bought 100,000, paid 10,000, sold 110,000 ===")
  {
    const db = (await freshDb())
    const svc = makeService(db)

    await svc.addAsset({
      farm_id: 1, asset_name: 'Pickup', category: 'Vehicle', purchase_date: '2025-01-05',
      total_price: 100000, payment_source: 'cash', initial_payment: 10000
    })
    const asset = (await svc.getAssets(1)).data[0]
    check('outstanding before the sale', asset.amount_outstanding, 90000)

    console.log('\n  --- Overview BEFORE the sale ---')
    printOverview('as at 2025-12-31:', (await overview(db, 1, { to: '2025-12-31' })))

    const r = await svc.sellAsset(asset.asset_id, '2025-06-20', 110000)
    checkTrue('sale succeeds', r.success, r.error)

    const after = (await svc.getAssets(1)).data[0]
    check('status', after.status, 'sold')
    check('amount paid now covers the whole price', after.amount_paid, 100000)
    check('OUTSTANDING IS ZERO', after.amount_outstanding, 0)
    check('payment count (installment + settlement)', after.payment_count, 2)

    console.log('\n  --- the settlement is VISIBLE in the payment history ---')
    const history = (await svc.getAssetPayments(after.asset_id, 1)).data
    const settlement = history.find(p => Number(p.is_settlement) === 1)
    checkTrue('a settlement row exists in the history', !!settlement, 'no is_settlement row returned')
    check('settlement amount', settlement.amount, 90000)
    check('settlement is dated the SALE date, not today', settlement.date, '2025-06-20')
    check('settlement is labelled', settlement.notes, 'Balance settled automatically on sale of the asset')
    check('the manual installment is NOT flagged',
      history.filter(p => Number(p.is_settlement) === 1).length, 1)

    console.log('\n  --- Overview AFTER the sale ---')
    const post = (await overview(db, 1, { to: '2025-12-31' }))
    printOverview('as at 2025-12-31:', post)
    check('money in', post.assetSales, 110000)
    check('money out', post.assetPayments, 100000)
    check('NET CASH ON THE ASSET = the profit he expects', post.net, 10000)
    check('outstanding on the dashboard', post.outstanding, 0)

    console.log('\n  --- the settlement lands in the SALE period, not the purchase period ---')
    const h1 = (await overview(db, 1, { from: '2025-01-01', to: '2025-03-31' }))
    check('Q1: only the 10,000 installment went out', h1.assetPayments, 10000)
    check('Q1: 90,000 still owed as at 31 Mar', h1.outstanding, 90000)
    const h2 = (await overview(db, 1, { from: '2025-04-01', to: '2025-09-30' }))
    check('Q2-Q3: sale in', h2.assetSales, 110000)
    check('Q2-Q3: settlement out', h2.assetPayments, 90000)
    check('Q2-Q3: nets to the gain', h2.net, 20000)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // B. EDGE CASES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n=== B. edge cases ===')
  {
    const db = (await freshDb())
    const svc = makeService(db)

    // 1. Already fully paid before the sale.
    await svc.addAsset({
      farm_id: 1, asset_name: 'Paid Off Shed', purchase_date: '2025-01-01',
      total_price: 300000, initial_payment: 300000
    })
    // 2. Overpaid — possible since the payment block was relaxed.
    await svc.addAsset({
      farm_id: 1, asset_name: 'Overpaid Van', purchase_date: '2025-01-02',
      total_price: 200000, initial_payment: 200000
    })
    // 3. Never paid a rupee.
    await svc.addAsset({
      farm_id: 1, asset_name: 'Unpaid Land', purchase_date: '2025-01-03', total_price: 500000
    })

    const byName = async (n) => (await svc.getAssets(1)).data.find(a => a.asset_name === n)

    const shed = await byName('Paid Off Shed')
    const van = await byName('Overpaid Van')
    await svc.addAssetPayment({
      asset_id: van.asset_id, farm_id: 1, date: '2025-02-01', amount: 25000, notes: 'Extra charges'
    })
    const land = await byName('Unpaid Land')

    console.log('\n  --- 1. fully paid before sale: no settlement ---')
    let r = await svc.sellAsset(shed.asset_id, '2025-05-01', 320000)
    checkTrue('sale succeeds', r.success, r.error)
    check('no settlement row written',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE asset_id=? AND is_settlement=1`, [shed.asset_id]))[0].c, 0)
    check('payment count unchanged', (await byName('Paid Off Shed')).payment_count, 1)
    check('outstanding still zero', (await byName('Paid Off Shed')).amount_outstanding, 0)

    console.log('\n  --- 2. overpaid: no NEGATIVE settlement ---')
    check('is genuinely overpaid (paid 225,000 of 200,000)', van.amount_paid + 25000, 225000)
    r = await svc.sellAsset(van.asset_id, '2025-05-02', 180000)
    checkTrue('sale succeeds', r.success, r.error)
    check('no settlement row written',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE asset_id=? AND is_settlement=1`, [van.asset_id]))[0].c, 0)
    check('no negative payment anywhere',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE amount < 0`))[0].c, 0)
    check('paid total untouched', (await byName('Overpaid Van')).amount_paid, 225000)

    console.log('\n  --- 3. zero payments recorded: settlement is the FULL price ---')
    check('nothing paid yet', land.amount_paid, 0)
    r = await svc.sellAsset(land.asset_id, '2025-05-03', 560000)
    checkTrue('sale succeeds', r.success, r.error)
    const landAfter = await byName('Unpaid Land')
    check('one settlement row', landAfter.payment_count, 1)
    check('settlement equals the full total price',
      (await rows(db, `SELECT amount a FROM asset_payments WHERE asset_id=? AND is_settlement=1`, [land.asset_id]))[0].a, 500000)
    check('outstanding is zero', landAfter.amount_outstanding, 0)

    console.log('\n  --- selling an already-sold asset is still refused ---')
    r = await svc.sellAsset(land.asset_id, '2025-07-01', 600000)
    checkTrue('refused', !r.success && /already sold/.test(r.error || ''), JSON.stringify(r))
    check('no second settlement',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE asset_id=? AND is_settlement=1`, [land.asset_id]))[0].c, 1)

    console.log('\n  --- account scoping: the settlement carries the asset\'s farm_id ---')
    await svc.addAsset({ farm_id: 2, asset_name: 'Other Farm Rig', purchase_date: '2025-01-01', total_price: 90000 })
    const rig = (await svc.getAssets(2)).data[0]
    await svc.sellAsset(rig.asset_id, '2025-06-01', 95000)
    check('settlement is filed under farm 2',
      (await rows(db, `SELECT farm_id f FROM asset_payments WHERE asset_id=? AND is_settlement=1`, [rig.asset_id]))[0].f, 2)
    check('farm 1 outstanding unaffected by farm 2', (await overview(db, 1, {})).outstanding, 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C. THE MIGRATION, over three consecutive launches
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n=== C. migration for assets already sold before this change ===')

  // C1 — a CURRENT-shaped database: the client's live situation. Assets sold
  // while the sale did not settle, still carrying a balance.
  {
    console.log('\n  --- C1: current-shape database with already-sold assets ---')
    const db = await createFixture()

    await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
    // A real database of this shape has already run the installments migration,
    // so its flag is set and it will not run again. Modelling that matters: with
    // the flag unset, that migration would read a genuinely never-paid asset as
    // a legacy outright purchase and hand it an opening payment for its full
    // price, hiding it from this one. C2 below covers the not-yet-migrated case.
    await runSqlFor(db, `INSERT INTO app_settings (farm_id, key, value) VALUES (0,'migration_asset_installments_v1','1')`)
    await runSqlFor(db, `INSERT INTO assets (asset_id, farm_id, asset_name, purchase_date, total_price, purchase_amount, payment_source, status, sale_date, sale_amount)
            VALUES (1,1,'Pickup','2025-01-05',100000,100000,'cash','sold','2025-06-20',110000),
                   (2,1,'Square Tractor','2025-01-10',400000,400000,'cash','sold','2025-07-01',380000),
                   (3,1,'Overpaid Van','2025-02-01',200000,200000,'cash','sold','2025-08-01',150000),
                   (4,1,'Never Paid Land','2025-03-01',500000,500000,'cash','sold','2025-09-01',560000),
                   (5,1,'Still Owned Shed','2025-04-01',250000,250000,'bank','active',NULL,NULL),
                   (6,2,'Other Farm Rig','2025-01-01',90000,90000,'cash','sold','2025-05-01',95000),
                   (7,1,'Undated Sale','2025-05-01',100000,100000,'cash','sold',NULL,90000)`)
    await runSqlFor(db, `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source)
            VALUES (1,1,'2025-01-05',10000,'cash'),
                   (2,1,'2025-01-10',400000,'cash'),
                   (3,1,'2025-02-01',225000,'cash'),
                   (5,1,'2025-04-01',50000,'bank'),
                   (6,2,'2025-01-01',20000,'cash')`)

    console.log('\n    stale figures BEFORE the migration:')
    printOverview('farm 1, all time:', (await overview(db, 1, {})))

    const eligible = (await rows(db, `
      SELECT COUNT(*) c,
             COALESCE(SUM(COALESCE(a.total_price, a.purchase_amount, 0)
                          - COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                                      WHERE p.asset_id = a.asset_id), 0)), 0) s
      FROM assets a
      WHERE a.status = 'sold'
        AND COALESCE(a.total_price, a.purchase_amount, 0)
            - COALESCE((SELECT SUM(p.amount) FROM asset_payments p
                        WHERE p.asset_id = a.asset_id), 0) > 0`))[0]
    console.log(`    rows the migration will create: ${eligible.c}, clearing Rs. ${Number(eligible.s).toLocaleString()}`)

    for (const launch of [1, 2, 3]) {
      await backfillAssetInstallments(db)
      await backfillAssetSaleSettlements(db)
      const created = (await rows(db, `SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM asset_payments WHERE is_settlement=1`))[0]
      const dupes = (await rows(db, `SELECT asset_id FROM asset_payments WHERE is_settlement=1 GROUP BY asset_id HAVING COUNT(*) > 1`))
      console.log(`    launch ${launch}: settlement rows=${created.c} total=Rs. ${Number(created.s).toLocaleString()} duplicates=${dupes.length}`)
      check(`launch ${launch}: settlement row count`, created.c, 4)
      check(`launch ${launch}: settlement total`, created.s, 90000 + 500000 + 70000 + 100000)
      check(`launch ${launch}: no duplicates`, dupes.length, 0)
    }

    console.log('\n    which assets were touched:')
    for (const r of (await rows(db, `SELECT a.asset_name, a.status,
                                     COALESCE((SELECT SUM(p.amount) FROM asset_payments p WHERE p.asset_id=a.asset_id AND p.is_settlement=1),0) settled
                              FROM assets a ORDER BY a.asset_id`))) {
      console.log(`      ${r.asset_name.padEnd(20)} ${String(r.status).padEnd(7)} settled Rs. ${Number(r.settled).toLocaleString()}`)
    }
    check('square asset left alone',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE asset_id=2 AND is_settlement=1`))[0].c, 0)
    check('overpaid asset left alone',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE asset_id=3 AND is_settlement=1`))[0].c, 0)
    check('asset still owned left alone',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE asset_id=5 AND is_settlement=1`))[0].c, 0)
    check('never-paid asset settled at its full price',
      (await rows(db, `SELECT amount a FROM asset_payments WHERE asset_id=4 AND is_settlement=1`))[0].a, 500000)
    check('settlement dated the recorded sale date',
      (await rows(db, `SELECT date d FROM asset_payments WHERE asset_id=1 AND is_settlement=1`))[0].d, '2025-06-20')
    check('other account migrated under its own farm_id',
      (await rows(db, `SELECT farm_id f FROM asset_payments WHERE asset_id=6 AND is_settlement=1`))[0].f, 2)
    // asset_payments.date is NOT NULL, so a sold row that somehow lost its
    // sale_date falls back to the purchase date rather than being skipped.
    check('sold asset with no sale_date falls back to the purchase date',
      (await rows(db, `SELECT date d FROM asset_payments WHERE asset_id=7 AND is_settlement=1`))[0].d, '2025-05-01')

    console.log('\n    figures AFTER the migration:')
    const post = (await overview(db, 1, {}))
    printOverview('farm 1, all time:', post)
    check('farm 1 outstanding is now only the shed still owned', post.outstanding, 200000)
    check('farm 2 outstanding cleared', (await overview(db, 2, {})).outstanding, 0)
  }

  // C2 — legacy row values in the final PostgreSQL schema. The ordering matters: the
  // installments backfill gives each legacy asset an opening payment for its
  // whole purchase_amount, so its sold assets are already square and must get NO
  // settlement. Running the settlements first would charge each of them twice.
  {
    console.log('\n  --- C2: legacy-shape database (pre-installments) ---')
    const db = await createFixture()
    await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x')`)
    await runSqlFor(db, `INSERT INTO assets (farm_id, asset_name, purchase_date, purchase_amount, status, sale_date, sale_amount)
            VALUES (1,'Old Van','2023-01-05',300000,'sold','2025-01-01',280000),
                   (1,'Gifted Land','2024-02-02',0,'sold','2025-02-02',50000),
                   (1,'Tractor','2024-03-10',500000,'active',NULL,NULL)`)

    for (const launch of [1, 2, 3]) {

      await backfillAssetInstallments(db)
      await backfillAssetSaleSettlements(db)
      const s = (await rows(db, `SELECT COUNT(*) c FROM asset_payments WHERE is_settlement=1`))[0]
      const p = (await rows(db, `SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM asset_payments`))[0]
      console.log(`    launch ${launch}: payments=${p.c} total=Rs. ${Number(p.t).toLocaleString()} settlements=${s.c}`)
      check(`launch ${launch}: legacy sold assets are already square, no settlement`, s.c, 0)
      check(`launch ${launch}: payments not duplicated`, p.c, 2)
    }
    // Zero-price gift: no opening payment (no money moved) and nothing owed, so
    // nothing to settle either.
    check('zero-price asset gets no settlement',
      (await rows(db, `SELECT COUNT(*) c FROM asset_payments p JOIN assets a ON a.asset_id=p.asset_id
                WHERE a.asset_name='Gifted Land'`))[0].c, 0)
    check('legacy outstanding stays zero', (await overview(db, 1, {})).outstanding, 0)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  for (const scratch of scratchDbs.reverse()) await scratch.close()
}
