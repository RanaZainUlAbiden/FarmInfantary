// [Codex] PostgreSQL port of verify_expense_ledger_separation.js. Original assertion values retained.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
async function runSqlFor(database, sql, params = []) { const r = await database.run(sql, params); if (!r.success) throw new Error(r.error); return r }
import { loadReferenceBackfill } from './lib/reference-asset-backfills.mjs'
const migrateExpenseLedgerSource = loadReferenceBackfill('migrateExpenseLedgerSource')
const migrateDropExpenseLedgerMirrors = loadReferenceBackfill('migrateDropExpenseLedgerMirrors')
const scratchDbs=[]
async function createFixture() { const s=await createScratchDb('expense_separation'); scratchDbs.push(s); return s.db }

// Asserts that making Expenses and Ledgers fully independent books moved NO
// number anywhere. Nothing in any P&L may move.
//
// The two tables both hold costs, and every total in the app splits them the
// same way — a partition, each row claimed by exactly one side:
//
//   expense side : every row of `expenses`
//   ledger side  : `ledger_entries` debits with source <> 'expense'
//
// What changed is where those rows come from. The Expenses screen used to write
// BOTH: an expense and a `source = 'expense'` mirror of it in an auto-created
// "Other" ledger. It now writes the expense alone, with a `category` of its own,
// and a one-time migration deletes every mirror already written. Because the
// mirrors were on the excluded side of the partition from the day they existed,
// deleting them subtracts nothing from any report: the expense side is untouched
// and the ledger side never counted them.
//
// The `<> 'expense'` guard is kept in all three consumers even though nothing
// writes that source any more. This file proves it matters: on an UNMIGRATED
// database (the migration failed and is retrying, or a pre-change backup was
// restored) it is the only thing between the app and counting every legacy
// expense twice.
//
// What this file actually runs: the real createTables/alterStatements and the
// real migrateExpenseLedgerSource/migrateDropExpenseLedgerMirrors from
// electron/database.js, the real SQL lifted out of expenses.component.ts and
// expenses.resolver.ts, and the real ledger-debit queries lifted out of
// report.component.ts, overview.service.ts and farm-report.service.ts. The OLD
// (mirroring) save path is spelled out here, because it no longer exists in the
// source — that is the point: this compares before against after.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')
const EXP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'expenses', 'expenses.component.ts'), 'utf8')
const RES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'resolvers', 'expenses.resolver.ts'), 'utf8')
const REP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'report', 'report.component.ts'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')
const FR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'farm-report.service.ts'), 'utf8')
const LED_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'ledger', 'ledger.component.ts'), 'utf8')

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



/** Pull the single template-literal SQL string that follows `marker` in `src`. */
function sqlAfter(src, marker, occurrence = 0) {
  let idx = -1
  for (let n = 0; n <= occurrence; n++) idx = src.indexOf(marker, idx + 1)
  if (idx < 0) throw new Error(`marker not found: ${marker}`)
  const open = src.indexOf('`', idx)
  const close = src.indexOf('`', open + 1)
  if (open < 0 || close < 0) throw new Error(`no SQL literal after: ${marker}`)
  return src.slice(open + 1, close)
}

/** Pull the template-literal SQL string that CONTAINS `marker`. */
function sqlContaining(src, marker) {
  const idx = src.indexOf(marker)
  if (idx < 0) throw new Error(`marker not found: ${marker}`)
  const open = src.lastIndexOf('`', idx)
  const close = src.indexOf('`', idx)
  if (open < 0 || close < 0) throw new Error(`no SQL literal around: ${marker}`)
  return src.slice(open + 1, close)
}

const rows = async (db, sql, params = []) => { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }
const scalar = async (db, sql, params = []) => Number((await rows(db, sql, params))[0]?.v || 0)

// ── the real SQL under test, lifted from the real files ────────────────────
const SCREEN_EXPENSES_SQL = sqlAfter(EXP_SRC, 'const expensesResult = await this.db.get(')
const RESOLVER_EXPENSES_SQL = sqlAfter(RES_SRC, 'const expensesResult = await this.db.get(')
const SCREEN_INSERT_SQL = sqlContaining(EXP_SRC, 'INSERT INTO expenses (flock_id, date, category')
const SCREEN_UPDATE_SQL = sqlContaining(EXP_SRC, 'UPDATE expenses SET date = ?, category = ?')
const SCREEN_DELETE_SQL = sqlContaining(EXP_SRC, 'DELETE FROM expenses WHERE expense_id = ?')
const REPORT_EXPENSES_SQL = sqlContaining(REP_SRC, 'SELECT e.* FROM expenses e')
const REPORT_LEDGER_SQL = sqlContaining(REP_SRC, 'SELECT le.*, l.ledger_name FROM ledger_entries le')

// The two services build their ledger-debit WHERE clause in code; take the
// clause itself so a change to either is caught here.
const OV_LEDGER_WHERE = (() => {
  const body = extractFn(OV_SRC, 'qLedgerDebits', 'private ')
  const m = body.match(/le\.type = 'debit'\s*\n?\s*AND COALESCE\(le\.source,'manual'\) <> 'expense'/)
  if (!m) throw new Error('overview.service.ts ledger-debit guard not found')
  return m[0].replace(/\s+/g, ' ')
})()
const FR_LEDGER_WHERE = (() => {
  const body = extractFn(FR_SRC, 'specLedgerDebits', 'private ')
  const m = body.match(/le\.type = 'debit' AND COALESCE\(le\.source,'manual'\) <> 'expense'/)
  if (!m) throw new Error('farm-report.service.ts ledger-debit guard not found')
  return m[0]
})()

/** The OLD save path, kept here only so before/after can be compared. */
async function saveExpenseTheOldWay(db, flockId, row) {
  let ledgerId = (await rows(db,
    `SELECT ledger_id FROM ledgers WHERE flock_id = ? AND ledger_name = 'Other' COLLATE NOCASE
     ORDER BY ledger_id ASC LIMIT 1`, [flockId]))[0]?.ledger_id
  if (!ledgerId) {
    ledgerId = (await runSqlFor(db, `INSERT INTO ledgers (flock_id, ledger_name) VALUES (?, 'Other')`, [flockId])).lastId
  }
  const entryId = (await runSqlFor(db, 
    `INSERT INTO ledger_entries (ledger_id, flock_id, date, description, amount, type, source)
     VALUES (?, ?, ?, ?, ?, 'debit', 'expense')`,
    [ledgerId, flockId, row.date, row.description, row.amount]
  )).lastId
  await runSqlFor(db, 
    `INSERT INTO expenses (flock_id, ledger_id, ledger_entry_id, date, description, amount, payment_type, bill_available, module_type)
     VALUES (?, ?, ?, ?, ?, ?, 'cash', 'No', 'broiler')`,
    [flockId, ledgerId, entryId, row.date, row.description, row.amount]
  )
}

/** The real NEW save path: one INSERT, no ledger anywhere. */
async function saveExpense(db, flockId, row) {
  // payment_source / bank_id come after payment_type: the screen now records
  // which bank account a bank-paid expense came out of. 'cash' with no account
  // is what this file is about, since a bank entry is not a ledger entry and
  // changes nothing here - the point being asserted is that it STAYS that way.
  await runSqlFor(db, SCREEN_INSERT_SQL, [
    flockId, row.date, (row.category || '').trim() || 'Other',
    row.description, row.amount, 'cash', 'cash', null, 'No', null
  ])
}

async function seed() {
  const db = await createFixture()


  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash, business_type) VALUES (1,'Talha','x','broiler')`)
  await runSqlFor(db, `INSERT INTO farm_units (unit_id, farm_id, unit_name, module_type) VALUES (1,1,'Farm A','broiler')`)
  await runSqlFor(db, `INSERT INTO flocks (flock_id, farm_id, unit_id, flock_name, start_date) VALUES (1,1,1,'Flock 1','2026-01-01')`)
  await runSqlFor(db, `INSERT INTO ledgers (ledger_id, flock_id, ledger_name) VALUES (1,1,'Utilities')`)

  // The worked example, as the OLD (mirroring) screen would have left it.
  //  A  a legacy expense with no ledger and no mirror at all
  await runSqlFor(db, `INSERT INTO expenses (expense_id, flock_id, ledger_id, ledger_entry_id, date, description, amount, module_type)
          VALUES (1,1,NULL,NULL,'2026-02-01','Diesel',5000,'broiler')`)
  //  B  an expense filed to "Utilities" -> mirror entry, source='expense'
  await runSqlFor(db, `INSERT INTO ledger_entries (entry_id, ledger_id, flock_id, date, description, amount, type, source)
          VALUES (1,1,1,'2026-02-02','Electricity bill',3000,'debit','expense')`)
  await runSqlFor(db, `INSERT INTO expenses (expense_id, flock_id, ledger_id, ledger_entry_id, date, description, amount, module_type)
          VALUES (2,1,1,1,'2026-02-02','Electricity bill',3000,'broiler')`)
  //  C  a debit entered on the Ledger screen and nowhere else
  await runSqlFor(db, `INSERT INTO ledger_entries (entry_id, ledger_id, flock_id, date, description, amount, type, source)
          VALUES (2,1,1,'2026-02-03','Generator repair',2000,'debit','manual')`)
  //  D  a ledger credit — not a cost, must never be subtracted
  await runSqlFor(db, `INSERT INTO ledger_entries (entry_id, ledger_id, flock_id, date, description, amount, type, source)
          VALUES (3,1,1,'2026-02-04','Refund',1000,'credit','manual')`)
  //  E  an expense saved through the OLD path: auto "Other" ledger + mirror
  await saveExpenseTheOldWay(db, 1, { date: '2026-02-05', description: 'Repairs', amount: 4000 })
  //  F  a legacy mirror the v2 backfill will mark: linked, but still 'manual'
  await runSqlFor(db, `INSERT INTO ledger_entries (entry_id, ledger_id, flock_id, date, description, amount, type, source)
          VALUES (50,1,1,'2026-02-06','Rope',500,'debit','manual')`)
  await runSqlFor(db, `INSERT INTO expenses (expense_id, flock_id, ledger_id, ledger_entry_id, date, description, amount, module_type)
          VALUES (50,1,1,50,'2026-02-06','Rope',500,'broiler')`)
  //  a layer batch whose batch_id collides with flock 1, to prove the guard holds
  await runSqlFor(db, `INSERT INTO batches (batch_id, farm_id, unit_id, batch_name, start_date, initial_birds) VALUES (1,1,1,'Batch 1','2026-01-01',500)`)
  await runSqlFor(db, `INSERT INTO expenses (flock_id, date, description, amount, module_type)
          VALUES (1,'2026-02-07','Layer feed sacks',7777,'layer')`)
  await runSqlFor(db, `INSERT INTO income (flock_id, date, description, amount, module_type) VALUES (1,'2026-02-10','Bird sale',20000,'broiler')`)
  return db
}

try {
  const db = (await seed())

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

  // ── the figures, computed the way each screen computes them ──────────────
  const screenRows = async () => (await rows(db, SCREEN_EXPENSES_SQL, [1]))
  const resolverRows = async () => (await rows(db, RESOLVER_EXPENSES_SQL, [1]))
  const sumRows = (rs) => rs.reduce((s, e) => s + (e.amount || 0), 0)

  // report.component.ts
  const reportExpenses = async () => sumRows((await rows(db, REPORT_EXPENSES_SQL, [1])))
  const reportLedgerDebit = async () => (await rows(db, REPORT_LEDGER_SQL, [1]))
    .filter(e => e.type === 'debit' && e.source !== 'expense')
    .reduce((s, e) => s + (e.amount || 0), 0)
  const reportIncome = async () => (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM income
     WHERE flock_id = ? AND COALESCE(module_type,'broiler') = 'broiler'`, [1]))
  const reportPL = async () => (await reportIncome()) - (await reportExpenses()) - (await reportLedgerDebit())

  // overview.service.ts / farm-report.service.ts
  const ovGeneral = async () => (await scalar(db,
    `SELECT COALESCE(SUM(e.amount),0) v FROM expenses e
     JOIN flocks f ON f.flock_id = e.flock_id
     WHERE f.farm_id = 1 AND COALESCE(e.module_type,'broiler') = 'broiler'`))
  const ovLedger = async () => (await scalar(db,
    `SELECT COALESCE(SUM(le.amount),0) v FROM ledger_entries le
     JOIN flocks f ON f.flock_id = le.flock_id
     WHERE f.farm_id = 1 AND ${OV_LEDGER_WHERE}`))
  const frLedger = async () => (await scalar(db,
    `SELECT COALESCE(SUM(le.amount),0) v FROM ledger_entries le
     JOIN flocks f ON f.flock_id = le.flock_id
     WHERE f.farm_id = 1 AND ${FR_LEDGER_WHERE}`))
  const mirrors = async () => (await scalar(db,
    `SELECT COUNT(*) v FROM ledger_entries WHERE COALESCE(source,'manual') = 'expense'`))

  console.log('=== a RAW database, before any migration has ever run ===')
  check('Expenses screen total', sumRows((await screenRows())), 12500)
  check('Report — Total Expenses', (await reportExpenses()), 12500)
  // 2000 manual + the 500 legacy mirror that is still marked 'manual'.
  check('Report — Ledger Debit', (await reportLedgerDebit()), 2500)
  check('mirror rows present', (await mirrors()), 2)

  console.log('\n=== migrateExpenseLedgerSource — PRE-EXISTING, and not this change ===')
  // Every live database has already run this one: it marks a linked legacy
  // mirror 'expense', which takes it off the ledger side. That reclassification
  // moves a figure (it removes a double count — the row was being subtracted
  // both as an expense and as a ledger debit), and it did so long before this
  // change. Its flag is already set everywhere, so it is inert from here on.
  // The baseline for "did separating the books move anything" is taken AFTER it,
  // because that is the state every real database is in today.
  await migrateExpenseLedgerSource(db)
  check('the linked legacy mirror got marked', (await mirrors()), 3)
  check('Report — Ledger Debit, after that backfill', (await reportLedgerDebit()), 2000)
  check('Report — Total Expenses is untouched by it', (await reportExpenses()), 12500)

  const before = {
    screenTotal: sumRows((await screenRows())),
    reportExpenses: (await reportExpenses()),
    reportLedger: (await reportLedgerDebit()),
    pl: (await reportPL()),
    ovGeneral: (await ovGeneral()),
    ovLedger: (await ovLedger()),
    frLedger: (await frLedger())
  }

  console.log('\n=== BEFORE — the state every live database is in today ===')
  check('Expenses screen total', before.screenTotal, 12500)
  check('Report — Total Expenses', before.reportExpenses, 12500)
  check('Report — Ledger Debit', before.reportLedger, 2000)
  check('Report — Net Profit', before.pl, 20000 - 12500 - 2000)
  check('Overview — general', before.ovGeneral, 12500)
  check('Overview — ledgerDebits', before.ovLedger, 2000)
  check('mirror rows still sitting on the Ledger screen', (await mirrors()), 3)

  console.log('\n=== migrateDropExpenseLedgerMirrors — THIS change ===')
  // Runs after the backfill above, and that ordering is load-bearing: the other
  // way round, entry 50 would be marked AFTER the delete and survive forever —
  // excluded from every total but still listed on the Ledger screen.
  await migrateDropExpenseLedgerMirrors(db)

  console.log('\n=== AFTER — no mirrors left, and NOTHING moved ===')
  check('mirror rows remaining', (await mirrors()), 0)
  check('Report — Total Expenses', (await reportExpenses()), before.reportExpenses)
  check('Report — Ledger Debit', (await reportLedgerDebit()), before.reportLedger)
  check('Report — Net Profit', (await reportPL()), before.pl)
  check('Overview — general', (await ovGeneral()), before.ovGeneral)
  check('Overview — ledgerDebits', (await ovLedger()), before.ovLedger)
  check('farm-report — ledgerDebits', (await frLedger()), before.frLedger)
  check('Expenses screen total', sumRows((await screenRows())), before.screenTotal)
  check('Expenses screen rows listed', (await screenRows()).length, 4)
  check('the ledger side is now the ledger\'s whole book', (await ovLedger()), (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM ledger_entries WHERE flock_id = 1 AND type = 'debit'`)))
  check('the manual debit survived', (await scalar(db,
    `SELECT COUNT(*) v FROM ledger_entries WHERE description = 'Generator repair'`)), 1)
  check('the ledger credit was never touched', (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM ledger_entries WHERE flock_id = 1 AND type = 'credit'`)), 1000)
  check('the expense rows behind the deleted mirrors are all still there', (await scalar(db,
    `SELECT COUNT(*) v FROM expenses WHERE expense_id IN (2,50)`)), 2)

  console.log('\n=== the migration is one-shot and idempotent ===')
  const flag = async () => (await scalar(db,
    `SELECT COUNT(*) v FROM app_settings WHERE farm_id = 0 AND key = 'migration_drop_expense_ledger_mirrors_v1'`))
  check('flag written', (await flag()), 1)
  await runSqlFor(db, `INSERT INTO ledger_entries (ledger_id, flock_id, date, description, amount, type, source)
          VALUES (1,1,'2026-03-01','Post-migration manual debit',900,'debit','manual')`)
  await migrateDropExpenseLedgerMirrors(db)
  await migrateDropExpenseLedgerMirrors(db)
  check('three more launches delete nothing further', (await scalar(db,
    `SELECT COUNT(*) v FROM ledger_entries WHERE description = 'Post-migration manual debit'`)), 1)
  check('Report — Ledger Debit picks the new debit up', (await reportLedgerDebit()), before.reportLedger + 900)

  console.log('\n=== a NEW expense writes ONE row and touches no ledger ===')
  const ledgersBefore = (await scalar(db, `SELECT COUNT(*) v FROM ledgers`))
  const entriesBefore = (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`))
  await saveExpense(db, 1, { date: '2026-03-02', description: 'Wire', amount: 1500, category: 'Repairs' })
  await saveExpense(db, 1, { date: '2026-03-03', description: 'Tape', amount: 100, category: '' })
  check('no ledger created', (await scalar(db, `SELECT COUNT(*) v FROM ledgers`)), ledgersBefore)
  check('no ledger entry written', (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`)), entriesBefore)
  // The auto-created "Other" ledger from the old regime survives the migration,
  // now empty. Deliberate: it is an ordinary row on the Ledger screen and the
  // user may have typed it themselves (ensureOtherLedgerId matched NOCASE), so
  // deleting it is their call, not a migration's. What matters is that nothing
  // files into it any more.
  check('no NEW "Other" ledger is created', (await scalar(db,
    `SELECT COUNT(*) v FROM ledgers WHERE ledger_name = 'Other' COLLATE NOCASE`)), 1)
  check('and the leftover one is empty', (await scalar(db,
    `SELECT COUNT(*) v FROM ledger_entries le JOIN ledgers l ON l.ledger_id = le.ledger_id
     WHERE l.ledger_name = 'Other' COLLATE NOCASE`)), 0)
  check('both rows carry no ledger link', (await scalar(db,
    `SELECT COUNT(*) v FROM expenses WHERE description IN ('Wire','Tape')
       AND ledger_id IS NULL AND ledger_entry_id IS NULL`)), 2)
  check('the typed category is stored', (await scalar(db,
    `SELECT COUNT(*) v FROM expenses WHERE description = 'Wire' AND category = 'Repairs'`)), 1)
  check('an empty category falls back to "Other"', (await scalar(db,
    `SELECT COUNT(*) v FROM expenses WHERE description = 'Tape' AND category = 'Other'`)), 1)
  check('Report — Total Expenses', (await reportExpenses()), before.reportExpenses + 1600)
  check('Report — Ledger Debit is UNMOVED by the new expenses', (await reportLedgerDebit()), before.reportLedger + 900)

  console.log('\n=== edit and delete touch `expenses` and nothing else ===')
  const wireId = (await rows(db, `SELECT expense_id FROM expenses WHERE description = 'Wire'`))[0].expense_id
  await runSqlFor(db, SCREEN_UPDATE_SQL, ['2026-03-02', 'Fencing', 'Wire', 1800, 'cash', 'cash', null, 'No', null, wireId])
  check('the edit saved', (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE expense_id = ?`, [wireId])), 1800)
  check('and re-categorised', (await scalar(db,
    `SELECT COUNT(*) v FROM expenses WHERE expense_id = ? AND category = 'Fencing'`, [wireId])), 1)
  check('no ledger entry appeared', (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`)), entriesBefore)

  // Expense 2 still carries a legacy ledger_entry_id whose entry the migration
  // deleted. Deleting the expense must not reach into `ledger_entries` at all.
  const ledgerRowsBeforeDelete = (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`))
  await runSqlFor(db, SCREEN_DELETE_SQL, [2])
  check('the expense is gone', (await scalar(db, `SELECT COUNT(*) v FROM expenses WHERE expense_id = 2`)), 0)
  check('no ledger row went with it', (await scalar(db, `SELECT COUNT(*) v FROM ledger_entries`)), ledgerRowsBeforeDelete)

  console.log('\n=== the partition holds: no cost counted twice, none lost ===')
  const everyCost = (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM expenses
     WHERE flock_id = 1 AND COALESCE(module_type,'broiler') = 'broiler'`)) +
    (await scalar(db,
      `SELECT COALESCE(SUM(amount),0) v FROM ledger_entries
       WHERE flock_id = 1 AND type = 'debit' AND COALESCE(source,'manual') <> 'expense'`))
  check('expense side + ledger side = total cost', (await reportExpenses()) + (await reportLedgerDebit()), everyCost)
  check('Overview agrees with the Report', (await ovGeneral()) + (await ovLedger()), (await reportExpenses()) + (await reportLedgerDebit()))

  console.log('\n=== the layer batch colliding on id 1 stays off this screen ===')
  check('no layer row listed', (await screenRows()).filter(e => e.amount === 7777).length, 0)
  check('layer row really is there', (await scalar(db,
    `SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE flock_id = 1 AND module_type = 'layer'`)), 7777)

  console.log('\n=== the screen and its resolver run the identical query ===')
  check('same row count', (await resolverRows()).length, (await screenRows()).length)
  check('same total', sumRows((await resolverRows())), sumRows((await screenRows())))
  const normalise = (s) => s.replace(/\s+/g, ' ').trim()
  assert('the two SQL strings are character-identical',
    normalise(SCREEN_EXPENSES_SQL) === normalise(RESOLVER_EXPENSES_SQL))

  console.log('\n=== the kept `<> expense` guard still earns its place ===')
  // An UNMIGRATED database: the migration threw and is retrying, or a pre-change
  // backup was restored. The guard is the only thing stopping every legacy
  // expense from being counted once as an expense and once as a ledger debit.
  const stale = (await seed())
  const staleGuarded = (await scalar(stale,
    `SELECT COALESCE(SUM(le.amount),0) v FROM ledger_entries le
     JOIN flocks f ON f.flock_id = le.flock_id
     WHERE f.farm_id = 1 AND ${OV_LEDGER_WHERE}`))
  const staleUnguarded = (await scalar(stale,
    `SELECT COALESCE(SUM(le.amount),0) v FROM ledger_entries le
     JOIN flocks f ON f.flock_id = le.flock_id
     WHERE f.farm_id = 1 AND le.type = 'debit'`))
  check('guarded ledger debit (correct)', staleGuarded, 2500)
  check('unguarded would double-count the mirrors', staleUnguarded, 2500 + 7000)
  assert('so the guard must stay in all three consumers',
    REP_SRC.includes(`e.source !== 'expense'`) &&
    OV_SRC.includes(`COALESCE(le.source,'manual') <> 'expense'`) &&
    FR_SRC.includes(`COALESCE(le.source,'manual') <> 'expense'`))
  // Both scratch schemas close in finally.

  console.log('\n=== nothing writes a mirror any more ===')
  assert('expenses.component.ts inserts no ledger_entries row',
    !/INSERT INTO ledger_entries/.test(EXP_SRC))
  assert('expenses.component.ts writes neither ledger_id nor ledger_entry_id',
    !/(INSERT INTO|UPDATE) expenses[\s\S]{0,400}?ledger_(id|entry_id)\s*=?/.test(
      EXP_SRC.replace(/\/\/[^\n]*/g, '')))
  assert('no "Other" ledger is created anywhere in src/',
    !/INSERT INTO ledgers[\s\S]{0,80}'Other'/.test(EXP_SRC))
  assert('the Ledger screen no longer writes to `expenses`',
    !/(UPDATE|DELETE FROM|INSERT INTO) expenses/.test(LED_SRC))

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally { for(const s of scratchDbs.reverse()) await s.close() }
