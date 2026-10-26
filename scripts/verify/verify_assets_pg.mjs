// [Codex] PostgreSQL port of verify_assets.js.
// Business SQL/method bodies come from the current src/ tree. Fixture values
// and assertion expressions are retained, using asynchronous PostgreSQL IO.
// Desktop structural references remain read-only; scratch schemas are removed.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
async function runSql(sql, params = []) {
  const result = await db.run(sql, params)
  if (!result.success) throw new Error(result.error)
  return result
}

// Exercises the real asset methods through server/src/db/execute.js against
// PostgreSQL, including the $lastId back-reference linking the opening payment.
const fs = require('fs')
const path = require('path')

// Repo root: these live in scripts/verify/ but read the real source files.
const ROOT = path.join(__dirname, '..', '..')

const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')

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

function loadMethod(name, kw = 'async ') {
  // Strip the TypeScript annotations with the real compiler rather than with
  // regexes — the method signatures include multi-line inline object types.
  const ts = require('typescript')
  const decl = /async/.test(kw) ? 'async function ' : 'function '
  const body = extractFn(SVC_SRC, name, kw)
    .replace(new RegExp('^' + kw.trim().replace(/\s+/g, '\\s+') + '\\s+'), decl)
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// The asset methods reference these class statics when they reach the bank
// ledger. Read off the real source, so a rename breaks this file loudly instead
// of at run time. The bank side itself is exercised by
// verify_bank_withdrawals.js; this file's fixture is cash-only, but the
// helpers still have to resolve.
const DatabaseService = {
  ASSET_PAYMENT_REF: SVC_SRC.match(/ASSET_PAYMENT_REF\s*=\s*'([^']+)'/)[1],
  ASSET_SALE_REF: SVC_SRC.match(/ASSET_SALE_REF\s*=\s*'([^']+)'/)[1],
  PERSONAL_EXPENSE_REF: SVC_SRC.match(/PERSONAL_EXPENSE_REF\s*=\s*'([^']+)'/)[1]
}

const methods = {
  getAssets: loadMethod('getAssets'),
  addAsset: loadMethod('addAsset'),
  updateAsset: loadMethod('updateAsset'),
  deleteAsset: loadMethod('deleteAsset'),
  addAssetPayment: loadMethod('addAssetPayment'),
  getAssetPayments: loadMethod('getAssetPayments'),

  // Private helpers the above call through to.
  bankBalanceSql: loadMethod('bankBalanceSql', 'private '),
  // bankWithdrawalOps is now a thin wrapper over bankEntryOps with
  // direction: 'out' - money IN exists too, because most of the source tables
  // are sales. Both halves have to be bound here or the wrapper calls nothing.
  nextTransactionNumberSql: loadMethod('nextTransactionNumberSql', 'private '),
  nextWithdrawalNumberSql: loadMethod('nextWithdrawalNumberSql', 'private '),
  rebuildBankBalanceOp: loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps: loadMethod('bankEntryOps', 'private '),
  bankWithdrawalOps: loadMethod('bankWithdrawalOps', 'private '),
  bankReversalOps: loadMethod('bankReversalOps', 'private '),
  // A plain public method, so it is located by its indentation rather than by a
  // keyword — deleteAsset now closes its batch with one rebuild per account.
  bankRebuildOps: loadMethod('bankRebuildOps', '\n  '),
  bankIdsForAsset: loadMethod('bankIdsForAsset', 'private async '),

  // The save-time balance guard. These scripts bind the real method bodies onto
  // this one object, so a new `this.` dependency has to be registered here or
  // the method under test throws instead of running.
  bankAmountText: loadMethod('bankAmountText', 'private '),
  checkBankBalances: loadMethod('checkBankBalances', 'async ')
}

const scratch = await createScratchDb('assets')
db = scratch.db
try {
  const svc = {
    async get(sql, params = []) { return db.get(sql, params) },
    async run(sql, params = []) { return db.run(sql, params) },
    // Real server batch: ordered, atomic, with $lastId back-references.
    async runBatch(ops) { return db.batch(ops) }
  }
  for (const [name, fn] of Object.entries(methods)) svc[name] = fn.bind(svc)

  await runSql(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)

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
  const scalar = async (sql, params = []) => {
  const result = await db.get(sql, params)
  if (!result.success) throw new Error(result.error)
  return Object.values(result.data[0] ?? {})[0] ?? null
}

  const run = async () => {
    console.log('=== add asset with a down payment (one atomic batch) ===')
    let r = await svc.addAsset({
      farm_id: 1, asset_name: 'Tractor', category: 'Vehicle', purchase_date: '2025-01-10',
      total_price: 1000000, payment_source: 'cash', initial_payment: 400000
    })
    checkTrue('save succeeds', r.success, r.error)
    check('one asset written', (await scalar('SELECT COUNT(*) FROM assets')), 1)
    check('one payment written', (await scalar('SELECT COUNT(*) FROM asset_payments')), 1)
    // The whole point of $lastId: -1.
    check('payment is linked to the asset',
      (await scalar('SELECT p.asset_id FROM asset_payments p')), (await scalar('SELECT asset_id FROM assets')))
    check('down payment amount', (await scalar('SELECT amount FROM asset_payments')), 400000)
    check('total_price stored', (await scalar('SELECT total_price FROM assets')), 1000000)
    check('purchase_amount mirrored', (await scalar('SELECT purchase_amount FROM assets')), 1000000)

    console.log('\n=== add asset with no down payment ===')
    r = await svc.addAsset({
      farm_id: 1, asset_name: 'Shed', purchase_date: '2025-02-01', total_price: 300000
    })
    checkTrue('save succeeds', r.success, r.error)
    check('no stray payment row', (await scalar('SELECT COUNT(*) FROM asset_payments')), 1)

    console.log('\n=== add asset with no price and no payment (was: NOT NULL constraint failed) ===')
    r = await svc.addAsset({
      farm_id: 1, asset_name: 'Mystery Plot', purchase_date: '2025-02-10'
    })
    checkTrue('save succeeds', r.success, r.error)
    check('purchase_amount defaults to 0, not null',
      (await scalar(`SELECT purchase_amount FROM assets WHERE asset_id=${r.lastId}`)), 0)
    check('total_price stays null (price genuinely unknown)',
      (await scalar(`SELECT total_price FROM assets WHERE asset_id=${r.lastId}`)), null)

    console.log('\n=== add asset with no price but an initial payment (was: NOT NULL constraint failed) ===')
    r = await svc.addAsset({
      farm_id: 1, asset_name: 'Unpriced Trailer', purchase_date: '2025-02-11',
      payment_source: 'cash', initial_payment: 20000
    })
    checkTrue('save succeeds', r.success, r.error)
    const unpriced = (await svc.getAssets(1)).data.find(a => a.asset_name === 'Unpriced Trailer')
    check('down payment recorded',
      (await scalar(`SELECT SUM(amount) FROM asset_payments WHERE asset_id=${unpriced.asset_id}`)), 20000)
    check('agreed_price stays null — a 0 purchase_amount must not read as a real price',
      unpriced.agreed_price, null)
    check('amount_outstanding stays null — nothing to compute it from, never negative',
      unpriced.amount_outstanding, null)

    console.log('\n=== card figures ===')
    const assets = (await svc.getAssets(1)).data
    const tractor = assets.find(a => a.asset_name === 'Tractor')
    const shed = assets.find(a => a.asset_name === 'Shed')
    check('tractor agreed price', tractor.agreed_price, 1000000)
    check('tractor paid', tractor.amount_paid, 400000)
    check('tractor outstanding', tractor.amount_outstanding, 600000)
    check('tractor payment count', tractor.payment_count, 1)
    check('shed shows zero paid, not null', shed.amount_paid, 0)
    check('shed outstanding is the full price', shed.amount_outstanding, 300000)

    console.log('\n=== further installments ===')
    r = await svc.addAssetPayment({
      asset_id: tractor.asset_id, farm_id: 1, date: '2025-04-15',
      amount: 250000, payment_source: 'bank', bank_id: 7
    })
    checkTrue('payment recorded', r.success, r.error)
    const after = (await svc.getAssets(1)).data.find(a => a.asset_name === 'Tractor')
    check('paid rolls up', after.amount_paid, 650000)
    check('outstanding falls', after.amount_outstanding, 350000)

    console.log('\n=== bank_id is dropped for a cash payment ===')
    await svc.addAssetPayment({
      asset_id: tractor.asset_id, farm_id: 1, date: '2025-05-01',
      amount: 50000, payment_source: 'cash', bank_id: 7
    })
    check('cash payment stores no bank_id',
      (await scalar(`SELECT COUNT(*) FROM asset_payments WHERE payment_source='cash' AND bank_id IS NOT NULL`)), 0)

    console.log('\n=== editing the price moves both columns together ===')
    r = await svc.updateAsset(tractor.asset_id, { total_price: 1100000 })
    checkTrue('update succeeds', r.success, r.error)
    check('total_price updated', (await scalar(`SELECT total_price FROM assets WHERE asset_id=${tractor.asset_id}`)), 1100000)
    check('purchase_amount followed', (await scalar(`SELECT purchase_amount FROM assets WHERE asset_id=${tractor.asset_id}`)), 1100000)

    console.log('\n=== clearing the price back to unknown (was: NOT NULL constraint failed) ===')
    r = await svc.addAsset({ farm_id: 1, asset_name: 'Renegotiated Land', purchase_date: '2025-03-01', total_price: 500000 })
    checkTrue('save succeeds', r.success, r.error)
    r = await svc.updateAsset(r.lastId, { total_price: null })
    checkTrue('update succeeds', r.success, r.error)
    const cleared = (await svc.getAssets(1)).data.find(a => a.asset_name === 'Renegotiated Land')
    check('purchase_amount falls back to 0, not null', cleared.purchase_amount, 0)
    check('agreed_price reads back null', cleared.agreed_price, null)

    console.log('\n=== farm scoping ===')
    await svc.addAsset({ farm_id: 2, asset_name: 'Generator', purchase_date: '2025-01-01', total_price: 90000, initial_payment: 10000 })
    check('farm 1 sees only its own', (await svc.getAssets(1)).data.length, 5)
    check('farm 2 sees only its own', (await svc.getAssets(2)).data.length, 1)
    check('payments are farm-scoped too',
      (await svc.getAssetPayments(tractor.asset_id, 2)).data.length, 0)

    console.log('\n=== deleting an asset takes its payments with it ===')
    const before = (await scalar('SELECT COUNT(*) FROM asset_payments'))
    checkTrue('tractor has payments to lose', before > 1, `only ${before}`)
    r = await svc.deleteAsset(tractor.asset_id)
    checkTrue('delete succeeds', r.success, r.error)
    check('asset gone', (await scalar(`SELECT COUNT(*) FROM assets WHERE asset_id=${tractor.asset_id}`)), 0)
    check('no orphaned payments left',
      (await scalar(`SELECT COUNT(*) FROM asset_payments WHERE asset_id=${tractor.asset_id}`)), 0)
    check('other assets untouched', (await scalar('SELECT COUNT(*) FROM assets')), 5)
    check('other payments untouched', (await scalar('SELECT COUNT(*) FROM asset_payments')), 2)

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
    process.exitCode = failures === 0 ? 0 : 1
  }

  await run()
} finally {
  await scratch.close()
}
