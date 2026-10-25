/**
 * SQLite -> PostgreSQL SQL translation.
 *
 * The app's SQL is written for SQLite and shipped from the browser unchanged.
 * Rather than edit 341 call sites, translate at the boundary.
 *
 * DESIGN RULE: translate what is known, FAIL LOUDLY on what is not.
 *
 * A partial translation that silently passes through an untranslated construct
 * is the worst outcome available — it either errors far from its cause or, for
 * `CAST`, returns quietly wrong numbers. So every construct this file knows
 * about is either rewritten or reported in `unhandled`, and the caller refuses
 * the statement. There is no "best effort" path.
 *
 * The inventory is measured, not guessed, by scripts/verify/verify_sql_dialect.mjs.
 * That script exists because the first hand-counted list missed two-argument
 * MAX entirely — 22 occurrences, all in money paths.
 */

import { codeOnly, codeMask, splitTopLevelArgs } from './scan.js';

/**
 * Walk from an opening paren to just past its match, counting only parens that
 * are CODE. A `)` inside a string literal closes nothing.
 */
function matchParen(src, openIdx, mask) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (!mask[i]) continue;
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Rewrites every call of `name(` whose argument list satisfies `accept`,
 * innermost-last so nested calls compose. Operates on the real string but only
 * matches positions that the scanner says are code.
 */
function rewriteCalls(sql, name, accept, build) {
  const mask = codeMask(sql);
  const re = new RegExp(`(^|[^.\\w])(${name})\\s*\\(`, 'gi');

  // Collect first, then apply right-to-left so earlier indices stay valid.
  const edits = [];
  let m;
  while ((m = re.exec(sql))) {
    const nameAt = m.index + m[1].length;
    if (!mask[nameAt]) continue;              // the call sits inside a literal
    const openIdx = m.index + m[0].length - 1;
    const end = matchParen(sql, openIdx, mask);
    if (end === -1) continue;
    const body = sql.slice(openIdx + 1, end - 1);
    const args = splitTopLevelArgs(body);
    if (!accept(args)) continue;
    edits.push({ from: nameAt, to: end, text: build(args) });
  }

  
  // Apply only the OUTERMOST, non-overlapping edits in this pass.
  //
  // A nested call produces overlapping ranges: in
  //     MAX(a - MIN(MAX(p, 0), t), 0)
  // the outer MAX's range CONTAINS the inner MAX's. Applying both — even
  // right-to-left — splices the inner replacement into text the outer one has
  // already rewritten, and the result is malformed SQL that PostgreSQL rejects
  // with "syntax error at or near )".
  //
  // That is not hypothetical: it broke two Overview dashboard queries, and the
  // screen reported only "unknown error" because the SQLite-shaped friendly
  // error mapping did not recognise PostgreSQL's message.
  //
  // Taking the outermost match and letting the caller's loop run again is what
  // makes nesting converge.
  const outermost = [];
  let lastEnd = -1;
  for (const e of edits.sort((a, b) => a.from - b.from)) {
    if (e.from >= lastEnd) {
      outermost.push(e);
      lastEnd = e.to;
    }
  }

  let out = sql;
  for (const e of outermost.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

/**
 * @param {string} sql
 * @returns {{ text: string, applied: string[], unhandled: string[] }}
 */
export function translate(sql) {
  const applied = [];
  const unhandled = [];
  let out = sql;
  const note = (k) => { if (!applied.includes(k)) applied.push(k); };

  // ── two-argument MAX / MIN -> GREATEST / LEAST ───────────
  // SQLite's MAX(a,b) is a SCALAR function. PostgreSQL's MAX() is aggregate
  // only, so the two-argument form is an outright error:
  //   ERROR: function max(double precision, integer) does not exist
  // One argument is the aggregate in both dialects and must be left alone.
  // Applied repeatedly because these nest: MIN(MAX(paid,0), total) is a clamp,
  // and one pass only rewrites the outermost.
  for (const [from, to] of [['MAX', 'GREATEST'], ['MIN', 'LEAST']]) {
    let before;
    do {
      before = out;
      out = rewriteCalls(out, from, (args) => args.length === 2, (args) => `${to}(${args.join(',')})`);
    } while (out !== before);
    if (out !== sql) note(`${from}->${to}`);
  }

  // ── julianday(x) - julianday('now') -> (x::date - CURRENT_DATE) ──
  // Only this binary form appears in the app (22 occurrences, all in
  // product-batch expiry). Any other julianday use is reported rather than
  // guessed at.
  {
    const re = /julianday\s*\(/gi;
    const mask = codeMask(out);
    const edits = [];
    let m;
    while ((m = re.exec(out))) {
      if (!mask[m.index]) continue;
      const open = m.index + m[0].length - 1;
      const end = matchParen(out, open, mask);
      if (end === -1) continue;
      const arg = out.slice(open + 1, end - 1).trim();

      const after = out.slice(end);
      const rhs = /^\s*-\s*julianday\s*\(\s*'now'\s*\)/i.exec(after);
      if (rhs) {
        edits.push({ from: m.index, to: end + rhs[0].length, text: `((${arg})::date - CURRENT_DATE)` });
      } else if (!/^\s*'now'\s*$/i.test(arg)) {
        unhandled.push(`julianday(${arg.slice(0, 40)}) in an unrecognised form`);
      }
    }
    if (edits.length) {
      for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
      note('julianday');
    }
  }

  // ── date(...) -> a TEXT date ─────────────────────────────
  //
  // SQLite's date() takes a value plus any number of MODIFIERS:
  //     date('now')                                  today
  //     date('now', '+3 months')                     today plus three months
  //     date(col, '+' || (n - 1) || ' days')         a column plus n-1 days
  //
  // PostgreSQL has no such function at all — not even the one-argument form:
  //     ERROR: function date(text, text) does not exist
  //
  // Every result is wrapped in to_char(..., 'YYYY-MM-DD') because dates are
  // stored as TEXT (D5). Returning a real date would reintroduce the
  // `text >= date` operator error that bare CURRENT_DATE caused.
  //
  // Only the three forms the app actually uses are translated. Anything else
  // is reported rather than guessed at — SQLite has a dozen modifiers
  // ('start of month', 'weekday 0', 'localtime') whose semantics are not
  // obvious to reproduce, and a wrong date is a silently wrong report.
  {
    const mask = codeMask(out);
    const re = /(^|[^.\w])date\s*\(/gi;
    const edits = [];
    let m;
    while ((m = re.exec(out))) {
      const at = m.index + m[1].length;
      if (!mask[at]) continue;
      const open = at + m[0].length - m[1].length - 1;
      const end = matchParen(out, open, mask);
      if (end === -1) continue;

      const args = splitTopLevelArgs(out.slice(open + 1, end - 1)).map((a) => a.trim());
      if (args.length === 0 || args.length > 2) {
        unhandled.push(`date() with ${args.length} arguments`);
        continue;
      }

      const isNow = /^'now'$/i.test(args[0]);
      const base = isNow ? 'CURRENT_DATE' : `(${args[0]})::date`;

      if (args.length === 1) {
        edits.push({ from: at, to: end, text: `to_char(${base}, 'YYYY-MM-DD')` });
        continue;
      }

      // '+3 months' / '-10 days' — a literal interval.
      const literal = /^'\s*([+-]?)\s*(\d+)\s+(day|days|month|months|year|years|hour|hours)\s*'$/i
        .exec(args[1]);
      if (literal) {
        const sign = literal[1] === '-' ? '-' : '+';
        edits.push({
          from: at, to: end,
          text: `to_char(${base} ${sign} INTERVAL '${literal[2]} ${literal[3].toLowerCase()}', 'YYYY-MM-DD')`,
        });
        continue;
      }

      // '+' || <expr> || ' days' — a computed number of days.
      //
      // The ::int cast is required, not tidiness. SQLite INTEGER maps to
      // bigint (D15), and PostgreSQL has no `date + bigint` operator — only
      // `date + integer`:
      //     ERROR: operator does not exist: date + bigint
      // A knock-on of the type mapping, and invisible until a real column is
      // used in the modifier.
      const computed = /^'\s*([+-])\s*'\s*\|\|\s*([\s\S]+?)\s*\|\|\s*'\s*days?\s*'$/i
        .exec(args[1]);
      if (computed) {
        const sign = computed[1] === '-' ? '-' : '+';
        edits.push({
          from: at, to: end,
          text: `to_char(${base} ${sign} (${computed[2]})::int, 'YYYY-MM-DD')`,
        });
        continue;
      }

      unhandled.push(`date(${args[0].slice(0, 24)}, ${args[1].slice(0, 40)}) — unrecognised modifier`);
    }
    if (edits.length) {
      for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
      note('date()');
    }
  }

  // ── CAST(x AS INTEGER) -> trunc(x)::int ──────────────────
  // SQLite TRUNCATES toward zero; PostgreSQL CAST ROUNDS. This one does not
  // error — it silently shifts every months-until-expiry bucket by one.
  {
    const mask = codeMask(out);
    const re = /(^|[^.\w])CAST\s*\(/gi;
    const edits = [];
    let m;
    while ((m = re.exec(out))) {
      if (!mask[m.index + m[1].length]) continue;
      const open = m.index + m[0].length - 1;
      const end = matchParen(out, open, mask);
      if (end === -1) continue;
      const body = out.slice(open + 1, end - 1);
      const asAt = /\s+AS\s+(INTEGER|INT)\s*$/i.exec(codeOnly(body));
      if (!asAt) continue;
      const expr = body.slice(0, asAt.index);
      // ::numeric FIRST. SQLite casts text to an integer happily, and the app
      // relies on it; PostgreSQL has no trunc(text):
      //     ERROR: function trunc(text) does not exist
      // Going through numeric works for text, numeric and double precision
      // alike, and truncates toward zero as SQLite does — a plain cast would
      // ROUND, turning -2.9 into -3 instead of -2.
      edits.push({ from: m.index + m[1].length, to: end, text: `trunc((${expr})::numeric)::bigint` });
    }
    if (edits.length) {
      for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
      note('CAST AS INTEGER');
    }
  }

  // ── `? IS NULL` -> `?::text IS NULL` ─────────────────────
  //
  // PostgreSQL infers a parameter's type from how it is used. A placeholder
  // used ONLY as the operand of IS NULL gives it nothing to work with:
  //     ERROR: could not determine data type of parameter $3
  // SQLite's parameters are untyped, so the app's optional-filter idiom
  //     AND (? IS NULL OR s.date >= ?)
  // was fine there and fails here.
  //
  // The cast is deliberately narrow — only a BARE placeholder immediately
  // before IS [NOT] NULL. Nothing else needs it: `COALESCE(?, '9999-12-31')`
  // already infers text from its sibling argument, and casting a placeholder
  // that is compared against a number would break it.
  //
  // Each `?` becomes its own `$n` in the placeholder pass, so a parameter is
  // never shared between an IS NULL test and a typed comparison.
  {
    const mask = codeMask(out);
    const re = /\?(\s*IS\s+(?:NOT\s+)?NULL)/gi;
    const edits = [];
    let m;
    while ((m = re.exec(out))) {
      if (!mask[m.index]) continue;
      edits.push({ from: m.index, to: m.index + m[0].length, text: `?::text${m[1]}` });
    }
    if (edits.length) {
      for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
      note('? IS NULL cast');
    }
  }

  // ── GROUP_CONCAT(x, sep) -> STRING_AGG(x::text, sep) ─────
  // STRING_AGG is strict about its first argument's type where GROUP_CONCAT
  // was not, so the cast is required rather than cosmetic.
  {
    const before = out;
    out = rewriteCalls(out, 'GROUP_CONCAT',
      (args) => args.length === 1 || args.length === 2,
      (args) => args.length === 2
        ? `STRING_AGG((${args[0].trim()})::text,${args[1]})`
        : `STRING_AGG((${args[0].trim()})::text, ',')`);
    if (out !== before) note('GROUP_CONCAT->STRING_AGG');
  }

  // ── INSERT OR IGNORE -> INSERT .. ON CONFLICT DO NOTHING ──
  {
    const mask = codeOnly(out);
    const m = /INSERT\s+OR\s+IGNORE\s+INTO/i.exec(mask);
    if (m) {
      out = out.slice(0, m.index) + 'INSERT INTO' + out.slice(m.index + m[0].length);
      if (!/ON\s+CONFLICT/i.test(codeOnly(out))) {
        out = out.replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
      }
      note('INSERT OR IGNORE');
    }
  }

  // ── refuse anything else SQLite-only ─────────────────────
  // Reported, never passed through. See the design rule at the top.
  const mask = codeOnly(out);
  for (const [re, what] of [
    [/\bstrftime\s*\(/i, 'strftime()'],
    [/\blast_insert_rowid\s*\(/i, 'last_insert_rowid() — take the id from the run() result'],
    [/\bINSERT\s+OR\s+REPLACE\b/i, 'INSERT OR REPLACE'],
    [/\bPRAGMA\b/i, 'PRAGMA'],
    [/\bsqlite_master\b/i, 'sqlite_master'],
    [/\bIFNULL\s*\(/i, 'IFNULL() — use COALESCE'],
    [/\bAUTOINCREMENT\b/i, 'AUTOINCREMENT'],
  ]) {
    if (re.test(mask)) unhandled.push(what);
  }

  return { text: out, applied, unhandled };
}

/**
 * Translate, or throw. The server uses this: an untranslated SQLite construct
 * must stop the statement, not reach PostgreSQL and fail somewhere confusing.
 */
export function translateStrict(sql) {
  const r = translate(sql);
  if (r.unhandled.length) {
    throw new Error(
      `SQL uses constructs with no PostgreSQL translation: ${r.unhandled.join('; ')}\n` +
      `  ${sql.trim().slice(0, 200)}`
    );
  }
  return r.text;
}
