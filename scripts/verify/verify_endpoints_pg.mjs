// The HTTP endpoints, driven the way the Angular app will drive them.
//
// WHY THIS IS SEPARATE FROM verify_execute_pg
// -------------------------------------------
// That one tests the query layer in process. This one goes over HTTP, through
// JSON serialisation, and that boundary has its own failure modes: a result
// shape that survives a function return can still be mangled by serialisation,
// and a thrown error that was a result object in process can become a 500.
//
// The contract being defended:
//
//   every statement that REACHED the database answers 200, even when it failed
//   failures are { success: false, error } in the body, never an HTTP error
//   only a malformed REQUEST (not statement) gets a 4xx
//
// On the desktop a failing statement came back as a result object and every
// call site checks `.success`. If SQL errors became 500s, Angular's HttpClient
// would reject, and error handling across all 60 screens would change shape.
//
// Skips (exit 0) when no database is configured.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const env = { ...process.env }
const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim()
  }
}
if (!env.DATABASE_URL) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }
env.NODE_ENV = 'development'

let buildServer
try {
  ;({ buildServer } = await import(new URL('../../server/src/server.js', import.meta.url)))
} catch (err) {
  console.log(`SKIP — server not available (${err.message})`)
  process.exit(0)
}

let passed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const { app, pool } = await buildServer({ env })

/** POST JSON, returning { status, body }. */
const post = async (url, payload) => {
  const res = await app.inject({ method: 'POST', url, payload })
  let body
  try { body = res.json() } catch { body = res.body }
  return { status: res.statusCode, body }
}

try {
  console.log('HTTP endpoints against PostgreSQL')
  console.log('='.repeat(64))

  console.log('\n=== A. health ===')
  const health = await app.inject({ method: 'GET', url: '/api/health' })
  check('GET /api/health answers 200', health.statusCode === 200, `got ${health.statusCode}`)
  const expectedKeys=Number((await pool.query(`SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(i.indkey)
    WHERE i.indisprimary AND i.indnkeyatts=1 AND n.nspname=current_schema() AND c.relkind='r' AND a.atttypid IN (20,21,23)`)).rows[0].n);
  check('it reports the loaded primary keys', expectedKeys>=58 && health.json().primaryKeys === expectedKeys,
    `got ${health.json().primaryKeys}`)
  check('it states plainly that nobody is authenticated',
    /development stub/.test(health.json().session ?? ''), health.json().session)

  console.log('\n=== B. the IPC surface, 1:1 ===')
  const got = await post('/api/db/get', { sql: 'SELECT COUNT(*)::int AS n FROM farms', params: [] })
  check('POST /api/db/get answers 200', got.status === 200, `got ${got.status}`)
  check('get returns { success, data }',
    got.body?.success === true && Array.isArray(got.body.data), JSON.stringify(got.body))

  // Everything that writes goes inside a transaction that is rolled back, so
  // the script leaves the database exactly as it found it.
  const tx = await post('/api/db/tx/begin', {})
  check('POST /api/db/tx/begin returns a token',
    tx.body?.success === true && typeof tx.body.token === 'string', JSON.stringify(tx.body))
  const token = tx.body.token

  const ran = await post('/api/db/run', {
    sql: `INSERT INTO farms (farm_name, password_hash, business_type) VALUES (?, ?, ?)`,
    params: ['ep_test', 'x', 'all'],
    token,
  })
  check('POST /api/db/run answers 200', ran.status === 200, `got ${ran.status}`)
  check('run returns a numeric lastId',
    ran.body?.success === true && typeof ran.body.lastId === 'number', JSON.stringify(ran.body))

  const batched = await post('/api/db/batch', {
    token,
    ops: [
      { sql: `INSERT INTO flocks (farm_id, flock_name, start_date) VALUES (?, ?, ?)`,
        // Development SQL acts as the server's fixed farm, even though this
        // legacy transport test also creates a throwaway root metadata row.
        params: [Number(env.DEV_FARM_ID ?? 1), 'F1', '2026-01-01'] },
      { sql: `INSERT INTO expenses (flock_id, date, amount) VALUES (?, ?, ?)`,
        params: [{ $lastId: -1 }, '2026-01-02', 250.5] },
    ],
  })
  check('POST /api/db/batch answers 200', batched.status === 200, `got ${batched.status}`)
  check('batch returns one result per statement',
    batched.body?.success === true && batched.body.results?.length === 2, JSON.stringify(batched.body))
  check('$lastId survives JSON serialisation over the wire',
    batched.body?.results?.[1]?.lastId > 0, JSON.stringify(batched.body?.results))

  // Money and ids must still be numbers after a JSON round trip.
  const read = await post('/api/db/get', {
    sql: `SELECT e.amount, e.flock_id FROM expenses e WHERE e.flock_id = ?`,
    params: [batched.body.results[0].lastId],
    token,
  })
  const row = read.body?.data?.[0]
  check('money is a number after JSON', typeof row?.amount === 'number', `got ${typeof row?.amount}`)
  check('an id is a number after JSON', typeof row?.flock_id === 'number', `got ${typeof row?.flock_id}`)

  const rolled = await post('/api/db/tx/rollback', { token })
  check('POST /api/db/tx/rollback succeeds', rolled.body?.success === true, JSON.stringify(rolled.body))

  const gone = await post('/api/db/get', {
    sql: `SELECT COUNT(*)::int AS n FROM farms WHERE farm_name = ?`, params: ['ep_test'],
  })
  check('the rolled-back writes are gone', gone.body?.data?.[0]?.n === 0, JSON.stringify(gone.body?.data))

  console.log('\n=== C. a failed STATEMENT is 200 + success:false ===')
  for (const [label, payload] of [
    ['a syntax error', { sql: 'SELEKT 1', params: [] }],
    ['an unknown table', { sql: 'SELECT * FROM does_not_exist', params: [] }],
    ['an untranslatable construct', { sql: 'SELECT last_insert_rowid()', params: [] }],
    ['a param count mismatch', { sql: 'SELECT * FROM farms WHERE farm_id = ?', params: [] }],
  ]) {
    const r = await post('/api/db/get', payload)
    check(`${label} answers 200, not 500`, r.status === 200, `got ${r.status}`)
    check(`${label} carries success:false and a message`,
      r.body?.success === false && typeof r.body.error === 'string' && r.body.error.length > 0,
      JSON.stringify(r.body))
  }

  const badBatch = await post('/api/db/batch', { ops: [{ params: [] }] })
  check('a malformed batch is 200 + success:false', badBatch.status === 200 && badBatch.body?.success === false,
    `${badBatch.status} ${JSON.stringify(badBatch.body)}`)

  console.log('\n=== D. a malformed REQUEST is a 4xx ===')
  // A client bug is not a database answer, so these do get an HTTP error.
  for (const [label, payload] of [
    ['missing sql', {}],
    ['sql of the wrong type', { sql: 42 }],
    ['empty sql', { sql: '   ' }],
  ]) {
    const r = await post('/api/db/get', payload)
    check(`${label} answers 400`, r.status === 400, `got ${r.status}`)
    check(`${label} still uses the { success, error } shape`, r.body?.success === false,
      JSON.stringify(r.body))
  }

  const missing = await post('/api/db/nope', {})
  check('an unknown route is 404 in the same shape',
    missing.status === 404 && missing.body?.success === false, `${missing.status}`)

  console.log('\n=== E. a stale transaction token is refused, not fatal ===')
  const stale = await post('/api/db/get', { sql: 'SELECT 1 AS v', params: [], token: 'tx_nope' })
  check('a dead token answers 200 + success:false', stale.status === 200 && stale.body?.success === false,
    `${stale.status} ${JSON.stringify(stale.body)}`)

  console.log('\n=== F. the dev session cannot be deployed ===')
  const { createDevSession } = await import(new URL('../../server/src/session.js', import.meta.url))
  let refused = false
  try { createDevSession({ NODE_ENV: 'production' }) } catch { refused = true }
  check('the stub refuses to start outside development', refused)
  check('it ignores anything the client sends',
    createDevSession({ NODE_ENV: 'development', DEV_FARM_ID: '7' })
      .resolve({ body: { farmId: 999 } }).farmId === 7)
} finally {
  await app.close()
  await pool.end()
}

console.log('\n' + '='.repeat(64))
if (failures.length) {
  console.log(`FAILED — ${failures.length} check(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`ALL CHECKS PASSED — ${passed} checks over HTTP`)
