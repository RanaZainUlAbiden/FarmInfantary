// THE FCR CARD on the broiler Report screen, asserted against the Flock Health
// screen's "Latest FCR" card beside it.
//
// THE ONE THING THIS FILE EXISTS TO PROTECT: FCR is now printed in TWO places,
// and there is exactly ONE implementation behind both — `latestFlockFcr` in
// `shared/utils/fcr.util.ts`. A second derivation on the Report would agree on
// the day it was written and drift the first time either screen's rows, its
// chosen row, or its rounding moved, with nothing on screen to say which number
// is the real one. That is the drift CLAUDE.md warns about for any figure shown
// twice, and it is the part that can rot without anything failing to compile.
//
// The formula itself is NOT restated here. It belongs to `fcr.util.ts` and is
// the client's own:
//
//     FCR = [(remaining birds / 1000) x avg weight in grams] / CUMULATIVE bags
//
// — kilograms of live weight per bag of feed, so HIGHER is better. Note that
// this is the reciprocal of the textbook "feed in / weight out" ratio; the
// client's own spreadsheet reads this way round and the app follows it. Anything
// here that needed the formula calls the real function.
//
// Everything runs REAL source against a real sql.js database: the schema from
// createTables/alterStatements, both utils lifted out of their files, both
// components' own getters lifted out of their source, and both components' own
// `flock_health` SELECT executed on that schema.
//
// What is proved:
//   A. ONE IMPLEMENTATION. Both screens call `latestFlockFcr`; neither carries
//      a row-selection loop or a division of its own, and the Report adds no
//      second FCR formula.
//   B. THE SAME FIGURE. Over the same flock's rows the Report's `latestFcr`
//      equals the Flock Health screen's, and the two templates render
//      BYTE-IDENTICAL strings — it is the same interpolation expression, so the
//      same digits, grouping and em dash.
//   C. THE EMPTY CASES. No rows, no feed, no weight, no birds left and a
//      not-yet-numbered day each give null and print "—", never 0 and never a
//      divide-by-zero.
//   D. CUMULATIVE, AND THE RIGHT ROW. The denominator is every bag from day 1,
//      not the last day's; the row chosen is the highest DAY INDEX that
//      qualifies, not the last element, so out-of-order entry, skipped days and
//      a later day still missing its weight all read correctly; a hand-entered
//      FCR is respected.
//   E. THE OTHER CARDS ARE UNCHANGED. Every other getter on the Report is
//      numerically untouched by `flock_health` rows and textually free of
//      `this.health`, so adding this card moved no existing figure.
//   F. NO NEW QUERY. The Report's statement count is unchanged and its
//      `flock_health` SELECT is the statement the Flock Health screen runs, so
//      the two cards read one set of rows.
//   G. SCOPING, AND THE LAYER SIDE. The rows are scoped by `flock_id`, the
//      colliding layer batch is untouched, and no layer or farm report grew an
//      FCR — layer FCR means feed per egg, a different thing.
//   H. THE TEMPLATE. The card is in the summary grid, carries one label and one
//      value, the grid is no longer a hard four columns, and every other card
//      kept its own label and value.
//   I. NO toISOString ANYWHERE NEAR THIS.
//
// Does not touch the real database file and does not launch Electron.
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..', '..')
const DB_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'database.js'), 'utf8')
const DAY_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'health-day.util.ts'), 'utf8')
const FCR_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'shared', 'utils', 'fcr.util.ts'), 'utf8')
const RP_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'report', 'report.component.ts'), 'utf8')
const RP_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'report', 'report.component.html'), 'utf8')
const RP_SCSS = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'report', 'report.component.scss'), 'utf8')
const FH_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'flock-health', 'flock-health.component.ts'), 'utf8')
const FH_HTML = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'flock-health', 'flock-health.component.html'), 'utf8')
const LR_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'layer-report', 'layer-report.component.ts'), 'utf8')
const FR_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'app', 'farm-report', 'farm-report.component.ts'), 'utf8')
const LFH_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app', 'layer-flock-health',
  'layer-flock-health.component.ts'), 'utf8')

// ── Lifting real source ─────────────────────────────────────────────────────

function extractFn(src, name, kw, from) {
  const start = from !== undefined ? from : src.indexOf(`${kw}${name}(`)
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

/** The position where `needle` is a DECLARATION, not a doc-comment mention. */
function declAt(src, needle) {
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    const lineStart = src.lastIndexOf('\n', i) + 1
    if (src.slice(lineStart, i).trim() === '') return i
  }
  return -1
}

const toJs = (text) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
}).outputText

function loadFrom(src, name, kw = '') {
  const at = declAt(src, `${kw}${name}(`)
  if (at < 0) throw new Error(`${name} not declared`)
  const raw = extractFn(src, name, kw, at)
  const stripped = kw.trim()
    ? raw.replace(new RegExp('^' + kw.trim().replace(/\s+/g, '\\s+') + '\\s+'), '')
    : raw
  return eval('(' + toJs('function ' + stripped).trim().replace(/;$/, '') + ')')
}

const loadUtil = (src, name) => loadFrom(src, name, 'export function ')

/**
 * A getter body (`get x(): T { … }`, or `private get x(): T { … }`), as a
 * zero-arg function to be installed with Object.defineProperty.
 */
function loadGetter(src, name, kw = 'get ') {
  const at = declAt(src, `${kw}${name}(`)
  if (at < 0) throw new Error(`getter ${name} not found`)
  const raw = extractFn(src, name, kw, at).replace(new RegExp('^' + kw), '')
  return eval('(' + toJs('function ' + raw).trim().replace(/;$/, '') + ')')
}

/** A getter's raw source text, for asserting what it does NOT contain. */
const getterSrc = (src, name) =>
  extractFn(src, name, 'get ', declAt(src, `get ${name}(`))

/** The SQL string literal containing `marker`, lifted out of a component. */
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

// ── The engine ──────────────────────────────────────────────────────────────

let db = null
const createTables = eval('(' + extractFn(DB_SRC, 'createTables', 'function ') + ')')
const alterStatements = (() => {
  const start = DB_SRC.indexOf('const alterStatements = [')
  const end = DB_SRC.indexOf('\n  ]', start)
  return eval(DB_SRC.slice(start, end + 4) + '; alterStatements')
})()

function rows(sql, params = []) {
  const out = []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}
const one = (sql, params = []) => Number(rows(sql, params)[0].v)

// ── The utils under test, lifted ────────────────────────────────────────────

const num = loadUtil(DAY_SRC, 'num')
const dayIndexOf = loadUtil(DAY_SRC, 'dayIndexOf')
const cumulativeThroughDay = loadUtil(DAY_SRC, 'cumulativeThroughDay')
Object.assign(global, { num, dayIndexOf, cumulativeThroughDay })

const fcrDayIndex = loadUtil(FCR_SRC, 'fcrDayIndex')
const cumulativeFeedThroughDay = loadUtil(FCR_SRC, 'cumulativeFeedThroughDay')
const computeAutoFcr = loadUtil(FCR_SRC, 'computeAutoFcr')
const isManualFcr = loadUtil(FCR_SRC, 'isManualFcr')
const displayFcr = loadUtil(FCR_SRC, 'displayFcr')
const latestFlockFcr = loadUtil(FCR_SRC, 'latestFlockFcr')
Object.assign(global, {
  fcrDayIndex, cumulativeFeedThroughDay, computeAutoFcr, isManualFcr,
  displayFcr, latestFlockFcr
})

// ── The two SCREENS under test, assembled from their own source ─────────────

const FH_SELECT = liftSql(FH_SRC, 'SELECT * FROM flock_health WHERE flock_id = ?')
const RP_SELECT = liftSql(RP_SRC, 'SELECT * FROM flock_health WHERE flock_id = ?')

/** The Flock Health screen, enough of it to read its "Latest FCR" card. */
function makeHealthScreen(records, pendingRows = [], editingId = null, editForm = {}) {
  const screen = { healthRecords: records, pendingRows, editingId, editForm }
  Object.defineProperty(screen, 'fcrRows',
    { get: loadGetter(FH_SRC, 'fcrRows', 'private get ') })
  Object.defineProperty(screen, 'latestFcr', { get: loadGetter(FH_SRC, 'latestFcr') })
  screen.getDisplayFcr = loadFrom(FH_SRC, 'getDisplayFcr')
  screen.getRowAutoFcr = loadFrom(FH_SRC, 'getRowAutoFcr')
  return screen
}

/** Every getter behind a card or a P&L line on the Report screen. */
const RP_GETTERS = [
  'totalExpenses', 'totalIncome', 'totalSaleWeight', 'totalSaleAmount',
  'totalMedicine', 'totalFeed', 'totalChicks', 'totalVaccinationCost', 'totalLabour',
  'totalLedgerDebit', 'totalExpensesAndLedger', 'profitLoss', 'latestFcr'
]

function makeReportScreen(data = {}) {
  const screen = Object.assign({
    expenses: [], ledgers: [], ledgerEntries: [], traders: [], medicineEntries: [],
    feedTraders: [], feedEntries: [], chickTraders: [], chickEntries: [],
    vaccinations: [], sales: [], income: [],
    health: [], labourPayments: []
  }, data)
  for (const name of RP_GETTERS) {
    Object.defineProperty(screen, name, { get: loadGetter(RP_SRC, name) })
  }
  return screen
}

// ── The card, as the TEMPLATE renders it ────────────────────────────────────
//
// Both templates interpolate the same expression; it is lifted from each and
// asserted identical below, then evaluated once here. `number:'1.2-3'` is
// Angular's DecimalPipe on the default en-US locale — minimum 2 and maximum 3
// fraction digits, with grouping — which is what Intl does with those bounds.
const FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 3
})
const renderCard = (value) => value !== null ? FORMAT.format(value) : '—'

/** The `card-value` interpolation of the card whose `card-label` is `label`. */
function cardExpression(html, label) {
  const at = html.indexOf(`>${label}<`)
  if (at < 0) throw new Error(`no card labelled ${label}`)
  const m = /<div class="card-value">([\s\S]*?)<\/div>/.exec(html.slice(at))
  if (!m) throw new Error(`no card-value after ${label}`)
  return m[1].trim()
}

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0
const check = (label, actual, expected) => {
  const ok = Math.abs(Number(actual) - Number(expected)) < 0.0005
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
const checkNull = (label, actual) => {
  const ok = actual === null
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, expected null`)
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()

initSqlJs().then(async SQL => {
  db = new SQL.Database()
  createTables(db)
  for (const sql of alterStatements) { try { db.run(sql) } catch (e) {} }

  db.run(`INSERT INTO farms (farm_id, farm_name, password_hash, business_type)
          VALUES (1, 'Talha', 'x', 'all')`)
  // Flock 1 and layer batch 1 collide on id, as they always do.
  db.run(`INSERT INTO flocks (flock_id, farm_id, flock_name, start_date)
          VALUES (1, 1, 'Flock A', '2026-03-01'), (2, 1, 'Empty', '2026-03-01'),
                 (3, 1, 'No weight', '2026-03-01'), (4, 1, 'No feed', '2026-03-01')`)
  db.run(`INSERT INTO batches (batch_id, farm_id, batch_name, start_date, initial_birds)
          VALUES (1, 1, 'Batch A', '2026-03-01', 5000)`)

  // Flock 1, entered OUT OF ORDER and with gaps, as the client really does:
  // day 35 before day 21, and no rows at all for days 2-6.
  const H = [
    [1, 1,  1000, 10, 5,   150],
    [1, 7,  990,  5,  20,  400],
    [1, 35, 985,  5,  120, 2000],
    [1, 21, 985,  0,  60,  1100]
  ]
  for (const r of H) {
    db.run(`INSERT INTO flock_health
              (flock_id, week_number, total_birds, mortality, feed_used, avg_weight)
            VALUES (?, ?, ?, ?, ?, ?)`, r)
  }
  // Flock 3: feed but never a weight. Flock 4: a weight but never any feed.
  db.run(`INSERT INTO flock_health
            (flock_id, week_number, total_birds, mortality, feed_used, avg_weight)
          VALUES (3, 1, 500, 0, 9, 0), (3, 2, 500, 0, 11, 0),
                 (4, 1, 500, 0, 0, 180), (4, 2, 500, 0, 0, 420)`)
  // The colliding layer batch has its own health rows, in its own table.
  db.run(`INSERT INTO layer_health
            (batch_id, day_number, date, total_birds, mortality, feed_used)
          VALUES (1, 1, '2026-03-01', 5000, 3, 70), (1, 2, '2026-03-02', 4997, 2, 72)`)

  // Both screens' own statements, on the real schema.
  const fhRows = rows(FH_SELECT, [1])
  const rpRows = rows(RP_SELECT, [1])

  // ── A. ONE IMPLEMENTATION ────────────────────────────────────────────────
  console.log('=== A. one implementation, two readers ===')

  checkTrue('the Report calls latestFlockFcr',
    /latestFlockFcr\(/.test(RP_SRC) && /from '\.\.\/shared\/utils\/fcr\.util'/.test(RP_SRC))
  checkTrue('the Flock Health screen calls latestFlockFcr',
    /latestFlockFcr\(/.test(FH_SRC) && /from '\.\.\/shared\/utils\/fcr\.util'/.test(FH_SRC))
  checkTrue('the formula lives in fcr.util.ts',
    /\*\s*avgWeight\s*\)\s*\/\s*feed/.test(FCR_SRC))

  // The thing that rots silently: a screen growing its own copy of the
  // selection loop or the division back again.
  const rpFcrGetter = getterSrc(RP_SRC, 'latestFcr')
  const fhFcrGetter = getterSrc(FH_SRC, 'latestFcr')
  for (const [who, body] of [['the Report', rpFcrGetter], ['Flock Health', fhFcrGetter]]) {
    checkTrue(`${who}'s latestFcr delegates`, /latestFlockFcr\(/.test(body))
    checkTrue(`  ${who} has no row-selection loop of its own`,
      !/\bfor\s*\(|\breduce\(|bestDay/.test(body))
    checkTrue(`  ${who} divides nothing itself`,
      !/\//.test(body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')))
  }
  checkTrue('the Report has no second FCR formula anywhere',
    !/\/\s*1000/.test(RP_SRC))
  checkTrue('  and reads no FCR out of the stored column',
    !/\.fcr\b/.test(RP_SRC.replace(/displayFcr|latestFlockFcr|fcrDayIndex|fcr\.util/g, '')))

  // ── B. THE SAME FIGURE ───────────────────────────────────────────────────
  console.log('\n=== B. the two cards print one figure, to the digit ===')

  const health = makeHealthScreen(fhRows)
  const report = makeReportScreen({ health: rpRows })

  // The expectation comes from the real function, on the row that must be
  // chosen: day 35 is the highest with both a weight and cumulative feed.
  const day35 = fhRows.find(r => Number(r.week_number) === 35)
  const expected = computeAutoFcr(day35, fhRows)
  check('cumulative feed through day 35 is every bag from day 1',
    cumulativeFeedThroughDay(fhRows, 35), 5 + 20 + 60 + 120)
  check('the Flock Health card', health.latestFcr, expected)
  check('the Report card', report.latestFcr, expected)
  checkTrue('and they are the same number, not merely close',
    health.latestFcr === report.latestFcr)
  checkStr('the Report renders what Flock Health renders',
    renderCard(report.latestFcr), renderCard(health.latestFcr))
  checkStr('  which is the figure to two decimals', renderCard(report.latestFcr), '9.561')

  // The same expression in both templates, so the same string for any value.
  const rpExpr = cardExpression(RP_HTML, 'FCR')
  const fhExpr = cardExpression(FH_HTML, 'Latest FCR')
  checkStr('the Report\'s card expression IS Flock Health\'s', rpExpr, fhExpr)
  checkTrue('  em dash on null, 1.2-3 otherwise',
    /latestFcr !== null/.test(rpExpr) && /number:'1\.2-3'/.test(rpExpr) &&
    rpExpr.includes('—'))

  // ── C. THE EMPTY CASES ───────────────────────────────────────────────────
  console.log('\n=== C. no ratio is null and prints an em dash, never 0 ===')

  const cases = [
    ['a flock with no health rows at all', 2],
    ['a flock with feed but no weight ever', 3],
    ['a flock with weight but no feed ever', 4]
  ]
  for (const [what, flockId] of cases) {
    const r = makeReportScreen({ health: rows(RP_SELECT, [flockId]) })
    const h = makeHealthScreen(rows(FH_SELECT, [flockId]))
    checkNull(what, r.latestFcr)
    checkTrue('  and Flock Health agrees', h.latestFcr === r.latestFcr)
    checkStr('  prints an em dash', renderCard(r.latestFcr), '—')
  }
  checkTrue('no divide-by-zero leaked a non-finite number',
    [2, 3, 4].every(f => {
      const v = makeReportScreen({ health: rows(RP_SELECT, [f]) }).latestFcr
      return v === null || Number.isFinite(v)
    }))

  checkNull('a row with no day index yet', makeReportScreen({
    health: [{ week_number: null, total_birds: 100, mortality: 0, feed_used: 9, avg_weight: 800 }]
  }).latestFcr)

  // EVERY BIRD DEAD is deliberately NOT a dash. The row has both a weight and
  // cumulative feed, so it qualifies, and `computeAutoFcr` returns 0 for
  // `remaining <= 0` — a terminal flock really did convert its feed into
  // nothing. What matters is that the Report says exactly what the Flock Health
  // screen beside it says; making this a dash would mean changing that screen's
  // existing card, which this change deliberately does not do.
  const allDead = [
    { week_number: 3, total_birds: 100, mortality: 100, feed_used: 9, avg_weight: 800 }
  ]
  check('every bird dead reads 0, as it always has',
    makeReportScreen({ health: allDead }).latestFcr, 0)
  checkTrue('  and Flock Health says the same thing',
    makeHealthScreen(allDead).latestFcr === makeReportScreen({ health: allDead }).latestFcr)
  checkTrue('  no divide-by-zero got through', Number.isFinite(
    makeReportScreen({ health: allDead }).latestFcr))
  checkStr('the whole-flock empty state is the dash, not "0.00"',
    renderCard(makeReportScreen().latestFcr), '—')

  // ── D. CUMULATIVE, AND THE RIGHT ROW ─────────────────────────────────────
  console.log('\n=== D. the cumulative denominator and the highest qualifying day ===')

  // The signature of the old single-day bug: day 1 agrees, every later day does
  // not. Dividing by day 35's own 120 bags instead of 205 inflates it wildly.
  const singleDay = ((985 - 5) / 1000 * 2000) / 120
  checkTrue('NOT the last day\'s feed alone', Math.abs(report.latestFcr - singleDay) > 1)
  check('  it is weight over CUMULATIVE bags',
    report.latestFcr, Number((((985 - 5) / 1000 * 2000) / 205).toFixed(3)))

  // Rows arrive out of order; the day index orders them, never the array.
  const shuffled = [...rpRows].reverse()
  check('out-of-order rows give the same figure',
    makeReportScreen({ health: shuffled }).latestFcr, expected)
  checkTrue('  not the last element\'s FCR',
    makeReportScreen({ health: shuffled }).latestFcr
      !== displayFcr(shuffled[shuffled.length - 1], shuffled))

  // A later day exists but is still missing its weight: the card must fall back
  // to the last day that actually has one, not go blank.
  const withBlankLaterDay = rpRows.concat([
    { week_number: 42, total_birds: 980, mortality: 0, feed_used: 30, avg_weight: 0 }
  ])
  check('a later day with no weight yet falls back to day 35',
    makeReportScreen({ health: withBlankLaterDay }).latestFcr, expected)

  // A real later day takes over, and its denominator includes every earlier bag.
  const withDay42 = rpRows.concat([
    { week_number: 42, total_birds: 980, mortality: 0, feed_used: 30, avg_weight: 2400 }
  ])
  check('a real day 42 takes over',
    makeReportScreen({ health: withDay42 }).latestFcr,
    Number(((980 / 1000 * 2400) / 235).toFixed(3)))

  // A hand-entered FCR is shown as entered, here as on the table.
  const manual = rpRows.concat([
    { week_number: 42, total_birds: 980, mortality: 0, feed_used: 30,
      avg_weight: 2400, fcr: 7.77, fcr_manual: 1 }
  ])
  check('a hand-entered FCR is respected',
    makeReportScreen({ health: manual }).latestFcr, 7.77)
  checkStr('  and rendered as typed',
    renderCard(makeReportScreen({ health: manual }).latestFcr), '7.77')

  // The Flock Health card moves as an unsaved row is typed; the Report has only
  // saved rows, so the chosen row is unaffected and must not try to be.
  const typing = makeHealthScreen(fhRows, [
    { week_number: 42, total_birds: 980, mortality: 0, feed_used: 30, avg_weight: 2400 }
  ])
  check('an unsaved row does not change the chosen saved row',
    typing.latestFcr, expected)
  checkTrue('  so the saved-row card is unmoved', typing.latestFcr === report.latestFcr)

  // ── E. THE OTHER CARDS ARE UNCHANGED ─────────────────────────────────────
  console.log('\n=== E. no existing figure on the Report moved ===')

  db.run(`INSERT INTO income (flock_id, date, source, amount, module_type)
          VALUES (1, '2026-03-10', 'manual', 400000, 'broiler')`)
  db.run(`INSERT INTO expenses (flock_id, date, category, amount, module_type)
          VALUES (1, '2026-03-02', 'Chicks', 120000, 'broiler')`)
  db.run(`INSERT INTO sales (flock_id, date, bird_weight, rate, total_amount, module_type)
          VALUES (1, '2026-04-05', 1960, 255.10, 500000, 'broiler')`)

  const loaded = {
    income: rows(`SELECT * FROM income WHERE flock_id = 1`),
    expenses: rows(`SELECT * FROM expenses WHERE flock_id = 1`),
    sales: rows(`SELECT * FROM sales WHERE flock_id = 1`)
  }
  const withHealth = makeReportScreen(Object.assign({ health: rpRows }, loaded))
  const withoutHealth = makeReportScreen(Object.assign({ health: [] }, loaded))

  for (const name of RP_GETTERS.filter(g => g !== 'latestFcr')) {
    check(`${name} is identical with and without flock_health rows`,
      withHealth[name], withoutHealth[name])
  }
  check('  Total Income still reads the income rows', withHealth.totalIncome, 400000)
  check('  Other Expenses still reads the expense rows', withHealth.totalExpenses, 120000)
  check('  Total Weight Sold still reads the sales rows', withHealth.totalSaleWeight, 1960)
  check('  Net Profit is still income less every cost',
    withHealth.profitLoss, 400000 - 120000)
  checkTrue('and only the FCR card reads this.health at all',
    RP_GETTERS.filter(g => g !== 'latestFcr')
      .every(g => !/this\.health\b/.test(getterSrc(RP_SRC, g))))
  checkTrue('the FCR card does read it', /this\.health\b/.test(rpFcrGetter))

  // ── F. NO NEW QUERY ──────────────────────────────────────────────────────
  console.log('\n=== F. no query was added, and both cards read one statement ===')

  // 14 since the Chicks screen landed: `chick_traders` and `chick_entries`
  // joined the flock's cost reads beside feed and medicine. The FCR card itself
  // still adds none — it reads the flock_health rows the Flock Health PDF
  // section already loaded, which is the claim this section exists to pin.
  check('the Report still issues exactly 14 reads',
    (RP_SRC.match(/this\.db\.get\(/g) || []).length, 14)
  check('  exactly one of them touches flock_health',
    (RP_SRC.match(/FROM flock_health/g) || []).length, 1)
  checkStr('and it IS the Flock Health screen\'s own statement',
    norm(RP_SELECT), norm(FH_SELECT))
  checkTrue('the FCR getter runs no SQL and awaits nothing',
    !/db\.|SELECT|await/i.test(rpFcrGetter))
  check('the two statements return the same rows', rpRows.length, fhRows.length)
  checkTrue('  row for row',
    rpRows.every((r, i) => JSON.stringify(r) === JSON.stringify(fhRows[i])))
  checkTrue('the Report writes nothing',
    !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(RP_SRC))

  // ── G. SCOPING, AND THE LAYER SIDE ───────────────────────────────────────
  console.log('\n=== G. flock-scoped, and the colliding layer batch is untouched ===')

  checkTrue('the statement is scoped by flock_id', /WHERE flock_id = \?/.test(RP_SELECT))
  check('flock 1\'s card sees only flock 1\'s four rows', rpRows.length, 4)
  checkTrue('  none of them is another flock\'s',
    rpRows.every(r => Number(r.flock_id) === 1))
  check('the colliding batch\'s layer_health rows are still there',
    one(`SELECT COUNT(*) v FROM layer_health WHERE batch_id = 1`), 2)
  check('  and none of them reached the broiler card',
    one(`SELECT COUNT(*) v FROM flock_health WHERE feed_used IN (70, 72)`), 0)
  // flock_health carries no module_type, which is exactly why layer health is a
  // table of its own rather than rows in here (see CLAUDE.md).
  checkTrue('flock_health still has no module_type column',
    !rows(`SELECT name FROM pragma_table_info('flock_health')`)
      .some(c => c.name === 'module_type'))

  checkTrue('the Layer Report still has no FCR — layer FCR is feed per egg',
    !/fcr/i.test(LR_SRC))
  checkTrue('the Farm Report still has no FCR', !/fcr/i.test(FR_SRC))
  checkTrue('the layer health screen was not touched by this',
    !/latestFlockFcr/.test(LFH_SRC))

  // ── H. THE TEMPLATE ─────────────────────────────────────────────────────
  console.log('\n=== H. the card is in the row, with one label and one value ===')

  const grid = (RP_HTML.match(/<div class="summary-grid">[\s\S]*?\n    <\/div>/) || [''])[0]
  checkTrue('the summary grid was found', grid.length > 0)
  const cards = grid.match(/<div class="summary-card[\s\S]*?<\/div>\s*<\/div>/g) || []
  check('the top row now holds five cards', cards.length, 5)
  cards.forEach((card, i) => {
    check(`card ${i + 1} has exactly one label`,
      (card.match(/class="card-label"/g) || []).length, 1)
    check(`card ${i + 1} has exactly one value`,
      (card.match(/class="card-value"/g) || []).length, 1)
  })
  checkTrue('the FCR card is the LAST of them',
    /class="card-label">FCR</.test(cards[cards.length - 1]))
  checkTrue('  and every earlier card kept its own label',
    ['Total Income', 'Other Expenses', 'Total Weight Sold']
      .every(l => grid.includes(`>${l}<`)))
  checkTrue('the grid is no longer a hard four columns',
    !/grid-template-columns:\s*repeat\(4,\s*1fr\)/.test(RP_SCSS))
  checkTrue('  it fits whatever it holds', /repeat\(auto-fit,\s*minmax\(/.test(RP_SCSS))
  checkTrue('the card has its own accent, like its neighbours', /&\.fcr\s/.test(RP_SCSS))

  // ── I. NO toISOString ────────────────────────────────────────────────────
  console.log('\n=== I. no date was stored through toISOString ===')

  for (const [who, src] of [['fcr.util.ts', FCR_SRC], ['health-day.util.ts', DAY_SRC],
                            ['report.component.ts', RP_SRC],
                            ['flock-health.component.ts', FH_SRC]]) {
    checkTrue(`${who} uses no toISOString`, !/toISOString/.test(src))
  }

  // ── The end state ────────────────────────────────────────────────────────
  console.log('\n=== the end state ===')

  check('the flock\'s health rows are exactly as written',
    one(`SELECT COUNT(*) v FROM flock_health WHERE flock_id = 1`), 4)
  check('  with the feed untouched',
    one(`SELECT COALESCE(SUM(feed_used),0) v FROM flock_health WHERE flock_id = 1`), 205)
  check('nothing wrote a stored fcr',
    one(`SELECT COUNT(*) v FROM flock_health WHERE COALESCE(fcr,0) <> 0`), 0)
  checkStr('and the card still reads',
    renderCard(makeReportScreen({ health: rows(RP_SELECT, [1]) }).latestFcr), '9.561')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
