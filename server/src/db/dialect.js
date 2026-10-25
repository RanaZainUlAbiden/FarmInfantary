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

  let out = sql;
  for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
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

  // ── date('now') -> to_char(CURRENT_DATE,'YYYY-MM-DD') ───
  // NOT bare CURRENT_DATE. Dates are stored as TEXT (D5), and PostgreSQL has
  // no `text >= date` operator where SQLite compared them happily as strings:
  //   ERROR: operator does not exist: text >= date
  // to_char is used rather than ::text because ::text depends on the server's
  // DateStyle, and the stored format is always 'YYYY-MM-DD'.
  {
    const mask = codeMask(out);
    const re = /(^|[^.\w])date\s*\(\s*'now'\s*\)/gi;
    const edits = [];
    let m;
    while ((m = re.exec(out))) {
      if (!mask[m.index + m[1].length]) continue;
      edits.push({
        from: m.index + m[1].length,
        to: m.index + m[0].length,
        text: `to_char(CURRENT_DATE, 'YYYY-MM-DD')`,
      });
    }
    if (edits.length) {
      for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
      note("date('now')");
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
      edits.push({ from: m.index + m[1].length, to: end, text: `trunc(${expr})::bigint` });
    }
    if (edits.length) {
      for (const e of edits.reverse()) out = out.slice(0, e.from) + e.text + out.slice(e.to);
      note('CAST AS INTEGER');
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
