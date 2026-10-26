// [Codex] PostgreSQL port of verify_debt_records.js.
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

// DEBT PAYMENT — A NOTEBOOK, AND THIS SCRIPT IS WHAT KEEPS IT ONE.
//
// The Overview > Debt Payment screen is somewhere for the client to write down
// who took money off him and disappeared. He asked for it to be connected to
// nothing, and that is also the only honest option: the app has no idea whether
// the money written down here ever moved through a drawer or an account. If it
// did, some other screen already recorded it and counting it again would double
// it. If it did not, counting it would invent a rupee that never existed.
//
// So the property under test is INERTNESS, which is unusual for this directory
// and is the whole point:
//
//   A. the four CRUD methods work, and are farm-scoped
//   B. STATICALLY: no source file outside the screen and its own service
//      methods so much as names `debt_records`; the table has no
//      payment_source/bank_id; it is not in BANK_SOURCES; it is in no cash
//      term; it is in no delete cascade; deleteBankAccount does not count it
//   C. DYNAMICALLY: writing, editing and deleting rows moves Cash in Hand,
//      every bank balance, and every Overview revenue/expense/profit query by
//      exactly ZERO
//
// If a change makes this script fail, the thing to re-read is the class comment
// in debt-payment.component.ts, not this file.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const DS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const CP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'cash-position.service.ts'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

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

function loadMethod(name, kw = 'async ') {
  let body = extractFn(DS_SRC, name, kw).trim()
  // Exclusive, not a chain: a chain rewrites 'private async foo' to
  // 'async function foo' and then matches its own output.
  if (/^private\s+async\s+/.test(body)) body = body.replace(/^private\s+async\s+/, 'async function ')
  else if (/^async\s+/.test(body)) body = body.replace(/^async\s+/, 'async function ')
  else if (/^private\s+/.test(body)) body = body.replace(/^private\s+/, 'function ')
  else body = 'function ' + body
  return eval('(' + toJs(body) + ')')
}



const AS_OF_PARAM = (CP_SRC.match(/export const AS_OF_PARAM = '([^']*)'/) || [])[1]
if (!AS_OF_PARAM) throw new Error('AS_OF_PARAM not found in cash-position.service.ts')

const cashProto = (() => {
  const cls = [
    'class LiftedCashPosition {',
    '  ' + extractFn(CP_SRC, 'getCashPosition', 'async '),
    '  ' + extractFn(CP_SRC, 'readBankTotal', 'private async '),
    '  ' + extractFn(CP_SRC, 'readComponents', 'private async '),
    '  ' + extractFn(CP_SRC, 'cashSql', '\n  ').trim(),
    '}'
  ].join('\n')
  return eval('(' + toJs(cls) + ')').prototype
})()

// Load every real builder and dependency, rather than silently skipping methods
// whose TypeScript annotations the old regex loader could not erase.
const { distributionBillsOnly } = (() => {
  const source = fs.readFileSync(path.join(ROOT, 'src/app/shared/utils/bill-source.util.ts'), 'utf8')
  const exports = {}
  new Function('exports', ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText)(exports)
  return exports
})()
const OverviewService = (() => {
  const body = OV_SRC.replace(/^import .*;$/gm, '')
    .replace(/@Injectable\([^)]*\)\s*\n?/g, '').replace(/^export /gm, '')
  return eval(toJs(body) + '; OverviewService')
})()
const ovCtx = new OverviewService(null)
function loadQuery(name) {
  const query = ovCtx[name]
  if (typeof query !== 'function') throw new Error(`Missing Overview builder ${name}`)
  return query
}

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

const methods = {
  getDebtRecords: loadMethod('getDebtRecords'),
  addDebtRecord: loadMethod('addDebtRecord'),
  updateDebtRecord: loadMethod('updateDebtRecord'),
  deleteDebtRecord: loadMethod('deleteDebtRecord')
}

const scratch = await createScratchDb('debt_records')
db = scratch.db
try {

  const rows = async (sql, params = []) => { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }
  const one = async (sql, params = []) => (await rows(sql, params))[0]

  const svc = {
    async get(sql, params = []) { return db.get(sql, params) },
    async run(sql, params = []) { return db.run(sql, params) }
  }
  for (const [name, fn] of Object.entries(methods)) svc[name] = fn.bind(svc)

  const cash = Object.create(cashProto)
  cash.db = svc

  const FARM = 1
  const OTHER = 2

  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
  await runSqlFor(db, `INSERT INTO bank_accounts (bank_id, farm_id, customer_id, bank_name, opening_balance, current_balance)
          VALUES (1, 1, NULL, 'HBL Main', 0, 200000)`)
  await runSqlFor(db, `INSERT INTO bank_ledger (bank_id, transaction_date, description, debit, credit, balance, reference_type, transaction_number)
          VALUES (1,'2026-01-01','Opening',200000,0,200000,'opening','DEP-0001')`)
  // Some real money on the account, so "nothing moved" is a claim about a
  // non-zero database rather than about an empty one.
  await runSqlFor(db, `INSERT INTO farm_units (unit_id, farm_id, module_type, unit_name) VALUES (1,1,'broiler','Farm A')`)
  await runSqlFor(db, `INSERT INTO flocks (flock_id, farm_id, flock_name, start_date, unit_id) VALUES (1,1,'F1','2026-02-01',1)`)
  await runSqlFor(db, `INSERT INTO sales (sale_id, flock_id, date, rate, total_amount, payment_type, payment_source, module_type)
          VALUES (1,1,'2026-02-10',200,90000,'cash','cash','broiler')`)
  await runSqlFor(db, `INSERT INTO expenses (expense_id, flock_id, date, description, amount, payment_type, module_type, payment_source)
          VALUES (1,1,'2026-02-11','Diesel',6000,'cash','broiler','cash')`)

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== A. the four methods work, and are farm-scoped ===')
  // ════════════════════════════════════════════════════════════════════════

  let r = await svc.addDebtRecord({
    farm_id: FARM, person_name: 'Akram', phone: '0300', date: '2026-03-01',
    amount: 75000, status: 'outstanding', notes: 'Took the money and left town'
  })
  checkTrue('a record saves', r.success === true)
  const ID = Number(r.lastId)
  checkTrue('and its id comes back', ID > 0)

  let list = await svc.getDebtRecords(FARM)
  checkTrue('the list reads back', list.success === true)
  check('one row', list.data.length, 1)
  check('  the name', list.data[0].person_name, 'Akram')
  check('  the amount', list.data[0].amount, 75000)
  check('  the status', list.data[0].status, 'outstanding')
  check('  the note', list.data[0].notes, 'Took the money and left town')

  r = await svc.addDebtRecord({ farm_id: FARM, person_name: '   ' })
  checkTrue('a nameless record is refused', r.success === false)

  r = await svc.addDebtRecord({ farm_id: FARM, person_name: 'No amount' })
  checkTrue('an amount is NOT required — it is a note, not an invoice', r.success === true)
  check('  and reads back as zero',
    (await one(`SELECT amount AS a FROM debt_records WHERE person_name = 'No amount'`)).a, 0)

  r = await svc.updateDebtRecord(ID, { status: 'recovered', amount: 80000 })
  checkTrue('an edit saves', r.success === true)
  check('  the status changed', (await one(`SELECT status AS s FROM debt_records WHERE debt_id = ?`, [ID])).s, 'recovered')
  check('  and the amount', (await one(`SELECT amount AS a FROM debt_records WHERE debt_id = ?`, [ID])).a, 80000)
  check('  while the untouched fields are untouched',
    (await one(`SELECT person_name AS n FROM debt_records WHERE debt_id = ?`, [ID])).n, 'Akram')

  r = await svc.updateDebtRecord(ID, {})
  checkTrue('an empty edit is refused rather than writing nothing silently', r.success === false)

  await runSqlFor(db, `INSERT INTO debt_records (farm_id, person_name, amount) VALUES (?, 'Other account', 999999)`, [OTHER])
  list = await svc.getDebtRecords(FARM)
  checkTrue("the other account's record is not in this account's list",
    !list.data.some(x => x.person_name === 'Other account'))
  check('and this account still sees its own', list.data.length, 2)

  r = await svc.deleteDebtRecord(ID)
  checkTrue('a delete succeeds', r.success === true)
  check('  and the row is gone',
    (await rows(`SELECT debt_id FROM debt_records WHERE debt_id = ?`, [ID])).length, 0)

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== B. STATICALLY disconnected: nothing else names the table ===')
  // ════════════════════════════════════════════════════════════════════════

  const SRC_DIR = path.join(ROOT, 'src')
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full, out)
      else if (/\.(ts|html|scss)$/.test(name)) out.push(full)
    }
    return out
  }

  // The ONLY files allowed to mention the table: the screen itself and the
  // service that holds its four methods.
  const ALLOWED = [
    path.join('src', 'app', 'debt-payment'),
    path.join('src', 'app', 'shared', 'services', 'database.service.ts')
  ]
  const offenders = walk(SRC_DIR)
    .filter(f => /debt_records/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f))
    .filter(rel => !ALLOWED.some(a => rel.startsWith(a)))
  if (offenders.length) console.log('        ' + offenders.join('\n        '))
  check('no file outside the screen and its service reads `debt_records`', offenders.length, 0)

  // And within the service, only the four methods — nothing in a money path.
  // Comments are stripped first: the block above the methods names this very
  // script, whose filename contains the table name, and a doc comment is not a
  // code path.
  const stripComments = (src) => src
    .split(/\r?\n/)
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join(' ')
  const dsHits = (stripComments(DS_SRC).match(/debt_records/g) || []).length
  const methodHits = Object.keys(methods)
    .map(n => (stripComments(extractFn(DS_SRC, n, 'async ')).match(/debt_records/g) || []).length)
    .reduce((a, b) => a + b, 0)
  check('every CODE mention in database.service.ts is inside those four methods',
    dsHits, methodHits)
  checkTrue('  and there are some, so the strip did not blank everything',
    methodHits >= 4)

  // The table itself has no money path to be wired into.
  const ddl = DB_SRC.slice(
    DB_SRC.indexOf('CREATE TABLE IF NOT EXISTS debt_records'),
    DB_SRC.indexOf('CREATE INDEX IF NOT EXISTS idx_debt_records_farm'))
  checkTrue('the table has no payment_source column', !/payment_source/.test(ddl))
  checkTrue('and no bank_id column', !/bank_id/.test(ddl))
  checkTrue('and no flock_id or batch_id, so no cascade can reach it',
    !/flock_id|batch_id/.test(ddl))
  const cols = (await rows(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'debt_records' ORDER BY ordinal_position`)).map(c => c.name)
  check('its columns are exactly the eight the screen uses',
    cols.join(','), 'debt_id,farm_id,person_name,phone,date,amount,status,notes,created_at')

  // Not in BANK_SOURCES, not in any cash term, not in deleteBankAccount.
  const bankSources = DS_SRC.slice(
    DS_SRC.indexOf('private static readonly BANK_SOURCES'),
    DS_SRC.indexOf('} as const;', DS_SRC.indexOf('private static readonly BANK_SOURCES')))
  checkTrue('it is not a BANK_SOURCES table', !/debt/.test(bankSources))
  checkTrue('it has no term in cashSql()', !/debt_records/.test(CP_SRC))
  const delBank = extractFn(DS_SRC, 'deleteBankAccount', 'async ')
  checkTrue('deleteBankAccount does not count it', !/debt_records/.test(delBank))
  checkTrue('no screen reads it through a resolver', !fs.existsSync(
    path.join(ROOT, 'src', 'app', 'shared', 'resolvers', 'debt-payment.resolver.ts')))

  // Both delete cascades leave it alone.
  for (const f of ['flock-management/flock-management.component.ts',
                   'batch-management/batch-management.component.ts']) {
    checkTrue(f.split('/')[0] + ' does not delete from it',
      !/debt_records/.test(fs.readFileSync(path.join(ROOT, 'src', 'app', f), 'utf8')))
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== C. DYNAMICALLY inert: every figure moves by exactly zero ===')
  // ════════════════════════════════════════════════════════════════════════

  const PROFIT_QUERIES = [
    'qBroilerSales', 'qEggSales', 'qHenSales', 'qBroilerIncome', 'qLayerIncome',
    'qDistributionBills', 'qExpenses', 'qLabour', 'qPurchases', 'qDistributionCogs',
    'qDistributionExpenses', 'qPersonalExpenses', 'qAssetSales', 'qAssetPayments'
  ]
  const snapshot = async () => {
    const pos = await cash.getCashPosition(FARM)
    const ov = {}
    for (const name of PROFIT_QUERIES) {
      const q = loadQuery(name)
      const args = (name === 'qExpenses' || name === 'qLabour')
        ? [FARM, {}, 'broiler'] : [FARM, {}]
      const [sql, params] = q.apply(ovCtx, args)
      // A pair of equal SQL errors is not evidence of unchanged balances.
      ov[name] = JSON.stringify((await rows(sql, params)))
    }
    return {
      cash: pos.cashInHand,
      bank: pos.totalBankBalance,
      terms: pos.components.map(c => c.key + '=' + c.amount).join(','),
      ledgerRows: (await rows(`SELECT COUNT(*) AS n FROM bank_ledger`))[0].n,
      ov
    }
  }

  const before = await snapshot()
  checkTrue('the fixture has real money in it, so "no change" means something',
    before.cash !== 0 && before.bank !== 0)

  // Write, edit and delete in every shape the screen allows.
  const a = await svc.addDebtRecord({
    farm_id: FARM, person_name: 'Vanished', date: '2026-04-01', amount: 500000,
    status: 'outstanding', notes: 'Never came back'
  })
  const b = await svc.addDebtRecord({
    farm_id: FARM, person_name: 'Paid up later', date: '2026-04-02', amount: 120000,
    status: 'recovered'
  })
  await svc.addDebtRecord({
    farm_id: FARM, person_name: 'Given up on', date: '2026-04-03', amount: 300000,
    status: 'written_off'
  })
  await svc.updateDebtRecord(Number(a.lastId), { amount: 650000, status: 'written_off' })
  await svc.deleteDebtRecord(Number(b.lastId))

  const after = await snapshot()
  check('Cash in Hand moved by', after.cash - before.cash, 0)
  check('Total Bank Balance moved by', after.bank - before.bank, 0)
  check('every cash TERM is identical', after.terms, before.terms)
  check('no bank_ledger row was written', after.ledgerRows, before.ledgerRows)

  let moved = 0
  for (const name of Object.keys(before.ov)) {
    if (before.ov[name] !== after.ov[name]) {
      moved++
      console.log(`        ${name}: ${before.ov[name]} -> ${after.ov[name]}`)
    }
  }
  check('not one Overview revenue/expense/profit query moved', moved, 0)
  checkTrue('  and those queries really were read', Object.keys(before.ov).length > 8)

  check('meanwhile the notes really are stored',
    (await rows(`SELECT COUNT(*) AS n FROM debt_records WHERE farm_id = ?`, [FARM]))[0].n, 3)
  check('  including the edited one',
    (await one(`SELECT amount AS a FROM debt_records WHERE person_name = 'Vanished'`)).a, 650000)

  console.log(failures === 0
    ? '\nALL CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
