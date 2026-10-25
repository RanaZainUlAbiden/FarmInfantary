import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scan, codeOnly } from '../src/db/scan.js';
import { toNumberedPlaceholders, prepare } from '../src/db/placeholders.js';
import { translate, translateStrict } from '../src/db/dialect.js';

// ── scanner ────────────────────────────────────────────────

test('scan: separates string literals from code', () => {
  const segs = scan(`SELECT 'a?b' , x FROM t`);
  assert.deepEqual(
    segs.map((s) => [s.code, s.text]),
    [[true, "SELECT "], [false, "'a?b'"], [true, " , x FROM t"]]
  );
});

test("scan: '' inside a literal does not terminate it", () => {
  assert.equal(codeOnly(`SELECT 'it''s ?' , 1`).includes('?'), false);
});

test('scan: line and block comments are not code', () => {
  assert.equal(codeOnly(`SELECT 1 -- ? here\n, 2`).includes('?'), false);
  assert.equal(codeOnly(`SELECT /* MAX(a,b) */ 1`).includes('MAX'), false);
});

test('scan: quoted identifiers are not rewritten', () => {
  assert.equal(codeOnly(`SELECT "max?" FROM t`).includes('?'), false);
});

// ── placeholders ───────────────────────────────────────────

test('placeholders: numbers left to right', () => {
  const { text, count } = toNumberedPlaceholders(
    `SELECT * FROM t WHERE a = ? AND b = ? AND c = ?`
  );
  assert.equal(text, `SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3`);
  assert.equal(count, 3);
});

test('placeholders: a ? inside a string literal is DATA, not a placeholder', () => {
  // The user typing "Paid in full?" must survive. Renumbering it corrupts
  // their text and shifts every later parameter by one.
  const { text, count } = toNumberedPlaceholders(
    `INSERT INTO expenses (description, amount) VALUES ('Paid in full?', ?)`
  );
  assert.equal(text, `INSERT INTO expenses (description, amount) VALUES ('Paid in full?', $1)`);
  assert.equal(count, 1);
});

test('placeholders: a ? in a comment is not a placeholder', () => {
  const { count } = toNumberedPlaceholders(`SELECT 1 -- why?\nWHERE a = ?`);
  assert.equal(count, 1);
});

test('placeholders: textual order is preserved for correlated subqueries', () => {
  // The inner ? appears BEFORE the outer one textually, and the params array
  // is built in that order. Binding them the other way round returns wrong
  // money without failing.
  const { text } = toNumberedPlaceholders(
    `SELECT (SELECT SUM(x) FROM b WHERE b.id = ?) AS v FROM a WHERE a.farm_id = ?`
  );
  assert.match(text, /b\.id = \$1/);
  assert.match(text, /a\.farm_id = \$2/);
});

test('prepare: param count mismatch fails fast and says so', () => {
  assert.throws(
    () => prepare(`SELECT * FROM t WHERE a = ? AND b = ?`, [1]),
    /expects 2 parameters but 1 was supplied/
  );
});

// ── dialect: two-argument MAX / MIN ────────────────────────

test('MAX(a, b) becomes GREATEST — PostgreSQL MAX is aggregate-only', () => {
  const { text } = translate(`SELECT MAX(total_amount - amount_paid, 0) FROM bills`);
  // Original spacing is preserved deliberately: the translator edits the call
  // name and nothing else, so a statement stays readable in error messages.
  assert.equal(text, `SELECT GREATEST(total_amount - amount_paid, 0) FROM bills`);
});

test('MAX(x) with ONE argument is the aggregate and must NOT change', () => {
  const { text } = translate(`SELECT MAX(amount) FROM bills`);
  assert.equal(text, `SELECT MAX(amount) FROM bills`);
});

test('nested MIN(MAX(..)) clamps translate all the way down', () => {
  // The real shape from overview.service.ts.
  const { text } = translate(
    `SELECT MIN(MAX(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))`
  );
  assert.equal(
    text,
    `SELECT LEAST(GREATEST(COALESCE(bl.amount_paid, 0), 0), COALESCE(bl.total_amount, 0))`
  );
});

test('the real debt definition translates', () => {
  const { text } = translate(
    `SELECT COALESCE(SUM(MAX(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)),0) FROM bills`
  );
  assert.match(text, /GREATEST\(COALESCE\(total_amount,0\) - COALESCE\(amount_paid,0\), 0\)/);
  assert.equal(/\bMAX\(/.test(text), false);
});

test('MAX inside a string literal is left alone', () => {
  const { text } = translate(`SELECT 'MAX(a, b)' AS note`);
  assert.equal(text, `SELECT 'MAX(a, b)' AS note`);
});

test('Math.max-style dotted names are not SQL and are not touched', () => {
  const { text } = translate(`SELECT a.MAX(x, y)`);
  assert.equal(text, `SELECT a.MAX(x, y)`);
});

// ── dialect: dates ─────────────────────────────────────────

test("julianday(x) - julianday('now') becomes a day difference", () => {
  const { text } = translate(
    `SELECT julianday(b.expiry_date) - julianday('now') AS days FROM product_batches b`
  );
  assert.equal(text, `SELECT ((b.expiry_date)::date - CURRENT_DATE) AS days FROM product_batches b`);
});

test("date('now') becomes a TEXT date, not a date", () => {
  // Dates are stored as TEXT (D5). Translating to bare CURRENT_DATE produces
  // `text >= date`, which PostgreSQL has no operator for — found by running
  // the real distribution-report query, not by unit tests.
  const { text } = translate(`SELECT * FROM t WHERE expiry_date >= date('now')`);
  assert.equal(text, `SELECT * FROM t WHERE expiry_date >= to_char(CURRENT_DATE, 'YYYY-MM-DD')`);
});

test('an unrecognised julianday form is reported, never guessed at', () => {
  // BOTH calls are reported, not just the first: each is independently
  // untranslatable and a reader fixing one needs to know about the other.
  const r = translate(`SELECT julianday(a) - julianday(b) FROM t`);
  assert.equal(r.unhandled.length, 2);
  assert.match(r.unhandled[0], /julianday\(a\)/);
  assert.match(r.unhandled[1], /julianday\(b\)/);
});

// ── dialect: CAST ──────────────────────────────────────────

test('CAST(x AS INTEGER) truncates, because SQLite truncates and PG rounds', () => {
  const { text } = translate(`SELECT CAST(months / 30.44 AS INTEGER) FROM t`);
  assert.equal(text, `SELECT trunc((months / 30.44)::numeric)::bigint FROM t`);
});

test('CAST(text AS INTEGER) works — PostgreSQL has no trunc(text)', () => {
  // Found by the Phase 1 gate: addLoan casts a text column, and trunc(text)
  // does not exist. Going through numeric covers text, numeric and double.
  const { text } = translate(`SELECT CAST(reference_id AS INTEGER) FROM bank_ledger`);
  assert.equal(text, `SELECT trunc((reference_id)::numeric)::bigint FROM bank_ledger`);
});

test('CAST to a non-integer type is left alone', () => {
  const { text } = translate(`SELECT CAST(x AS TEXT) FROM t`);
  assert.equal(text, `SELECT CAST(x AS TEXT) FROM t`);
});

// ── dialect: misc ──────────────────────────────────────────

test('GROUP_CONCAT becomes STRING_AGG with a text cast', () => {
  const { text } = translate(`SELECT GROUP_CONCAT(f.flock_name, ', ') FROM flocks f`);
  assert.equal(text, `SELECT STRING_AGG((f.flock_name)::text, ', ') FROM flocks f`);
});

test('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING', () => {
  const { text } = translate(
    `INSERT OR IGNORE INTO categories (farm_id, category_name) VALUES (?, ?)`
  );
  assert.equal(
    text,
    `INSERT INTO categories (farm_id, category_name) VALUES (?, ?) ON CONFLICT DO NOTHING`
  );
});

test('ON CONFLICT .. DO UPDATE passes through unchanged', () => {
  const sql = `INSERT INTO app_settings (farm_id, key, value) VALUES (?,?,?) ` +
    `ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`;
  assert.equal(translate(sql).text, sql);
});

// ── the design rule: refuse rather than guess ──────────────

test('untranslatable SQLite constructs are refused, not passed through', () => {
  for (const sql of [
    `SELECT strftime('%Y', d) FROM t`,
    `SELECT last_insert_rowid()`,
    `INSERT OR REPLACE INTO t VALUES (1)`,
    `SELECT IFNULL(a, 0) FROM t`,
    `SELECT name FROM sqlite_master`,
  ]) {
    assert.throws(() => translateStrict(sql), /no PostgreSQL translation/, sql);
  }
});

test('a clean statement passes translateStrict unchanged', () => {
  const sql = `SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE flock_id = ?`;
  assert.equal(translateStrict(sql), sql);
});

test('translation is idempotent — translating twice changes nothing', () => {
  const sql = `SELECT MIN(MAX(a, 0), b), CAST(x AS INTEGER), date('now') FROM t`;
  const once = translate(sql).text;
  assert.equal(translate(once).text, once);
});
