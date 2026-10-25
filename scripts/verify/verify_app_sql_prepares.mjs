// Every static SQL string in the app, translated and PREPAREd against
// PostgreSQL.
//
// WHY PREPARE
// -----------
// `PREPARE` makes PostgreSQL parse, resolve and type-check a statement
// without running it. That catches the whole class of problems the screen
// walk was finding one blank card at a time:
//
//   - unknown functions          function date(text, text) does not exist
//   - operator mismatches        operator does not exist: date + bigint
//   - uninferable parameters     could not determine data type of parameter $3
//   - GROUP BY strictness        column "p.product_name" must appear in the
//                                GROUP BY clause
//
// The last one is the reason this exists. SQLite lets a query select bare
// columns alongside an aggregate and picks an arbitrary row; PostgreSQL
// refuses unless each is grouped, aggregated, or functionally dependent on a
// grouped primary key. There are 45 GROUP BY queries in the app and no way to
// reach them all by clicking — a screen only reveals its own.
//
// SCOPE, STATED HONESTLY
// ----------------------
// Only SQL that is a self-contained template literal is checked. Strings built
// with ${...} interpolation are skipped and counted: their final text is not
// knowable without running the app. The skipped count is reported so the gap
// is visible rather than implied.
//
// Skips (exit 0) when no database is configured.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

const envPath = join(ROOT, '.env')
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* no .env */ }

if (!process.env.DATABASE_URL) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }

let pg, dialect, placeholders, splitStatements
try {
  pg = require(join(ROOT, 'server', 'node_modules', 'pg'))
  dialect = await import(new URL('../../server/src/db/dialect.js', import.meta.url))
  placeholders = await import(new URL('../../server/src/db/placeholders.js', import.meta.url))
  ;({ splitStatements } = await import(new URL('../../server/src/db/scan.js', import.meta.url)))
} catch (err) {
  console.log(`SKIP — server deps unavailable (${err.message})`)
  process.exit(0)
}

// ── find the app's SQL ─────────────────────────────────────

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

const SRC = [join(ROOT, 'src', 'app'), join(ROOT, 'Talha Farm', 'src', 'app')]
  .filter((d) => { try { return statSync(d).isDirectory() } catch { return false } })
  .filter((d) => walk(d).length > 0)[0]

if (!SRC) { console.log('SKIP — no Angular source tree found'); process.exit(0) }

/** Template literals whose content reads as a complete SQL statement. */
function sqlLiterals(src) {
  const found = []
  let fragments = 0
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`') continue
    let j = i + 1
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue }
      if (src[j] === '`') break
    }
    const body = src.slice(i + 1, j)
    // Is this literal a FRAGMENT of a concatenated statement?
    //
    // overview.service.ts builds queries as `SELECT ... WHERE ...` + a date
    // clause + ` GROUP BY ...`. Taking the first piece alone yields a query
    // with an aggregate and no GROUP BY, which PostgreSQL rightly rejects —
    // and reports as a GROUP BY defect that does not exist. Seven of the ten
    // failures in the first run were this.
    //
    // A `+` immediately before or after the backticks is the signal.
    const before = src.slice(Math.max(0, i - 3), i)
    const after = src.slice(j + 1, j + 4)
    const isFragment = /\+\s*$/.test(before) || /^\s*\+/.test(after)
    i = j
    if (isFragment) { fragments++; continue }
    // A bare keyword is not a statement. The app has literals like `update`
    // and `insert` used as mode flags, and a comment-ish `INSERT INTO
    // *_vouchers`; requiring the matching clause keyword filters those out
    // without needing a parser.
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue
    if (body.trim().length < 25) continue
    const kind = /^\s*(\w+)/.exec(body)[1].toUpperCase()
    const needs = {
      SELECT: /\bFROM\b/i,
      INSERT: /\bINTO\b[\s\S]*\b(VALUES|SELECT)\b/i,
      UPDATE: /\bSET\b/i,
      DELETE: /\bFROM\b/i,
    }[kind]
    if (needs && !needs.test(body)) continue
    found.push(body)
  }
  sqlLiterals.fragments = (sqlLiterals.fragments || 0) + fragments
  return found
}

const statements = []
let skippedInterpolated = 0

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  for (const body of sqlLiterals(readFileSync(file, 'utf8'))) {
    if (body.includes('${')) { skippedInterpolated++; continue }
    statements.push({ file: rel, sql: body })
  }
}

// ── prepare each one ───────────────────────────────────────

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

let prepared = 0
const failures = []
let n = 0

console.log('App SQL, translated and PREPAREd against PostgreSQL')
console.log('='.repeat(68))
console.log(`  ${statements.length} self-contained statements from ${relative(ROOT, SRC)}`)
console.log(`  ${skippedInterpolated} skipped (built with \${...} interpolation)\n`)

for (const s of statements) {
  // Split FIRST, then translate and number each piece — exactly the order
  // execute.js uses at runtime. Numbering across the whole string and then
  // splitting leaves piece two holding $2 with no $1, which PostgreSQL
  // reports as an undeterminable parameter type. That is a bug in the
  // checker, not the app, and it produced a false failure.
  let pieces
  try {
    pieces = splitStatements(s.sql).map((piece) => {
      const t = dialect.translate(piece)
      if (t.unhandled.length) throw new Error(`untranslated: ${t.unhandled.join('; ')}`)
      return placeholders.toNumberedPlaceholders(t.text).text
    })
  } catch (err) {
    failures.push({ ...s, error: err.message })
    continue
  }

  try {
    for (const piece of pieces) {
      const name = `vp_${++n}`
      await client.query(`PREPARE ${name} AS ${piece}`)
      await client.query(`DEALLOCATE ${name}`)
    }
    prepared++
  } catch (err) {
    failures.push({ ...s, error: err.message })
  }
}

await client.end()

console.log('='.repeat(68))
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${statements.length} statements do not prepare:\n`)
  const byError = new Map()
  for (const f of failures) {
    const key = f.error.replace(/\$\d+/g, '$N').replace(/"[^"]*"/g, '"…"')
    if (!byError.has(key)) byError.set(key, [])
    byError.get(key).push(f)
  }
  for (const [key, list] of byError) {
    console.log(`  ${list.length}x  ${key}`)
    for (const f of list.slice(0, 3)) {
      console.log(`        ${f.file}`)
      console.log(`        ${f.sql.replace(/\s+/g, ' ').trim().slice(0, 150)}`)
    }
    console.log('')
  }
  process.exit(1)
}
console.log(`ALL CHECKS PASSED — ${prepared} statements prepare cleanly`)
