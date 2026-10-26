// [Codex] PostgreSQL port of verify_layer_ledger.js.
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

// Asserts the Layer Ledger counts as a cost exactly once, that it cannot touch
// the broiler ledger on a colliding id, and that a batch delete takes it with it.
//
// WHY PARALLEL TABLES, which is what every check below is really testing.
// `ledgers`/`ledger_entries` are keyed on `flock_id` and carry NO `module_type`
// column, and every query against them filters `flock_id` alone. `flocks.flock_id`
// and `batches.batch_id` are separate AUTOINCREMENT sequences that both start at 1
// and are database-wide, so broiler flock N and layer batch N collide from #1 and
// need not even belong to the same login. Filing a batch in `ledger_entries` would
// therefore surface it inside the broiler flock that happens to share its id, with
// nothing able to tell the two apart. `layer_ledgers`/`layer_ledger_entries` are
// keyed on `batch_id` instead — the same choice `layer_health` makes beside
// `flock_health`, and for the same reason. Different tables means no guard to get
// right: a batch_id and a flock_id never meet in one column.
//
// THE PARTITION. Every layer cost is claimed by exactly one side:
//
//   expense side : `expenses` rows with module_type = 'layer'
//   ledger side  : `layer_ledger_entries` debits
//
// They are rows in different tables and nothing mirrors one into the other — the
// layer Expenses screen writes `expenses` and nothing else, exactly as the broiler
// one does. That is why there is no `source` column here and no `<> 'expense'`
// guard to carry: `ledger_entries.source` exists only to mark the mirrors the OLD
// Expenses screen wrote, and nothing auto-files anywhere any more.
//
// What this file actually runs: the real createTables/alterStatements from
// electron/database.js, the real SQL lifted out of layer-ledger.component.ts,
// batch-management.component.ts, layer-report.component.ts, overview.service.ts
// and farm-report.service.ts. No SQL is retyped here except the arithmetic that
// proves the partition.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const LL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'layer-ledger', 'layer-ledger.component.ts'), 'utf8')
const BM_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'batch-management', 'batch-management.component.ts'), 'utf8')
const LR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'layer-report', 'layer-report.component.ts'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')
const FR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'farm-report.service.ts'), 'utf8')
const LE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'layer-expenses', 'layer-expenses.component.ts'), 'utf8')

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

const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

/** Pull the template-literal SQL string that CONTAINS `marker`. */
function sqlContaining(src, marker) {
  const idx = src.indexOf(marker)
  if (idx < 0) throw new Error(`marker not found: ${marker}`)
  const open = src.lastIndexOf('`', idx)
  const close = src.indexOf('`', idx)
  if (open < 0 || close < 0) throw new Error(`no SQL literal around: ${marker}`)
  return src.slice(open + 1, close)
}

const rows = async (database, sql, params = []) => {
  const result = await database.get(sql, params)
  if (!result.success) throw new Error(result.error)
  return result.data
}
const scalar = async (db, sql, params = []) => Number((await rows(db, sql, params))[0]?.v || 0)

// ── the real SQL under test, lifted from the real files ────────────────────
const SCREEN_LEDGER_INSERT = sqlContaining(LL_SRC, 'INSERT INTO layer_ledgers (batch_id, farm_id, ledger_name)')
const SCREEN_ENTRY_INSERT = sqlContaining(LL_SRC, 'INSERT INTO layer_ledger_entries')
const SCREEN_ENTRY_UPDATE = sqlContaining(LL_SRC, 'UPDATE layer_ledger_entries')
const SCREEN_ENTRY_DELETE = sqlContaining(LL_SRC, 'DELETE FROM layer_ledger_entries WHERE entry_id = ?')
const SCREEN_LEDGERS_LIST = sqlContaining(LL_SRC, 'FROM layer_ledgers l')
const SCREEN_ENTRIES_LIST = sqlContaining(LL_SRC, 'SELECT * FROM layer_ledger_entries')
const LEDGER_DEL_ENTRIES = sqlContaining(LL_SRC, 'DELETE FROM layer_ledger_entries WHERE ledger_id = ?')
const LEDGER_DEL_LEDGER = sqlContaining(LL_SRC, 'DELETE FROM layer_ledgers WHERE ledger_id = ?')

// The batch-delete cascade's two new statements, taken from the real runBatch.
const CASCADE_ENTRIES = sqlContaining(BM_SRC, 'DELETE FROM layer_ledger_entries WHERE batch_id = ?')
const CASCADE_LEDGERS = sqlContaining(BM_SRC, 'DELETE FROM layer_ledgers        WHERE batch_id = ?')

// The layer Report's two loaders. Their SQL carries `${unitClause}`, which the
// screen fills with ' AND b.unit_id = ?' when the account has farm_units and with
// '' otherwise — the legacy fallback. The account-wide form is what is exercised
// here, so the placeholder resolves to empty; the unit-scoped form is exercised
// through farm-report.service.ts's spec below, which always carries a unit_id.
const noUnit = (sql) => {
  if (!sql.includes('${unitClause}')) throw new Error('layer-report SQL no longer carries ${unitClause}')
  return sql.split('${unitClause}').join('')
}
const REPORT_LEDGERS_SQL = noUnit(sqlContaining(LR_SRC, 'FROM layer_ledgers l JOIN batches b'))
const REPORT_ENTRIES_SQL = noUnit(sqlContaining(LR_SRC, 'FROM layer_ledger_entries le JOIN layer_ledgers l'))

// The two services build their layer-ledger query in code. Take the whole thing,
// with the `?` for farm_id, so a change to either is caught here rather than in a
// user's books.
// Lift the complete builder: its GROUP BY follows an optional date clause.
// The desktop harness took only the first template fragment; SQLite tolerated
// its bare unit_id beside SUM(), but PostgreSQL correctly rejects that fragment.
function loadOverviewMethod(name) {
  const body = extractFn(OV_SRC, name, 'private ').replace(/^private\s+/, 'function ')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}
const overviewContext = { dateClause: loadOverviewMethod('dateClause') }
const OV_LAYER_LEDGER_SQL = loadOverviewMethod('qLayerLedgerDebits').call(overviewContext, 1, {})[0]
const FR_LAYER_LEDGER_SPEC = (() => {
  const body = extractFn(FR_SRC, 'specLayerLedgerDebits', 'private ')
  const pick = (key) => {
    const m = body.match(new RegExp(`${key}:\\s*(?:'([^']*)'|\`([^\`]*)\`)`))
    if (!m) throw new Error(`farm-report.service.ts specLayerLedgerDebits: no ${key}`)
    return m[1] !== undefined ? m[1] : m[2]
  }
  return {
    table: pick('table'), alias: pick('alias'), ownerCol: pick('ownerCol'),
    amount: pick('amount'), where: pick('where')
  }
})()

// The layer Report's debit total, as the getter computes it.
const reportLedgerDebit = async (db, batchFilter) => {
  const all = (await rows(db, REPORT_ENTRIES_SQL, [1]))
  const scoped = batchFilter === 'all' ? all : all.filter(e => String(e.batch_id) === String(batchFilter))
  return scoped.filter(e => e.type === 'debit').reduce((s, e) => s + (e.amount || 0), 0)
}

async function seed() {

  await runSql(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1,'Talha','x','all')`)
  await runSql(`INSERT INTO farm_units (unit_id, farm_id, unit_name, module_type) VALUES (1,1,'Layer Farm A','layer')`)
  await runSql(`INSERT INTO farm_units (unit_id, farm_id, unit_name, module_type) VALUES (2,1,'Broiler Farm A','broiler')`)

  // THE COLLISION, set up on purpose: broiler flock 1 and layer batch 1 share id 1.
  await runSql(`INSERT INTO flocks (flock_id, farm_id, unit_id, flock_name, start_date) VALUES (1,1,2,'Flock 1','2026-01-01')`)
  await runSql(`INSERT INTO batches (batch_id, farm_id, unit_id, batch_name, start_date, initial_birds) VALUES (1,1,1,'Batch 1','2026-01-01',5000)`)
  // A second batch, so "delete batch 1" can be shown not to touch batch 2.
  await runSql(`INSERT INTO batches (batch_id, farm_id, unit_id, batch_name, start_date, initial_birds) VALUES (2,1,1,'Batch 2','2026-02-01',3000)`)

  // ── the broiler side, which must not move by one rupee ──
  await runSql(`INSERT INTO ledgers (ledger_id, flock_id, ledger_name) VALUES (1,1,'Generator')`)
  await runSql(`INSERT INTO ledger_entries (ledger_id, flock_id, date, description, amount, type, source)
          VALUES (1,1,'2026-03-01','Diesel for generator',3000,'debit','manual')`)
  await runSql(`INSERT INTO ledger_entries (ledger_id, flock_id, date, description, amount, type, source)
          VALUES (1,1,'2026-03-02','Refund on spares',1000,'credit','manual')`)
  await runSql(`INSERT INTO expenses (flock_id, date, category, description, amount, module_type)
          VALUES (1,'2026-03-03','Repairs','Broiler shed repair',9000,'broiler')`)
  await runSql(`INSERT INTO income (flock_id, date, description, amount, module_type)
          VALUES (1,'2026-03-04','Bird sale',50000,'broiler')`)

  // ── the layer side ──
  // An expense on batch 1, through the REAL layer Expenses save path, so the
  // expense side of the partition is whatever that screen actually writes.
  // sql.js implicitly bound missing trailing arguments as NULL; PG requires
  // the two payment fields to be supplied explicitly. Fixture values stay NULL.
  await runSql(sqlContaining(LE_SRC, 'INSERT INTO expenses (flock_id, date, category'),
    [1, '2026-03-05', 'Transport', 'Egg crates to town', 4000, null, null, null])
  await runSql(`INSERT INTO egg_sales (batch_id, date, quantity, rate_per_egg, total_amount)
          VALUES (1,'2026-03-06',10000,18,180000)`)
  return db
}

const scratch = await createScratchDb('layer_ledger')
db = scratch.db
try {
  await seed()

  let failures = 0
  const check = (label, actual, expected) => {
    const ok = Number(actual) === Number(expected)
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
  }
  const assert = (label, ok) => {
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  }

  // ── the figures, computed the way each consumer computes them ─────────────
  // overview.service.ts — the real SQL, per unit, summed like this.sum() does.
  const ovLayerLedger = async () =>
    (await rows(db, OV_LAYER_LEDGER_SQL, [1])).reduce((s, r) => s + Number(r.amount || 0), 0)
  const ovBroilerLedger = async () => {
    const [sql, params] = loadOverviewMethod('qLedgerDebits').call(overviewContext, 1, {})
    return (await rows(db, sql, params)).reduce((s, r) => s + Number(r.amount || 0), 0)
  }
  const ovLayerGeneral = async () => (await scalar(db,
    `SELECT COALESCE(SUM(e.amount),0) v FROM expenses e
     JOIN batches b ON b.batch_id = e.flock_id
     WHERE b.farm_id = 1 AND e.module_type = 'layer'`))
  const ovBroilerGeneral = async () => (await scalar(db,
    `SELECT COALESCE(SUM(e.amount),0) v FROM expenses e
     JOIN flocks f ON f.flock_id = e.flock_id
     WHERE f.farm_id = 1 AND COALESCE(e.module_type,'broiler') = 'broiler'`))

  // farm-report.service.ts — buildQuery() assembled from the extracted spec,
  // for the layer module (which joins `batches o`), unit 1.
  const s = FR_LAYER_LEDGER_SPEC
  const FR_LAYER_SQL =
    `SELECT o.batch_id AS owner_id, COALESCE(SUM(${s.amount}),0) AS amount, COUNT(*) AS row_count
     FROM ${s.table} ${s.alias}
     JOIN batches o ON o.batch_id = ${s.alias}.${s.ownerCol}
     WHERE o.farm_id = ? AND o.unit_id = ? AND ${s.where}
     GROUP BY o.batch_id`
  const frLayerLedger = async () =>
    (await rows(db, FR_LAYER_SQL, [1, 1])).reduce((acc, r) => acc + Number(r.amount || 0), 0)

  console.log('=== BEFORE — no layer ledger exists yet ===')
  const before = {
    ovLayerLedger: (await ovLayerLedger()),
    ovLayerGeneral: (await ovLayerGeneral()),
    ovBroilerLedger: (await ovBroilerLedger()),
    ovBroilerGeneral: (await ovBroilerGeneral())
  }
  check('Overview — layer ledgerDebits', before.ovLayerLedger, 0)
  check('Overview — layer general (expenses)', before.ovLayerGeneral, 4000)
  check('Overview — broiler ledgerDebits', before.ovBroilerLedger, 3000)
  check('Overview — broiler general (expenses)', before.ovBroilerGeneral, 9000)
  check('layer Report — Ledger Debit', (await reportLedgerDebit(db, 'all')), 0)

  console.log('\n=== the screen writes its book: the WORKED EXAMPLE ===')
  // Batch 1 gets a ledger with two debits and one credit. The credit is the trap:
  // it is money back, not a cost, and must never be subtracted.
  const layerLedgerId = (await runSql(SCREEN_LEDGER_INSERT, [1, 1, 'Generator'])).lastId
  await runSql(SCREEN_ENTRY_INSERT, [layerLedgerId, 1, '2026-03-07', 'Diesel for generator', 5000, 'debit'])
  await runSql(SCREEN_ENTRY_INSERT, [layerLedgerId, 1, '2026-03-08', 'Generator servicing', 2000, 'debit'])
  await runSql(SCREEN_ENTRY_INSERT, [layerLedgerId, 1, '2026-03-09', 'Spares returned', 800, 'credit'])
  // Batch 2 gets its own ledger, so per-batch scoping is exercised too.
  const batch2LedgerId = (await runSql(SCREEN_LEDGER_INSERT, [2, 1, 'Transport'])).lastId
  await runSql(SCREEN_ENTRY_INSERT, [batch2LedgerId, 2, '2026-03-10', 'Truck hire', 1500, 'debit'])

  //   layer expenses (expenses, module_type='layer')       4,000
  //   layer ledger debits (layer_ledger_entries)           7,000   = 5,000 + 2,000
  //   layer ledger credit, NOT a cost                       (800)  excluded
  //   ── layer module cost, batch 1                       11,000
  //   batch 2 ledger debit                                 1,500
  //   ── layer module cost, whole account                 12,500
  console.log('\n=== the layer figures, and nothing counted twice ===')
  check('Overview — layer ledgerDebits', (await ovLayerLedger()), 8500)
  check('Overview — layer general is UNMOVED by the ledger', (await ovLayerGeneral()), before.ovLayerGeneral)
  check('farm-report — layer ledgerDebits (unit 1)', (await frLayerLedger()), 8500)
  check('farm-report agrees with Overview', (await frLayerLedger()), (await ovLayerLedger()))
  check('layer Report — Ledger Debit, all batches', (await reportLedgerDebit(db, 'all')), 8500)
  check('layer Report — Ledger Debit, batch 1 only', (await reportLedgerDebit(db, 1)), 7000)
  check('layer Report — Ledger Debit, batch 2 only', (await reportLedgerDebit(db, 2)), 1500)

  // THE PARTITION. Each row is claimed by exactly one side, so the sum of the two
  // sides equals the sum over both tables with no row seen twice and none lost.
  const everyLayerCost =
    (await scalar(db, `SELECT COALESCE(SUM(amount),0) v FROM expenses
                WHERE flock_id IN (1,2) AND module_type = 'layer'`)) +
    (await scalar(db, `SELECT COALESCE(SUM(amount),0) v FROM layer_ledger_entries
                WHERE batch_id IN (1,2) AND type = 'debit'`))
  check('expense side + ledger side = every layer cost', (await ovLayerGeneral()) + (await ovLayerLedger()), everyLayerCost)
  check('and that is 12,500', everyLayerCost, 12500)
  check('the credit was never subtracted', (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM layer_ledger_entries WHERE type = 'credit'`)), 800)

  // The screen's own list query and the report's must see the same debits, or the
  // same figure reads two ways depending on which screen you are on.
  const screenDebits = (await rows(db, SCREEN_ENTRIES_LIST, [layerLedgerId]))
    .filter(e => e.type === 'debit').reduce((acc, e) => acc + e.amount, 0)
  check('the screen and the Report agree on batch 1', screenDebits, (await reportLedgerDebit(db, 1)))
  check('the ledger card total is debits + credits', (await scalar(db,
    `SELECT COALESCE(total,0) v FROM (${SCREEN_LEDGERS_LIST.replace(/\?/, '1')}) WHERE ledger_id = ${layerLedgerId}`)),
    7800)

  console.log('\n=== THE COLLISION — batch 1 and broiler flock 1 share id 1 ===')
  // This is the whole reason for the parallel tables. Nothing the layer ledger
  // holds may reach the broiler book, and vice versa, even though the ids match.
  check('Overview — broiler ledgerDebits is UNMOVED', (await ovBroilerLedger()), before.ovBroilerLedger)
  check('Overview — broiler general is UNMOVED', (await ovBroilerGeneral()), before.ovBroilerGeneral)
  check('the broiler ledger still holds only its own 2 rows', (await scalar(db,
    `SELECT COUNT(*) v FROM ledger_entries WHERE flock_id = 1`)), 2)
  check('the layer ledger holds only its own 3 rows on batch 1', (await scalar(db,
    `SELECT COUNT(*) v FROM layer_ledger_entries WHERE batch_id = 1`)), 3)
  assert('the two books are in different tables, so no id can be in both',
    (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries WHERE amount IN (5000,2000,800)`)) === 0 &&
    (await scalar(db, `SELECT COUNT(*) v FROM layer_ledger_entries WHERE amount IN (3000,1000)`)) === 0)

  console.log('\n=== edit and delete touch the layer book and nothing else ===')
  const broilerRowsBefore = (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`))
  const expenseRowsBefore = (await scalar(db, `SELECT COUNT(*) v FROM expenses`))
  const servicingId = (await rows(db,
    `SELECT entry_id FROM layer_ledger_entries WHERE description = 'Generator servicing'`))[0].entry_id
  await runSql(SCREEN_ENTRY_UPDATE, ['2026-03-08', 'Generator servicing', 2500, 'debit', servicingId])
  check('the edit saved', (await ovLayerLedger()), 9000)
  check('no broiler ledger row moved', (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`)), broilerRowsBefore)
  check('no expense row moved', (await scalar(db, `SELECT COUNT(*) v FROM expenses`)), expenseRowsBefore)
  check('broiler ledgerDebits STILL unmoved', (await ovBroilerLedger()), before.ovBroilerLedger)

  await runSql(SCREEN_ENTRY_DELETE, [servicingId])
  check('the delete reversed it', (await ovLayerLedger()), 6500)
  check('layer general untouched by the entry delete', (await ovLayerGeneral()), before.ovLayerGeneral)

  console.log('\n=== deleting a ledger takes its entries, and only those ===')
  await runSql(LEDGER_DEL_ENTRIES, [batch2LedgerId])
  await runSql(LEDGER_DEL_LEDGER, [batch2LedgerId])
  check('batch 2 ledger gone', (await scalar(db,
    `SELECT COUNT(*) v FROM layer_ledgers WHERE ledger_id = ?`, [batch2LedgerId])), 0)
  check('its entries gone with it', (await scalar(db,
    `SELECT COUNT(*) v FROM layer_ledger_entries WHERE ledger_id = ?`, [batch2LedgerId])), 0)
  check('batch 1 ledger untouched', (await ovLayerLedger()), 5000)
  check('no expense row went with it', (await scalar(db, `SELECT COUNT(*) v FROM expenses`)), expenseRowsBefore)

  console.log('\n=== the batch delete cascade reaches both tables ===')
  // The real two statements out of batch-management's runBatch, on batch 1 — the
  // colliding id. The broiler flock's ledger must survive intact.
  await runSql(CASCADE_ENTRIES, [1])
  await runSql(CASCADE_LEDGERS, [1])
  check('batch 1 ledger entries gone', (await scalar(db,
    `SELECT COUNT(*) v FROM layer_ledger_entries WHERE batch_id = 1`)), 0)
  check('batch 1 ledgers gone', (await scalar(db,
    `SELECT COUNT(*) v FROM layer_ledgers WHERE batch_id = 1`)), 0)
  check('Overview — layer ledgerDebits back to zero', (await ovLayerLedger()), 0)
  check('broiler flock 1 ledger SURVIVED the colliding delete', (await scalar(db,
    `SELECT COUNT(*) v FROM ledger_entries WHERE flock_id = 1`)), 2)
  check('Overview — broiler ledgerDebits unmoved to the last', (await ovBroilerLedger()), before.ovBroilerLedger)
  check('and the Report reads zero too', (await reportLedgerDebit(db, 'all')), 0)

  console.log('\n=== structural: what must be true of the source ===')
  assert('createTables creates both tables',
    /CREATE TABLE IF NOT EXISTS layer_ledgers\b/.test(DB_SRC) &&
    /CREATE TABLE IF NOT EXISTS layer_ledger_entries\b/.test(DB_SRC))
  assert('both are in PRIMARY_KEY_MAP, or lastId comes back null',
    /layer_ledgers:\s*'ledger_id'/.test(DB_SRC) &&
    /layer_ledger_entries:\s*'entry_id'/.test(DB_SRC))
  assert('every alterStatement for them is idempotent (IF NOT EXISTS)',
    alterStatements
      .filter(sql => /layer_ledger/.test(sql))
      .every(sql => /IF NOT EXISTS/i.test(sql)))
  assert('the batch delete cascade covers both tables',
    /DELETE FROM layer_ledger_entries\s+WHERE batch_id = \?/.test(BM_SRC) &&
    /DELETE FROM layer_ledgers\s+WHERE batch_id = \?/.test(BM_SRC))
  assert('no module_type was retrofitted onto ledgers / ledger_entries',
    !/ALTER TABLE ledgers ADD COLUMN module_type/.test(DB_SRC) &&
    !/ALTER TABLE ledger_entries ADD COLUMN module_type/.test(DB_SRC))
  assert('the layer ledger never writes `expenses`',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+expenses\b/.test(LL_SRC))
  assert('the layer Expenses screen never writes a layer ledger row',
    !/layer_ledger/.test(LE_SRC))
  assert('nothing auto-creates a layer ledger named "Other"',
    !/INSERT INTO layer_ledgers[\s\S]{0,80}'Other'/.test(LL_SRC))
  assert('the layer Report subtracts the ledger debit from profit',
    /netProfitLoss[\s\S]{0,400}?this\.totalLedgerDebit/.test(LR_SRC))
  assert('overview.service.ts adds it to the LAYER module total',
    /layerExpenseTotal\s*=[\s\S]{0,300}?this\.sum\(layerLedgerDebits\)/.test(OV_SRC))
  assert('...and to the per-farm layer breakdown',
    /layerExpenses:\s*\[[\s\S]{0,200}?layerLedgerDebits/.test(OV_SRC))
  assert('farm-report.service.ts picks the layer spec for the layer module',
    /layer \? this\.specLayerLedgerDebits\(\) : this\.specLedgerDebits\(\)/.test(FR_SRC))
  // Multi-row writes go through runBatch: one file write, and no half-saved set.
  assert('the multi-row save is one runBatch, not a run() per row',
    /runBatch\([\s\S]{0,400}?INSERT INTO layer_ledger_entries/.test(LL_SRC))
  assert('the ledger delete is one runBatch of entries-then-ledger',
    /runBatch\(\[[\s\S]{0,400}?DELETE FROM layer_ledger_entries WHERE ledger_id[\s\S]{0,300}?DELETE FROM layer_ledgers WHERE ledger_id/.test(LL_SRC))
  assert('every write checks .success',
    (LL_SRC.match(/result\??\.success/g) || []).length >= 5)
  assert('dates go through toLocalDateString(), never toISOString()',
    /toLocalDateString\(\)/.test(LL_SRC) && !/toISOString\(/.test(LL_SRC))
  assert('the delete-code dialog gates both deletes',
    /showDeleteLedgerCodeDialog/.test(LL_SRC) && /showDeleteEntryCodeDialog/.test(LL_SRC))
  // Values reach SQL as params, never interpolated — the renderer is trusted by
  // the main process, so an interpolated value is a real injection.
  assert('no SQL string in the screen interpolates a value',
    !/(INSERT INTO|UPDATE|DELETE FROM|SELECT)[^`]*\$\{/.test(LL_SRC))

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await scratch.close()
}
