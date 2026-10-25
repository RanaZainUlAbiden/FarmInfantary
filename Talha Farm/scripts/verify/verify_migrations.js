// Verification harness for the assets/installments + expense-categories work.
// Builds a LEGACY-shaped database (the schema as it existed before this change),
// then runs the same sequence initializeDatabase() runs: createTables ->
// alterStatements -> the two flagged backfills. Twice, to prove idempotency.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')

// These live in scripts/verify/ but read the real source files at the repo root.
const ROOT = path.join(__dirname, '..', '..')
const SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')

// Pull the pieces we need out of database.js without executing its module body
// (it opens the real DB path on require).
function extractFunction(name) {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let depth = 0, i = SRC.indexOf('{', start)
  const open = i
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(start, i + 1)
}

function extractAlterStatements() {
  const start = SRC.indexOf('const alterStatements = [')
  const end = SRC.indexOf('\n  ]', start)
  const body = SRC.slice(start, end + 4)
  // eslint-disable-next-line no-eval
  return eval(body + '; alterStatements')
}

const createTables = eval('(' + extractFunction('createTables') + ')')
const backfillAssetInstallments = eval('(' + extractFunction('backfillAssetInstallments') + ')')
const backfillExpenseCategories = eval('(' + extractFunction('backfillExpenseCategories') + ')')
const alterStatements = extractAlterStatements()

// The pre-change shape of the two tables, copied from git history.
const LEGACY = `
CREATE TABLE app_settings (farm_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (farm_id, key));
CREATE TABLE farms (farm_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_name TEXT NOT NULL, password_hash TEXT NOT NULL, business_type TEXT DEFAULT 'broiler', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE assets (
  asset_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, unit_id INTEGER,
  asset_name TEXT NOT NULL, category TEXT, purchase_date DATE NOT NULL,
  purchase_amount REAL NOT NULL DEFAULT 0, payment_source TEXT DEFAULT 'cash', bank_id INTEGER,
  status TEXT DEFAULT 'active', sale_date DATE, sale_amount REAL, notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE personal_expenses (
  pexpense_id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL, date DATE NOT NULL,
  category TEXT, description TEXT, amount REAL NOT NULL DEFAULT 0,
  payment_source TEXT DEFAULT 'cash', bank_id INTEGER, notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`

function seed(db) {
  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
  db.run(`INSERT INTO assets (farm_id, asset_name, purchase_date, purchase_amount, payment_source, status)
          VALUES (1,'Tractor','2024-03-10',500000,'cash','active'),
                 (1,'Shed','2024-06-01',250000,'bank','active'),
                 (1,'Old Van','2023-01-05',300000,'cash','sold'),
                 (1,'Gifted Land','2024-02-02',0,'cash','active'),
                 (2,'Generator','2024-05-05',80000,'cash','active')`)
  db.run(`UPDATE assets SET sale_date='2025-01-01', sale_amount=280000 WHERE asset_name='Old Van'`)
  db.run(`INSERT INTO personal_expenses (farm_id, date, category, description, amount)
          VALUES (1,'2025-01-10','Household','Groceries',12000),
                 (1,'2025-01-15','household','Soap',800),
                 (1,'2025-02-01','Medical','Clinic',5000),
                 (1,'2025-02-03','','Unlabelled',400),
                 (1,'2025-02-04',NULL,'Also unlabelled',600),
                 (2,'2025-01-20','Travel','Fuel',3000)`)
}

function rows(db, sql) {
  const out = []
  const stmt = db.prepare(sql)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

function runInitSequence(db, label) {
  const problems = []
  try {
    createTables(db)
  } catch (e) {
    problems.push(`createTables THREW: ${e.message}`)
  }
  for (const sql of alterStatements) {
    try { db.run(sql) } catch (e) { /* duplicate column = already applied */ }
  }
  try { backfillAssetInstallments(db) } catch (e) { problems.push(`assets backfill THREW: ${e.message}`) }
  try { backfillExpenseCategories(db) } catch (e) { problems.push(`categories backfill THREW: ${e.message}`) }
  if (problems.length) console.log(`  [${label}] ${problems.join(' | ')}`)
  return problems
}

initSqlJs().then(SQL => {
  console.log('=== LEGACY DATABASE, three consecutive launches ===\n')
  const db = new SQL.Database()
  db.run(LEGACY)
  seed(db)

  const allProblems = []
  for (const launch of ['launch 1', 'launch 2', 'launch 3']) {
    console.log(`--- ${launch} ---`)
    allProblems.push(...runInitSequence(db, launch))

    const payments = rows(db, `SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM asset_payments`)[0]
    const dupes = rows(db, `SELECT asset_id, COUNT(*) c FROM asset_payments GROUP BY asset_id HAVING c > 1`)
    const cats = rows(db, `SELECT COUNT(*) c FROM expense_categories`)[0]
    const unlinked = rows(db, `SELECT COUNT(*) c FROM personal_expenses WHERE category_id IS NULL`)[0]
    const nullPrice = rows(db, `SELECT COUNT(*) c FROM assets WHERE total_price IS NULL`)[0]
    console.log(`  payment rows=${payments.c} total=${payments.s} | assets with >1 payment=${dupes.length}` +
                ` | categories=${cats.c} | unlinked entries=${unlinked.c} | assets w/ NULL total_price=${nullPrice.c}`)
    if (dupes.length) console.log(`  !! DUPLICATED: ${JSON.stringify(dupes)}`)
  }

  console.log('\n=== final state ===')
  console.log('assets:', JSON.stringify(rows(db, `SELECT asset_name, total_price, purchase_amount, status FROM assets ORDER BY asset_id`), null, 0))
  console.log('payments:', JSON.stringify(rows(db, `SELECT asset_id, date, amount, payment_source FROM asset_payments ORDER BY payment_id`), null, 0))
  console.log('categories:', JSON.stringify(rows(db, `SELECT category_id, farm_id, category_name FROM expense_categories ORDER BY category_id`), null, 0))
  console.log('entries:', JSON.stringify(rows(db, `SELECT pexpense_id, farm_id, category, category_id, amount FROM personal_expenses ORDER BY pexpense_id`), null, 0))

  console.log('\n=== FRESH DATABASE (no legacy tables) ===')
  const fresh = new SQL.Database()
  allProblems.push(...runInitSequence(fresh, 'fresh'))
  console.log('  fresh install completed; assets columns:',
    rows(fresh, `PRAGMA table_info(assets)`).map(c => c.name).join(','))
  console.log('  personal_expenses columns:',
    rows(fresh, `PRAGMA table_info(personal_expenses)`).map(c => c.name).join(','))

  const dupes = rows(db, `SELECT asset_id FROM asset_payments GROUP BY asset_id HAVING COUNT(*) > 1`)
  if (dupes.length) allProblems.push(dupes.length + ' asset(s) got duplicate opening payments')
  const ok = allProblems.length === 0
  console.log(ok ? '\nRESULT: no throws, no duplicate payments'
                 : '\nRESULT: ' + allProblems.length + ' problem(s)')
  process.exit(ok ? 0 : 1)
}).catch(e => { console.error('HARNESS FAILED:', e); process.exit(1) })
