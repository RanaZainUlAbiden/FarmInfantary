// The error-message patterns exist in two places. Prove they are identical.
//
// src/app/shared/utils/sql-error.util.ts is the real implementation; the
// Angular tree is TypeScript and cannot be imported by the Node test runner
// without a build step, so server/test/helpers/sql-error.mjs mirrors it.
//
// That mirror is only worth having if it cannot drift. This compares the three
// regex SOURCES character for character and fails the build if they diverge —
// otherwise the tests would keep passing against a pattern the app no longer
// uses, which is exactly the kind of false confidence that lets a defect ship.
//
// What the patterns decide is not cosmetic: whether a user sees "relation
// \"bills\" does not exist" or a sentence they can act on.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const TS = join(ROOT, 'src', 'app', 'shared', 'utils', 'sql-error.util.ts')
const MIRROR = join(ROOT, 'server', 'test', 'helpers', 'sql-error.mjs')

const NAMES = ['SQLITE_ERROR_PATTERN', 'POSTGRES_ERROR_PATTERN', 'COMMON_ERROR_PATTERN']

/** Pull `const NAME =\n  /.../i;` out of a source file. */
function pattern(src, name, file) {
  const at = src.indexOf(`const ${name} =`)
  if (at < 0) throw new Error(`${name} not found in ${file}`)
  const start = src.indexOf('/', src.indexOf('=', at))
  // Walk to the closing delimiter, skipping escapes and character classes.
  let i = start + 1
  let inClass = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) break
  }
  return src.slice(start + 1, i)
}

const ts = readFileSync(TS, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')

let passed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}

console.log('sql-error patterns: implementation vs test mirror')
console.log('='.repeat(62))

for (const name of NAMES) {
  const a = pattern(ts, name, 'sql-error.util.ts')
  const b = pattern(mirror, name, 'sql-error.mjs')
  check(
    `${name} is identical in both files`,
    a === b,
    a === b ? '' : `ts     : ${a}\n        mirror : ${b}`
  )
}

// A pattern that matched nothing would hide no driver text at all, and the
// test file would still pass every "app message passes through" case.
const sample = 'relation "bills" does not exist'
const combined = new RegExp(NAMES.map((n) => pattern(ts, n, 'ts')).join('|'), 'i')
check('the combined pattern still hides PostgreSQL driver text', combined.test(sample), sample)
check('and still lets an app-authored sentence through',
  !combined.test('Choose which bank account the payment came from.'))

console.log('\n' + '='.repeat(62))
if (failures.length) {
  console.log(`FAILED — ${failures.length} check(s).`)
  console.log('\nCopy the pattern from sql-error.util.ts into server/test/helpers/sql-error.mjs.')
  console.log('Do not edit the mirror to make this pass — the .ts file is the implementation.')
  process.exit(1)
}
console.log(`ALL CHECKS PASSED — ${passed} checks`)
