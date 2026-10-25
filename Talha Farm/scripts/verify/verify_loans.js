// LOANS AND ADVANCES — money lent out, and money being held for someone else.
//
// Everything here runs the REAL methods out of database.service.ts and the real
// cash derivation out of cash-position.service.ts against a real sql.js
// database, through the real resolveBatchParams/runBatch contract.
//
// What it pins:
//   A. the direction rule — 'given' pays out, 'received' takes in, and a
//      settlement always runs the opposite way to its own principal
//   B. the outstanding derivation, and the two headline totals
//   C. cash in hand moves by the amount on a cash loan, and NOT on a bank one
//   D. the bank ledger: exactly one entry per row, pointing the right way,
//      under its own reference_type, and `current_balance` == its own ledger
//   E. the edit — reversed and re-posted, including a flipped DIRECTION and a
//      moved account, with the union of both accounts rebuilt
//   F. the refusals: overdraw, overpayment, bank with no account
//   G. the deletes — never guarded, and they take every entry with them
//   H. A LOAN IS NEVER INCOME AND NEVER AN EXPENSE: Overview's revenue,
//      expenses and profit are byte-identical before and after all of it
//   I. farm scoping, on a colliding id
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const initSqlJs = require('sql.js')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const DS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'database.service.ts'), 'utf8')
const CP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'cash-position.service.ts'), 'utf8')
const OV_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'shared', 'services', 'overview.service.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

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

const toJs = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText.trim().replace(/;$/, '')

/**
 * `kw` is whatever precedes the declaration in the real source: 'async ',
 * 'private ', 'private async ', or '\n  ' for a plain public method, which
 * carries no keyword at all.
 */
function loadMethod(name, kw = 'async ') {
  let body = extractFn(DS_SRC, name, kw).trim()
  // EXCLUSIVE, not a chain: a chain would rewrite 'private async foo' to
  // 'async function foo' and then match its own output, giving
  // 'async function function foo'.
  if (/^private\s+async\s+/.test(body)) body = body.replace(/^private\s+async\s+/, 'async function ')
  else if (/^async\s+/.test(body)) body = body.replace(/^async\s+/, 'async function ')
  else if (/^private\s+/.test(body)) body = body.replace(/^private\s+/, 'function ')
  else body = 'function ' + body
  return eval('(' + toJs(body) + ')')
}

const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const resolveBatchParams = eval('(' + extractFn(DB_SRC, 'resolveBatchParams', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

// The class statics the loan methods name, read OUT of the source so a rename
// breaks this file loudly rather than at run time.
const LOAN_REF = DS_SRC.match(/LOAN_REF\s*=\s*'([^']+)'/)[1]
const LOAN_PAYMENT_REF = DS_SRC.match(/LOAN_PAYMENT_REF\s*=\s*'([^']+)'/)[1]
const DatabaseService = { LOAN_REF, LOAN_PAYMENT_REF }

// ── The cash derivation, lifted whole ───────────────────────────────────────
const AS_OF_PARAM = (CP_SRC.match(/export const AS_OF_PARAM = '([^']*)'/) || [])[1]
if (!AS_OF_PARAM) throw new Error('AS_OF_PARAM not found in cash-position.service.ts')

const cashProto = (() => {
  const cls = [
    'class LiftedCashPosition {',
    '  ' + extractFn(CP_SRC, 'getCashPosition', 'async '),
    '  ' + extractFn(CP_SRC, 'readBankTotal', 'private async '),
    '  ' + extractFn(CP_SRC, 'readComponents', 'private async '),
    '  ' + extractFn(CP_SRC, 'cashSql', '\n  ').trim(),
    '}'
  ].join('\n')
  return eval('(' + toJs(cls) + ')').prototype
})()

// ── Overview's own query builders, for section H ────────────────────────────
function loadQuery(name) {
  let body = extractFn(OV_SRC, name, 'private ')
  body = body
    .replace(/^private\s+/, 'function ')
    .replace(/\(farmId: number, range: OverviewDateRange\)/, '(farmId, range)')
    .replace(/: \[string, any\[\]\]/g, '')
    .replace(/const (params|paidParams|assetParams): any\[\]/g, 'const $1')
  return eval('(' + body + ')')
}

const ovCtx = {
  dateClause(column, range, params) {
    let sql = ''
    if (range.from) { sql += ` AND ${column} >= ?`; params.push(range.from) }
    if (range.to) { sql += ` AND ${column} <= ?`; params.push(range.to) }
    return sql
  }
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const EPS = 0.005
const check = (label, actual, expected) => {
  const ok = Math.abs(Number(actual) - Number(expected)) < EPS
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`)
}
const checkStr = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got "${actual}", expected "${expected}"`)
}
const checkTrue = (label, actual) => {
  if (!actual) failures++
  console.log(`  ${actual ? 'PASS' : 'FAIL'}  ${label}`)
}

// ── The methods under test ──────────────────────────────────────────────────

const methods = {
  getLoans: loadMethod('getLoans'),
  getLoanPayments: loadMethod('getLoanPayments'),
  getLoanTotals: loadMethod('getLoanTotals'),
  addLoan: loadMethod('addLoan'),
  updateLoan: loadMethod('updateLoan'),
  deleteLoan: loadMethod('deleteLoan'),
  addLoanPayment: loadMethod('addLoanPayment'),
  deleteLoanPayment: loadMethod('deleteLoanPayment'),

  // The private helpers the above call through to. These scripts bind real
  // method bodies onto one object, so a new `this.` dependency inside a loan
  // path has to be registered here or the method throws instead of running.
  loanPrincipalDirection: loadMethod('loanPrincipalDirection', 'private '),
  loanPaymentDirection: loadMethod('loanPaymentDirection', 'private '),
  bankIdOf: loadMethod('bankIdOf', 'private '),
  bankBalanceSql: loadMethod('bankBalanceSql', 'private '),
  nextTransactionNumberSql: loadMethod('nextTransactionNumberSql', 'private '),
  rebuildBankBalanceOp: loadMethod('rebuildBankBalanceOp', 'private '),
  bankEntryOps: loadMethod('bankEntryOps', 'private '),
  bankReversalOps: loadMethod('bankReversalOps', 'private '),
  bankRebuildOps: loadMethod('bankRebuildOps', '\n  '),
  bankEntryEffect: loadMethod('bankEntryEffect', 'private async '),
  bankAmountText: loadMethod('bankAmountText', 'private '),
  checkBankBalances: loadMethod('checkBankBalances', 'async ')
}

initSqlJs().then(async SQL => {
  const db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  const rows = (sql, params = []) => {
    const out = []
    const stmt = db.prepare(sql)
    stmt.bind(params)
    while (stmt.step()) out.push(stmt.getAsObject())
    stmt.free()
    return out
  }
  const one = (sql, params = []) => rows(sql, params)[0]

  const PK = {
    loans: 'loan_id', loan_payments: 'payment_id', bank_ledger: 'ledger_id',
    bank_accounts: 'bank_id', farms: 'farm_id', flocks: 'flock_id'
  }
  const lastIdFor = (sql) => {
    const m = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+`?(\w+)`?/i.exec(sql)
    if (!m || !PK[m[1]]) return null
    const r = db.exec(`SELECT MAX(${PK[m[1]]}) AS id FROM ${m[1]}`)
    return r.length ? r[0].values[0][0] : null
  }

  const svc = {
    async get(sql, params = []) {
      try { return { success: true, data: rows(sql, params) } }
      catch (e) { return { success: false, error: e.message } }
    },
    async run(sql, params = []) {
      try { db.run(sql, params); return { success: true, lastId: lastIdFor(sql) } }
      catch (e) { return { success: false, error: e.message } }
    },
    async runBatch(ops) {
      const results = []
      try {
        db.run('BEGIN')
        for (let i = 0; i < ops.length; i++) {
          db.run(ops[i].sql, resolveBatchParams(ops[i].params, results, i))
          results.push({ lastId: lastIdFor(ops[i].sql) })
        }
        db.run('COMMIT')
        return { success: true, results }
      } catch (e) {
        try { db.run('ROLLBACK') } catch (_) {}
        return { success: false, error: e.message }
      }
    }
  }
  for (const [name, fn] of Object.entries(methods)) svc[name] = fn.bind(svc)

  const cash = Object.create(cashProto)
  cash.db = svc

  const FARM = 1
  const OTHER = 2

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash) VALUES (1,'Talha','x'),(2,'Other','x')`)
  db.run(`INSERT INTO bank_accounts (bank_id, farm_id, customer_id, bank_name, opening_balance, current_balance)
          VALUES (1, 1, NULL, 'HBL Main', 0, 300000),
                 (2, 1, NULL, 'Meezan',   0, 100000),
                 (3, 1, 9,    'Customer deposit', 0, 50000)`)
  // The opening balances have to exist as ledger rows too, or the
  // cache == ledger invariant is false before anything is tested.
  db.run(`INSERT INTO bank_ledger (bank_id, transaction_date, description, debit, credit, balance, reference_type, transaction_number)
          VALUES (1,'2026-01-01','Opening',300000,0,300000,'opening','DEP-0001'),
                 (2,'2026-01-01','Opening',100000,0,100000,'opening','DEP-0001'),
                 (3,'2026-01-01','Opening', 50000,0, 50000,'opening','DEP-0001')`)

  const bankBalance = (id) =>
    Number(one(`SELECT current_balance AS b FROM bank_accounts WHERE bank_id = ?`, [id]).b)
  const ledgerOf = (id) =>
    Number(one(`SELECT COALESCE(SUM(debit - credit),0) AS b FROM bank_ledger WHERE bank_id = ?`, [id]).b)
  const entryFor = (ref, id) =>
    rows(`SELECT * FROM bank_ledger WHERE reference_type = ? AND reference_id = ?`, [ref, id])
  const cashNow = async (farmId = FARM) => (await cash.getCashPosition(farmId)).cashInHand

  /** Every account's cache equals its own ledger — the standing invariant. */
  const assertInvariant = (label) => {
    const drifted = rows(
      `SELECT ba.bank_id FROM bank_accounts ba
       WHERE ba.current_balance <> (SELECT COALESCE(SUM(bl.debit - bl.credit),0)
                                    FROM bank_ledger bl WHERE bl.bank_id = ba.bank_id)`)
    check(`${label} — accounts whose cache drifted from their ledger`, drifted.length, 0)
    const orphans = rows(
      `SELECT ledger_id FROM bank_ledger
       WHERE reference_type = ? AND reference_id NOT IN (SELECT loan_id FROM loans)`, [LOAN_REF])
    check(`${label} — loan entries with no loan`, orphans.length, 0)
    const pOrphans = rows(
      `SELECT ledger_id FROM bank_ledger
       WHERE reference_type = ? AND reference_id NOT IN (SELECT payment_id FROM loan_payments)`,
      [LOAN_PAYMENT_REF])
    check(`${label} — loan-payment entries with no payment`, pOrphans.length, 0)
    const missing = rows(
      `SELECT loan_id FROM loans WHERE payment_source = 'bank' AND loan_id NOT IN
        (SELECT reference_id FROM bank_ledger WHERE reference_type = ?)`, [LOAN_REF])
    check(`${label} — bank loans with no entry`, missing.length, 0)
    const pMissing = rows(
      `SELECT payment_id FROM loan_payments WHERE payment_source = 'bank' AND payment_id NOT IN
        (SELECT reference_id FROM bank_ledger WHERE reference_type = ?)`, [LOAN_PAYMENT_REF])
    check(`${label} — bank loan payments with no entry`, pMissing.length, 0)
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== A. direction: given pays out, received takes in ===')
  // ════════════════════════════════════════════════════════════════════════

  const cashBeforeA = await cashNow()

  let r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Imran', date: '2026-02-01',
    principal: 50000, payment_source: 'cash'
  })
  checkTrue('a cash loan GIVEN saves', r.success === true)
  const GIVEN_CASH = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Imran'`).id)
  check('and takes its amount straight out of cash', await cashNow(), cashBeforeA - 50000)
  check('with no bank entry at all', entryFor(LOAN_REF, GIVEN_CASH).length, 0)

  r = await svc.addLoan({
    farm_id: FARM, direction: 'received', party_name: 'Nadia', date: '2026-02-02',
    principal: 30000, payment_source: 'cash'
  })
  checkTrue('a cash loan RECEIVED saves', r.success === true)
  const RECEIVED_CASH = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Nadia'`).id)
  check('and puts its amount INTO cash', await cashNow(), cashBeforeA - 50000 + 30000)

  // THE WHOLE POINT OF THE DIRECTION COLUMN: a settlement runs the opposite
  // way to its own principal, so the money comes back the way it went.
  r = await svc.addLoanPayment({
    loan_id: GIVEN_CASH, farm_id: FARM, date: '2026-03-01', amount: 20000, payment_source: 'cash'
  })
  checkTrue('a repayment ON A LOAN GIVEN saves', r.success === true)
  check('and brings cash back IN', await cashNow(), cashBeforeA - 50000 + 30000 + 20000)

  r = await svc.addLoanPayment({
    loan_id: RECEIVED_CASH, farm_id: FARM, date: '2026-03-02', amount: 10000, payment_source: 'cash'
  })
  checkTrue('a payment ON MONEY RECEIVED saves', r.success === true)
  check('and takes cash back OUT', await cashNow(), cashBeforeA - 50000 + 30000 + 20000 - 10000)

  assertInvariant('after the cash loans')

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== B. outstanding is derived, and the two totals come off it ===')
  // ════════════════════════════════════════════════════════════════════════

  const loans = await svc.getLoans(FARM)
  checkTrue('getLoans succeeds', loans.success === true)
  const byId = new Map(loans.data.map(l => [l.loan_id, l]))
  check('the loan given: 50,000 less 20,000 settled',
    byId.get(GIVEN_CASH).outstanding, 30000)
  check('the money received: 30,000 less 10,000 settled',
    byId.get(RECEIVED_CASH).outstanding, 20000)
  checkTrue('there is no stored outstanding column to drift',
    !/loans\s*\(\s*[^)]*outstanding/i.test(DB_SRC.slice(DB_SRC.indexOf('CREATE TABLE IF NOT EXISTS loans'), DB_SRC.indexOf('CREATE TABLE IF NOT EXISTS loan_payments'))))

  let totals = await svc.getLoanTotals(FARM)
  check('Loan Receivable == the given side of the list', totals.receivable, 30000)
  check('Loan Payable == the received side of the list', totals.payable, 20000)
  check('and each equals the sum the list itself shows',
    totals.receivable + totals.payable,
    loans.data.reduce((s, l) => s + Number(l.outstanding), 0))

  // A row that names no direction takes the column's own default rather than
  // NULL — the column is NOT NULL DEFAULT 'given' — so "a loan with no
  // direction" cannot exist in the first place. The `COALESCE(direction,
  // 'given')` every query here carries is belt and braces behind that, and
  // both halves are asserted: the default, and that the COALESCE is present.
  db.run(`INSERT INTO loans (loan_id, farm_id, party_name, date, principal, payment_source)
          VALUES (900, ?, 'Defaulted', '2026-01-15', 5000, 'cash')`, [FARM])
  checkStr('a loan saved with no direction defaults to given',
    one(`SELECT direction AS d FROM loans WHERE loan_id = 900`).d, 'given')
  totals = await svc.getLoanTotals(FARM)
  check('and it lands on the receivable side', totals.receivable, 35000)
  checkTrue("the reads COALESCE it anyway, so a NULL could not skew either total",
    /COALESCE\(l\.direction/.test(DS_SRC))
  db.run(`DELETE FROM loans WHERE loan_id = 900`)

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== C/D. a BANK loan moves the account, not the drawer ===')
  // ════════════════════════════════════════════════════════════════════════

  const cashBeforeBank = await cashNow()
  const mainBefore = bankBalance(1)

  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Shahid', date: '2026-04-01',
    principal: 80000, payment_source: 'bank', bank_id: 1
  })
  checkTrue('a BANK loan given saves', r.success === true)
  const GIVEN_BANK = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Shahid'`).id)
  check('the account fell by exactly the amount', bankBalance(1), mainBefore - 80000)
  check('and the drawer did not move at all', await cashNow(), cashBeforeBank)

  const ge = entryFor(LOAN_REF, GIVEN_BANK)
  check('exactly one entry for it', ge.length, 1)
  check('  on the credit side — money out', ge[0].credit, 80000)
  check('  and nothing on the debit side', ge[0].debit, 0)
  checkTrue('  numbered WD-', String(ge[0].transaction_number).startsWith('WD-'))
  checkStr('  dated the loan date', ge[0].transaction_date, '2026-04-01')

  r = await svc.addLoan({
    farm_id: FARM, direction: 'received', party_name: 'Kashif', date: '2026-04-02',
    principal: 25000, payment_source: 'bank', bank_id: 2
  })
  checkTrue('a BANK loan received saves', r.success === true)
  const RECEIVED_BANK = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Kashif'`).id)
  check('the account ROSE by exactly the amount', bankBalance(2), 100000 + 25000)
  const re = entryFor(LOAN_REF, RECEIVED_BANK)
  check('  one entry, on the debit side — money in', re[0].debit, 25000)
  checkTrue('  numbered DEP-', String(re[0].transaction_number).startsWith('DEP-'))

  // A repayment into the bank on a loan given: money in.
  r = await svc.addLoanPayment({
    loan_id: GIVEN_BANK, farm_id: FARM, date: '2026-05-01', amount: 30000,
    payment_source: 'bank', bank_id: 1
  })
  checkTrue('a bank repayment on a loan given saves', r.success === true)
  const REPAY_BANK = Number(one(
    `SELECT payment_id AS id FROM loan_payments WHERE loan_id = ? ORDER BY payment_id DESC`,
    [GIVEN_BANK]).id)
  check('the account rose by it', bankBalance(1), mainBefore - 80000 + 30000)
  check('  its entry is a debit', entryFor(LOAN_PAYMENT_REF, REPAY_BANK)[0].debit, 30000)
  checkTrue('  under the PAYMENT reference type, not the loan one',
    entryFor(LOAN_REF, REPAY_BANK).length === 0)

  assertInvariant('after the bank loans')
  check('and every cache equals its ledger — account 1', bankBalance(1), ledgerOf(1))
  check('and account 2', bankBalance(2), ledgerOf(2))

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== E. the edit reverses and re-posts, direction included ===')
  // ════════════════════════════════════════════════════════════════════════

  // Amount up, same account: the net movement is the difference.
  const beforeAmountEdit = bankBalance(1)
  r = await svc.updateLoan(GIVEN_BANK, { principal: 90000 })
  checkTrue('raising the amount saves', r.success === true)
  check('the account moved by the DIFFERENCE only', bankBalance(1), beforeAmountEdit - 10000)
  check('and there is still exactly one entry', entryFor(LOAN_REF, GIVEN_BANK).length, 1)

  // Account moved: both accounts rebuilt, which is the half most easily missed.
  const m1 = bankBalance(1), m2 = bankBalance(2)
  r = await svc.updateLoan(GIVEN_BANK, { payment_source: 'bank', bank_id: 2 })
  checkTrue('moving the account saves', r.success === true)
  check('the OLD account got its 90,000 back', bankBalance(1), m1 + 90000)
  check('and the NEW account paid it', bankBalance(2), m2 - 90000)
  check('still exactly one entry', entryFor(LOAN_REF, GIVEN_BANK).length, 1)
  check('  now on the new account', entryFor(LOAN_REF, GIVEN_BANK)[0].bank_id, 2)

  // THE TRANSITION UNIQUE TO THIS TABLE: flipping the direction turns a
  // withdrawal into a deposit. The reverse-and-re-post shape handles it with
  // no branch of its own.
  const before2 = bankBalance(2)
  r = await svc.updateLoan(GIVEN_BANK, { direction: 'received' })
  checkTrue('flipping the direction saves', r.success === true)
  check('the account moved by TWICE the amount — a withdrawal became a deposit',
    bankBalance(2), before2 + 180000)
  check('  and the entry is now a debit', entryFor(LOAN_REF, GIVEN_BANK)[0].debit, 90000)
  check('  with nothing on the credit side', entryFor(LOAN_REF, GIVEN_BANK)[0].credit, 0)
  // Put it back, so the sections below describe the loan they expect.
  await svc.updateLoan(GIVEN_BANK, { direction: 'given', bank_id: 1, payment_source: 'bank' })
  checkTrue('and back again', entryFor(LOAN_REF, GIVEN_BANK)[0].credit === 90000)

  // bank -> cash: the entry goes and the row stays.
  const beforeToCash = bankBalance(2)
  r = await svc.updateLoan(RECEIVED_BANK, { payment_source: 'cash', bank_id: null })
  checkTrue('bank -> cash saves', r.success === true)
  check('the account gave the deposit back', bankBalance(2), beforeToCash - 25000)
  check('no entry is left', entryFor(LOAN_REF, RECEIVED_BANK).length, 0)
  checkStr('and the row says cash',
    one(`SELECT payment_source AS s FROM loans WHERE loan_id = ?`, [RECEIVED_BANK]).s, 'cash')

  assertInvariant('after every edit transition')

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== F. the refusals ===')
  // ════════════════════════════════════════════════════════════════════════

  const ledgerRowsBefore = rows(`SELECT COUNT(*) AS n FROM bank_ledger`)[0].n
  const loanRowsBefore = rows(`SELECT COUNT(*) AS n FROM loans`)[0].n

  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Too big', date: '2026-06-01',
    principal: bankBalance(1) + 1, payment_source: 'bank', bank_id: 1
  })
  checkTrue('lending more than the account holds is REFUSED', r.success === false)
  checkTrue('  and the message names the account and both figures',
    /HBL Main/.test(r.error || '') && /enough balance/i.test(r.error || ''))
  check('  nothing was written', rows(`SELECT COUNT(*) AS n FROM loans`)[0].n, loanRowsBefore)
  check('  no ledger row either', rows(`SELECT COUNT(*) AS n FROM bank_ledger`)[0].n, ledgerRowsBefore)

  // Zero is allowed; the refusal starts one paisa past it.
  const exact = bankBalance(1)
  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Exactly', date: '2026-06-02',
    principal: exact, payment_source: 'bank', bank_id: 1
  })
  checkTrue('emptying an account exactly is ALLOWED', r.success === true)
  check('  and it lands on zero', bankBalance(1), 0)
  const EXACT = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Exactly'`).id)
  await svc.deleteLoan(EXACT)
  check('  (reversed for the sections below)', bankBalance(1), exact)

  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'No account', date: '2026-06-03',
    principal: 1000, payment_source: 'bank', bank_id: null
  })
  checkTrue('Bank with no account chosen is REFUSED, not downgraded to cash',
    r.success === false)
  check('  and nothing was written',
    rows(`SELECT COUNT(*) AS n FROM loans WHERE party_name = 'No account'`)[0].n, 0)

  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Zero', date: '2026-06-04', principal: 0
  })
  checkTrue('a zero loan is refused', r.success === false)

  const left = Number((await svc.getLoans(FARM)).data.find(l => l.loan_id === GIVEN_CASH).outstanding)
  r = await svc.addLoanPayment({
    loan_id: GIVEN_CASH, farm_id: FARM, date: '2026-06-05', amount: left + 1, payment_source: 'cash'
  })
  checkTrue('settling MORE than is outstanding is REFUSED', r.success === false)
  checkTrue('  and the message says what is left', new RegExp(String(left)).test((r.error || '').replace(/,/g, '')))

  r = await svc.addLoanPayment({
    loan_id: GIVEN_CASH, farm_id: FARM, date: '2026-06-06', amount: left, payment_source: 'cash'
  })
  checkTrue('settling EXACTLY what is outstanding is allowed', r.success === true)
  check('  and the loan is square', Number(
    (await svc.getLoans(FARM)).data.find(l => l.loan_id === GIVEN_CASH).outstanding), 0)
  r = await svc.addLoanPayment({
    loan_id: GIVEN_CASH, farm_id: FARM, date: '2026-06-07', amount: 1, payment_source: 'cash'
  })
  checkTrue('and a settled loan takes nothing more', r.success === false)

  assertInvariant('after the refusals')

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== G. the deletes: never guarded, and nothing is left behind ===')
  // ════════════════════════════════════════════════════════════════════════

  // A DELETE IS NEVER GUARDED, and may legitimately leave an account negative.
  // Built with the real writer: take a deposit in, spend it all on something
  // else, then delete the deposit. The account goes below zero and the delete
  // still succeeds — refusing it would strand a row that cannot be corrected.
  r = await svc.addLoan({
    farm_id: FARM, direction: 'received', party_name: 'Deposit to drop', date: '2026-07-01',
    principal: 40000, payment_source: 'bank', bank_id: 2
  })
  checkTrue('the deposit saves', r.success === true)
  const DROP = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Deposit to drop'`).id)
  const beforeDrain = bankBalance(2)
  // Spend the account down to zero through the real lending path, so nothing
  // here hand-writes a ledger row.
  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Drain', date: '2026-07-02',
    principal: beforeDrain, payment_source: 'bank', bank_id: 2
  })
  checkTrue('and the account can be spent down to exactly zero', r.success === true)
  check('  which it is', bankBalance(2), 0)

  r = await svc.deleteLoan(DROP)
  checkTrue('deleting the deposit is NOT refused, even taking the account negative',
    r.success === true)
  check('  and the balance fell by exactly the deposit', bankBalance(2), -40000)
  check('  its entry is gone', entryFor(LOAN_REF, DROP).length, 0)
  checkTrue('  the account really is negative, and that is allowed', bankBalance(2) < 0)

  // Put it back the way the rest of the file expects.
  const DRAIN = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Drain'`).id)
  await svc.deleteLoan(DRAIN)
  check('  (account restored)', bankBalance(2), beforeDrain - 40000)

  // Deleting a loan takes its settlements and THEIR entries with it.
  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Cascade', date: '2026-08-01',
    principal: 60000, payment_source: 'bank', bank_id: 1
  })
  const CASCADE = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Cascade'`).id)
  await svc.addLoanPayment({
    loan_id: CASCADE, farm_id: FARM, date: '2026-08-10', amount: 15000,
    payment_source: 'bank', bank_id: 2
  })
  await svc.addLoanPayment({
    loan_id: CASCADE, farm_id: FARM, date: '2026-08-11', amount: 5000, payment_source: 'cash'
  })
  const cascadeBalance1 = bankBalance(1), cascadeBalance2 = bankBalance(2)
  const cashBeforeCascade = await cashNow()
  r = await svc.deleteLoan(CASCADE)
  checkTrue('deleting the loan succeeds', r.success === true)
  check('  the loan is gone',
    rows(`SELECT COUNT(*) AS n FROM loans WHERE loan_id = ?`, [CASCADE])[0].n, 0)
  check('  every settlement went with it',
    rows(`SELECT COUNT(*) AS n FROM loan_payments WHERE loan_id = ?`, [CASCADE])[0].n, 0)
  check('  the principal account got its money back', bankBalance(1), cascadeBalance1 + 60000)
  check('  and the settlement account gave its back', bankBalance(2), cascadeBalance2 - 15000)
  check('  the cash settlement is undone too', await cashNow(), cashBeforeCascade - 5000)

  // One settlement alone, reversed.
  r = await svc.addLoan({
    farm_id: FARM, direction: 'given', party_name: 'Partial', date: '2026-09-01',
    principal: 20000, payment_source: 'cash'
  })
  const PARTIAL = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Partial'`).id)
  await svc.addLoanPayment({
    loan_id: PARTIAL, farm_id: FARM, date: '2026-09-05', amount: 8000,
    payment_source: 'bank', bank_id: 1
  })
  const PAY = Number(one(
    `SELECT payment_id AS id FROM loan_payments WHERE loan_id = ?`, [PARTIAL]).id)
  const beforePayDelete = bankBalance(1)
  const outstandingBefore = Number(
    (await svc.getLoans(FARM)).data.find(l => l.loan_id === PARTIAL).outstanding)
  r = await svc.deleteLoanPayment(PAY)
  checkTrue('deleting one settlement succeeds', r.success === true)
  check('  the account gave its deposit back', bankBalance(1), beforePayDelete - 8000)
  check('  and the outstanding balance went back up', Number(
    (await svc.getLoans(FARM)).data.find(l => l.loan_id === PARTIAL).outstanding),
    outstandingBefore + 8000)

  assertInvariant('after every delete')

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== H. A LOAN IS NEVER INCOME AND NEVER AN EXPENSE ===')
  // ════════════════════════════════════════════════════════════════════════
  {
    // Every Overview figure that feeds revenue, expenses or profit, read before
    // and after a large loan in each direction plus settlements on both. If a
    // single one moves, a loan has leaked into a profit figure.
    const PROFIT_QUERIES = [
      'qBroilerSales', 'qEggSales', 'qHenSales', 'qBroilerIncome', 'qLayerIncome',
      'qDistributionBills', 'qExpenses', 'qLabour', 'qPurchases', 'qDistributionCogs',
      'qDistributionExpenses', 'qPersonalExpenses', 'qAssetSales', 'qAssetPayments'
    ]
    const snapshot = () => {
      const out = {}
      for (const name of PROFIT_QUERIES) {
        let q
        try { q = loadQuery(name) } catch (e) { continue }
        try {
          const args = name === 'qExpenses' || name === 'qLabour'
            ? [FARM, {}, 'broiler']
            : [FARM, {}]
          const [sql, params] = q.apply(ovCtx, args)
          out[name] = JSON.stringify(rows(sql, params))
        } catch (e) { out[name] = 'ERR:' + e.message }
      }
      return out
    }

    const before = snapshot()

    await svc.addLoan({
      farm_id: FARM, direction: 'given', party_name: 'Profit test A', date: '2026-10-01',
      principal: 150000, payment_source: 'cash'
    })
    await svc.addLoan({
      farm_id: FARM, direction: 'received', party_name: 'Profit test B', date: '2026-10-02',
      principal: 250000, payment_source: 'bank', bank_id: 1
    })
    const PA = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Profit test A'`).id)
    const PB = Number(one(`SELECT loan_id AS id FROM loans WHERE party_name = 'Profit test B'`).id)
    await svc.addLoanPayment({
      loan_id: PA, farm_id: FARM, date: '2026-10-10', amount: 60000, payment_source: 'cash'
    })
    await svc.addLoanPayment({
      loan_id: PB, farm_id: FARM, date: '2026-10-11', amount: 100000,
      payment_source: 'bank', bank_id: 1
    })

    const after = snapshot()
    let moved = 0
    for (const name of Object.keys(before)) {
      if (before[name] !== after[name]) {
        moved++
        console.log(`        ${name}: ${before[name]} -> ${after[name]}`)
      }
    }
    check('not one Overview revenue/expense/profit query moved', moved, 0)
    checkTrue('  and the queries really were read', Object.keys(before).length > 8)

    // What DID move: the cash/bank position and the two outstanding cards.
    check('Loan Receivable picked up the loan given',
      (await svc.getLoanTotals(FARM)).receivable - 0, 150000 - 60000 +
        Number((await svc.getLoans(FARM)).data
          .filter(l => l.direction !== 'received' && l.loan_id !== PA)
          .reduce((s, l) => s + Number(l.outstanding), 0)))
    check('Loan Payable picked up the money received',
      (await svc.getLoanTotals(FARM)).payable, 250000 - 100000 +
        Number((await svc.getLoans(FARM)).data
          .filter(l => l.direction === 'received' && l.loan_id !== PB)
          .reduce((s, l) => s + Number(l.outstanding), 0)))

    assertInvariant('after the profit-neutrality section')
  }

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n=== I. farm-scoped, on a colliding id ===')
  // ════════════════════════════════════════════════════════════════════════

  db.run(`INSERT INTO loans (farm_id, direction, party_name, date, principal, payment_source)
          VALUES (?, 'given', 'Other account loan', '2026-11-01', 999999, 'cash')`, [OTHER])
  const mine = await svc.getLoans(FARM)
  checkTrue("the other account's loan is not in this account's list",
    !mine.data.some(l => l.party_name === 'Other account loan'))
  const otherTotals = await svc.getLoanTotals(OTHER)
  check('and it is the whole of the other account\'s receivable', otherTotals.receivable, 999999)
  const myTotals = await svc.getLoanTotals(FARM)
  checkTrue('which is not in this account\'s', myTotals.receivable < 999999)

  // A settlement is refused against a loan belonging to another account, even
  // with the right loan_id — the read is scoped by farm_id as well.
  const OTHER_LOAN = Number(one(
    `SELECT loan_id AS id FROM loans WHERE party_name = 'Other account loan'`).id)
  r = await svc.addLoanPayment({
    loan_id: OTHER_LOAN, farm_id: FARM, date: '2026-11-02', amount: 100, payment_source: 'cash'
  })
  checkTrue("settling another account's loan is refused", r.success === false)

  // ── Closing reconciliation ──────────────────────────────────────────────
  console.log('\n=== the end state ===')
  assertInvariant('closing')
  const p = await cash.getCashPosition(FARM)
  check('cash in hand == the sum of its own terms',
    p.cashInHand, p.components.reduce((s, c) => s + c.amount, 0))
  checkTrue('all four loan terms are present',
    ['loans_given_out', 'loans_received_in', 'loan_repayments_in', 'loan_repayments_out']
      .every(k => p.components.some(c => c.key === k)))
  check('the customer account was never touched by any of it', bankBalance(3), 50000)

  console.log(failures === 0
    ? '\nALL CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error(e); process.exit(1) })
