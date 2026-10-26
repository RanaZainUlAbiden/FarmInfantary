// [Codex] PostgreSQL port of verify_own_farm_customers.js. Original assertion values retained.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
async function runSqlFor(database, sql, params = []) { const r = await database.run(sql, params); if (!r.success) throw new Error(r.error); return r }
import { loadReferenceBackfill } from './lib/reference-asset-backfills.mjs'
const migrateOwnFarmCustomers = loadReferenceBackfill('migrateOwnFarmCustomers')

// Own-farm sales: distribution earns the revenue, the farm carries the debt,
// and Overview still eliminates both sides.
//
// Everything here runs REAL source against a real sql.js database — the schema
// from createTables/alterStatements, the migration from database.js, and the
// consolidation queries lifted out of overview.service.ts. Nothing is a copy.
//
// What is proved:
//   A. migrateOwnFarmCustomers() over three consecutive launches: what it
//      reinterprets, what falls back to the unit_id = NULL customer, that it is
//      one-shot, and that it converges if the flag never gets written.
//   B. THE INVARIANT — Overview's numbers are byte-identical in all three
//      states: the old forced-paid shape, the migrated unsettled shape, and the
//      fully-settled shape. Selling to yourself, and then paying yourself, must
//      move nothing at account level.
//   C. The distribution side DOES move: own-farm sales are revenue there, on the
//      collected basis, so settling lifts it by exactly what was settled.
//   D. The farm side carries the debt, and the two sides agree on the number.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')

// These live in scripts/verify/ but read the real source files at the repo root.
const ROOT = path.join(__dirname, '..', '..')

const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')
const FR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'farm-report.service.ts'), 'utf8')

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
// regexes — several of these signatures carry union and tuple types.
const ts = require('typescript')

// overview.service.ts's bill queries call `distributionBillsOnly()` to keep an
// unpaid LAYER SALE's receivable — a `bills` row tagged with its source — out
// of every distribution figure. The util is transpiled and eval'd whole so the
// lifted queries bind to the real function rather than a restatement; function
// declarations in a direct eval reach module scope the way `var` does.
const BILLSRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bill-source.util.ts'), 'utf8')
const { distributionBillsOnly } = (() => { const exports={}; new Function('exports',ts.transpileModule(BILLSRC,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText)(exports); return exports })()
function loadPrivate(src, name) {
  const body = extractFn(src, name, 'private ').replace(/^private\s+/, 'function ')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// The consolidation queries under test, plus every helper they call, all lifted
// from the real overview.service.ts and bound onto one context object so the
// `this.` calls inside them resolve exactly as they do in the app.
const ctx = {
  dateClause: loadPrivate(OV_SRC, 'dateClause'),
  internalBillIdsSql: loadPrivate(OV_SRC, 'internalBillIdsSql'),
  internalRefIdsSql: loadPrivate(OV_SRC, 'internalRefIdsSql'),
  internalExpenseIdsSql: loadPrivate(OV_SRC, 'internalExpenseIdsSql'),
  productRateCte: loadPrivate(OV_SRC, 'productRateCte'),
  qDistributionBills: loadPrivate(OV_SRC, 'qDistributionBills'),
  qDistributionUnpaid: loadPrivate(OV_SRC, 'qDistributionUnpaid'),
  qInternalBills: loadPrivate(OV_SRC, 'qInternalBills'),
  qDistributionCogs: loadPrivate(OV_SRC, 'qDistributionCogs'),
  qInternalExpenseSide: loadPrivate(OV_SRC, 'qInternalExpenseSide'),
  qTraderEntries: loadPrivate(OV_SRC, 'qTraderEntries'),
  qExpenses: loadPrivate(OV_SRC, 'qExpenses'),
  qDistributionExpenses: loadPrivate(OV_SRC, 'qDistributionExpenses')
}

// The farm-side debt query, lifted from the real farm-report.service.ts. It is
// an async method taking a DatabaseService, so it gets a `db.get` shim and the
// same `num` helper the service uses.
const loadOwedToDistribution = (() => {
  const body = extractFn(FR_SRC, 'loadOwedToDistribution', 'private async ')
    .replace(/^private async\s+/, 'async function ')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
})()

async function rows(db, sql, params = []) { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }

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

/**
 * Everything the Overview dashboard derives from these tables, as one object,
 * so two states can be compared field by field rather than one figure at a time.
 * This is the account-level picture the elimination is supposed to hold still.
 */
async function overviewSnapshot(db, farmId, range = {}) {
  const one = async (spec) => {
    const [sql, params] = spec
    return (await rows(db, sql, params))[0] || {}
  }
  const sumUnits = async (spec) => {
    const [sql, params] = spec
    return (await rows(db, sql, params)).reduce((s, r) => s + Number(r.amount || 0), 0)
  }

  const distributionRevenue = Number((await one(ctx.qDistributionBills.call(ctx, farmId, range))).amount || 0)
  const distributionUnpaid = Number((await one(ctx.qDistributionUnpaid.call(ctx, farmId, range))).amount || 0)
  const cogs = Number((await one(ctx.qDistributionCogs.call(ctx, farmId, range))).amount || 0)
  const distExpenses = Number((await one(ctx.qDistributionExpenses.call(ctx, farmId, range))).amount || 0)

  // The broiler cost side, with the internal-transfer rows eliminated exactly as
  // the dashboard eliminates them.
  const broilerFeed = (await sumUnits(ctx.qTraderEntries.call(ctx, farmId, range, 'broiler', 'feed')))
  const broilerMedicine = (await sumUnits(ctx.qTraderEntries.call(ctx, farmId, range, 'broiler', 'medicine')))
  const broilerGeneral = (await sumUnits(ctx.qExpenses.call(ctx, farmId, range, 'broiler')))

  const revenueTotal = distributionRevenue
  const expenseTotal = cogs + distExpenses + broilerFeed + broilerMedicine + broilerGeneral

  return {
    distributionRevenue,
    distributionUnpaid,
    costOfGoodsSold: cogs,
    distributionExpenses: distExpenses,
    broilerFeed,
    broilerMedicine,
    broilerGeneral,
    revenueTotal,
    expenseTotal,
    profit: revenueTotal - expenseTotal
  }
}

function compareSnapshots(label, before, after) {
  console.log(`\n=== ${label} ===`)
  for (const key of Object.keys(before)) {
    check(key, after[key], before[key])
  }
}

const scratch = await createScratchDb('own_farm_customers')
db = scratch.db
try {

  // A DatabaseService shim for the farm-report query — same { success, data }
  // contract the real one returns.
  const dbShim = {
    async get(sql, params) { return db.get(sql, params) }
  }
  const frCtx = { db: dbShim, num: (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 } }

  // ── Seed ────────────────────────────────────────────────────────────────
  //
  // One account, two farms (units), a flock on each. Distribution supplies feed
  // to farm A's flock twice and to farm B's flock once, and there is one legacy
  // own-farm bill whose internal_transfers rows were lost — the fallback case.
  // One ordinary outside customer bill is here too, so the external side of
  // every figure is non-zero and a regression there cannot hide behind a zero.
  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x')`)
  await runSqlFor(db, `INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name)
          VALUES (1,1,'broiler','North Farm'), (2,1,'broiler','South Farm')`)
  await runSqlFor(db, `INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id)
          VALUES (10,1,'Flock A','2025-01-01',1), (11,1,'Flock B','2025-01-01',2),
                 (12,1,'Orphan Flock','2025-01-01',NULL)`)
  await runSqlFor(db, `INSERT INTO products (product_id, farm_id, product_name, category, cost_price, selling_price)
          VALUES (100,1,'Starter Feed','feed',700,1000)`)
  await runSqlFor(db, `INSERT INTO customers (customer_id, farm_id, customer_name)
          VALUES (500,1,'Outside Buyer')`)

  // Stock: every unit costs 700 to buy and sells for 1000.
  await runSqlFor(db, `INSERT INTO product_batches (batch_id, product_id, farm_id, batch_code, manufacturing_date, expiry_date, quantity, purchase_price)
          VALUES (200,100,1,'B1','2025-01-01','2030-01-01',1000,700)`)

  // Bills. Own-farm ones are written in the OLD shape on purpose: customer_id
  // NULL and amount_paid forced to total_amount, which is exactly what every
  // bill in the client's database looks like today.
  const ownFarmBills = [
    { id: 1, num: 'BILL-001', total: 10000, flock: 10 },  // North Farm
    { id: 2, num: 'BILL-002', total: 4000, flock: 10 },   // North Farm again
    { id: 3, num: 'BILL-003', total: 6000, flock: 11 }    // South Farm
  ]
  for (const b of ownFarmBills) {
    await runSqlFor(db, `INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date, subtotal, total_amount, amount_paid, payment_type)
            VALUES (?,1,?,NULL,'Own Farm','2025-03-10',?,?,?,'internal')`,
      [b.id, b.num, b.total, b.total, b.total])
    await runSqlFor(db, `INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
            VALUES (?,100,'Starter Feed',?,1000,?)`, [b.id, b.total / 1000, b.total])
    await runSqlFor(db, `INSERT INTO batch_transactions (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
            VALUES (200,100,'sale',?, '2025-03-10',?,'Sale order')`, [b.total / 1000, b.id])
    // The farm-side cost row, at the SELLING price, plus the join row.
    await runSqlFor(db, `INSERT INTO feed_traders (trader_id, flock_id, trader_name, module_type)
            VALUES (?,?,'Internal Distribution','broiler')`, [b.id, b.flock])
    await runSqlFor(db, `INSERT INTO feed_entries (entry_id, trader_id, flock_id, date, feed_name, quantity, price_per_unit, total_amount, module_type, bill_id, bill_number)
            VALUES (?,?,?,'2025-03-10','Starter Feed',?,1000,?,'broiler',?,?)`,
      [b.id, b.id, b.flock, b.total / 1000, b.total, b.id, b.num])
    await runSqlFor(db, `INSERT INTO internal_transfers (bill_id, target_module, target_flock_id, target_type, reference_id)
            VALUES (?,'broiler',?,'feed',?)`, [b.id, b.flock, b.id])
  }

  // Bill 4: an own-farm bill whose internal_transfers rows were lost. It still
  // owes money; it just cannot say which farm owes it.
  await runSqlFor(db, `INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date, subtotal, total_amount, amount_paid, payment_type)
          VALUES (4,1,'BILL-004',NULL,'Own Farm','2025-03-11',2000,2000,2000,'internal')`)
  await runSqlFor(db, `INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (4,100,'Starter Feed',2,1000,2000)`)
  await runSqlFor(db, `INSERT INTO batch_transactions (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
          VALUES (200,100,'sale',2,'2025-03-11',4,'Sale order')`)

  // Bill 5: a real outside sale, half collected.
  await runSqlFor(db, `INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date, subtotal, total_amount, amount_paid, payment_type)
          VALUES (5,1,'BILL-005',500,'Outside Buyer','2025-03-12',8000,8000,3000,'cash')`)
  await runSqlFor(db, `INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (5,100,'Starter Feed',8,1000,8000)`)
  await runSqlFor(db, `INSERT INTO batch_transactions (batch_id, product_id, type, quantity, transaction_date, reference_id, notes)
          VALUES (200,100,'sale',8,'2025-03-12',5,'Sale order')`)

  // ── A. Overview BEFORE anything changes (the old forced-paid shape) ──────
  console.log('=== Overview BEFORE the migration (old forced-paid shape) ===')
  const before = (await overviewSnapshot(db, 1))
  for (const [k, v] of Object.entries(before)) console.log(`  ${k}: ${v}`)

  // Sanity: the numbers are what the model says they should be, so the
  // comparison below is anchored to something and not just self-consistent.
  // Own-farm bills are dropped from revenue; only the outside bill's collected
  // 3,000 counts. COGS is every unit that left, at 700: (10+4+6+2+8) = 30 units.
  check('anchor: distribution revenue is the outside collected 3,000', before.distributionRevenue, 3000)
  check('anchor: COGS covers all 30 units at 700', before.costOfGoodsSold, 21000)
  check('anchor: broiler feed cost is fully eliminated', before.broilerFeed, 0)
  check('anchor: profit', before.profit, 3000 - 21000)

  // ── B. The migration, three consecutive launches ─────────────────────────
  console.log('\n=== migrateOwnFarmCustomers(), launch 1 ===')
  await migrateOwnFarmCustomers(db)

  const ownFarmCustomers = (await rows(db, `SELECT * FROM customers WHERE customer_type = 'own_farm' ORDER BY customer_id`))
  check('own-farm customers created', ownFarmCustomers.length, 3)
  checkStr('North Farm customer name', ownFarmCustomers[0].customer_name, 'Own Farm - North Farm')
  checkStr('South Farm customer name', ownFarmCustomers[1].customer_name, 'Own Farm - South Farm')
  checkStr('fallback customer name', ownFarmCustomers[2].customer_name, 'Own Farm (Unassigned)')
  check('fallback customer has no unit', ownFarmCustomers[2].unit_id == null ? 1 : 0, 1)

  check('every own-farm bill now has a customer',
    (await rows(db, `SELECT COUNT(*) c FROM bills WHERE payment_type='internal' AND customer_id IS NULL`))[0].c, 0)
  check('every own-farm bill is now unpaid',
    (await rows(db, `SELECT COUNT(*) c FROM bills WHERE payment_type='internal' AND amount_paid <> 0`))[0].c, 0)
  check('the outside bill was not touched',
    (await rows(db, `SELECT amount_paid p FROM bills WHERE bill_id=5`))[0].p, 3000)
  check('the outside customer stayed external',
    (await rows(db, `SELECT COUNT(*) c FROM customers WHERE customer_id=500 AND customer_type='external'`))[0].c, 1)

  check('ledger debits written', (await rows(db, `SELECT COUNT(*) c FROM customer_ledger`))[0].c, 4)
  check('North Farm owes 14,000',
    (await rows(db, `SELECT outstanding_balance b FROM customers WHERE unit_id=1`))[0].b, 14000)
  check('South Farm owes 6,000',
    (await rows(db, `SELECT outstanding_balance b FROM customers WHERE unit_id=2`))[0].b, 6000)
  check('the fallback customer owes 2,000',
    (await rows(db, `SELECT outstanding_balance b FROM customers WHERE customer_type='own_farm' AND unit_id IS NULL`))[0].b, 2000)

  console.log('\n=== launches 2 and 3 — one-shot, and no drift ===')
  await migrateOwnFarmCustomers(db)
  await migrateOwnFarmCustomers(db)
  check('still 3 own-farm customers',
    (await rows(db, `SELECT COUNT(*) c FROM customers WHERE customer_type='own_farm'`))[0].c, 3)
  check('still 4 ledger rows', (await rows(db, `SELECT COUNT(*) c FROM customer_ledger`))[0].c, 4)
  check('North Farm still owes 14,000',
    (await rows(db, `SELECT outstanding_balance b FROM customers WHERE unit_id=1`))[0].b, 14000)

  console.log('\n=== convergence: the flag never got written (crash before it) ===')
  await runSqlFor(db, `DELETE FROM app_settings WHERE key = 'migration_own_farm_customers_v1'`)
  await migrateOwnFarmCustomers(db)
  check('no duplicate customers on a re-run',
    (await rows(db, `SELECT COUNT(*) c FROM customers WHERE customer_type='own_farm'`))[0].c, 3)
  check('no duplicate ledger rows on a re-run',
    (await rows(db, `SELECT COUNT(*) c FROM customer_ledger`))[0].c, 4)
  check('North Farm still owes 14,000 after a re-run',
    (await rows(db, `SELECT outstanding_balance b FROM customers WHERE unit_id=1`))[0].b, 14000)

  // ── C. THE INVARIANT: Overview does not move ─────────────────────────────
  const afterMigration = (await overviewSnapshot(db, 1))
  compareSnapshots('Overview AFTER the migration — every figure must be unchanged',
    before, afterMigration)

  // Now settle every own-farm bill in full, the way the client would by pressing
  // Paid or taking the payment on the Customer Ledger screen.
  await runSqlFor(db, `UPDATE bills SET amount_paid = total_amount WHERE payment_type = 'internal'`)
  const afterSettlement = (await overviewSnapshot(db, 1))
  compareSnapshots('Overview AFTER the farms settle in full — still unchanged',
    before, afterSettlement)

  // And a partial settlement, which is the state that could most plausibly
  // unbalance an elimination that looked at amount_paid.
  await runSqlFor(db, `UPDATE bills SET amount_paid = 5000 WHERE bill_id = 1`)
  await runSqlFor(db, `UPDATE bills SET amount_paid = 0 WHERE bill_id = 3`)
  const afterPartial = (await overviewSnapshot(db, 1))
  compareSnapshots('Overview with own-farm bills PART settled — still unchanged',
    before, afterPartial)

  console.log('\n=== the elimination still balances at every settlement level ===')
  // The dashboard warns when the two sides of the elimination disagree. Both are
  // accrual, so the gap must be 0 whatever has been paid.
  const internalRev = (await rows(db, ...ctx.qInternalBills.call(ctx, 1, {})))[0]
  const internalExp = (await rows(db, ...ctx.qInternalExpenseSide.call(ctx, 1, {})))[0]
  check('revenue side eliminated', internalRev.amount, 22000)
  check('cost side eliminated', internalExp.amount, 20000)
  // Bill 4 lost its internal_transfers rows AND its feed_entries row in this
  // fixture, so its 2,000 has no cost side to remove — the gap the dashboard's
  // own warning is designed to surface, reproduced here deliberately.
  check('gap is exactly the orphaned bill', internalRev.amount - internalExp.amount, 2000)
  check('unsettled internal debt is reported', internalRev.unsettled, 22000 - 5000 - 4000 - 2000)

  // ── D. The distribution side DOES move, and the farm carries the debt ────
  console.log('\n=== Distribution report: own-farm sales are revenue, collected basis ===')
  // Mirrors distribution-report.component.ts: revenueBills is every bill,
  // totalPaidSales clamps amount_paid into [0, total_amount].
  const distributionCollected = async () =>
    (await rows(db, `SELECT COALESCE(SUM(MIN(MAX(COALESCE(amount_paid,0),0), COALESCE(total_amount,0))),0) v
              FROM bills WHERE farm_id = 1`))[0].v
  const distributionBilled = async () =>
    (await rows(db, `SELECT COALESCE(SUM(COALESCE(total_amount,0)),0) v FROM bills WHERE farm_id = 1`))[0].v

  // State right now: bill 1 = 5,000 of 10,000; bill 2 = 4,000 paid; bill 3 = 0;
  // bill 4 = 2,000 paid; outside bill 5 = 3,000 of 8,000.
  check('billed (accrual)', (await distributionBilled()), 30000)
  check('collected, own-farm part settled', (await distributionCollected()), 5000 + 4000 + 0 + 2000 + 3000)

  await runSqlFor(db, `UPDATE bills SET amount_paid = 0 WHERE payment_type = 'internal'`)
  const collectedUnsettled = (await distributionCollected())
  await runSqlFor(db, `UPDATE bills SET amount_paid = total_amount WHERE payment_type = 'internal'`)
  const collectedSettled = (await distributionCollected())
  check('nothing settled -> only the outside 3,000', collectedUnsettled, 3000)
  check('all settled -> outside 3,000 + own-farm 22,000', collectedSettled, 25000)
  check('settling moves distribution revenue by exactly the own-farm total',
    collectedSettled - collectedUnsettled, 22000)

  console.log('\n=== Farm side: the debt, and both sides agreeing on it ===')
  await runSqlFor(db, `UPDATE bills SET amount_paid = 0 WHERE payment_type = 'internal'`)
  let north = await loadOwedToDistribution.call(frCtx, 1, 1, {}, [])
  let south = await loadOwedToDistribution.call(frCtx, 1, 2, {}, [])
  check('North Farm owes 14,000', north.outstanding, 14000)
  check('North Farm was billed 14,000', north.billed, 14000)
  check('North Farm has 2 unpaid bills', north.unpaidBillCount, 2)
  check('South Farm owes 6,000', south.outstanding, 6000)

  // The farm's view of what it owes and distribution's view of what it is owed
  // are the same number, computed by different code on different screens.
  const distributionOwedByOwnFarms = (await rows(db,
    `SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0)
              - MIN(MAX(COALESCE(amount_paid,0),0), COALESCE(total_amount,0)), 0)),0) v
     FROM bills WHERE farm_id=1 AND payment_type='internal'`))[0].v
  check('farm side and distribution side agree',
    north.outstanding + south.outstanding + 2000, distributionOwedByOwnFarms)

  await runSqlFor(db, `UPDATE bills SET amount_paid = total_amount WHERE bill_id = 1`)
  north = await loadOwedToDistribution.call(frCtx, 1, 1, {}, [])
  check('settling bill 1 leaves North Farm owing 4,000', north.outstanding, 4000)
  check('and one unpaid bill', north.unpaidBillCount, 1)
  check('billed is unchanged by settlement', north.billed, 14000)

  console.log('\n=== the debt is a stock: only range.to applies ===')
  const asAt = await loadOwedToDistribution.call(frCtx, 1, 1, { from: '2025-06-01', to: '2025-03-10' }, [])
  check('as at 2025-03-10, North Farm was billed 14,000', asAt.billed, 14000)

  console.log('\n=== an account with no farm_units has no per-farm debt to show ===')
  const noUnit = await loadOwedToDistribution.call(frCtx, 1, null, {}, [])
  check('outstanding', noUnit.outstanding, 0)
  check('billed', noUnit.billed, 0)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally { await scratch.close() }
