// Deleting a product must not rewrite history, and must not orphan anything.
//
// The Inventory delete used to be two loose `run()` calls — product_batches,
// then products — with neither result checked and `batch_transactions` never
// touched, so it took the cost side of bills that were already in the reports
// and left transactions pointing at batches that no longer existed.
//
// Everything here runs REAL source against a real sql.js database — the schema
// from createTables/alterStatements, the atomic writer from runBatch(), and
// deleteProduct()/deleteBatch() lifted out of database.service.ts, with the
// COGS query lifted out of overview.service.ts. Nothing is a copy.
//
// What is proved:
//   A. A product that was never traded deletes cleanly: product, batches and
//      their stock-in rows all go, in one batch, leaving nothing orphaned.
//   B. THE REFUSAL — a product with a bill line, a sales return, a purchase
//      order, a legacy sales order or a non-purchase batch movement is refused,
//      one blocker at a time, and nothing is written on a refusal.
//   C. THE REASON — deleting a sold product would have moved reported profit.
//      Overview's COGS is measured before and after a refused delete and after
//      the cascade the old code would have run, showing exactly what the refusal
//      is protecting.
//   D. Atomicity — a batch that cannot complete leaves the product intact.
//   E. Scoping — a product belonging to another account is not deleted.
//   F. Consistency with deleteBatch(), which already refuses to hard-delete a
//      single batch that has transactions.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const OV_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

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

let db = null
let poisonedConnection = false
let inTransaction = false
let savepointCounter = 0
const startTransactionWatchdog = () => {}
const clearTransactionWatchdog = () => {}
const saveDatabase = () => {}
const getDbPath = () => ':memory:'
const refuseWrite = (what) => ({ success: false, error: `refused ${what}` })

const PRIMARY_KEY_MAP = eval(
  DB_SRC.slice(DB_SRC.indexOf('const PRIMARY_KEY_MAP = {'), DB_SRC.indexOf('\n}', DB_SRC.indexOf('const PRIMARY_KEY_MAP = {')) + 2)
    .replace('const PRIMARY_KEY_MAP =', '(') + ')')

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const executeStatement = eval('(' + extractFn(DB_SRC, 'executeStatement', 'function ') + ')')
const resolveBatchParams = eval('(' + extractFn(DB_SRC, 'resolveBatchParams', 'function ') + ')')
const runBatch = eval('(' + extractFn(DB_SRC, 'runBatch', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

function rows(sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

global.toLocalDateString = () => '2025-06-01'

const svc = {
  toLocalDateString: global.toLocalDateString,
  async get(sql, params = []) {
    try { return { success: true, data: rows(sql, params) } }
    catch (err) { return { success: false, error: err.message } }
  },
  async run(sql, params = []) {
    try { return { success: true, ...executeStatement(sql, params) } }
    catch (err) { return { success: false, error: err.message } }
  },
  async runBatch(ops) { return runBatch(ops) },

  addBatchTransaction: loadMethod(SVC_SRC, 'addBatchTransaction', 'async '),
  deleteBatch:         loadMethod(SVC_SRC, 'deleteBatch', 'async '),
  deleteProduct:       loadMethod(SVC_SRC, 'deleteProduct', 'async ')
}
const call = (name, ...args) => svc[name].apply(svc, args)

// Overview's COGS query, lifted whole, so "what the reports say" is measured by
// the code that says it.
const ovCtx = {
  dateClause:           loadMethod(OV_SRC, 'dateClause', 'private '),
  internalBillIdsSql:   loadMethod(OV_SRC, 'internalBillIdsSql', 'private '),
  productRateCte:       loadMethod(OV_SRC, 'productRateCte', 'private '),
  qDistributionCogs:    loadMethod(OV_SRC, 'qDistributionCogs', 'private ')
}
const cogs = (farmId = 1) => {
  const [sql, params] = ovCtx.qDistributionCogs.call(ovCtx, farmId, {})
  return Number((rows(sql, params)[0] || {}).amount || 0)
}

// ── Assertions ──────────────────────────────────────────────────────────────

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

const count = (sql, params = []) => Number(rows(sql, params)[0].c)
const productExists = (id) => count('SELECT COUNT(*) c FROM products WHERE product_id = ?', [id])
const batchCount = (id) => count('SELECT COUNT(*) c FROM product_batches WHERE product_id = ?', [id])
const txCount = (id) => count('SELECT COUNT(*) c FROM batch_transactions WHERE product_id = ?', [id])

/**
 * No `batch_transactions` row may point at a batch that is gone. Foreign keys
 * are declared but never enforced (`PRAGMA foreign_keys` is never switched on),
 * so nothing but this catches it — and the shipped delete produced exactly this.
 */
const orphanedTransactions = () => count(
  `SELECT COUNT(*) c FROM batch_transactions bt
   WHERE NOT EXISTS (SELECT 1 FROM product_batches pb WHERE pb.batch_id = bt.batch_id)`)

// ── Fixture helpers ─────────────────────────────────────────────────────────

let nextProductId = 1, nextBatchId = 1
function addProduct(name, { farmId = 1, cost = 700, sell = 1000, stock = 100 } = {}) {
  const id = nextProductId++
  db.run(`INSERT INTO products (product_id, farm_id, product_name, category, unit,
                                current_stock, cost_price, selling_price)
          VALUES (?,?,?,'feed','kg',?,?,?)`, [id, farmId, name, stock, cost, sell])
  return id
}
async function addBatch(productId, { farmId = 1, qty = 100, price = 700 } = {}) {
  const id = nextBatchId++
  db.run(`INSERT INTO product_batches (batch_id, product_id, farm_id, batch_code,
                                       manufacturing_date, expiry_date, quantity, purchase_price)
          VALUES (?,?,?,?, '2025-01-01','2030-01-01',?,?)`,
    [id, productId, farmId, `B${id}`, qty, price])
  // Stock arriving, exactly as addBatch/the migration record it.
  await call('addBatchTransaction', id, productId, 'purchase', qty, '2025-01-01', null, 'Initial batch addition')
  return id
}

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'), (2,'Other','x')`)
  db.run(`INSERT INTO customers (customer_id, farm_id, customer_name) VALUES (1,1,'Buyer')`)
  db.run(`INSERT INTO suppliers (supplier_id, farm_id, supplier_name) VALUES (1,1,'Mill')`)

  // ── A. An untraded product deletes cleanly ───────────────────────────────
  console.log('=== A. Never traded: the product, its batches and their stock-in rows all go ===')
  const fresh = addProduct('Unused Feed')
  await addBatch(fresh)
  await addBatch(fresh)
  check('two batches', batchCount(fresh), 2)
  check('two stock-in rows', txCount(fresh), 2)

  const del = await call('deleteProduct', fresh, 1)
  checkTrue('the delete was accepted', del.success === true)
  check('the product is gone', productExists(fresh), 0)
  check('its batches are gone', batchCount(fresh), 0)
  check('its stock-in rows are gone', txCount(fresh), 0)
  check('nothing was orphaned', orphanedTransactions(), 0)

  // ── B. THE REFUSAL, one blocker at a time ────────────────────────────────
  console.log('\n=== B. Each kind of history refuses the delete on its own ===')

  // A bill line. The bill is what the reports price.
  const sold = addProduct('Sold Feed')
  const soldBatch = await addBatch(sold)
  db.run(`INSERT INTO bills (bill_id, farm_id, bill_number, customer_id, customer_name, bill_date,
                             subtotal, total_amount, amount_paid, payment_type)
          VALUES (1,1,'BILL-001',1,'Buyer','2025-03-01',10000,10000,10000,'cash')`)
  db.run(`INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (1,?,'Sold Feed',10,1000,10000)`, [sold])
  await call('addBatchTransaction', soldBatch, sold, 'sale', 10, '2025-03-01', 1, 'Sale order')

  const soldRefusal = await call('deleteProduct', sold, 1)
  checkTrue('a sold product is refused', soldRefusal.success === false)
  checkTrue('the message names the bill lines', /bill line/.test(soldRefusal.error))
  checkTrue('and the stock movement', /stock movement/.test(soldRefusal.error))
  checkTrue('and names the product', /Sold Feed/.test(soldRefusal.error))
  check('the product survives', productExists(sold), 1)
  check('its batches survive', batchCount(sold), 1)
  check('its transactions survive', txCount(sold), 2)

  // A sales return line, with no bill line of its own left.
  const returned = addProduct('Returned Feed')
  await addBatch(returned)
  db.run(`INSERT INTO sales_returns (return_id, farm_id, bill_id, return_number, return_date, return_amount)
          VALUES (1,1,1,'RET-001','2025-03-05',500)`)
  db.run(`INSERT INTO sales_return_items (return_id, bill_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (1,1,?,'Returned Feed',1,500,500)`, [returned])
  const returnRefusal = await call('deleteProduct', returned, 1)
  checkTrue('a returned product is refused', returnRefusal.success === false)
  checkTrue('the message names the return', /sales return/.test(returnRefusal.error))
  check('the product survives', productExists(returned), 1)

  // A purchase order — it feeds the supplier ledger and the cost fallback.
  const bought = addProduct('Bought Feed')
  await addBatch(bought)
  db.run(`INSERT INTO purchase_orders (purchase_id, farm_id, supplier_id, product_id, date,
                                       quantity, cost_price, total_amount)
          VALUES (1,1,1,?, '2025-02-01',50,700,35000)`, [bought])
  const boughtRefusal = await call('deleteProduct', bought, 1)
  checkTrue('a purchased product is refused', boughtRefusal.success === false)
  checkTrue('the message names the order', /purchase order/.test(boughtRefusal.error))
  check('the product survives', productExists(bought), 1)

  // A legacy sales_orders row.
  const ordered = addProduct('Ordered Feed')
  db.run(`INSERT INTO sales_orders (order_id, farm_id, customer_id, product_id, date,
                                    quantity, selling_price, total_amount)
          VALUES (1,1,1,?, '2025-02-10',5,1000,5000)`, [ordered])
  const orderedRefusal = await call('deleteProduct', ordered, 1)
  checkTrue('a legacy sales order refuses too', orderedRefusal.success === false)
  checkTrue('the message names it', /sales order/.test(orderedRefusal.error))

  // An adjustment with no paperwork behind it at all — stock that moved is
  // still stock that moved.
  const adjusted = addProduct('Adjusted Feed')
  const adjBatch = await addBatch(adjusted)
  await call('addBatchTransaction', adjBatch, adjusted, 'adjustment', 5, '2025-03-02', null, 'Batch deleted — stock zeroed')
  const adjRefusal = await call('deleteProduct', adjusted, 1)
  checkTrue('an adjusted product is refused', adjRefusal.success === false)
  checkTrue('the message names the movement', /stock movement/.test(adjRefusal.error))

  // Plain stock-in is NOT history: it is the product's own bookkeeping, and a
  // product that only ever had stock added still deletes.
  const stockedOnly = addProduct('Stocked Only')
  await addBatch(stockedOnly)
  const stockedDel = await call('deleteProduct', stockedOnly, 1)
  checkTrue('stock-in alone does not block', stockedDel.success === true)
  check('it is gone', productExists(stockedOnly), 0)
  check('nothing orphaned', orphanedTransactions(), 0)

  // A product that is already gone is reported, not silently treated as success.
  const goneRes = await call('deleteProduct', 9999, 1)
  checkTrue('a missing product is reported', goneRes.success === false &&
    /no longer exists/.test(goneRes.error))

  // ── C. THE REASON: what the refusal is protecting ────────────────────────
  console.log('\n=== C. Reported cost of goods sold, before and after ===')
  const cogsBefore = cogs()
  check('the sold product is costed at its batch price (10 x 700)', cogsBefore, 7000)

  await call('deleteProduct', sold, 1)   // refused
  check('a refused delete moves nothing', cogs(), cogsBefore)
  check('and wrote nothing', txCount(sold), 2)

  // Now do by hand what the shipped code did, and watch the number move.
  db.run('DELETE FROM product_batches WHERE product_id = ?', [sold])
  db.run('DELETE FROM products WHERE product_id = ?', [sold])
  const cogsAfterCascade = cogs()
  checkTrue('the old cascade DID move reported profit', cogsAfterCascade !== cogsBefore)
  check('the 7,000 of cost vanished', cogsAfterCascade, 0)
  checkTrue('and it orphaned the transactions', orphanedTransactions() > 0)
  console.log(`  (COGS ${cogsBefore} -> ${cogsAfterCascade}; ${orphanedTransactions()} orphaned transaction row(s))`)

  // Put the fixture back so the rest runs on a clean picture.
  db.run('DELETE FROM batch_transactions WHERE product_id = ?', [sold])
  db.run('DELETE FROM bill_items WHERE product_id = ?', [sold])
  check('orphans cleared', orphanedTransactions(), 0)

  // ── D. Atomicity ─────────────────────────────────────────────────────────
  console.log('\n=== D. A batch that cannot complete leaves the product intact ===')
  const atomic = addProduct('Atomic Feed')
  await addBatch(atomic)
  db.run(`CREATE TRIGGER block_product_delete BEFORE DELETE ON products
          BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
  const blocked = await call('deleteProduct', atomic, 1)
  db.run('DROP TRIGGER block_product_delete')

  checkTrue('the failure is reported', blocked.success === false)
  check('the product is still there', productExists(atomic), 1)
  check('its batch is still there', batchCount(atomic), 1)
  check('its stock-in row is still there', txCount(atomic), 1)
  check('nothing orphaned', orphanedTransactions(), 0)

  const retry = await call('deleteProduct', atomic, 1)
  checkTrue('the retry succeeds', retry.success === true)
  check('and now it is gone', productExists(atomic), 0)

  // ── E. Scoping ───────────────────────────────────────────────────────────
  console.log('\n=== E. Another account\'s product is not deleted ===')
  const theirs = addProduct('Their Feed', { farmId: 2 })
  await addBatch(theirs, { farmId: 2 })
  const crossFarm = await call('deleteProduct', theirs, 1)
  checkTrue('refused: not this account\'s product', crossFarm.success === false &&
    /no longer exists/.test(crossFarm.error))
  check('their product survives', productExists(theirs), 1)
  check('their batch survives', batchCount(theirs), 1)

  const ownFarm = await call('deleteProduct', theirs, 2)
  checkTrue('their own account can delete it', ownFarm.success === true)
  check('gone', productExists(theirs), 0)

  // ── F. Consistent with deleteBatch() ─────────────────────────────────────
  console.log('\n=== F. The same rule one level down: deleteBatch() already refuses ===')
  const movedProduct = addProduct('Moved Feed')
  const movedBatch = await addBatch(movedProduct, { qty: 40 })
  await call('addBatchTransaction', movedBatch, movedProduct, 'sale', 10, '2025-03-03', 1, 'Sale order')

  await call('deleteBatch', movedBatch)
  check('a transacted batch is soft-deleted, not removed', batchCount(movedProduct), 1)
  check('its stock is zeroed', Number(rows(
    'SELECT quantity q FROM product_batches WHERE batch_id = ?', [movedBatch])[0].q), 0)
  const movedRefusal = await call('deleteProduct', movedProduct, 1)
  checkTrue('and the product delete refuses for the same reason',
    movedRefusal.success === false && /stock movement/.test(movedRefusal.error))
  check('the product survives', productExists(movedProduct), 1)
  check('nothing orphaned anywhere', orphanedTransactions(), 0)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error('HARNESS FAILED:', e); process.exit(1) })
