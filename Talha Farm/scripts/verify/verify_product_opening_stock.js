// A new product's opening stock must land, or the save must fail loudly.
//
// Inventory's new-product save wrote the `products` row and then asked for its
// id with a SEPARATE `SELECT last_insert_rowid()`. That round trip cannot work
// here: runQuery() writes the file through saveDatabase() -> db.export(), and
// db.export() closes and re-opens the sql.js connection (the same property
// saveDatabase() already documents for open transactions). On the re-opened
// connection last_insert_rowid() is 0 — falsy — so `if (productId)` was never
// entered, no batch and no stock-in row were written, and nothing reported it.
// Enter 5 units, get a product at zero stock and no error. Reproduced on v1.0.0.
//
// Everything here runs REAL source against a real sql.js database: the schema
// from createTables/alterStatements, the REAL executeStatement/runQuery/
// saveDatabase/runBatch and the REAL begin/commit/rollback from
// electron/database.js, addBatch()/addBatchTransaction()/getTotalStock()/
// transaction() lifted out of database.service.ts, and saveNewRow() itself
// lifted out of inventory.component.ts. Nothing is a copy.
//
// saveDatabase() is the REAL one — it exports to a scratch file on disk. That
// is the whole point: every other verify script stubs it to a no-op, which is
// exactly why eighteen green scripts never saw this bug.
//
// What is proved:
//   A. THE MECHANISM — after the real runQuery(), a separate
//      `SELECT last_insert_rowid()` returns 0 while run().lastId returns the
//      true id. This is the regression lock: it fails if the harness ever stops
//      modelling the bug, so the rest of the file means something.
//   B. The save path: 5 units entered gives one products row, one
//      product_batches row of 5, one 'purchase' batch_transactions row, and a
//      derived stock of 5 read back through getTotalStock().
//   C. products.current_stock stays 0 — the batches are the source of truth and
//      the screen renders getTotalStock(), not that column.
//   D. ATOMICITY — with the batch INSERT made to fail, nothing is left behind:
//      no product, no batch, no stock-in row, no half-state. The error reaches
//      this.errorMessage and the typed draft goes back on screen.
//   E. Same again when the failure is in `batch_transactions` — a batch must
//      never commit with no record of where its stock came from.
//   F. Same again when the `products` INSERT itself fails.
//   G. Initial stock of 0 writes the product, no batch, and no error.
//   H. One save writes the database file ONCE, not once per statement.
//   I. The batch is scoped to the saving account's farm_id.
//   J. THE HELPER — addBatch() reports a failed addBatchTransaction() instead
//      of swallowing it, both when the real INSERT fails and when the result
//      alone says so with nothing thrown. Asserted on the renderer helper in
//      database.service.ts AND on its twin in electron/database.js, which has
//      no caller today but had the identical defect.
//   K. THE OTHER CALLER — Distribution > Batch. addBatch() reporting a failure
//      is not the same as the failure leaving nothing behind: it is still two
//      writes, and that screen called it outside any transaction, so the batch
//      row survived the report. An orphan holding stock with no record of
//      where it came from, on a screen that had just said the save failed.
//      saveBatch() is lifted whole and run against the real BEGIN/COMMIT/
//      ROLLBACK: with the stock-in row failing — by a real aborting trigger
//      AND by the mutation where only the RESULT says it failed — zero rows
//      are left in product_batches and batch_transactions, and the form stays
//      open holding what was typed. The edit path too: a failed 'adjustment'
//      row, which was not even checked before, no longer leaves the new
//      quantity committed with nothing to account for it.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const os = require('os')
const path = require('path')
const initSqlJs = require('sql.js')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const INV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'inventory', 'inventory.component.ts'), 'utf8')
const SQLERR_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'sql-error.util.ts'), 'utf8')
const DATE_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'date.util.ts'), 'utf8')
const DBATCH_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'distribution-batch', 'distribution-batch.component.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

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

function loadMethod(src, name, kw) {
  const decl = /async/.test(kw) ? 'async function ' : 'function '
  const body = extractFn(src, name, kw)
    .replace(new RegExp('^' + kw.trim().replace(/\s+/g, '\\s+') + '\\s+'), decl)
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// ── The main process, for real ──────────────────────────────────────────────
//
// These are the module-scope bindings the lifted functions close over. The
// watchdog and the poisoned-connection recovery are stubbed — neither is under
// test here, and the real watchdog would hold the process open for a minute.
let db = null
let inTransaction = false
let poisonedConnection = null
let savepointCounter = 0
const TRANSACTION_TIMEOUT_MS = 60000
const startTransactionWatchdog = () => {}
const clearTransactionWatchdog = () => {}
const clearPoison = () => { poisonedConnection = null; return true }

// The real saveDatabase() needs somewhere to write. Counting the writes is how
// assertion H is made.
const DB_FILE = path.join(os.tmpdir(), `verify_opening_stock_${process.pid}.db`)
const getDbPath = () => DB_FILE
let fileWrites = 0
const countingFs = { writeFileSync: (...args) => { fileWrites++; return fs.writeFileSync(...args) } }

// Direct eval, so each function closes over the bindings above exactly as it
// does over its own module scope in electron/database.js. A `const` declared
// inside a direct eval stays trapped in that eval's own scope, where the
// functions lifted by the later evals could not see it — `var` is what reaches
// module scope, so the one declaration here is rewritten on the way in.
eval(DB_SRC.slice(
  DB_SRC.indexOf('const PRIMARY_KEY_MAP = {'),
  DB_SRC.indexOf('\n}', DB_SRC.indexOf('const PRIMARY_KEY_MAP = {')) + 2)
  .replace('const PRIMARY_KEY_MAP', 'var PRIMARY_KEY_MAP'))
eval(extractFn(DB_SRC, 'refuseWrite', 'function '))
eval(extractFn(DB_SRC, 'executeStatement', 'function '))
eval(extractFn(DB_SRC, 'resolveBatchParams', 'function '))
eval(extractFn(DB_SRC, 'runBatch', 'function '))
eval(extractFn(DB_SRC, 'getQuery', 'function '))
// The main process's own addBatch/addBatchTransaction — exported from
// database.js with no ipcMain handler and no caller today, but carrying the
// identical unchecked-result defect, so section J pins them too. They close
// over the renderer's `toLocalDateString` below; database.js has its own
// module-scope copy that deliberately mirrors date.util.ts, and the date is not
// what section J is testing.
eval(extractFn(DB_SRC, 'getLastInsertId', 'function '))
eval(extractFn(DB_SRC, 'addBatchTransaction', 'function '))
eval(extractFn(DB_SRC, 'addBatch', 'function '))
eval(extractFn(DB_SRC, 'beginTransaction', 'function '))
eval(extractFn(DB_SRC, 'commitTransaction', 'function '))
eval(extractFn(DB_SRC, 'performRollback', 'function '))
eval(extractFn(DB_SRC, 'rollbackTransaction', 'function '))
// saveDatabase() is lifted whole, with `fs` swapped for the counting wrapper so
// its db.export() runs for real and the writes can be counted.
eval(extractFn(DB_SRC, 'saveDatabase', 'function ').replace('fs.writeFileSync', 'countingFs.writeFileSync'))
eval(extractFn(DB_SRC, 'runQuery', 'function '))

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// ── The renderer, for real ──────────────────────────────────────────────────

// Both utils the save path reaches for, lifted rather than reimplemented.
// friendlySqlError() closes over the module's own pattern, so that comes too —
// it is what decides whether raw driver text reaches the user or is swapped for
// the fallback, which assertion D reads.
eval(SQLERR_SRC.slice(SQLERR_SRC.indexOf('const SQL_ERROR_PATTERN'),
  SQLERR_SRC.indexOf('\n', SQLERR_SRC.indexOf('const SQL_ERROR_PATTERN')))
  .replace('const SQL_ERROR_PATTERN', 'var SQL_ERROR_PATTERN'))
const friendlySqlError = loadMethod(SQLERR_SRC, 'friendlySqlError', 'export function ')
const toLocalDateString = loadMethod(DATE_SRC, 'toLocalDateString', 'export function ')

// DatabaseService. run/get/runBatch/begin/commit/rollback are the IPC hops —
// here they call straight into the real main-process functions above, which is
// precisely what preload.js arranges in the app.
const svc = {
  async run(sql, params = []) { return runQuery(sql, params) },
  async get(sql, params = []) { return getQuery(sql, params) },
  async runBatch(ops) { return runBatch(ops) },
  async beginTransaction() { return beginTransaction() },
  async commitTransaction() { return commitTransaction() },
  async rollbackTransaction() { return rollbackTransaction() },

  // `transaction` is generic, so its name carries the type parameter here.
  transaction:         loadMethod(SVC_SRC, 'transaction<T>', 'async '),
  addBatch:            loadMethod(SVC_SRC, 'addBatch', 'async '),
  updateBatch:         loadMethod(SVC_SRC, 'updateBatch', 'async '),
  addBatchTransaction: loadMethod(SVC_SRC, 'addBatchTransaction', 'async '),
  getTotalStock:       loadMethod(SVC_SRC, 'getTotalStock', 'async ')
}

// InventoryComponent, with only what saveNewRow() actually touches.
const cleared = []
let reloads = 0
const screen = {
  db: svc,
  currentFarm: { farm_id: 1 },
  errorMessage: '',
  isSaving: false,
  showNewRow: false,
  FORM_KEY: INV_SRC.match(/FORM_KEY\s*=\s*'([^']+)'/)[1],
  formState: { clearState: (key) => cleared.push(key) },
  cdr: { detectChanges: () => {} },
  loadProducts: async () => { reloads++ },
  assertOk:   loadMethod(INV_SRC, 'assertOk', 'private '),
  saveNewRow: loadMethod(INV_SRC, 'saveNewRow', 'async ')
}

const save = async (newRow) => {
  screen.newRow = {
    product_name: '', category: '', unit: '', current_stock: null,
    expiry_date: '', min_stock_alert: null, cost_price: null, selling_price: null,
    ...newRow
  }
  screen.showNewRow = true
  screen.errorMessage = ''
  cleared.length = 0
  fileWrites = 0
  await screen.saveNewRow()
  return {
    error: screen.errorMessage,
    draftBack: screen.showNewRow,
    cleared: cleared.length,
    writes: fileWrites
  }
}

// ── Assertions ──────────────────────────────────────────────────────────────

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
const scalar = (sql, params = []) => {
  const stmt = db.prepare(sql); stmt.bind(params)
  const v = stmt.step() ? Object.values(stmt.getAsObject())[0] : null
  stmt.free(); return v
}
const rows = (sql, params = []) => {
  const out = []; const stmt = db.prepare(sql); stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free(); return out
}

const products = () => Number(scalar('SELECT COUNT(*) FROM products'))
const batches = () => Number(scalar('SELECT COUNT(*) FROM product_batches'))
const stockIns = () => Number(scalar('SELECT COUNT(*) FROM batch_transactions'))
const wipe = () => {
  db.run('DELETE FROM batch_transactions')
  db.run('DELETE FROM product_batches')
  db.run('DELETE FROM products')
}
// Nothing may point at a parent that is gone: foreign keys are declared but
// `PRAGMA foreign_keys` is never switched on, so only a check like this sees it.
const orphans = () => Number(scalar(
  `SELECT COUNT(*) FROM batch_transactions bt
     WHERE NOT EXISTS (SELECT 1 FROM product_batches b WHERE b.batch_id = bt.batch_id)
        OR NOT EXISTS (SELECT 1 FROM products p WHERE p.product_id = bt.product_id)`))

// Failure injection. A BEFORE INSERT trigger that aborts is the cleanest way to
// make one specific write fail while leaving every other statement working.
const breakTable = (table) => db.run(
  `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table}
   BEGIN SELECT RAISE(ABORT, 'injected failure on ${table}'); END`)
const unbreak = (table) => db.run(`DROP TRIGGER IF EXISTS fail_${table}`)

const oneYearOut = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 1)
  return toLocalDateString(d)
}

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }
  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
  saveDatabase(DB_FILE)

  console.log('=== A. the mechanism: last_insert_rowid() after the real runQuery ===')
  // Exactly what the old code did, outside any transaction, as it ran.
  const direct = runQuery(
    'INSERT INTO products (farm_id, product_name, category, unit, current_stock) VALUES (?,?,?,?,?)',
    [1, 'Mechanism Probe', 'feed', 'bag', 0])
  const roundTrip = getQuery('SELECT last_insert_rowid() as id', [])
  const realId = Number(scalar(`SELECT product_id FROM products WHERE product_name = 'Mechanism Probe'`))
  check('run() hands back the real id', direct.lastId, realId)
  check('a separate SELECT last_insert_rowid() hands back 0', roundTrip.data[0].id, 0)
  checkTrue('...so `if (productId)` was false and the batch block was skipped', !roundTrip.data[0].id)
  console.log(`  (db.export() closed and re-opened the connection; the true id was ${realId})`)
  wipe()

  console.log('\n=== B. 5 units entered, through the real saveNewRow() ===')
  let r = await save({
    product_name: 'Test', category: 'feed', unit: 'bag',
    current_stock: 5, cost_price: 100, selling_price: 150
  })
  check('no error surfaced', r.error || '(none)', '(none)')
  check('one products row', products(), 1)
  check('one product_batches row', batches(), 1)
  check('one batch_transactions row', stockIns(), 1)
  const pid = Number(scalar('SELECT product_id FROM products'))
  const batch = rows('SELECT * FROM product_batches')[0]
  check('the batch holds the entered quantity', batch.quantity, 5)
  check('the batch carries the cost price', batch.purchase_price, 100)
  check('the batch is active', batch.status, 'active')
  check('expiry defaults a year out', batch.expiry_date, oneYearOut())
  const stockIn = rows('SELECT * FROM batch_transactions')[0]
  check('the stock-in row is a purchase', stockIn.type, 'purchase')
  check('the stock-in row records the quantity', stockIn.quantity, 5)
  check('the stock-in row is tied to the batch', stockIn.batch_id, batch.batch_id)
  check('the stock-in row is tied to the product', stockIn.product_id, pid)
  check('nothing is orphaned', orphans(), 0)

  console.log('\n=== C. the stock the screen reads back ===')
  check('getTotalStock() reads back the entered value', await svc.getTotalStock(pid), 5)
  check('products.current_stock stays 0 — batches are the source of truth',
    scalar('SELECT current_stock FROM products WHERE product_id = ?', [pid]), 0)

  console.log('\n=== H. one save, one file write ===')
  check('the whole save wrote the file once', r.writes, 1)
  check('the draft was cleared on success', r.cleared, 1)
  check('the draft row is gone from the screen', r.draftBack, false)

  console.log('\n=== I. scoping ===')
  check('the batch belongs to the saving account', batch.farm_id, 1)
  check('and nothing landed on the other account',
    scalar('SELECT COUNT(*) FROM product_batches WHERE farm_id = 2'), 0)
  wipe()

  console.log('\n=== D. the batch INSERT fails — nothing may be left behind ===')
  breakTable('product_batches')
  r = await save({ product_name: 'Doomed', category: 'feed', unit: 'bag', current_stock: 5, cost_price: 100 })
  unbreak('product_batches')
  checkTrue('the save reports the failure', /failed/i.test(r.error), `errorMessage was ${JSON.stringify(r.error)}`)
  check('no product row survives', products(), 0)
  check('no batch row survives', batches(), 0)
  check('no stock-in row survives', stockIns(), 0)
  check('nothing is orphaned', orphans(), 0)
  checkTrue('the typed draft goes back on screen to retry', r.draftBack)
  check('the draft was NOT cleared', r.cleared, 0)
  check('nothing reached the file', r.writes, 0)
  check('the transaction is closed, not left open', inTransaction, false)

  console.log('\n=== E. the stock-in INSERT fails — no batch without its stock-in row ===')
  breakTable('batch_transactions')
  r = await save({ product_name: 'Half Doomed', category: 'feed', unit: 'bag', current_stock: 5, cost_price: 100 })
  unbreak('batch_transactions')
  checkTrue('the save reports the failure', /failed|not recorded/i.test(r.error), `errorMessage was ${JSON.stringify(r.error)}`)
  check('no product row survives', products(), 0)
  check('no batch is committed without its stock-in row', batches(), 0)
  check('no stock-in row survives', stockIns(), 0)
  checkTrue('the typed draft goes back on screen to retry', r.draftBack)
  check('nothing reached the file', r.writes, 0)
  check('the transaction is closed, not left open', inTransaction, false)

  console.log('\n=== F. the products INSERT itself fails ===')
  breakTable('products')
  r = await save({ product_name: 'Never Born', category: 'feed', unit: 'bag', current_stock: 5, cost_price: 100 })
  unbreak('products')
  checkTrue('the save reports the failure', /failed/i.test(r.error), `errorMessage was ${JSON.stringify(r.error)}`)
  check('no product row survives', products(), 0)
  check('no batch row survives', batches(), 0)
  check('no stock-in row survives', stockIns(), 0)
  checkTrue('the typed draft goes back on screen to retry', r.draftBack)
  check('the transaction is closed, not left open', inTransaction, false)

  console.log('\n=== G. no opening stock — a product with no batch is legitimate ===')
  r = await save({ product_name: 'Empty', category: 'feed', unit: 'bag', current_stock: null, cost_price: 100 })
  check('no error surfaced', r.error || '(none)', '(none)')
  check('one products row', products(), 1)
  check('no batch', batches(), 0)
  check('no stock-in row', stockIns(), 0)
  check('derived stock is 0', await svc.getTotalStock(Number(scalar('SELECT product_id FROM products'))), 0)
  check('the draft was cleared on success', r.cleared, 1)
  wipe()

  r = await save({ product_name: 'Zero', category: 'feed', unit: 'bag', current_stock: 0, cost_price: 100 })
  check('an explicit 0 behaves the same way', r.error || '(none)', '(none)')
  check('and writes no batch', batches(), 0)
  wipe()

  console.log('\n=== J. addBatch() reports a failed stock-in instead of swallowing it ===')
  // Straight at the helper this time, not through the screen: the screen's own
  // read-back (section E) would mask a helper that still lied.
  runQuery('INSERT INTO products (farm_id, product_name, category, unit, current_stock) VALUES (?,?,?,?,?)',
    [1, 'Helper Probe', 'feed', 'bag', 0])
  const probeId = Number(scalar(`SELECT product_id FROM products WHERE product_name = 'Helper Probe'`))
  const batchArgs = () => ({
    product_id: probeId, farm_id: 1, manufacturing_date: '2026-01-01',
    expiry_date: '2027-01-01', quantity: 7, purchase_price: 50
  })
  const clearBatches = () => {
    db.run('DELETE FROM batch_transactions')
    db.run('DELETE FROM product_batches')
  }

  console.log('  -- the real stock-in INSERT fails --')
  breakTable('batch_transactions')
  let h = await svc.addBatch(batchArgs())
  unbreak('batch_transactions')
  check('the renderer helper reports the failure', h.success, false)
  checkTrue('and says why', /injected failure|stock-in/i.test(h.error || ''), `error was ${JSON.stringify(h.error)}`)
  check('no stock-in row was written', stockIns(), 0)
  checkTrue('it does not hand back a batch_id it cannot stand behind', !h.batch_id)
  // Honest about what this does NOT fix: addBatch is two run() calls, not one
  // atom, so the batch row it already wrote is still there. That is precisely
  // why every caller wraps it — section E shows the screen's path, inside a
  // db.transaction(), leaving nothing behind at all.
  check('the batch row it already wrote survives, so callers must use a transaction', batches(), 1)
  clearBatches()

  console.log('  -- THE MUTATION: nothing throws, only the result says it failed --')
  // This is the exact shape of the bug. The INSERT would have succeeded; the
  // helper is simply told it did not. A helper that relies on an exception
  // passes section E and fails here.
  const realAddBatchTransaction = svc.addBatchTransaction
  svc.addBatchTransaction = async () => ({ success: false, error: 'mutated: stock-in refused' })
  h = await svc.addBatch(batchArgs())
  svc.addBatchTransaction = realAddBatchTransaction
  check('the helper reports a failure nothing threw for', h.success, false)
  check('and passes the reason straight through', h.error, 'mutated: stock-in refused')
  clearBatches()

  console.log('  -- and a clean call still succeeds --')
  h = await svc.addBatch(batchArgs())
  check('success', h.success, true)
  check('one batch', batches(), 1)
  check('one stock-in row', stockIns(), 1)
  check('the batch id comes back', h.batch_id, scalar('SELECT batch_id FROM product_batches'))
  check('the batch code comes back', h.batch_code, scalar('SELECT batch_code FROM product_batches'))
  clearBatches()

  console.log('  -- the twin in electron/database.js, which had the same defect --')
  breakTable('batch_transactions')
  let m = addBatch(batchArgs())
  unbreak('batch_transactions')
  check('the main-process helper reports the failure', m.success, false)
  checkTrue('and says why', /injected failure|stock-in/i.test(m.error || ''), `error was ${JSON.stringify(m.error)}`)
  check('no stock-in row was written', stockIns(), 0)
  checkTrue('it does not hand back a batch_id it cannot stand behind', !m.batch_id)
  clearBatches()
  m = addBatch(batchArgs())
  check('and a clean call still succeeds', m.success, true)
  check('one batch', batches(), 1)
  check('one stock-in row', stockIns(), 1)
  check('the batch id comes back', m.batch_id, scalar('SELECT batch_id FROM product_batches'))


  console.log('\n=== K. the Distribution > Batch screen leaves NO orphan batch ===')
  // addBatch() reports a failed stock-in row rather than swallowing it
  // (section J), but it is still two writes and not atomic on its own. This
  // screen called it outside any transaction, so the report arrived and the
  // batch row stayed behind: an orphan holding stock with no record of where
  // it came from, on a screen that had just said the save failed. saveBatch()
  // is lifted whole out of distribution-batch.component.ts and run against the
  // real main process, including the real BEGIN/COMMIT/ROLLBACK.

  // DistributionBatchComponent, with only what saveBatch() touches.
  const batchScreen = {
    db: svc,
    productId: probeId,
    farmId: 1,
    batches: [],
    isLoading: false,
    errorMessage: '',
    showBatchForm: true,
    isEditing: false,
    editingBatchId: null,
    batchForm: {},
    loadBatches: async () => { batchScreen.batches = rows('SELECT * FROM product_batches') },
    assertOk:  loadMethod(DBATCH_SRC, 'assertOk', 'private '),
    saveBatch: loadMethod(DBATCH_SRC, 'saveBatch', 'async ')
  }

  const saveNewBatch = async (form = {}) => {
    batchScreen.isEditing = false
    batchScreen.editingBatchId = null
    batchScreen.showBatchForm = true
    batchScreen.errorMessage = ''
    batchScreen.batchForm = {
      manufacturing_date: '2026-01-01', expiry_date: '2027-01-01',
      quantity: 9, purchase_price: 60, ...form
    }
    await batchScreen.saveBatch()
    return { error: batchScreen.errorMessage, formOpen: batchScreen.showBatchForm }
  }

  clearBatches()

  console.log('  -- THE BUG: the stock-in row fails --')
  breakTable('batch_transactions')
  let b = await saveNewBatch()
  unbreak('batch_transactions')
  checkTrue('the user is told the save failed', !!b.error, `error was ${JSON.stringify(b.error)}`)
  checkTrue('and the reason reaches them', /injected failure|stock-in|batch/i.test(b.error || ''), b.error)
  check('THE FIX: zero product_batches rows for the attempted batch', batches(), 0)
  check('and zero batch_transactions rows', stockIns(), 0)
  check('no orphan rows of any kind', orphans(), 0)
  checkTrue('the form stays open holding what was typed', b.formOpen)
  clearBatches()

  console.log('  -- the mutation: nothing throws, only the result says it failed --')
  // The shape no exception-based check would catch: the INSERT would have
  // worked, the helper is simply told it did not. This is what the prompt's
  // mutation assertion asks for, and the rollback has to be driven by the
  // RESULT, not by a thrown error.
  const realAddBatchTransaction2 = svc.addBatchTransaction
  svc.addBatchTransaction = async () => ({ success: false, error: 'mutated: stock-in refused' })
  b = await saveNewBatch()
  svc.addBatchTransaction = realAddBatchTransaction2
  checkTrue('the save is reported as failed', !!b.error, `error was ${JSON.stringify(b.error)}`)
  check('and passes the reason through', /mutated: stock-in refused/.test(b.error || '') ? 1 : 0, 1)
  check('zero product_batches rows', batches(), 0)
  check('zero batch_transactions rows', stockIns(), 0)
  clearBatches()

  console.log('  -- the batch row itself fails --')
  breakTable('product_batches')
  b = await saveNewBatch()
  unbreak('product_batches')
  checkTrue('reported', !!b.error, `error was ${JSON.stringify(b.error)}`)
  check('nothing written', batches(), 0)
  check('and no stray stock-in row', stockIns(), 0)
  clearBatches()

  console.log('  -- a clean save writes both rows and closes the form --')
  b = await saveNewBatch()
  check('no error', b.error || '(none)', '(none)')
  check('one batch', batches(), 1)
  check('one stock-in row', stockIns(), 1)
  check("and it is the 'purchase' row recording where the stock came from",
    scalar(`SELECT COUNT(*) FROM batch_transactions WHERE type = 'purchase'`), 1)
  check('of the quantity entered', scalar('SELECT quantity FROM product_batches'), 9)
  checkTrue('the form closed', !b.formOpen)
  checkTrue('and the list was re-read', batchScreen.batches.length === 1)

  console.log('  -- EDITING: the quantity change and its audit row are one movement --')
  const editedId = Number(scalar('SELECT batch_id FROM product_batches'))
  const editBatch = async (quantity) => {
    batchScreen.batches = rows('SELECT * FROM product_batches')
    batchScreen.isEditing = true
    batchScreen.editingBatchId = editedId
    batchScreen.showBatchForm = true
    batchScreen.errorMessage = ''
    batchScreen.batchForm = {
      manufacturing_date: '2026-01-01', expiry_date: '2027-01-01',
      quantity, purchase_price: 60
    }
    await batchScreen.saveBatch()
    return { error: batchScreen.errorMessage, formOpen: batchScreen.showBatchForm }
  }

  // The 'adjustment' row was not even checked before: a failed one left the
  // new quantity committed with nothing on the audit trail to account for it.
  breakTable('batch_transactions')
  b = await editBatch(40)
  unbreak('batch_transactions')
  checkTrue('a failed adjustment row is reported', !!b.error, `error was ${JSON.stringify(b.error)}`)
  check('THE FIX: the quantity is NOT left changed', scalar('SELECT quantity FROM product_batches'), 9)
  check('and no adjustment row was written',
    scalar(`SELECT COUNT(*) FROM batch_transactions WHERE type = 'adjustment'`), 0)

  b = await editBatch(40)
  check('a clean edit succeeds', b.error || '(none)', '(none)')
  check('the quantity changed', scalar('SELECT quantity FROM product_batches'), 40)
  check('and one adjustment row explains it',
    scalar(`SELECT COUNT(*) FROM batch_transactions WHERE type = 'adjustment'`), 1)
  check('for the difference', scalar(`SELECT quantity FROM batch_transactions WHERE type = 'adjustment'`), 31)
  clearBatches()

  try { fs.unlinkSync(DB_FILE) } catch (e) {}
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => { console.error(err); process.exit(1) })
