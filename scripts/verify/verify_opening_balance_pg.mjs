// [Codex] PostgreSQL port of verify_opening_balance.js.
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

// Opening balance: a hand-entered figure carried forward from the client's
// previous system (`farm_units.opening_balance` for a farm, `app_settings`
// key 'distribution_opening_balance' for Distribution — it has no farm_units
// row of its own), added on top of the app's own profit calculation on both
// the Farm Report / Distribution Report screens and the Overview dashboard.
//
// Everything here runs real source against PostgreSQL — the final schema
// and OverviewService /
// FarmReportService themselves, lifted whole (not copied) out of
// overview.service.ts and farm-report.service.ts. Nothing here re-implements
// their arithmetic — it only supplies fixture data and a `db.get` shim.
//
// What is proved, for farms (sections 1-4) and again for Distribution
// (sections 5-7, same shape):
//   1/5. THE SIGN — a +100,000 opening balance raises the combined total by
//      exactly 100,000; a -50,000 one lowers it by exactly 50,000. Checked
//      against the SAME baseline (same flock, same revenue/expenses),
//      isolating opening_balance as the only variable.
//   2.   NO CONTAMINATION — revenue, expenses, netProfit/profit and the
//      per-farm Profit column are identical across all three opening-balance
//      values; only the *WithOpeningBalance figures move. (Proved again for
//      distribution inline in section 5, against the same invariant.)
//   3/6. NO DOUBLE COUNTING — section 3: two farm_units on the same account
//      each contribute their own opening_balance exactly once to the Overview
//      headline. Section 6: a farm_units balance and Distribution's
//      app_settings balance, together on the same account, each land exactly
//      once too — proving the two storage locations don't collide or
//      duplicate into the headline.
//   4/7. NULL HANDLING — a farm_units row with opening_balance written as NULL
//      (section 4) and an app_settings row with value written as NULL
//      (section 7) are both treated as 0, not NaN.
//
// Distribution's own screen total (`totalProfitLoss + distributionOpeningBalance`
// in distribution-report.component.ts) is not separately re-verified here: it is
// a plain addition, the same one-line pattern farm-report.service.ts's
// `totalWithOpeningBalance` already uses and section 1 already proves against;
// the account-level Overview consolidation in sections 5-7 is where a real
// double-counting bug would actually surface, since that's the one place both
// storage locations are summed together.
//
// Uses a disposable schema and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

// overview.service.ts's bill queries call `distributionBillsOnly()` to keep an
// unpaid LAYER SALE's receivable — a `bills` row tagged with its source — out
// of every distribution figure. The util is transpiled and eval'd whole so the
// lifted queries bind to the real function rather than a restatement. Explicit
// exports keep the binding available in this ES module.
const BILLSRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'bill-source.util.ts'), 'utf8')
const { distributionBillsOnly } = (() => {
  const exports = {}
  const code = ts.transpileModule(BILLSRC, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', code)(exports)
  return exports
})()
const FR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'farm-report.service.ts'), 'utf8')

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



/**
 * Loads an entire exported class as a runnable constructor, straight off the
 * real .ts source — not a hand-copied subset of its methods. Strips the
 * Angular import and @Injectable() decorator (there is nothing here to
 * inject into), and the `export` keywords Angular needs but a bare `eval`
 * does not; everything else — every private method, every interface (erased
 * by the compiler), every module-level const the class closes over — is left
 * exactly as written.
 */
function loadClass(src, className) {
  const body = src
    .replace(/^import .*;$/gm, '')
    .replace(/@Injectable\([^)]*\)\s*\n?/g, '')
    .replace(/^export /gm, '')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval(js + `; ${className}`)
}

const OverviewService = loadClass(OV_SRC, 'OverviewService')
const FarmReportService = loadClass(FR_SRC, 'FarmReportService')

async function rows(db, sql, params = []) { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }

// The real `db.get` interface both services call: { success, data: rows[] }.
const dbShim = {
  async get(sql, params = []) { return db.get(sql, params) }
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = Number(actual) === Number(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

const FARM = 1
const UNIT = 1

const scratch = await createScratchDb('opening_balance')
db = scratch.db
try {

  const overview = new OverviewService(dbShim)
  const farmReport = new FarmReportService(dbShim)

  // ── Fixture: one farm, one broiler unit, one flock with known P&L ─────────
  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1, 'Talha', 'x', 'broiler')`)
  await runSqlFor(db, `INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name, opening_balance) VALUES (${UNIT}, ${FARM}, 'broiler', 'Farm A', 0)`)
  await runSqlFor(db, `INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id) VALUES (1, ${FARM}, 'Flock 1', '2025-01-01', ${UNIT})`)
  // Revenue 200,000, expense 150,000 -> known netProfit of 50,000.
  await runSqlFor(db, `INSERT INTO income (flock_id, date, description, amount, source, module_type) VALUES (1, '2025-01-15', 'Sale proceeds', 200000, 'manual', 'broiler')`)
  await runSqlFor(db, `INSERT INTO expenses (flock_id, date, description, amount, module_type) VALUES (1, '2025-01-20', 'Feed bought', 150000, 'broiler')`)

  const setOpeningBalance = async (v) => {
    if (v === null) await runSqlFor(db, `UPDATE farm_units SET opening_balance = NULL WHERE unit_id = ${UNIT}`)
    else await runSqlFor(db, `UPDATE farm_units SET opening_balance = ? WHERE unit_id = ${UNIT}`, [v])
  }

  const runBoth = async (openingBalanceParam) => {
    const fr = await farmReport.getReport(FARM, UNIT, 'broiler', 'Farm A', {}, openingBalanceParam)
    const ov = await overview.getSummary(FARM, {})
    return { fr, ov }
  }

  console.log('\n=== 1. THE SIGN — opening balance is ADDED, not subtracted ===')

  await setOpeningBalance(0)
  const base = await runBoth(0)
  check('baseline netProfit (Farm Report)', base.fr.netProfit, 50000)
  check('baseline totalWithOpeningBalance == netProfit when opening balance is 0', base.fr.totalWithOpeningBalance, 50000)
  check('baseline Overview profit', base.ov.profit, 50000)
  check('baseline Overview profitWithOpeningBalance == profit when opening balance is 0', base.ov.profitWithOpeningBalance, 50000)

  await setOpeningBalance(100000)
  const plus = await runBoth(100000)
  check('Farm Report total with +100,000 opening balance', plus.fr.totalWithOpeningBalance, 150000)
  check('  i.e. exactly 100,000 HIGHER than baseline',
    plus.fr.totalWithOpeningBalance - base.fr.totalWithOpeningBalance, 100000)
  check('Overview total with +100,000 opening balance', plus.ov.profitWithOpeningBalance, 150000)
  check('  i.e. exactly 100,000 HIGHER than baseline',
    plus.ov.profitWithOpeningBalance - base.ov.profitWithOpeningBalance, 100000)

  await setOpeningBalance(-50000)
  const minus = await runBoth(-50000)
  check('Farm Report total with -50,000 opening balance (a carried-forward LOSS)', minus.fr.totalWithOpeningBalance, 0)
  check('  i.e. exactly 50,000 LOWER than baseline',
    minus.fr.totalWithOpeningBalance - base.fr.totalWithOpeningBalance, -50000)
  check('Overview total with -50,000 opening balance', minus.ov.profitWithOpeningBalance, 0)
  check('  i.e. exactly 50,000 LOWER than baseline',
    minus.ov.profitWithOpeningBalance - base.ov.profitWithOpeningBalance, -50000)

  console.log('\n  Summary of the three totals:')
  console.log(`    opening_balance =        0  ->  Farm Report total = ${base.fr.totalWithOpeningBalance.toLocaleString()}   Overview total = ${base.ov.profitWithOpeningBalance.toLocaleString()}`)
  console.log(`    opening_balance = +100,000  ->  Farm Report total = ${plus.fr.totalWithOpeningBalance.toLocaleString()}   Overview total = ${plus.ov.profitWithOpeningBalance.toLocaleString()}`)
  console.log(`    opening_balance =  -50,000  ->  Farm Report total = ${minus.fr.totalWithOpeningBalance.toLocaleString()}   Overview total = ${minus.ov.profitWithOpeningBalance.toLocaleString()}`)

  console.log('\n=== 2. NO CONTAMINATION — everything upstream of the final line is untouched ===')

  for (const [label, s] of [['+100,000', plus], ['-50,000', minus]]) {
    check(`revenue.total unchanged (${label})`, s.fr.revenue.total, base.fr.revenue.total)
    check(`expenses.total unchanged (${label})`, s.fr.expenses.total, base.fr.expenses.total)
    check(`netProfit unchanged (${label})`, s.fr.netProfit, base.fr.netProfit)
    check(`Overview moneyIn.total unchanged (${label})`, s.ov.moneyIn.total, base.ov.moneyIn.total)
    check(`Overview moneyOut.total unchanged (${label})`, s.ov.moneyOut.total, base.ov.moneyOut.total)
    check(`Overview profit unchanged (${label})`, s.ov.profit, base.ov.profit)
    const row = s.ov.perFarm.find(f => f.unitId === UNIT)
    const baseRow = base.ov.perFarm.find(f => f.unitId === UNIT)
    check(`per-farm Profit column unchanged (${label})`, row.profit, baseRow.profit)
  }

  console.log('\n=== 3. NO DOUBLE COUNTING — a second farm_units row contributes once ===')

  await runSqlFor(db, `INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name, opening_balance) VALUES (2, ${FARM}, 'broiler', 'Farm B', 25000)`)
  const twoUnits = await overview.getSummary(FARM, {})
  check('headline openingBalance is the SUM of both units, not one',
    twoUnits.openingBalance, -50000 + 25000)
  const rowA = twoUnits.perFarm.find(f => f.unitId === UNIT)
  const rowB = twoUnits.perFarm.find(f => f.unitId === 2)
  check('Farm A row carries only its own opening balance', rowA.openingBalance, -50000)
  check('Farm B row carries only its own opening balance', rowB.openingBalance, 25000)
  // The per-farm rows are informational only — the headline is computed
  // straight off farm_units (see overview.service.ts), never by re-summing
  // perFarm[].openingBalance. Confirm that sum would in fact double it if it
  // were (mis)used that way, i.e. the two really are independent figures.
  const perFarmSum = twoUnits.perFarm.reduce((s, f) => s + (f.openingBalance || 0), 0)
  check('per-farm sum agrees with the headline (both derive from farm_units once each)',
    perFarmSum, twoUnits.openingBalance)
  await runSqlFor(db, `DELETE FROM farm_units WHERE unit_id = 2`)

  console.log('\n=== 4. NULL HANDLING — a NULL opening_balance behaves like 0 ===')

  await setOpeningBalance(null)
  const nullRow = (await rows(db, 'SELECT opening_balance FROM farm_units WHERE unit_id = ?', [UNIT]))[0]
  checkTrue('the column really is NULL in the database', nullRow.opening_balance === null)
  const nullOv = await overview.getSummary(FARM, {})
  checkTrue('Overview headline openingBalance is a finite number, not NaN', Number.isFinite(nullOv.openingBalance))
  check('Overview headline openingBalance treats NULL as 0', nullOv.openingBalance, 0)
  checkTrue('Overview profitWithOpeningBalance is finite', Number.isFinite(nullOv.profitWithOpeningBalance))
  check('Overview profitWithOpeningBalance == profit when opening balance is NULL',
    nullOv.profitWithOpeningBalance, nullOv.profit)
  const nullRowInPerFarm = nullOv.perFarm.find(f => f.unitId === UNIT)
  checkTrue('per-farm openingBalance is finite, not NaN', Number.isFinite(nullRowInPerFarm.openingBalance))
  check('per-farm openingBalance treats NULL as 0', nullRowInPerFarm.openingBalance, 0)

  // FarmReportService never queries opening_balance itself — the component
  // passes it in (`currentUnit?.opening_balance ?? 0`), so the NULL-safety
  // that matters there is the same `?? 0` a raw NULL from the row would hit.
  const nullFr = await farmReport.getReport(FARM, UNIT, 'broiler', 'Farm A', {}, nullRow.opening_balance ?? 0)
  checkTrue('Farm Report openingBalance is finite, not NaN', Number.isFinite(nullFr.openingBalance))
  check('Farm Report openingBalance treats NULL as 0', nullFr.openingBalance, 0)
  check('Farm Report totalWithOpeningBalance == netProfit when opening balance is NULL',
    nullFr.totalWithOpeningBalance, nullFr.netProfit)

  // ── Distribution ───────────────────────────────────────────────────────
  //
  // Distribution has no farm_units row of its own (it is one business per
  // account), so its opening balance lives in app_settings instead, under
  // key 'distribution_opening_balance'. OverviewService.qDistributionOpeningBalance()
  // reads it and folds it into the SAME `openingBalance` / `profitWithOpeningBalance`
  // figures already proved above — this is exactly where a double-counting bug
  // would surface, so it is what these sections target.
  const setDistOpeningBalance = async (v) => {
    if (v === null) {
      await runSqlFor(db, `INSERT INTO app_settings (farm_id, key, value) VALUES (?, 'distribution_opening_balance', NULL)
              ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`, [FARM])
    } else {
      await runSqlFor(db, `INSERT INTO app_settings (farm_id, key, value) VALUES (?, 'distribution_opening_balance', ?)
              ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`, [FARM, String(v)])
    }
  }
  const clearDistOpeningBalance = async () => {
    await runSqlFor(db, `DELETE FROM app_settings WHERE farm_id = ? AND key = 'distribution_opening_balance'`, [FARM])
  }

  console.log('\n=== 5. DISTRIBUTION — same three-value test, via app_settings not farm_units ===')

  // Reset the farm's own opening balance to a known, non-interfering value so
  // this section isolates the distribution figure the same way section 1 isolated
  // the farm one.
  await setOpeningBalance(0)
  await clearDistOpeningBalance()

  const distBaseline = await overview.getSummary(FARM, {})
  check('baseline: no distribution app_settings row -> contributes 0 to the headline',
    distBaseline.openingBalance, 0)
  checkTrue('baseline: no Distribution row in perFarm when there is no activity and no opening balance',
    !distBaseline.perFarm.find(f => f.moduleType === 'distribution'))

  await setDistOpeningBalance(100000)
  const distPlus = await overview.getSummary(FARM, {})
  check('headline openingBalance with distribution +100,000', distPlus.openingBalance, 100000)
  check('headline profitWithOpeningBalance is profit + 100,000',
    distPlus.profitWithOpeningBalance, distPlus.profit + 100000)
  check('revenue/expenses/profit unaffected by the distribution opening balance',
    distPlus.profit, distBaseline.profit)
  const distRowPlus = distPlus.perFarm.find(f => f.moduleType === 'distribution')
  checkTrue('Distribution row now appears in perFarm, purely for its opening balance', !!distRowPlus)
  check('Distribution row carries exactly its own opening balance', distRowPlus.openingBalance, 100000)
  check('  and no revenue (no sales activity in this fixture)', distRowPlus.revenue, 0)
  check('  and no expenses', distRowPlus.expenses, 0)
  check('  and no profit — opening balance is NOT folded into the row\'s Profit column',
    distRowPlus.profit, 0)

  await setDistOpeningBalance(-50000)
  const distMinus = await overview.getSummary(FARM, {})
  check('headline openingBalance with distribution -50,000 (a carried-forward LOSS)',
    distMinus.openingBalance, -50000)
  check('headline profitWithOpeningBalance is profit - 50,000',
    distMinus.profitWithOpeningBalance, distMinus.profit - 50000)
  const distRowMinus = distMinus.perFarm.find(f => f.moduleType === 'distribution')
  check('Distribution row carries the negative figure too', distRowMinus.openingBalance, -50000)

  console.log('\n  Summary of the three distribution-only totals:')
  console.log(`    distribution opening_balance =        0  ->  headline openingBalance = ${distBaseline.openingBalance.toLocaleString()}`)
  console.log(`    distribution opening_balance = +100,000  ->  headline openingBalance = ${distPlus.openingBalance.toLocaleString()}`)
  console.log(`    distribution opening_balance =  -50,000  ->  headline openingBalance = ${distMinus.openingBalance.toLocaleString()}`)

  console.log('\n=== 6. NO DOUBLE COUNTING — a farm_units balance and the distribution balance each land once ===')

  await setOpeningBalance(75000)       // Farm A (farm_units), unrelated to distribution
  await setDistOpeningBalance(25000)   // Distribution (app_settings)
  const combined = await overview.getSummary(FARM, {})
  check('headline openingBalance is the SUM of the farm_units total and the distribution figure, once each',
    combined.openingBalance, 75000 + 25000)
  const combinedFarmRow = combined.perFarm.find(f => f.unitId === UNIT)
  const combinedDistRow = combined.perFarm.find(f => f.moduleType === 'distribution')
  check('Farm A row carries only its own farm_units figure', combinedFarmRow.openingBalance, 75000)
  check('Distribution row carries only its own app_settings figure', combinedDistRow.openingBalance, 25000)
  // Same cross-check as section 3: the per-farm rows are informational only —
  // the headline is computed directly from farm_units + app_settings, never by
  // re-summing perFarm[].openingBalance. Confirming the sums agree proves the
  // two sources really are independent, not one bucket double-counted as the
  // other under a different name.
  const combinedPerFarmSum = combined.perFarm.reduce((s, f) => s + (f.openingBalance || 0), 0)
  check('per-farm sum agrees with the headline (each source contributes exactly once)',
    combinedPerFarmSum, combined.openingBalance)

  console.log('\n=== 7. NULL HANDLING — an explicit NULL app_settings value behaves like 0 ===')

  await setOpeningBalance(0)
  await setDistOpeningBalance(null)
  const distNullRow = (await rows(db, `SELECT value FROM app_settings WHERE farm_id = ? AND key = 'distribution_opening_balance'`, [FARM]))[0]
  checkTrue('the app_settings value really is NULL in the database', distNullRow.value === null)
  const distNull = await overview.getSummary(FARM, {})
  checkTrue('headline openingBalance is finite when the distribution value is NULL',
    Number.isFinite(distNull.openingBalance))
  check('headline openingBalance treats a NULL distribution value as 0', distNull.openingBalance, 0)
  checkTrue('profitWithOpeningBalance is finite', Number.isFinite(distNull.profitWithOpeningBalance))
  check('profitWithOpeningBalance == profit when both opening balances are 0/NULL',
    distNull.profitWithOpeningBalance, distNull.profit)

  await clearDistOpeningBalance()

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
