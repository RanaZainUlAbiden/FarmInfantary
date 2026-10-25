// PRIMARY_KEY_MAP must agree with the real schema, table for table.
//
// WHY THIS EXISTS
// ---------------
// `lastId` is how 341 call sites learn the id of a row they just inserted, and
// taking it from a separate `SELECT last_insert_rowid()` has always returned 0
// (docs/LANDMINES.md line 126). The desktop app resolves it from
// last_insert_rowid() with a MAX(pk) fallback driven by PRIMARY_KEY_MAP in
// electron/database.js. A table missing from that map logs a warning and
// returns `lastId: null` — and a null id does not throw. It gets written into a
// foreign key column, and the row is quietly orphaned.
//
// PHASE 1 makes this worse before it makes it better: PostgreSQL has no
// last_insert_rowid(), so `RETURNING <pk>` becomes the ONLY mechanism, and the
// map becomes the single source of truth for which column to return. A gap that
// is merely a fallback today is a guaranteed null tomorrow.
//
// So this asserts the map is complete and correct against the schema the app
// actually builds — createTables + alterStatements + the structural migration.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const REF = path.join(ROOT, 'Talha Farm')

const initSqlJs = require(path.join(REF, 'node_modules', 'sql.js'))
const DB_SRC = fs.readFileSync(path.join(REF, 'electron', 'database.js'), 'utf8')

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

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const migrateVaccinations = eval(
  '(' + extractFn(DB_SRC, 'migrateVaccinationsNullableBatchId', 'function ') + ')'
)
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// The map itself, lifted from the real source.
const PRIMARY_KEY_MAP = (() => {
  const start = DB_SRC.indexOf('const PRIMARY_KEY_MAP = {')
  if (start < 0) throw new Error('PRIMARY_KEY_MAP not found')
  const end = DB_SRC.indexOf('\n}', start)
  return eval(DB_SRC.slice(start, end + 2) + '; PRIMARY_KEY_MAP')
})()

// ── harness ────────────────────────────────────────────────
let passed = 0
const failures = []
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

;(async () => {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(REF, 'node_modules', 'sql.js', 'dist', f),
  })
  const db = new SQL.Database()

  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch { /* already applied */ } }
  try { migrateVaccinations(db) } catch { /* best effort */ }

  const q = (sql) => {
    const out = [], st = db.prepare(sql)
    while (st.step()) out.push(st.getAsObject())
    st.free()
    return out
  }

  const tables = q(
    `SELECT name, sql FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  )

  console.log('PRIMARY_KEY_MAP vs the real schema')
  console.log('='.repeat(62))
  console.log(`  schema: ${tables.length} tables   map: ${Object.keys(PRIMARY_KEY_MAP).length} entries\n`)

  // ── A. every insertable table is mapped ──────────────────
  console.log('=== A. coverage — a gap here means lastId is null ===')

  const needsMap = []   // single-column INTEGER pk: an insert here yields an id
  const textPk = []     // pk is not an integer: no generated id to return
  const noPk = []

  for (const t of tables) {
    const cols = q(`PRAGMA table_info(${t.name})`)
    const pks = cols.filter((c) => c.pk > 0)
    if (pks.length === 0) { noPk.push(t.name); continue }
    if (pks.length > 1) { noPk.push(`${t.name} (composite)`); continue }
    const pk = pks[0]
    if (String(pk.type).toUpperCase() === 'INTEGER') needsMap.push([t.name, pk.name])
    else textPk.push(`${t.name}.${pk.name}:${pk.type}`)
  }

  const missing = needsMap.filter(([t]) => !PRIMARY_KEY_MAP[t])
  check(
    `every integer-keyed table is in the map (${needsMap.length} tables)`,
    missing.length === 0,
    missing.length ? `MISSING: ${missing.map(([t, c]) => `${t}.${c}`).join(', ')}` : ''
  )

  // ── B. every mapping names the right column ──────────────
  console.log('\n=== B. correctness — a wrong column name returns the wrong id ===')

  const wrong = needsMap.filter(([t, c]) => PRIMARY_KEY_MAP[t] && PRIMARY_KEY_MAP[t] !== c)
  check(
    'every mapped column is that table\'s actual primary key',
    wrong.length === 0,
    wrong.map(([t, c]) => `${t}: map says "${PRIMARY_KEY_MAP[t]}", schema says "${c}"`).join('; ')
  )

  // ── C. no stale entries ──────────────────────────────────
  console.log('\n=== C. no stale entries — a renamed table leaves a dead mapping ===')

  const tableNames = new Set(tables.map((t) => t.name))
  const orphanTables = Object.keys(PRIMARY_KEY_MAP).filter((t) => !tableNames.has(t))
  check(
    'every map entry names a table that exists',
    orphanTables.length === 0,
    orphanTables.join(', ')
  )

  const badCols = []
  for (const [t, c] of Object.entries(PRIMARY_KEY_MAP)) {
    if (!tableNames.has(t)) continue
    const cols = q(`PRAGMA table_info(${t})`).map((x) => x.name)
    if (!cols.includes(c)) badCols.push(`${t}.${c}`)
  }
  check('every map entry names a column that exists', badCols.length === 0, badCols.join(', '))

  // ── D. what Phase 1 must carry ───────────────────────────
  console.log('\n=== D. the Phase 1 contract ===')
  check(
    'the map covers every table RETURNING will need',
    needsMap.length > 0 && missing.length === 0,
    `${needsMap.length} tables need RETURNING <pk>`
  )

  if (textPk.length) console.log(`  note  non-integer keys, no id to return: ${textPk.join(', ')}`)
  if (noPk.length) console.log(`  note  no single-column key: ${noPk.join(', ')}`)

  console.log('\n' + '='.repeat(62))
  if (failures.length) {
    console.log(`FAILED — ${failures.length} check(s):`)
    for (const f of failures) console.log(`  - ${f}`)
    console.log(
      '\nFix PRIMARY_KEY_MAP in electron/database.js (Phase 0/1) or its ported\n' +
      'equivalent in server/src/db/primary-keys.ts. An unmapped table returns\n' +
      'lastId: null, and a null id does not throw — it orphans the row.'
    )
    process.exit(1)
  }
  console.log(`ALL CHECKS PASSED — ${passed} checks, ${needsMap.length} insertable tables mapped`)
})().catch((err) => {
  console.error('\nThrew:', err && err.stack ? err.stack : err)
  process.exit(1)
})
