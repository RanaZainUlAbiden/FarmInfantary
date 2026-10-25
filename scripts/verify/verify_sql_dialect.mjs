// Inventory every SQLite-ism in the app's SQL, and fail when a new one appears.
//
// WHY THIS EXISTS
// ---------------
// The Phase 1 dialect list was originally produced by eyeballing greps, and it
// was WRONG: it missed two-argument `MAX(a, b)` entirely, because the regex
// used to count it excluded nested parentheses and every real occurrence is
// wrapped in COALESCE. Eleven of them, all in money paths — the app's debt
// definition. PostgreSQL rejects it:
//
//   ERROR: function max(double precision, integer) does not exist
//
// A hand-counted list is a claim. This is a measurement, and it fails the build
// when the measurement changes — so the next missed construct is found by the
// suite instead of by a screen that stopped working.
//
// Comments are stripped before matching. The original miss ran the other way
// too: the only `MAX(.., 0)` matches the first grep found were in comments,
// which made the construct look absent when it was pervasive.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

// Phase 2 moves the Angular source to src/; until then it lives in the frozen
// reference app. Pick the first tree that actually CONTAINS sources — src/app
// exists from the scaffold but is empty until Phase 2, and scanning an empty
// directory would report a clean bill of health for code it never looked at.
const TARGETS = [join(ROOT, 'src', 'app'), join(ROOT, 'Talha Farm', 'src', 'app')]
  .filter((d) => { try { return statSync(d).isDirectory() } catch { return false } })
  .filter((d) => walk(d).length > 0)
  .slice(0, 1)

if (TARGETS.length === 0) {
  console.log('SKIP — no Angular source tree with .ts files found')
  process.exit(0)
}

/** Remove // and block comments so a construct named in prose is not counted. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/**
 * Two-argument MAX/MIN, with balanced-paren awareness. A regex cannot do this:
 * `MAX(COALESCE(a,0) - COALESCE(b,0), 0)` has commas at two different depths,
 * and only the depth-0 one splits the arguments. Getting this wrong is exactly
 * what caused the original miss.
 */
function findScalarMaxMin(src) {
  const hits = []
  // Case-SENSITIVE uppercase, and not preceded by a dot. Both matter:
  // `Math.max(a, b)` is JavaScript, not SQL, and a case-insensitive `\bmax\(`
  // matches the `max(` inside it — which over-counted 91 where the real figure
  // is far lower. SQL in this codebase is written uppercase throughout.
  const re = /(^|[^.\w])(MAX|MIN)\s*\(/g
  let m
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    let commas = 0
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 1) commas++
    }
    if (depth === 0 && commas === 1) {
      hits.push({ index: m.index, text: src.slice(m.index, Math.min(i, m.index + 70)).trim() })
    }
  }
  return hits
}

const PATTERNS = [
  // Found by the Phase 1 gate, not by inspection: SQLite ships a built-in
  // NOCASE collation and PostgreSQL does not, so these statements fail
  // outright until db/schema/000_collations.sql defines one.
  { key: 'COLLATE NOCASE',   re: /\bCOLLATE\s+NOCASE\b/gi,        fix: 'an ICU nocase collation — db/schema/000_collations.sql' },
  // Found by walking the app and by verify_app_sql_prepares.mjs — not by any
  // text search, because these are differences in what PostgreSQL ACCEPTS
  // rather than in what the SQL says.
  { key: 'date(x, modifier)', re: /\bdate\s*\([^()]*,[^()]*\)/gi,  fix: 'to_char(x::date +/- INTERVAL ..) — translated' },
  { key: '? IS NULL',        re: /\?\s*IS\s+(?:NOT\s+)?NULL/gi,    fix: '?::text IS NULL — PG cannot infer the type otherwise' },
  { key: 'julianday',        re: /\bjulianday\s*\(/gi,            fix: "(x::date - CURRENT_DATE)" },
  { key: "date('now')",      re: /\bdate\s*\(\s*'now'\s*\)/gi,    fix: 'CURRENT_DATE' },
  { key: 'strftime',         re: /\bstrftime\s*\(/gi,             fix: 'to_char()' },
  { key: 'datetime()',       re: /\bdatetime\s*\(/gi,             fix: 'to_char(now(), ..)' },
  { key: 'CAST(.. AS INTEGER)', re: /\bCAST\s*\([^;]*?\bAS\s+INTEGER\s*\)/gi, fix: 'trunc(x)::int — SQLite truncates, PG rounds' },
  { key: 'GROUP_CONCAT',     re: /\bGROUP_CONCAT\s*\(/gi,         fix: 'STRING_AGG' },
  { key: 'INSERT OR IGNORE', re: /\bINSERT\s+OR\s+IGNORE\b/gi,    fix: 'ON CONFLICT DO NOTHING' },
  { key: 'INSERT OR REPLACE',re: /\bINSERT\s+OR\s+REPLACE\b/gi,   fix: 'ON CONFLICT DO UPDATE' },
  { key: 'last_insert_rowid',re: /\blast_insert_rowid\s*\(/gi,    fix: 'RETURNING <pk>' },
  { key: 'PRAGMA',           re: /\bPRAGMA\s+\w+/gi,              fix: 'not applicable' },
  { key: 'AUTOINCREMENT',    re: /\bAUTOINCREMENT\b/gi,           fix: 'GENERATED BY DEFAULT AS IDENTITY' },
  { key: 'IFNULL',           re: /\bIFNULL\s*\(/gi,               fix: 'COALESCE' },
  { key: 'printf(',          re: /\bprintf\s*\(/gi,               fix: 'format()' },
  { key: 'RANDOM()',         re: /\bRANDOM\s*\(\s*\)/gi,          fix: 'random()' },
  { key: 'sqlite_master',    re: /\bsqlite_master\b/gi,           fix: 'information_schema / pg_catalog' },
]

// The measured inventory. Change a number here ONLY with the matching SQL
// change, and say why in the commit.
const EXPECTED = {
  // MEASURED, not estimated. The first hand-counted list had four of these
  // wrong: two-arg MAX/MIN at 11 (it is 22, and some are nested MIN(MAX(..)),
  // julianday at 11 (that was LINES, not occurrences), CAST at 19 (that
  // counted every CAST, not just AS INTEGER) and date('now') at 5.
  'COLLATE NOCASE': 7,
  'date(x, modifier)': 2,
  '? IS NULL': 2,
  'two-arg MAX/MIN': 22,
  'julianday': 22,
  "date('now')": 7,
  'CAST(.. AS INTEGER)': 10,
  'GROUP_CONCAT': 2,
  'INSERT OR IGNORE': 1,
  'strftime': 0,
  'datetime()': 0,
  'INSERT OR REPLACE': 0,
  'last_insert_rowid': 0,
  'PRAGMA': 0,
  'AUTOINCREMENT': 0,
  'IFNULL': 0,
  'printf(': 0,
  'RANDOM()': 0,
  'sqlite_master': 0,
}

const files = TARGETS.flatMap((d) => walk(d))
const counts = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, 0]))
const where = {}

for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  const rel = relative(ROOT, f)

  const mm = findScalarMaxMin(src)
  if (mm.length) {
    counts['two-arg MAX/MIN'] += mm.length
    ;(where['two-arg MAX/MIN'] ??= new Set()).add(rel)
  }

  for (const p of PATTERNS) {
    const n = (src.match(p.re) ?? []).length
    if (n) {
      counts[p.key] += n
      ;(where[p.key] ??= new Set()).add(rel)
    }
  }
}

let passed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('SQLite dialect inventory')
console.log('='.repeat(66))
console.log(`  ${files.length} source files under ${relative(ROOT, TARGETS[0]) || TARGETS[0]}\n`)

const present = Object.entries(counts).filter(([, n]) => n > 0)
const absent = Object.entries(counts).filter(([, n]) => n === 0)

console.log('=== constructs that need translation ===')
for (const [k, n] of present.sort((a, b) => b[1] - a[1])) {
  const fix = PATTERNS.find((p) => p.key === k)?.fix ?? 'GREATEST / LEAST'
  console.log(`  ${String(n).padStart(3)}  ${k.padEnd(24)} -> ${fix}`)
  console.log(`       ${[...(where[k] ?? [])].map((f) => f.replace(/^Talha Farm[\\/]/, '')).join('\n       ')}`)
}

console.log('\n=== counts match the recorded inventory ===')
for (const [k, want] of Object.entries(EXPECTED)) {
  check(`${k}: ${counts[k]}`, counts[k] === want, `expected ${want}, found ${counts[k]}`)
}

console.log(`\n  not present: ${absent.map(([k]) => k).join(', ')}`)

console.log('\n' + '='.repeat(66))
if (failures.length) {
  console.log(`FAILED — ${failures.length} construct count(s) moved.`)
  console.log(
    '\nEither SQL changed, or a construct was missed before. Do NOT just update\n' +
    'EXPECTED: work out which SQL moved and whether it needs translating. The\n' +
    'two-arg MAX case was missed exactly this way and reached PostgreSQL as an\n' +
    'error in eleven money queries.'
  )
  process.exit(1)
}
console.log(`ALL CHECKS PASSED — ${passed} constructs inventoried across ${files.length} files`)
