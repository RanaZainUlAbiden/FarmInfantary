// Runs the REAL category methods from database.service.ts against a real sql.js
// database. `this.get` / `this.run` / `this.runBatch` are stubbed to execute
// against that database instead of going over IPC, so the method bodies —
// including the delete refusal — run exactly as they do in the app.
//
// What matters here: the id-or-name fallback predicate. personal_expenses keeps
// its `category` text alongside category_id specifically so an entry whose link
// is missing is still counted and still blocks its category's deletion. A test
// that only ever exercises well-linked rows would never notice if that broke.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')

// Repo root: these live in scripts/verify/ but read the real source files.
const ROOT = path.join(__dirname, '..', '..')

const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const SVC_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')

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

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const backfillExpenseCategories = eval('(' + extractFn(DB_SRC, 'backfillExpenseCategories', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// Strip the TS annotations so the method body can be eval'd as plain JS.
function loadMethod(name) {
  // Strip the TypeScript annotations with the real compiler rather than with
  // regexes — the method signatures include multi-line inline object types.
  const ts = require('typescript')
  const body = extractFn(SVC_SRC, name, 'async ').replace(/^async\s+/, 'async function ')
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText
  return eval('(' + js.trim().replace(/;$/, '') + ')')
}

const methods = {
  getPersonalExpenseCategories: loadMethod('getPersonalExpenseCategories'),
  addPersonalExpenseCategory: loadMethod('addPersonalExpenseCategory'),
  renamePersonalExpenseCategory: loadMethod('renamePersonalExpenseCategory'),
  deletePersonalExpenseCategory: loadMethod('deletePersonalExpenseCategory'),
  getPersonalExpensesByCategory: loadMethod('getPersonalExpensesByCategory')
}

initSqlJs().then(SQL => {
  const db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  // The service `this`: get/run/runBatch wired straight to sql.js.
  const svc = {
    async get(sql, params = []) {
      try {
        const out = []
        const stmt = db.prepare(sql)
        stmt.bind(params)
        while (stmt.step()) out.push(stmt.getAsObject())
        stmt.free()
        return { success: true, data: out }
      } catch (e) { return { success: false, error: e.message } }
    },
    async run(sql, params = []) {
      try { db.run(sql, params); return { success: true } }
      catch (e) { return { success: false, error: e.message } }
    },
    async runBatch(ops) {
      try {
        db.run('BEGIN')
        for (const op of ops) db.run(op.sql, op.params || [])
        db.run('COMMIT')
        return { success: true }
      } catch (e) { try { db.run('ROLLBACK') } catch (_) {} ; return { success: false, error: e.message } }
    }
  }
  for (const [name, fn] of Object.entries(methods)) svc[name] = fn.bind(svc)

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)

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

  const run = async () => {
    console.log('=== add categories ===')
    let r = await svc.addPersonalExpenseCategory(1, 'Household')
    checkTrue('creates a category', r.success)
    r = await svc.addPersonalExpenseCategory(1, 'Medical')
    checkTrue('creates a second category', r.success)
    r = await svc.addPersonalExpenseCategory(2, 'Household')
    checkTrue('same name allowed on a different account', r.success)

    console.log('\n=== duplicate names refused ===')
    r = await svc.addPersonalExpenseCategory(1, 'household')
    checkTrue('case-insensitive duplicate refused', !r.success, 'it was allowed')
    console.log(`         message: ${r.error}`)

    const catsRes = await svc.getPersonalExpenseCategories(1); if (!catsRes.success) console.log("  QUERY ERROR:", catsRes.error); const cats = catsRes.data
    const household = cats.find(c => c.category_name === 'Household')
    const medical = cats.find(c => c.category_name === 'Medical')
    check('farm 1 sees only its own categories', cats.length, 2)

    // One properly linked entry, and one with a NULL link that only its text
    // ties to Household — the case the fallback predicate exists for.
    db.run(`INSERT INTO personal_expenses (farm_id, date, category, category_id, description, amount)
            VALUES (1,'2025-01-10','Household',?,'Groceries',12000)`, [household.category_id])
    db.run(`INSERT INTO personal_expenses (farm_id, date, category, category_id, description, amount)
            VALUES (1,'2025-01-12','Household',NULL,'Broken link',3000)`)

    console.log('\n=== card totals include a row whose link is missing ===')
    const withEntries = (await svc.getPersonalExpenseCategories(1)).data
    const hh = withEntries.find(c => c.category_name === 'Household')
    check('Household entry count', hh.entry_count, 2)
    check('Household total', hh.total_spent, 15000)

    console.log('\n=== detail view lists the unlinked row too ===')
    const listed = (await svc.getPersonalExpensesByCategory(1, household.category_id, 'Household')).data
    check('entries listed', listed.length, 2)
    checkTrue('newest first', listed[0].date === '2025-01-12', `got ${listed[0].date}`)

    console.log('\n=== delete refused while entries remain ===')
    r = await svc.deletePersonalExpenseCategory(household.category_id, 1)
    checkTrue('refuses a category with entries', !r.success, 'the delete went through')
    checkTrue('names the count in the message', /2 entries/.test(r.error || ''), r.error)
    console.log(`         message: ${r.error}`)
    check('category survived', (await svc.getPersonalExpenseCategories(1)).data.length, 2)

    console.log('\n=== empty category deletes cleanly ===')
    r = await svc.deletePersonalExpenseCategory(medical.category_id, 1)
    checkTrue('deletes an empty category', r.success, r.error)
    check('one category left', (await svc.getPersonalExpenseCategories(1)).data.length, 1)

    console.log('\n=== rename moves the denormalised text too ===')
    r = await svc.renamePersonalExpenseCategory(household.category_id, 1, 'Home')
    checkTrue('rename succeeds', r.success, r.error)
    const renamed = (await svc.getPersonalExpenseCategories(1)).data[0]
    check('card shows the new name', renamed.category_name, 'Home')
    check('totals survive the rename', renamed.total_spent, 15000)
    check('entry count survives the rename', renamed.entry_count, 2)
    const texts = []
    const st = db.prepare(`SELECT category FROM personal_expenses WHERE farm_id = 1`)
    while (st.step()) texts.push(st.getAsObject().category)
    st.free()
    checkTrue('entry text was moved with it', texts.every(t => t === 'Home'), texts.join(','))

    console.log('\n=== renamed category still refuses deletion ===')
    r = await svc.deletePersonalExpenseCategory(household.category_id, 1)
    checkTrue('still refused after rename', !r.success, 'the delete went through')

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  }

  run().catch(e => { console.error('RUN FAILED:', e); process.exit(1) })
}).catch(e => { console.error('HARNESS FAILED:', e); process.exit(1) })
