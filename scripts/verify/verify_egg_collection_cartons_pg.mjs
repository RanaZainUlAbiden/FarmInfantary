// [Codex] PostgreSQL port of verify_egg_collection_cartons.js. Original assertion values retained.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadEnv, createScratchDb, REF } from './lib/pg-harness.mjs'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
let db
async function runSqlFor(database, sql, params = []) { const r = await database.run(sql, params); if (!r.success) throw new Error(r.error); return r }
import { migrate } from '../../db/migration-runner.mjs'
const runQuery=async (sql,params=[])=>(await runSqlFor(db, sql,params))
const runBatch=ops=>db.batch(ops)
async function eggColumns() {
 const r=await db.get("SELECT column_name AS name, data_type AS type, column_default AS dflt_value FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='egg_collection' ORDER BY ordinal_position")
 if(!r.success)throw new Error(r.error)
 return r.data.map(c=>({...c,type:({text:'TEXT','double precision':'REAL',bigint:'INTEGER'})[c.type]||c.type,dflt_value:c.dflt_value===null?'null':c.dflt_value.replace(/::text$/,'')}))
}

// Egg collection recorded per carton — total_eggs always holds the TRUE count.
//
// Egg Sales already prices per carton. Egg Collection now RECORDS per carton,
// and the stakes on this side are higher: `egg_sales.quantity` is one input to
// the stock figure, but `egg_collection.total_eggs` IS the production figure.
// Egg stock, cumulative production and the layer report all read that column
// directly, and none of them knows a recording mode exists. A per_carton row
// that wrote the CARTON count there would divide every one of those figures by
// 360 — silently, with nothing on screen to say why.
//
// So the one thing this file exists to prove is the derivation:
//
//     per_egg     total_eggs = the entered egg count
//     per_carton  total_eggs = carton_count * eggs_per_carton
//
// and that only total_eggs is derived — broken_eggs and the four grade columns
// are plain EGG COUNTS in both modes, which is what lets the grading check
// compare egg counts to egg counts either way.
//
// What it checks:
//   A. The three columns exist on a fresh schema AND after the ALTERs, with
//      'per_egg' / NULL / 360 as the defaults, and the ALTERs survive re-running
//      (they execute on every single app launch).
//   B. The screen's OWN INSERT and UPDATE, lifted from the component as text
//      with the real parameter arrays, bound with a distinct sentinel per
//      parameter — the verify_bank_screen_sql discipline. TypeScript cannot see
//      a placeholder count or a parameter ORDER that stopped matching the
//      column list; three new columns on two hand-written statements is exactly
//      the shape that invites it.
//   C. The derivation itself, through the component's real computeTotalEggs:
//      2 cartons -> 720 not 2; 3 cartons at 180 -> 540, proving eggs_per_carton
//      is read per row and not hardcoded; per_egg unchanged with carton_count
//      NULL; broken and graded eggs stored as egg counts on a carton row.
//   D. The component's real validateEggRow: broken + graded is bounded by 720
//      on a 2-carton row, and by the entered count in per_egg mode.
//   E. An edit that switches a row's mode either way stores the correct
//      total_eggs for the mode it lands in.
//   F. Every downstream egg figure — egg stock (egg-sales), cumulative
//      production (layer-flock-health), the layer report's collection list and
//      total — is IDENTICAL for a per_egg collection written by the old
//      pre-change statement and by the new one, and correct for a per_carton
//      one. Overview and farm-report are asserted statically to read no
//      egg_collection column at all.
//   G. The adjacent fix: the save's loop of unchecked db.run() became one
//      runBatch. Proven a pure move — ten per_egg rows saved both ways leave
//      byte-identical rows, column for column, and the same egg stock.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')

const src = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'app', ...p), 'utf8')

const COL_SRC = src('egg-collection', 'egg-collection.component.ts')
const EGG_SALES_SRC = src('egg-sales', 'egg-sales.component.ts')
const LFH_SRC = src('layer-flock-health', 'layer-flock-health.component.ts')
const LR_SRC = src('layer-report', 'layer-report.component.ts')
const OVERVIEW_SRC = src('shared', 'services', 'overview.service.ts')
const FARM_REPORT_SRC = src('shared', 'services', 'farm-report.service.ts')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(s, name, kw) {
  // Anchored on a declaration: a line whose first non-blank text IS the member.
  // A doc comment mentioning the name starts with `*` and a call site with
  // `this.`, either of which a bare indexOf would pick instead and then run off
  // the end of the file looking for a matching brace.
  const needle = `${kw}${name}(`
  let start = -1
  for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + 1)) {
    const lineStart = s.lastIndexOf('\n', i) + 1
    if (s.slice(lineStart, i).trim() === '') { start = i; break }
  }
  if (start < 0) throw new Error(`${name} not declared`)
  let i = s.indexOf('(', start), depth = 0
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) { i++; break } }
  }
  depth = 0
  for (i = s.indexOf('{', i); i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') { depth--; if (depth === 0) break }
  }
  return s.slice(start, i + 1)
}

/** A component method with its TypeScript annotations stripped. */
function loadMethod(source, name) {
  const raw = extractFn(source, name, '')
  const js = raw
    .replace(/^(\w+)\s*\(([^)]*)\)\s*:\s*[\w|\s'<>\[\]]+\s*\{/, (m, fn, args) =>
      `function ${fn}(${args.replace(/:\s*[\w<>\[\]|'\s]+/g, '')}) {`)
  return eval('(' + js + ')')
}

/**
 * The SQL string literal containing `marker`. Screens use backticks and plain
 * quotes interchangeably, so the delimiter is whichever one actually encloses
 * the marker rather than an assumed backtick.
 */
function liftSql(source, marker) {
  const idx = source.indexOf(marker)
  if (idx < 0) throw new Error(`marker not found: ${marker}`)
  let open = -1, quote = ''
  for (const q of ['`', "'", '"']) {
    const at = source.lastIndexOf(q, idx)
    if (at > open) { open = at; quote = q }
  }
  if (open < 0) throw new Error(`no SQL literal around: ${marker}`)
  const close = source.indexOf(quote, idx)
  if (close < 0) throw new Error(`unterminated SQL literal at: ${marker}`)
  return source.slice(open + 1, close)
}

/**
 * The parameter array that follows the SQL literal containing `marker`, as a
 * callable. Lifting the parameter list rather than restating it is the whole
 * point: a restated list would keep passing while the screen's own order
 * drifted, which is precisely the mistake that cannot be seen in TypeScript.
 *
 * It is the first array literal after the statement, which covers both shapes
 * the screen uses — a `params:` property inside a batch op, and a positional
 * second argument to db.run().
 */
function liftParams(source, marker, argNames) {
  const idx = source.indexOf(marker)
  if (idx < 0) throw new Error(`marker not found: ${marker}`)
  // Past the closing delimiter of the SQL literal itself, so a `[` inside the
  // statement text could not be mistaken for the start of the array.
  const quote = source[source.lastIndexOf('`', idx)] === '`' ? '`' : "'"
  const afterSql = source.indexOf(quote, idx)
  let start = source.indexOf('[', afterSql)
  if (start < 0) throw new Error(`no parameter array after: ${marker}`)
  let i = start, depth = 0, end = -1
  for (; i < source.length; i++) {
    if (source[i] === '[') depth++
    else if (source[i] === ']') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error(`unterminated parameter array at: ${marker}`)
  return eval(`(function (${argNames.join(', ')}) { return ${source.slice(start, end + 1)} })`)
}

// The engine. runBatch and executeStatement close over module-level state in
// database.js, so those names are declared here for the eval'd copies to bind
// to — this is the real writer, savepoints and all, not an emulation of it.
// ── The screen under test ───────────────────────────────────────────────────

const INSERT_SQL = liftSql(COL_SRC, 'INSERT INTO egg_collection (batch_id, date, total_eggs')
const UPDATE_SQL = liftSql(COL_SRC, 'UPDATE egg_collection SET batch_id = ?, date = ?')
const insertParams = liftParams(COL_SRC, 'INSERT INTO egg_collection (batch_id, date, total_eggs', ['row'])
const updateParams = liftParams(COL_SRC, 'UPDATE egg_collection SET batch_id = ?, date = ?', ['id'])

// The real derivation and the real validator, bound onto one context so the
// `this.` calls inside them resolve exactly as they do in the app.
const screen = {
  computeTotalEggs: loadMethod(COL_SRC, 'computeTotalEggs'),
  validateEggRow: loadMethod(COL_SRC, 'validateEggRow'),
  editForm: {}
}
// `this` inside the lifted parameter arrays is the component: the INSERT array
// reads this.computeTotalEggs(row), the UPDATE array this.editForm.
const buildInsertParams = (row) => insertParams.call(screen, row)
const buildUpdateParams = (editForm, id) => {
  screen.editForm = editForm
  return updateParams.call(screen, id)
}

// The statement as it stood BEFORE this change — frozen history, which is what
// makes "identical before and after" a real comparison rather than the new
// statement checked against itself. Every row in every existing database was
// written by this.
const LEGACY_INSERT_SQL =
  `INSERT INTO egg_collection (batch_id, date, total_eggs, broken_eggs, small_grade, medium_grade, large_grade, xl_grade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

// ── The downstream readers, lifted from their own screens ───────────────────

const Q_EGG_STOCK = liftSql(EGG_SALES_SRC, 'SELECT COALESCE(SUM(total_eggs - broken_eggs), 0) AS collected')
const Q_CUM_PRODUCTION = liftSql(LFH_SRC, 'SELECT date, COALESCE(SUM(total_eggs), 0) AS eggs')
// The layer report builds its unit filter by interpolation; the no-unit case is
// the empty string, which is the shape this file seeds.
const Q_LAYER_REPORT = liftSql(LR_SRC, 'SELECT ec.*, b.batch_name FROM egg_collection ec')
  .replace('${unitClause}', '')

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

const scratch = await createScratchDb('egg_collection_cartons', { farmContext: 1 })
db = scratch.db
try {
  await scratch.pool.query(fs.readFileSync(path.join(ROOT,'db/migrations/001_initial_schema.sql'),'utf8'))
  await migrate(scratch.pool,{schema:scratch.schema,historySchema:scratch.schema+'_meta',baseline:true})

  const rows = async (sql, params = []) => { const result = await db.get(sql, params); if (!result.success) throw new Error(result.error); return result.data }
  const one = async (sql, params = []) => (await rows(sql, params))[0]
  const cols = () => eggColumns()
  const clear = async () => (await runSqlFor(db, `DELETE FROM egg_collection`))
  // executeStatement logs the id of every insert and runBatch logs a failed
  // statement; both are the real functions, so the noise is silenced around
  // the calls rather than removed from them.
  const realLog = console.log
  const realErr = console.error
  const quiet = (fn) => { console.log = () => {}; console.error = () => {}; try { return fn() } finally { console.log = realLog; console.error = realErr } }
  const latest = async () => (await one(`SELECT * FROM egg_collection ORDER BY collection_id DESC LIMIT 1`))

  // Seed the account and batch the readers join through.
  await runSqlFor(db, `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1, 'Talha', 'x')`)
  await runSqlFor(db, `INSERT INTO batches (batch_id, farm_id, batch_name, start_date, initial_birds) VALUES (9, 1, 'Batch A', '2025-01-01', 5000)`)
  const BATCH = 9
  const FARM = 1

  // ── A. Schema ─────────────────────────────────────────────────────────────
  console.log('\n=== A. the three columns, their defaults, and re-running the ALTERs ===')

  for (const [name, type] of [['collection_mode', 'TEXT'], ['carton_count', 'REAL'], ['eggs_per_carton', 'INTEGER']]) {
    const col = (await cols()).find(c => c.name === name)
    checkTrue(`egg_collection.${name} exists`, !!col)
    if (col) check(`egg_collection.${name} type`, col.type, type)
  }
  check('collection_mode default', ((await cols()).find(c => c.name === 'collection_mode') || {}).dflt_value, `'per_egg'`)
  check('carton_count default', ((await cols()).find(c => c.name === 'carton_count') || {}).dflt_value, 'null')
  check('eggs_per_carton default', ((await cols()).find(c => c.name === 'eggs_per_carton') || {}).dflt_value, '360')

  // A row written by the legacy statement — which is every row in every
  // existing database — reads back as per_egg with no cartons. This is what
  // "no backfill" has to mean in practice: SQLite's ADD COLUMN ... DEFAULT
  // fills the existing rows, so nothing is left NULL-moded.
  await runSqlFor(db, LEGACY_INSERT_SQL, [BATCH, '2025-02-01', 500, 5, 100, 150, 200, 50])
  const legacyRow = (await latest())
  check('a legacy row reads back as per_egg', legacyRow.collection_mode, 'per_egg')
  checkTrue('a legacy row has no carton_count', legacyRow.carton_count === null)
  check('a legacy row carries the default carton size', legacyRow.eggs_per_carton, 360)
  check('a legacy row keeps its total_eggs', legacyRow.total_eggs, 500)
  await clear()

  // The ALTERs run on EVERY app launch. Running them again must change nothing
  // and must not throw past the duplicate-column catch that is how the loop
  // detects "already applied".
  const before = JSON.stringify((await cols()))
  let alterThrew = null
  try { await migrate(scratch.pool, { schema:scratch.schema, historySchema:scratch.schema+'_meta' }) } catch(e) { alterThrew=e.message }
  checkTrue('re-running PostgreSQL migrations raises no errors', alterThrew === null)
  check('re-running PostgreSQL migrations leaves the schema identical', JSON.stringify((await cols())), before)

  // ── B. The screen's own statements, one sentinel per parameter ────────────
  console.log('\n=== B. the screen INSERT and UPDATE bind to the right columns ===')

  // Values no two of which could be confused, so a parameter landing in the
  // wrong column cannot coincide with the right one.
  const S = {
    batch_id: BATCH, date: '2025-03-04',
    collection_mode: 'per_carton', carton_count: 11, eggs_per_carton: 13,
    broken_eggs: 21, small_grade: 22, medium_grade: 23, large_grade: 24, xl_grade: 25
  }
  check('INSERT placeholder count matches the screen parameter list',
    (INSERT_SQL.match(/\?/g) || []).length, buildInsertParams(S).length)
  check('UPDATE placeholder count matches the screen parameter list',
    (UPDATE_SQL.match(/\?/g) || []).length, buildUpdateParams(S, 1).length)

  let threw = null
  try { await runSqlFor(db, INSERT_SQL, buildInsertParams(S)) } catch (e) { threw = e.message }
  checkTrue('the screen INSERT executes against the real schema', threw === null)
  if (threw) console.log(`        ${threw}`)
  const sent = (await latest())
  check('INSERT -> batch_id', sent.batch_id, S.batch_id)
  check('INSERT -> date', sent.date, S.date)
  check('INSERT -> broken_eggs', sent.broken_eggs, S.broken_eggs)
  check('INSERT -> small_grade', sent.small_grade, S.small_grade)
  check('INSERT -> medium_grade', sent.medium_grade, S.medium_grade)
  check('INSERT -> large_grade', sent.large_grade, S.large_grade)
  check('INSERT -> xl_grade', sent.xl_grade, S.xl_grade)
  check('INSERT -> collection_mode', sent.collection_mode, S.collection_mode)
  check('INSERT -> carton_count', sent.carton_count, S.carton_count)
  check('INSERT -> eggs_per_carton', sent.eggs_per_carton, S.eggs_per_carton)
  // The one column that is NOT a passed-through sentinel: it is derived, and
  // with distinct carton sentinels only the product can be right.
  check('INSERT -> total_eggs is the product, not either factor',
    sent.total_eggs, S.carton_count * S.eggs_per_carton)

  const U = {
    batch_id: BATCH, date: '2025-04-05',
    collection_mode: 'per_carton', carton_count: 31, eggs_per_carton: 17,
    broken_eggs: 41, small_grade: 42, medium_grade: 43, large_grade: 44, xl_grade: 45
  }
  threw = null
  try { await runSqlFor(db, UPDATE_SQL, buildUpdateParams(U, sent.collection_id)) } catch (e) { threw = e.message }
  checkTrue('the screen UPDATE executes against the real schema', threw === null)
  if (threw) console.log(`        ${threw}`)
  const upd = (await latest())
  check('UPDATE -> batch_id', upd.batch_id, U.batch_id)
  check('UPDATE -> date', upd.date, U.date)
  check('UPDATE -> broken_eggs', upd.broken_eggs, U.broken_eggs)
  check('UPDATE -> small_grade', upd.small_grade, U.small_grade)
  check('UPDATE -> medium_grade', upd.medium_grade, U.medium_grade)
  check('UPDATE -> large_grade', upd.large_grade, U.large_grade)
  check('UPDATE -> xl_grade', upd.xl_grade, U.xl_grade)
  check('UPDATE -> collection_mode', upd.collection_mode, U.collection_mode)
  check('UPDATE -> carton_count', upd.carton_count, U.carton_count)
  check('UPDATE -> eggs_per_carton', upd.eggs_per_carton, U.eggs_per_carton)
  check('UPDATE -> total_eggs is the product', upd.total_eggs, U.carton_count * U.eggs_per_carton)
  check('UPDATE touched exactly one row', (await one(`SELECT COUNT(*) AS n FROM egg_collection`)).n, 1)
  await clear()

  // ── C. The derivation ─────────────────────────────────────────────────────
  console.log('\n=== C. total_eggs holds the TRUE egg count ===')

  // THE one that matters: 2 cartons is 720 eggs, not 2.
  const twoCartons = {
    batch_id: BATCH, date: '2025-05-01', collection_mode: 'per_carton',
    total_eggs: null, carton_count: 2, eggs_per_carton: 360,
    broken_eggs: 0, small_grade: 0, medium_grade: 0, large_grade: 0, xl_grade: 0
  }
  check('computeTotalEggs(2 cartons x 360)', screen.computeTotalEggs(twoCartons), 720)
  await runSqlFor(db, INSERT_SQL, buildInsertParams(twoCartons))
  check('a 2-carton save records total_eggs', (await latest()).total_eggs, 720)
  checkTrue('a 2-carton save does NOT record the carton count in total_eggs', (await latest()).total_eggs !== 2)
  check('a 2-carton save keeps the carton count in its own column', (await latest()).carton_count, 2)
  await clear()

  // A different carton size, proving eggs_per_carton is read off the ROW.
  const threeAt180 = {
    batch_id: BATCH, date: '2025-05-02', collection_mode: 'per_carton',
    total_eggs: null, carton_count: 3, eggs_per_carton: 180,
    broken_eggs: 0, small_grade: 0, medium_grade: 0, large_grade: 0, xl_grade: 0
  }
  check('computeTotalEggs(3 cartons x 180)', screen.computeTotalEggs(threeAt180), 540)
  await runSqlFor(db, INSERT_SQL, buildInsertParams(threeAt180))
  check('a 3-carton save at 180 records total_eggs', (await latest()).total_eggs, 540)
  checkTrue('and did not fall back to the 360 default', (await latest()).total_eggs !== 1080)
  check('and stores the size it was recorded at', (await latest()).eggs_per_carton, 180)
  await clear()

  // per_egg is untouched: the entered count, stored as entered.
  const perEgg = {
    batch_id: BATCH, date: '2025-05-03', collection_mode: 'per_egg',
    total_eggs: 487, carton_count: null, eggs_per_carton: 360,
    broken_eggs: 7, small_grade: 100, medium_grade: 150, large_grade: 200, xl_grade: 30
  }
  check('computeTotalEggs(per_egg)', screen.computeTotalEggs(perEgg), 487)
  await runSqlFor(db, INSERT_SQL, buildInsertParams(perEgg))
  check('a per_egg save records the entered count unchanged', (await latest()).total_eggs, 487)
  checkTrue('a per_egg save leaves carton_count NULL', (await latest()).carton_count === null)
  check('a per_egg save still records a carton size for the row', (await latest()).eggs_per_carton, 360)
  await clear()

  // A per_egg row whose carton fields were typed and then abandoned by a mode
  // switch must not take them: the mode alone decides.
  const abandoned = { ...perEgg, carton_count: 99 }
  await runSqlFor(db, INSERT_SQL, buildInsertParams(abandoned))
  check('a per_egg row ignores a leftover carton_count for total_eggs', (await latest()).total_eggs, 487)
  checkTrue('a per_egg row stores no leftover carton_count', (await latest()).carton_count === null)
  await clear()

  // Broken and graded eggs are EGG COUNTS in both modes. A 2-carton collection
  // with one broken egg stores 1, not one carton's worth.
  const cartonWithBroken = { ...twoCartons, broken_eggs: 1, small_grade: 300, medium_grade: 400, xl_grade: 19 }
  await runSqlFor(db, INSERT_SQL, buildInsertParams(cartonWithBroken))
  const cwb = (await latest())
  check('a carton row stores broken as an EGG count', cwb.broken_eggs, 1)
  check('a carton row stores grades as EGG counts', `${cwb.small_grade}/${cwb.medium_grade}/${cwb.xl_grade}`, '300/400/19')
  check('and its sellable stock is eggs minus broken eggs', cwb.total_eggs - cwb.broken_eggs, 719)
  await clear()

  // ── D. The grading check ──────────────────────────────────────────────────
  console.log('\n=== D. broken + graded is bounded by the DERIVED total ===')

  const valid = (row) => screen.validateEggRow(row)
  // 720 exactly: allowed. 721: refused. The bound is the derived count, so a
  // carton row is not being checked against its 2.
  checkTrue('a 2-carton row grading 720 eggs is accepted',
    valid({ ...twoCartons, broken_eggs: 20, small_grade: 300, medium_grade: 300, large_grade: 100 }) === null)
  checkTrue('a 2-carton row grading 721 eggs is refused',
    /cannot exceed/.test(valid({ ...twoCartons, broken_eggs: 21, small_grade: 300, medium_grade: 300, large_grade: 100 }) || ''))
  checkTrue('a 3-carton row at 180 is bounded by 540, not 1080',
    /cannot exceed/.test(valid({ ...threeAt180, small_grade: 541 }) || ''))
  checkTrue('a per_egg row is bounded by its entered count',
    /cannot exceed/.test(valid({ ...perEgg, total_eggs: 100, broken_eggs: 0, small_grade: 101, medium_grade: 0, large_grade: 0, xl_grade: 0 }) || ''))
  checkTrue('a per_egg row within its entered count is accepted',
    valid({ ...perEgg, total_eggs: 100, broken_eggs: 0, small_grade: 100, medium_grade: 0, large_grade: 0, xl_grade: 0 }) === null)
  checkTrue('a carton row with no carton count is refused',
    /Carton count/.test(valid({ ...twoCartons, carton_count: null }) || ''))
  checkTrue('a carton row with no carton size is refused',
    /Eggs per carton/.test(valid({ ...twoCartons, eggs_per_carton: 0 }) || ''))
  checkTrue('a per_egg row with no total is refused',
    /total eggs/.test(valid({ ...perEgg, total_eggs: null }) || ''))
  checkTrue('negative quantities are refused in carton mode',
    /negative/.test(valid({ ...twoCartons, broken_eggs: -1 }) || ''))

  // ── E. Switching a row's mode in an edit ──────────────────────────────────
  console.log('\n=== E. an edit that switches mode stores the new mode total ===')

  await runSqlFor(db, INSERT_SQL, buildInsertParams(twoCartons))
  const switchId = (await latest()).collection_id
  check('starts at 720', (await latest()).total_eggs, 720)
  // per_carton -> per_egg: the entered count wins and the carton figure goes.
  await runSqlFor(db, UPDATE_SQL, buildUpdateParams({
    ...twoCartons, collection_mode: 'per_egg', total_eggs: 455, carton_count: 2
  }, switchId))
  check('per_carton -> per_egg stores the entered count', (await latest()).total_eggs, 455)
  check('per_carton -> per_egg records the new mode', (await latest()).collection_mode, 'per_egg')
  checkTrue('per_carton -> per_egg clears carton_count', (await latest()).carton_count === null)
  // per_egg -> per_carton: the product wins, and the stale total_eggs the form
  // still carries from the per-egg input must not be taken instead.
  await runSqlFor(db, UPDATE_SQL, buildUpdateParams({
    ...twoCartons, collection_mode: 'per_carton', total_eggs: 455, carton_count: 4, eggs_per_carton: 360
  }, switchId))
  check('per_egg -> per_carton stores the product', (await latest()).total_eggs, 1440)
  check('per_egg -> per_carton records the new mode', (await latest()).collection_mode, 'per_carton')
  check('per_egg -> per_carton records the cartons', (await latest()).carton_count, 4)
  // A carton-size change on a row already in carton mode re-derives too.
  await runSqlFor(db, UPDATE_SQL, buildUpdateParams({
    ...twoCartons, collection_mode: 'per_carton', carton_count: 4, eggs_per_carton: 180
  }, switchId))
  check('changing the carton size re-derives total_eggs', (await latest()).total_eggs, 720)
  await clear()

  // ── F. Every downstream egg figure ────────────────────────────────────────
  console.log('\n=== F. downstream figures: identical for per_egg, correct for per_carton ===')

  // The same user input, written by the OLD statement and by the NEW one. Each
  // downstream reader is then run over both and the figures compared.
  const DAYS = [
    { date: '2025-06-01', total: 480, broken: 6, s: 100, m: 150, l: 200, xl: 24 },
    { date: '2025-06-02', total: 512, broken: 9, s: 120, m: 160, l: 210, xl: 13 },
    { date: '2025-06-02', total: 240, broken: 2, s: 60, m: 80, l: 90, xl: 8 },
    { date: '2025-06-03', total: 505, broken: 0, s: 110, m: 155, l: 205, xl: 35 }
  ]
  const readAll = async () => ({
    stock: (await one(Q_EGG_STOCK, [BATCH])).collected,
    production: JSON.stringify((await rows(Q_CUM_PRODUCTION, [BATCH]))),
    // layer-report.component.ts:137 — totalEggs is reduce(+ e.total_eggs) over
    // exactly the rows this query returns.
    reportRows: (await rows(Q_LAYER_REPORT, [FARM])).length,
    reportTotalEggs: (await rows(Q_LAYER_REPORT, [FARM])).reduce((s, e) => s + (e.total_eggs || 0), 0),
    reportBroken: (await rows(Q_LAYER_REPORT, [FARM])).reduce((s, e) => s + (e.broken_eggs || 0), 0)
  })

  await clear()
  for (const d of DAYS) await runSqlFor(db, LEGACY_INSERT_SQL, [BATCH, d.date, d.total, d.broken, d.s, d.m, d.l, d.xl])
  const beforeFigures = (await readAll())

  await clear()
  for (const d of DAYS) {
    await runSqlFor(db, INSERT_SQL, buildInsertParams({
      batch_id: BATCH, date: d.date, collection_mode: 'per_egg',
      total_eggs: d.total, carton_count: null, eggs_per_carton: 360,
      broken_eggs: d.broken, small_grade: d.s, medium_grade: d.m, large_grade: d.l, xl_grade: d.xl
    }))
  }
  const afterFigures = (await readAll())

  check('egg stock (egg-sales) identical before and after', afterFigures.stock, beforeFigures.stock)
  check('cumulative production (layer-flock-health) identical', afterFigures.production, beforeFigures.production)
  check('layer report row count identical', afterFigures.reportRows, beforeFigures.reportRows)
  check('layer report total eggs identical', afterFigures.reportTotalEggs, beforeFigures.reportTotalEggs)
  check('layer report broken eggs identical', afterFigures.reportBroken, beforeFigures.reportBroken)
  // Not merely equal to each other — equal to the arithmetic the user expects.
  check('and that figure is the eggs the user entered',
    afterFigures.reportTotalEggs, DAYS.reduce((s, d) => s + d.total, 0))
  check('and the stock is those eggs minus the broken ones',
    afterFigures.stock, DAYS.reduce((s, d) => s + d.total - d.broken, 0))

  // Now the carton side: the SAME physical collection, recorded as cartons,
  // has to produce the same figures as recording its egg count directly.
  await clear()
  await runSqlFor(db, INSERT_SQL, buildInsertParams({
    batch_id: BATCH, date: '2025-07-01', collection_mode: 'per_egg',
    total_eggs: 720, carton_count: null, eggs_per_carton: 360,
    broken_eggs: 4, small_grade: 0, medium_grade: 0, large_grade: 0, xl_grade: 0
  }))
  const asEggs = (await readAll())
  await clear()
  await runSqlFor(db, INSERT_SQL, buildInsertParams({
    batch_id: BATCH, date: '2025-07-01', collection_mode: 'per_carton',
    total_eggs: null, carton_count: 2, eggs_per_carton: 360,
    broken_eggs: 4, small_grade: 0, medium_grade: 0, large_grade: 0, xl_grade: 0
  }))
  const asCartons = (await readAll())
  check('2 cartons and 720 eggs report the same stock', asCartons.stock, asEggs.stock)
  check('2 cartons and 720 eggs report the same production', asCartons.production, asEggs.production)
  check('2 cartons and 720 eggs report the same layer-report total', asCartons.reportTotalEggs, asEggs.reportTotalEggs)
  check('and that total is 720, not 2', asCartons.reportTotalEggs, 720)
  check('and the stock is 716, not -2', asCartons.stock, 716)
  await clear()

  // Overview and farm-report have no egg-collection figure to move, and that is
  // asserted rather than assumed: they read egg_sales (money), not production.
  checkTrue('overview.service.ts reads no egg_collection column', !/egg_collection/.test(OVERVIEW_SRC))
  checkTrue('farm-report.service.ts reads no egg_collection column', !/egg_collection/.test(FARM_REPORT_SRC))
  // And every screen that DOES read it still reads total_eggs, unchanged — a
  // consumer rewritten to read carton_count would be the failure this catches.
  checkTrue('egg-sales still reads SUM(total_eggs - broken_eggs)', /SUM\(total_eggs - broken_eggs\)/.test(EGG_SALES_SRC))
  checkTrue('layer-flock-health still reads SUM(total_eggs)', /SUM\(total_eggs\)/.test(LFH_SRC))
  checkTrue('layer-report still sums e.total_eggs', /e\.total_eggs/.test(LR_SRC))
  // No egg_collection READ mentions a carton column: every downstream figure
  // comes off total_eggs, which is the whole reason the derivation can live at
  // save time. (The consumer FILES do mention carton_count — egg-sales and the
  // layer report's sales section have their own per-carton pricing — so this is
  // asserted on the lifted egg_collection queries, not on whole files.)
  for (const [what, sql] of [['egg stock', Q_EGG_STOCK], ['cumulative production', Q_CUM_PRODUCTION]]) {
    checkTrue(`the ${what} query aggregates total_eggs and names no carton column`,
      /total_eggs/.test(sql) && !/carton/.test(sql))
  }
  // The layer report selects ec.* and does its arithmetic in the component, so
  // what matters there is that it names no carton column either.
  checkTrue('the layer report query selects the collection row and names no carton column',
    /ec\.\*/.test(Q_LAYER_REPORT) && !/carton/.test(Q_LAYER_REPORT))
  // layer-report.component.ts:137 sums e.total_eggs off those rows; the only
  // carton reference in that file is on an egg SALES row (s.carton_count).
  checkTrue('the layer report sums collections off total_eggs, not cartons',
    /e\.total_eggs/.test(LR_SRC) && !/e\.carton_count/.test(LR_SRC))

  // ── G. The adjacent fix: the save loop became one runBatch ───────────────
  console.log('\n=== G. loop of run() -> one runBatch is a pure move ===')

  const TEN = Array.from({ length: 10 }, (_, i) => ({
    batch_id: BATCH, date: `2025-08-${String(i + 1).padStart(2, '0')}`,
    collection_mode: 'per_egg',
    total_eggs: 400 + i * 7, carton_count: null, eggs_per_carton: 360,
    broken_eggs: i, small_grade: 50 + i, medium_grade: 60 + i, large_grade: 70 + i, xl_grade: 80 + i
  }))
  // Every column except the autoincrement id, which is not a figure anyone
  // reads and necessarily differs between two separate runs.
  const snapshot = async () => (await rows(`SELECT * FROM egg_collection ORDER BY date, collection_id`))
    .map(r => { const { collection_id, ...rest } = r; return rest })

  // The OLD shape: one runQuery per row, exactly as the loop did it.
  await clear()
  for (const row of TEN) {
    const res = (await quiet(async () => (await runQuery(INSERT_SQL, buildInsertParams(row)))))
    if (!res.success) { failures++; console.log(`  FAIL  loop write failed: ${res.error}`) }
  }
  const loopRows = (await snapshot())
  const loopStock = (await one(Q_EGG_STOCK, [BATCH])).collected
  const loopProduction = JSON.stringify((await rows(Q_CUM_PRODUCTION, [BATCH])))

  // The NEW shape: one batch, through the real runBatch.
  await clear()
  const batchRes = (await quiet(async () => (await runBatch(TEN.map(row => ({ sql: INSERT_SQL, params: buildInsertParams(row) }))))))
  checkTrue('the batch reports success', batchRes && batchRes.success === true)
  const batchRows = (await snapshot())
  const batchStock = (await one(Q_EGG_STOCK, [BATCH])).collected
  const batchProduction = JSON.stringify((await rows(Q_CUM_PRODUCTION, [BATCH])))

  check('ten rows either way', batchRows.length, 10)
  check('every column of every row is identical', JSON.stringify(batchRows), JSON.stringify(loopRows))
  check('egg stock identical', batchStock, loopStock)
  check('cumulative production identical', batchProduction, loopProduction)
  // Per column, so a failure says WHICH column drifted rather than dumping two
  // JSON blobs to compare by eye.
  for (const key of Object.keys(loopRows[0] || {})) {
    check(`  column ${key} identical`,
      JSON.stringify(batchRows.map(r => r[key])), JSON.stringify(loopRows.map(r => r[key])))
  }

  // And the property the move was for: a batch that fails writes NOTHING,
  // where the loop left the rows before the failure behind.
  await clear()
  const partial = (await quiet(async () => (await runBatch([
    { sql: INSERT_SQL, params: buildInsertParams(TEN[0]) },
    { sql: `INSERT INTO egg_collection (batch_id, date, no_such_column) VALUES (?, ?, ?)`, params: [BATCH, '2025-09-01', 1] },
    { sql: INSERT_SQL, params: buildInsertParams(TEN[1]) }
  ]))))
  checkTrue('a failing batch reports failure', partial && partial.success === false)
  check('a failing batch leaves no rows behind', (await one(`SELECT COUNT(*) AS n FROM egg_collection`)).n, 0)
  await clear()

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} finally { await scratch.pool.query('DROP SCHEMA IF EXISTS '+scratch.schema+'_meta CASCADE'); await scratch.close() }
