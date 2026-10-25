#!/usr/bin/env node
/**
 * Ports an inherited verify script to PostgreSQL.
 *
 *   node scripts/verify/lib/port.mjs verify_loans
 *
 * WHY A TRANSFORM AND NOT A REWRITE
 * ---------------------------------
 * These scripts are 700-1000 lines each and the assertions ARE the value. A
 * hand-rewrite risks quietly changing what is asserted, and a test that passes
 * for the wrong reason is worse than no test at all.
 *
 * So this is deliberately conservative: the ASSERTION BODY is copied BYTE FOR
 * BYTE apart from three mechanical substitutions that sql.js's synchronous API
 * forces (`db.run`, `rows`, `one` become awaited calls). Everything the script
 * checks, and every message it prints, is the original's.
 *
 * Three regions:
 *
 *   PREAMBLE   source extraction + the `methods` map. Kept verbatim and made to
 *              work by shimming the globals it expects (`fs`, `path`, `ts`,
 *              `ROOT`, `*_SRC`) — rather than editing it, which would risk
 *              changing which code is lifted.
 *   BOOTSTRAP  the sql.js database and the `svc` stub. REPLACED — this is the
 *              only part that is genuinely about the storage engine.
 *   BODY       the fixtures and assertions. Byte-identical but for the three
 *              substitutions.
 *
 * The output is a committed file, reviewable in a diff against the original.
 *
 * STATUS — WORKS FOR SHAPE A ONLY
 * -------------------------------
 * Shape A (`svc` built inside initSqlJs().then(), methods bound afterwards)
 * ports cleanly: verify_loans came through with all 133 checks green.
 *
 * Shape B (`svc` as a top-level literal with a `call()` helper) does NOT yet
 * port. Its preamble defines helpers that close over the sql.js handle and are
 * reached from the body, so the transformed region had to grow to include
 * them — and once it did, the async cascade stopped converging. The
 * `inline arrows made async` pass reports 0 matches at transform time even
 * though the same pattern matches the emitted file, which is unexplained.
 *
 * Do not extend this speculatively. Either debug that discrepancy first, or
 * hand-port the shape-B scripts — there are four money-critical ones
 * (vouchers, internal_settlements, cash_and_bank_totals, no_negative_bank)
 * and a hand port is a known quantity where another transform layer is not.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SRC_DIR = join(ROOT, 'Talha Farm', 'scripts', 'verify');
const OUT_DIR = join(ROOT, 'scripts', 'verify');

const name = process.argv[2]?.replace(/\.js$/, '');
if (!name) {
  console.error('usage: port.mjs <verify_script_name>');
  process.exit(2);
}

const srcPath = join(SRC_DIR, `${name}.js`);
if (!existsSync(srcPath)) {
  console.error(`No such script: ${srcPath}`);
  process.exit(2);
}

const src = readFileSync(srcPath, 'utf8');

// ── locate the three regions ───────────────────────────────

// The preamble starts after the last `require(...)` line.
//
// Deliberately NOT after the `*_SRC = fs.readFileSync(...)` declarations:
// those vary between scripts and some span several lines, so a shim that
// re-declares them collides with whichever ones the regex left behind.
// Letting each original declare its own sources is simpler and truer — the
// shim then only has to supply `fs`, `path`, `ts` and `ROOT`.
const requires = [...src.matchAll(/^const \w+ = require\([^\n]*\)\n/gm)];
if (requires.length === 0) throw new Error('Could not find the require() header block');
const preambleStart = requires.at(-1).index + requires.at(-1)[0].length;

const bootAt = src.search(/^initSqlJs\(\)\s*\.then\(/m);
if (bootAt < 0) throw new Error('Could not find the initSqlJs() bootstrap');

/**
 * The scripts come in two shapes, and the difference is where `svc` lives.
 *
 *   A. `svc` is built INSIDE initSqlJs().then(), and the methods are bound
 *      onto it with a `for (… of Object.entries(methods))` line. The body
 *      starts after that line.
 *
 *   B. `svc` is a top-level object literal that already carries the methods,
 *      with a `call()` helper. Nothing binds afterwards, so the body starts
 *      after the alterStatements loop instead, and `svc`'s three database
 *      methods are OVERRIDDEN once the scratch database exists.
 *
 * Shape B needs no edit to the preamble at all: its `rows`/`one`/`svc.get`
 * closures still reference the sql.js handle, but that handle stays null and
 * nothing calls them — the body's calls are rewritten to the awaited helpers,
 * and svc's methods are replaced. They become unreachable dead code, which is
 * safer than editing a preamble whose job is deciding which source gets lifted.
 */
const bindRe = /^\s*for \(const \[name, fn\] of Object\.entries\(methods\)\) svc\[name\] = fn\.bind\(svc\)\n/m;
const bindMatch = bindRe.exec(src);

let bodyStart;
let shape;
if (bindMatch) {
  shape = 'A';
  bodyStart = bindMatch.index + bindMatch[0].length;
} else {
  const alterRe = /^\s*for \(const sql of alterStatements\)[^\n]*\n/m;
  const alterMatch = alterRe.exec(src);
  if (!alterMatch) {
    throw new Error('Recognised neither shape: no svc bind line and no alterStatements loop');
  }
  shape = 'B';
  bodyStart = alterMatch.index + alterMatch[0].length;
}

// The body ends at the trailing .catch() that closes the promise chain.
const tailAt = src.search(/^\}\)\.catch\(/m);
if (tailAt < 0) throw new Error('Could not find the trailing .catch()');

let preamble;
let body;

if (shape === 'A') {
  preamble = src.slice(preambleStart, bootAt).trimEnd();
  body = src.slice(bodyStart, tailAt);
} else {
  // Shape B's preamble does not stop at `svc`. It goes on to define helpers
  // that close over the sql.js handle — `bankInvariant` calls `one()` calls
  // `rows()` calls `db.prepare` — and the body calls THOSE. Leaving them
  // untransformed was the "Cannot read properties of null" failure.
  //
  // So the split moves: everything up to the end of the `svc` literal is
  // verbatim preamble (it decides which source is lifted, and must not be
  // touched); everything after it is transformed along with the body.
  const svcAt = src.indexOf('const svc = {');
  if (svcAt < 0) throw new Error('Shape B without a `const svc = {` literal');
  let depth = 0;
  let i = src.indexOf('{', svcAt);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  preamble = src.slice(preambleStart, i).trimEnd();

  // Two pieces, skipping the sql.js bootstrap that sits between them.
  body = src.slice(i, bootAt) + '\n' + src.slice(bodyStart, tailAt);
}

// ── the three mechanical substitutions ─────────────────────
// sql.js is synchronous; PostgreSQL is not. These are the only edits made to
// the body, and each is reported so the count can be eyeballed against the
// original.

const subs = [];

/** Index just past the paren opened at `openIdx`. */
function matchParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * Rewrite `name(...)` to `(await to(...))`, wrapping the WHOLE call.
 *
 * The parentheses are not optional. The originals write `one(sql).balance`,
 * and `await _one(sql).balance` reads the property off the promise — which is
 * `undefined`, silently, and every assertion downstream then compares against
 * nothing. That is precisely the kind of quietly-passing test this port must
 * not produce.
 */
function wrapCalls(src, name, to) {
  const re = new RegExp(`(^|[^.\\w])(${name.replace('.', '\\.')})\\s*\\(`, 'g');
  const edits = [];
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const end = matchParen(src, open);
    if (end === -1) continue;
    const args = src.slice(open, end);
    const text = resultIsUsed(src, end)
      ? `(await ${to}${args})`
      : `await ${to}${args}`;
    edits.push({ from: m.index + m[1].length, to: end, text });
  }
  for (const e of edits.reverse()) src = src.slice(0, e.from) + e.text + src.slice(e.to);
  return { src, count: edits.length };
}

/**
 * Whether the call at [start, end) has its RESULT used, i.e. is followed by a
 * property access or index.
 *
 * This decides whether the rewrite needs wrapping parentheses, and it matters
 * because the originals are written without semicolons. Wrapping a
 * statement-position call turns
 *
 *     const OTHER = 2
 *     db.run(`...`)
 *
 * into `2(await _run(...))` — "2 is not a function" — because automatic
 * semicolon insertion will not break before an open parenthesis. A bare
 * `await` cannot continue the previous expression, so statement-position calls
 * are left unwrapped.
 */
function resultIsUsed(src, end) {
  // The window must be generous: the originals chain across line breaks —
  //     rows(`…`)
  //       .every(r => …)
  // — and a three-character lookahead sees only the newline and indent, misses
  // the dot, and leaves the call unwrapped. That produced
  // `_rows(...).every is not a function`, because `.every` was read off the
  // promise. Skip whitespace properly instead of guessing a width.
  const rest = src.slice(end, end + 200).replace(/^\s+/, '');
  return rest.startsWith('.') || rest.startsWith('[') || rest.startsWith('?.');
}

for (const [name, to] of [
  ['db.run', '_run'], ['db.exec', '_exec'], ['rows', '_rows'], ['one', '_one'],
]) {
  const r = wrapCalls(body, name, to);
  body = r.src;
  subs.push(`${name}: ${r.count}`);
}

/**
 * Make the body's own named helpers async, and await calls to them.
 *
 * The originals build synchronous closures over `one`/`rows`
 * (`const bal = (id) => Number(one(sql).b)`). Once those reads are awaited the
 * helper must be async, and then every call to it must be awaited too.
 *
 * Only TOP-LEVEL named helpers are touched — never inline callbacks. Making
 * `.find(c => ...)` async would return a promise, which is always truthy, so
 * every find would match its first element and the assertions would pass for
 * entirely the wrong reason.
 *
 * Awaiting a non-promise is a no-op in JavaScript, so applying this to helpers
 * that did not need it is harmless. That is deliberate: it avoids having to
 * decide which helpers transitively need it, which is where a subtle miss
 * would hide.
 */
const helperRe = /^(\s*)(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/gm;
const helpers = [];
for (const m of body.matchAll(helperRe)) {
  // Only arrow functions: look for `=>` before the statement ends.
  const after = body.slice(m.index + m[0].length, m.index + m[0].length + 4000);
  const close = matchParen(body, m.index + m[0].length - 1);
  if (close === -1) continue;
  const tail = body.slice(close, close + 12);
  if (!/^\s*=>/.test(tail)) continue;
  if (m[3]) continue; // already async
  helpers.push({ name: m[2], at: m.index + m[0].length - 1 - (m[2].length + 3) });
}

// Mark them async, right to left so indices stay valid.
let asyncCount = 0;
for (const h of [...helpers].reverse()) {
  const eq = body.indexOf('=', body.indexOf(h.name, h.at));
  const open = body.indexOf('(', eq);
  body = body.slice(0, open) + 'async ' + body.slice(open);
  asyncCount++;
}
subs.push(`helpers made async: ${asyncCount}`);

// ...and await every call to them.
let awaited = 0;
for (const h of helpers) {
  const r = wrapCalls(body, h.name, h.name);
  body = r.src;
  awaited += r.count;
}
subs.push(`helper calls awaited: ${awaited}`);

/**
 * Inline arrow callbacks that now CONTAIN an await must themselves be async.
 *
 * The originals pass synchronous thunks to wrappers that invoke them:
 *     quiet(() => editTo(50000, MAIN))
 *     movement('broiler sale', () => db.run(`…`))
 * Once the inner call is awaited the arrow is no longer valid JavaScript —
 * "Unexpected reserved word" — so the arrow needs `async` too.
 *
 * Only arrows whose body STARTS with the introduced await are touched, which
 * is the shape the wrappers use. Anything subtler is left alone and will fail
 * loudly at parse time rather than be guessed at.
 */
const arrowRe = /(^|[^.\w])(\([^()]*\)|[A-Za-z_$][\w$]*)(\s*=>\s*)(\(?await)/g;
let asyncArrows = 0;

// An awaited call inside .find/.filter/.some/.every/.map cannot be made to
// work by adding `async`: the predicate would return a promise, which is
// always truthy, and every such call would match its first element. Refuse.
const unsafe = [...body.matchAll(/\.(find|filter|some|every|map|sort)\s*\(\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\(?await/g)];
if (unsafe.length) {
  console.error(`Refusing to port: ${unsafe.length} awaited call(s) inside an array predicate`);
  console.error('  e.g. ' + unsafe[0][0].replace(/\s+/g, ' ').slice(0, 90));
  console.error('Adding `async` there would make the predicate always truthy. Port by hand.');
  process.exit(1);
}

body = body.replace(arrowRe, (m, pre, params, arrow, tail) => {
  asyncArrows++;
  return `${pre}async ${params}${arrow}${tail}`;
});
subs.push(`inline arrows made async: ${asyncArrows}`);

// Anything still reaching for the sql.js handle is a region this transform
// does not understand. Refuse rather than emit a script that would fail in a
// confusing way later.
const leftover = body.match(/(^|[^.\w])db\.\w+\(/g);
if (leftover) {
  console.error(`Unhandled sql.js calls in the body: ${[...new Set(leftover)].join(', ')}`);
  console.error('Port this script by hand, or extend port.mjs to cover them.');
  process.exit(1);
}

// ── emit ───────────────────────────────────────────────────

const header = `// PORTED to PostgreSQL by scripts/verify/lib/port.mjs from
// "Talha Farm"/scripts/verify/${name}.js — do not hand-edit; re-run the tool.
//
// The ASSERTION BODY below is byte-identical to the original apart from the
// mechanical substitutions sql.js's synchronous API forces:
//   ${subs.join(' · ')}
//
// The methods under test are still lifted verbatim out of the real source.
// What changed is underneath them: db/schema/ instead of createTables(), and
// server/src/db/execute.js instead of sql.js.
//
// Skips (exit 0) when no database is configured.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { loadEnv, createScratchDb, makeService, REF, ROOT as REPO_ROOT } from './lib/pg-harness.mjs'

if (!loadEnv()) { console.log('SKIP — no DATABASE_URL configured'); process.exit(0) }

// Shims so the ORIGINAL preamble runs unchanged. Editing it would risk
// changing which code gets lifted, which is the one thing that must not move.
const require = createRequire(import.meta.url)
const fs = require('fs')
const path = require('path')
const ts = require(join(REF, 'node_modules', 'typescript'))
// The originals compute their own ROOT as path.join(__dirname, '..', '..').
// Give them a __dirname that makes that land on the reference app, rather than
// declaring ROOT here and colliding with theirs.
const __dirname = join(REF, 'scripts', 'verify')

// ── ORIGINAL PREAMBLE (verbatim) ───────────────────────────
${preamble}

// ── PostgreSQL bootstrap (replaces the sql.js one) ─────────
const __pg = await createScratchDb('${name.replace(/^verify_/, '')}')
${shape === 'A'
  ? `const svc = makeService(__pg.db, methods)`
  : `// Shape B: svc already exists with its methods. Point its three database
// calls at PostgreSQL; the sql.js versions above are now unreachable.
svc.get = (sql, params = []) => __pg.db.get(sql, params)
svc.run = (sql, params = []) => __pg.db.run(sql, params)
svc.runBatch = (ops) => __pg.db.batch(ops)`}

const _run = (sql, params = []) => __pg.db.run(sql, params)
const _rows = async (sql, params = []) => {
  const r = await __pg.db.get(sql, params)
  if (!r.success) throw new Error(r.error)
  return r.data
}
const _one = async (sql, params = []) => (await _rows(sql, params))[0]
const _exec = async (sql, params = []) => {
  // sql.js's exec() shape, for the few places that used it.
  const data = await _rows(sql, params)
  if (data.length === 0) return []
  const columns = Object.keys(data[0])
  return [{ columns, values: data.map((r) => columns.map((c) => r[c])) }]
}

let _failed = false
try {
// ── ORIGINAL BODY (verbatim but for the substitutions) ─────
`;

const footer = `
// ── end of original body ───────────────────────────────────
} catch (e) {
  _failed = true
  console.error(e)
} finally {
  await __pg.close()
}
if (_failed) process.exit(1)
`;

const outPath = join(OUT_DIR, `${name}_pg.mjs`);
writeFileSync(outPath, header + body + footer);

console.log(`Ported -> scripts/verify/${name}_pg.mjs`);
console.log(`  substitutions: ${subs.join(' · ')}`);
console.log(`  body: ${body.split('\n').length} lines, copied verbatim otherwise`);
