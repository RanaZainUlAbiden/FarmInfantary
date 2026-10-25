/**
 * Splits SQL into CODE and LITERAL regions.
 *
 * Everything that rewrites SQL — the `?` to `$n` placeholder pass, the dialect
 * translation — must only touch code. A `?` inside `'Paid in full?'` is data,
 * and turning it into `$3` corrupts the user's text. A `MAX(` inside a string
 * literal or a comment is not a function call.
 *
 * This is the one place that knows SQL lexical structure, so it is the one
 * place that can get it wrong. Everything downstream is a fold over its output.
 *
 * Handles, because PostgreSQL and the app's SQL both use them:
 *   'text'            with '' as an embedded quote
 *   "identifier"      with "" as an embedded quote
 *   -- line comment
 *   /* block comment *\/   (not nested — PostgreSQL nests, but the app has none
 *                           and treating them as flat is the safe direction:
 *                           it ends the region early rather than late)
 *   $tag$ dollar $tag$
 *   E'escaped\\'      backslash escapes inside E'' strings
 */

/** @typedef {{ code: boolean, text: string, start: number }} Segment */

/**
 * @param {string} sql
 * @returns {Segment[]} alternating-ish regions covering the whole input
 */
export function scan(sql) {
  /** @type {Segment[]} */
  const out = [];
  let i = 0;
  let codeStart = 0;

  const pushCode = (end) => {
    if (end > codeStart) out.push({ code: true, text: sql.slice(codeStart, end), start: codeStart });
  };
  const pushLiteral = (start, end) => {
    out.push({ code: false, text: sql.slice(start, end), start });
  };

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (c === '-' && next === '-') {
      pushCode(i);
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      pushLiteral(i, j);
      i = codeStart = j;
      continue;
    }

    // /* block comment */
    if (c === '/' && next === '*') {
      pushCode(i);
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? sql.length : j + 2;
      pushLiteral(i, j);
      i = codeStart = j;
      continue;
    }

    // E'...' — backslash escapes are active
    if ((c === 'E' || c === 'e') && next === "'") {
      pushCode(i);
      let j = i + 2;
      while (j < sql.length) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      pushLiteral(i, j);
      i = codeStart = j;
      continue;
    }

    // 'string' — '' is an embedded quote, not a terminator
    if (c === "'") {
      pushCode(i);
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      pushLiteral(i, j);
      i = codeStart = j;
      continue;
    }

    // "identifier" — quoted names are not code we may rewrite
    if (c === '"') {
      pushCode(i);
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      pushLiteral(i, j);
      i = codeStart = j;
      continue;
    }

    // $tag$ ... $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        pushCode(i);
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const end = j === -1 ? sql.length : j + tag.length;
        pushLiteral(i, end);
        i = codeStart = end;
        continue;
      }
    }

    i++;
  }

  pushCode(sql.length);
  return out;
}

/**
 * Rewrites only the code regions, leaving literals and comments byte-identical.
 *
 * @param {string} sql
 * @param {(code: string, segmentIndex: number) => string} fn
 * @returns {string}
 */
export function mapCode(sql, fn) {
  let n = 0;
  return scan(sql)
    .map((s) => (s.code ? fn(s.text, n++) : s.text))
    .join('');
}

/** The SQL with every literal and comment blanked, for safe pattern matching. */
export function codeOnly(sql) {
  return scan(sql)
    .map((s) => (s.code ? s.text : s.text.replace(/[^\n]/g, ' ')))
    .join('');
}

/**
 * A byte-per-character map: 1 where the character is CODE, 0 where it is inside
 * a string literal, quoted identifier, or comment.
 *
 * Use this rather than `codeOnly()` whenever a pattern needs to SEE literal
 * content while still only matching in code. `date('now')` is the motivating
 * case: the call is code but `'now'` is a literal, so a pattern matched against
 * a literal-blanked mask can never find it. Matching the real SQL and testing
 * the match's START position gets both halves right.
 */
export function codeMask(sql) {
  const mask = new Uint8Array(sql.length);
  for (const s of scan(sql)) {
    if (!s.code) continue;
    for (let i = s.start; i < s.start + s.text.length; i++) mask[i] = 1;
  }
  return mask;
}

/**
 * Split a parenthesised body on top-level commas, ignoring commas inside
 * nested parens AND inside string literals.
 *
 * The literal part is not hypothetical: `GROUP_CONCAT(name, ', ')` contains a
 * comma inside its separator argument, and counting it makes a two-argument
 * call look like three.
 */
export function splitTopLevelArgs(body) {
  const mask = codeMask(body);
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (!mask[i]) continue;
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      args.push(body.slice(start, i));
      start = i + 1;
    }
  }
  args.push(body.slice(start));
  return args;
}

/**
 * Split a string into individual statements on top-level semicolons.
 *
 * The app sends multi-statement SQL in at least one place —
 * `updateBatchStatuses()` issues three UPDATEs in a single `run()` — which
 * SQLite executed happily. PostgreSQL only allows that through the simple
 * query protocol, i.e. with NO parameters, so a parameterised multi-statement
 * string fails with a confusing message about the first statement.
 *
 * Splitting here lets each statement be translated, parameterised and
 * executed on its own, which also means the Phase 3 guard can inspect each one
 * — it will reject multi-statement input outright, as any such guard must.
 *
 * Semicolons inside string literals and comments are not separators, which is
 * the whole reason this uses the scanner rather than `sql.split(';')`.
 */
export function splitStatements(sql) {
  const mask = codeMask(sql);
  const out = [];
  // A piece that is only whitespace and comments is not a statement — a
  // trailing `-- note` after the last semicolon would otherwise be executed
  // and fail.
  const hasCode = (piece) => codeOnly(piece).trim() !== '';
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    if (mask[i] && sql[i] === ';') {
      const piece = sql.slice(start, i);
      if (hasCode(piece)) out.push(piece);
      start = i + 1;
    }
  }
  const tail = sql.slice(start);
  if (hasCode(tail)) out.push(tail);
  return out;
}

/** How many `?` placeholders a statement carries, literals excluded. */
export function countPlaceholders(sql) {
  const mask = codeMask(sql);
  let n = 0;
  for (let i = 0; i < sql.length; i++) if (mask[i] && sql[i] === '?') n++;
  return n;
}
