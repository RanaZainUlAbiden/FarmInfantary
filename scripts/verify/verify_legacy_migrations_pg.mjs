// [Codex] PostgreSQL port of verify_migrations.js. Original assertion values retained.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
async function runSqlFor(database, sql, params = []) { const r = await database.run(sql, params); if (!r.success) throw new Error(r.error); return r }
import {loadReferenceBackfill,backfillAssetInstallments} from './lib/reference-asset-backfills.mjs'
const backfillExpenseCategories=loadReferenceBackfill('backfillExpenseCategories')
const scratchDbs=[]
async function createFixture() { const s=await createScratchDb('historical_migrations');scratchDbs.push(s);await s.pool.query(fs.readFileSync(path.join(ROOT,'db/schema/002_indexes.sql'),'utf8'));return s.db }
// Verification harness for the assets/installments + expense-categories work.
// Builds a LEGACY-shaped database (the schema as it existed before this change),
// then runs the same sequence initializeDatabase() runs: createTables ->
// alterStatements -> the two flagged backfills. Twice, to prove idempotency.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')

// These live in scripts/verify/ but read the real source files at the repo root.
const ROOT = path.join(__dirname, '..', '..')
const SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')

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

async function seed(db) {
  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
  await runSqlFor(db, `INSERT INTO assets (farm_id, asset_name, purchase_date, purchase_amount, payment_source, status)
          VALUES (1,'Tractor','2024-03-10',500000,'cash','active'),
                 (1,'Shed','2024-06-01',250000,'bank','active'),
                 (1,'Old Van','2023-01-05',300000,'cash','sold'),
                 (1,'Gifted Land','2024-02-02',0,'cash','active'),
                 (2,'Generator','2024-05-05',80000,'cash','active')`)
  await runSqlFor(db, `UPDATE assets SET sale_date='2025-01-01', sale_amount=280000 WHERE asset_name='Old Van'`)
  await runSqlFor(db, `INSERT INTO personal_expenses (farm_id, date, category, description, amount)
          VALUES (1,'2025-01-10','Household','Groceries',12000),
                 (1,'2025-01-15','household','Soap',800),
                 (1,'2025-02-01','Medical','Clinic',5000),
                 (1,'2025-02-03','','Unlabelled',400),
                 (1,'2025-02-04',NULL,'Also unlabelled',600),
                 (2,'2025-01-20','Travel','Fuel',3000)`)
}

async function rows(db, sql, params = []) { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }

async function runInitSequence(db,label) {
 const problems=[]
 try { await backfillAssetInstallments(db) } catch(e) { problems.push('asset backfill: '+e.message) }
 try { await backfillExpenseCategories(db) } catch(e) { problems.push('category backfill: '+e.message) }
 return problems
}
try {
  console.log('=== LEGACY DATABASE, three consecutive launches ===\n')
  const db = await createFixture()
  await seed(db)

  const allProblems = []
  for (const launch of ['launch 1', 'launch 2', 'launch 3']) {
    console.log(`--- ${launch} ---`)
    allProblems.push(...(await runInitSequence(db, launch)))

    const payments = (await rows(db, `SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM asset_payments`))[0]
    const dupes = (await rows(db, `SELECT asset_id, COUNT(*) c FROM asset_payments GROUP BY asset_id HAVING COUNT(*) > 1`))
    const cats = (await rows(db, `SELECT COUNT(*) c FROM expense_categories`))[0]
    const unlinked = (await rows(db, `SELECT COUNT(*) c FROM personal_expenses WHERE category_id IS NULL`))[0]
    const nullPrice = (await rows(db, `SELECT COUNT(*) c FROM assets WHERE total_price IS NULL`))[0]
    console.log(`  payment rows=${payments.c} total=${payments.s} | assets with >1 payment=${dupes.length}` +
                ` | categories=${cats.c} | unlinked entries=${unlinked.c} | assets w/ NULL total_price=${nullPrice.c}`)
    if (dupes.length) console.log(`  !! DUPLICATED: ${JSON.stringify(dupes)}`)
  }

  console.log('\n=== final state ===')
  console.log('assets:', JSON.stringify((await rows(db, `SELECT asset_name, total_price, purchase_amount, status FROM assets ORDER BY asset_id`)), null, 0))
  console.log('payments:', JSON.stringify((await rows(db, `SELECT asset_id, date, amount, payment_source FROM asset_payments ORDER BY payment_id`)), null, 0))
  console.log('categories:', JSON.stringify((await rows(db, `SELECT category_id, farm_id, category_name FROM expense_categories ORDER BY category_id`)), null, 0))
  console.log('entries:', JSON.stringify((await rows(db, `SELECT pexpense_id, farm_id, category, category_id, amount FROM personal_expenses ORDER BY pexpense_id`)), null, 0))

  console.log('\n=== FRESH DATABASE (no legacy tables) ===')
  const fresh = await createFixture()
  allProblems.push(...(await runInitSequence(fresh, 'fresh')))
  console.log('  fresh install completed; assets columns:',
    (await rows(fresh, `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='assets' ORDER BY ordinal_position`)).map(c => c.name).join(','))
  console.log('  personal_expenses columns:',
    (await rows(fresh, `SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='personal_expenses' ORDER BY ordinal_position`)).map(c => c.name).join(','))

  const dupes = (await rows(db, `SELECT asset_id FROM asset_payments GROUP BY asset_id HAVING COUNT(*) > 1`))
  if (dupes.length) allProblems.push(dupes.length + ' asset(s) got duplicate opening payments')
  const ok = allProblems.length === 0
  console.log(ok ? '\nRESULT: no throws, no duplicate payments'
                 : '\nRESULT: ' + allProblems.length + ' problem(s)')
  process.exitCode = ok ? 0 : 1
} finally { for(const f of scratchDbs.reverse())await f.close() }
