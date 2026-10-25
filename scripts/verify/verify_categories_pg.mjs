// verify_categories, ported to PostgreSQL.
//
// The METHODS are unchanged: still lifted verbatim out of database.service.ts
// and executed as the real shipping code. Only two things differ from the
// sql.js original — the schema comes from db/schema/001_tables.sql, and
// get/run/runBatch go through server/src/db/execute.js.
//
// That is the whole point of the Phase 1 gate. Anything that fails here is a
// difference PostgreSQL makes to real business logic, not to a test.
//
// What it covers: the id-or-name fallback predicate. personal_expenses keeps
// its `category` text alongside category_id specifically so an entry whose
// link is missing is still counted and still blocks its category's deletion.
// A test that only ever exercised well-linked rows would never notice if that
// broke.
//
// Skips (exit 0) when no database is configured.

import {
  loadEnv, loadMethod, createScratchDb, makeService, createChecker,
} from './lib/pg-harness.mjs'

if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }

const methods = {
  getPersonalExpenseCategories: loadMethod('getPersonalExpenseCategories'),
  addPersonalExpenseCategory: loadMethod('addPersonalExpenseCategory'),
  renamePersonalExpenseCategory: loadMethod('renamePersonalExpenseCategory'),
  deletePersonalExpenseCategory: loadMethod('deletePersonalExpenseCategory'),
  getPersonalExpensesByCategory: loadMethod('getPersonalExpensesByCategory'),
}

const ctx = await createScratchDb('categories')
const svc = makeService(ctx.db, methods)
const C = createChecker()
const check = (label, actual, expected) =>
  C.check(`${label}: got ${actual}, expected ${expected}`, String(actual) === String(expected))
const checkTrue = (label, cond, detail = '') => C.check(label, cond, detail)

try {
  console.log('Categories (real methods) against PostgreSQL')
  console.log('='.repeat(62))

  await ctx.db.run(
    `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (?,?,?)`, [1, 'Talha', 'x'])
  await ctx.db.run(
    `INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (?,?,?)`, [2, 'Other', 'x'])

  console.log('\n=== add categories ===')
  let r = await svc.addPersonalExpenseCategory(1, 'Household')
  checkTrue('creates a category', r.success, r.error)
  r = await svc.addPersonalExpenseCategory(1, 'Medical')
  checkTrue('creates a second category', r.success, r.error)
  r = await svc.addPersonalExpenseCategory(2, 'Household')
  checkTrue('same name allowed on a different account', r.success, r.error)

  console.log('\n=== duplicate names refused ===')
  r = await svc.addPersonalExpenseCategory(1, 'household')
  checkTrue('case-insensitive duplicate refused', !r.success, 'it was allowed')

  const catsRes = await svc.getPersonalExpenseCategories(1)
  checkTrue('listing succeeds', catsRes.success, catsRes.error)
  const cats = catsRes.data ?? []
  const household = cats.find((c) => c.category_name === 'Household')
  const medical = cats.find((c) => c.category_name === 'Medical')
  check('farm 1 sees only its own categories', cats.length, 2)

  // One properly linked entry, and one whose link is NULL so only its text
  // ties it to Household — the case the fallback predicate exists for.
  await ctx.db.run(
    `INSERT INTO personal_expenses (farm_id, date, category, category_id, description, amount)
     VALUES (?,?,?,?,?,?)`, [1, '2025-01-10', 'Household', household.category_id, 'Groceries', 12000])
  await ctx.db.run(
    `INSERT INTO personal_expenses (farm_id, date, category, category_id, description, amount)
     VALUES (?,?,?,NULL,?,?)`, [1, '2025-01-12', 'Household', 'Broken link', 3000])

  console.log('\n=== card totals include a row whose link is missing ===')
  const withEntries = (await svc.getPersonalExpenseCategories(1)).data
  const hh = withEntries.find((c) => c.category_name === 'Household')
  check('Household entry count', hh.entry_count, 2)
  check('Household total', hh.total_spent, 15000)
  checkTrue('the total is a NUMBER, not a string', typeof hh.total_spent === 'number',
    `got ${typeof hh.total_spent}`)

  console.log('\n=== detail view lists the unlinked row too ===')
  const listed = (await svc.getPersonalExpensesByCategory(1, household.category_id, 'Household')).data
  check('entries listed', listed.length, 2)
  checkTrue('newest first', listed[0].date === '2025-01-12', `got ${listed[0].date}`)

  console.log('\n=== delete refused while entries remain ===')
  r = await svc.deletePersonalExpenseCategory(household.category_id, 1)
  checkTrue('refuses a category with entries', !r.success, 'the delete went through')
  checkTrue('names the count in the message', /2 entries/.test(r.error || ''), r.error)
  check('category survived', (await svc.getPersonalExpenseCategories(1)).data.length, 2)

  console.log('\n=== empty category deletes cleanly ===')
  r = await svc.deletePersonalExpenseCategory(medical.category_id, 1)
  checkTrue('deletes an empty category', r.success, r.error)
  check('one category left', (await svc.getPersonalExpenseCategories(1)).data.length, 1)

  console.log('\n=== rename moves the denormalised text too ===')
  r = await svc.renamePersonalExpenseCategory(household.category_id, 1, 'Home')
  checkTrue('renames', r.success, r.error)
  const renamed = (await svc.getPersonalExpenseCategories(1)).data
  check('new name shows', renamed[0].category_name, 'Home')
  check('its entries came with it', renamed[0].entry_count, 2)

  const stillListed = (await svc.getPersonalExpensesByCategory(1, household.category_id, 'Home')).data
  check('detail view still finds both rows after the rename', stillListed.length, 2)
} finally {
  await ctx.close()
}

C.finish('categories, on PostgreSQL')
