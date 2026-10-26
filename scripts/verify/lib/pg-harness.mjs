/**
 * Shared harness for running the inherited verify scripts against PostgreSQL.
 *
 * WHAT THE INHERITED SCRIPTS DO
 * -----------------------------
 * Each one lifts real method bodies out of `database.service.ts` AS TEXT,
 * transpiles away the TypeScript, and runs them against a `svc` object whose
 * `get` / `run` / `runBatch` are wired to a sql.js database built by the real
 * `createTables` + `alterStatements`. The methods are the actual shipping code,
 * which is the whole point — these are not reimplementations.
 *
 * WHAT CHANGES FOR POSTGRESQL
 * ---------------------------
 * Only the two ends:
 *   - the schema comes from db/schema/001_tables.sql instead of createTables()
 *   - `svc` is backed by server/src/db/execute.js instead of sql.js
 *
 * The extraction, the method bodies and the assertions are untouched. That is
 * what makes a green run meaningful: the same code, the same checks, a
 * different database underneath.
 *
 * Each script gets its own PostgreSQL SCHEMA, dropped at the end, so scripts
 * cannot see each other's rows and nothing is left behind.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..', '..')
export const REF = join(ROOT, 'Talha Farm')

const require = createRequire(import.meta.url)

// ── env ────────────────────────────────────────────────────

export function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch { /* no .env — the caller decides whether that is fatal */ }
  return process.env.DATABASE_URL ?? null
}

// ── source extraction (identical to the inherited scripts) ──

export const DB_SRC = readFileSync(join(REF, 'electron', 'database.js'), 'utf8')
export const SVC_SRC = readFileSync(
  join(REF, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8'
)

/**
 * Lift a function or method body out of source text.
 *
 * The parameter list is skipped FIRST: a signature can carry an inline object
 * type whose braces would otherwise be mistaken for the body. That is also why
 * several interfaces in database.service.ts are named rather than written
 * inline — keep that convention.
 */
export function extractFn(src, name, kw) {
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

/** Extract an `async methodName(...)` from database.service.ts as a function. */
export function loadMethod(name, kw = 'async ') {
  const ts = require(join(REF, 'node_modules', 'typescript'))
  const body = extractFn(SVC_SRC, name, kw).replace(/^async\s+/, 'async function ')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

// ── PostgreSQL scratch schema ──────────────────────────────

let schemaSql = null
let collationSql = null

/** Collations the app's SQL depends on. See db/schema/000_collations.sql. */
function collationsDdl() {
  if (collationSql === null) {
    collationSql = readFileSync(join(ROOT, 'db', 'schema', '000_collations.sql'), 'utf8')
  }
  return collationSql
}

/** The generated DDL, with `CREATE TABLE IF NOT EXISTS` kept as-is. */
function tablesDdl() {
  if (schemaSql === null) {
    schemaSql = readFileSync(join(ROOT, 'db', 'schema', '001_tables.sql'), 'utf8')
  }
  return schemaSql
}

/**
 * A pool whose every connection is pinned to a fresh scratch schema.
 *
 * `search_path` is set in the connection startup options, so the extracted
 * method bodies — which issue unqualified SQL, exactly as the app does — land
 * in the scratch schema without being rewritten.
 */
export async function createScratchDb(label = 'v', { farmContext = null } = {}) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  const pg = require(join(ROOT, 'server', 'node_modules', 'pg'))
  const { registerTypeParsers } = await import(
    new URL('../../../server/src/db/types.js', import.meta.url)
  )
  const { createDb } = await import(
    new URL('../../../server/src/db/execute.js', import.meta.url)
  )
  registerTypeParsers(pg)

  const schema = `vp_${label}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`
    .replace(/[^a-z0-9_]/gi, '')
    .toLowerCase()

  // A connect-event query is not awaited by pg.Pool. Parallel service reads
  // could arrive while that SET is still running on a newly opened client.
  // Set the scratch path during startup before any connection can be borrowed.
  if (farmContext !== null && (!Number.isSafeInteger(farmContext) || farmContext < 1)) throw new Error('Invalid fixture farm context')
  const pool = new pg.Pool({ connectionString: url, max: 4,
    options: `-c search_path=${schema},public` + (farmContext === null ? '' : ` -c app.farm_id=${farmContext}`) })

  const admin = await pool.connect()
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`SET search_path TO ${schema}`)
    // The NOCASE collation lives in public and the app's SQL uses it in 10
    // places. Without it those statements fail outright.
    await admin.query(collationsDdl())
    await admin.query(tablesDdl())
    // DDL intentionally used the scratch schema alone. Restore public for
    // unqualified COLLATE NOCASE before this client is returned to the pool.
    await admin.query(`SET search_path TO ${schema}, public`)
  } finally {
    admin.release()
  }

  const db = createDb(pool)
  await db.init()

  return {
    schema,
    pool,
    db,
    async close() {
      const c = await pool.connect()
      try { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { c.release() }
      await pool.end()
    },
  }
}

/**
 * The `svc` object the extracted methods are bound to — the same shape the
 * inherited scripts build, so a ported script's body needs no changes.
 */
export function makeService(db, methods = {}) {
  const svc = {
    get: (sql, params = []) => db.get(sql, params),
    run: (sql, params = []) => db.run(sql, params),
    runBatch: (ops) => db.batch(ops),
  }
  for (const [name, fn] of Object.entries(methods)) svc[name] = fn.bind(svc)
  return svc
}

// ── assertion harness ──────────────────────────────────────

export function createChecker() {
  let passed = 0
  const failures = []
  return {
    check(label, cond, detail) {
      if (cond) { passed++; console.log(`  PASS  ${label}`) }
      else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
    },
    equal(label, actual, expected) {
      const ok = actual === expected
      this.check(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`, ok)
    },
    finish(title) {
      console.log('\n' + '='.repeat(62))
      if (failures.length) {
        console.log(`FAILED — ${failures.length} check(s):`)
        for (const f of failures) console.log(`  - ${f}`)
        process.exit(1)
      }
      console.log(`ALL CHECKS PASSED — ${passed} checks${title ? ` (${title})` : ''}`)
    },
    get passed() { return passed },
    get failures() { return failures },
  }
}
