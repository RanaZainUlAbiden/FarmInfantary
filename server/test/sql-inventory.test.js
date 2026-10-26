import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSqlLiterals } from '../../scripts/verify/lib/sql-literals.mjs';

test('SQL inventory reads single, double and template quotes with cooked escapes', () => {
  const src = `db.run('DELETE FROM products WHERE product_id = ?', [id]);
    db.get("SELECT * FROM products WHERE category = 'feed'");
    db.run(\`UPDATE product_batches SET status = 'depleted' WHERE batch_id = ?\`);
    db.get('SELECT * FROM products WHERE product_name = \\'Test\\'');`;
  assert.deepEqual(collectSqlLiterals(src), {
    statements: ['DELETE FROM products WHERE product_id = ?',
      "SELECT * FROM products WHERE category = 'feed'",
      "UPDATE product_batches SET status = 'depleted' WHERE batch_id = ?",
      "SELECT * FROM products WHERE product_name = 'Test'"],
    interpolated: 0, fragments: 0,
  });
});

test('SQL inventory counts interpolated and concatenated statements as unchecked', () => {
  const src = 'db.get(`SELECT * FROM ${table}`);\n'
    + 'const q = (`SELECT unit_id, SUM(amount) FROM expenses`) + clause + ` GROUP BY unit_id`;\n'
    + 'const q2 = "SELECT * FROM products" + where;';
  assert.deepEqual(collectSqlLiterals(src), { statements: [], interpolated: 1, fragments: 2 });
});

test('SQL inventory ignores comments, ordinary strings and SQL-like mode flags', () => {
  const src = '// db.run("DELETE FROM products");\n/* `SELECT * FROM products` */\n'
    + 'const mode = "update"; const key = "insert"; const prose = "Click delete to remove";';
  assert.deepEqual(collectSqlLiterals(src), { statements: [], interpolated: 0, fragments: 0 });
});
