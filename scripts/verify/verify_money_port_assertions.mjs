// A PostgreSQL port must not earn green by weakening its original assertions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);
const assertionNames = new Set(['check', 'checkTrue', 'checkStr', 'checkText', 'checkShape', 'checkNull', 'assert']);

// Parentheses, await and async are the necessary storage-API adaptations.
// Every other token, operator, literal, call and argument must stay identical.
function canonical(node, source) {
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) return canonical(node.expression, source);
  if (node.kind === ts.SyntaxKind.AsyncKeyword) return null;
  // Awaited filtering must use the original Boolean predicate, not treat the
  // Promise returned by an async native .filter callback as truthy.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['filterAsync', 'everyAsync'].includes(node.expression.text)) {
    assert.equal(node.arguments.length, 2);
    return [ts.SyntaxKind.CallExpression, [
      [ts.SyntaxKind.PropertyAccessExpression, [canonical(node.arguments[0], source), [ts.SyntaxKind.Identifier, node.expression.text === 'filterAsync' ? 'filter' : 'every']]],
      canonical(node.arguments[1], source),
    ]];
  }
  const children = [];
  ts.forEachChild(node, (child) => { const value = canonical(child, source); if (value) children.push(value); });
  return children.length ? [node.kind, children] : [node.kind, node.getText(source)];
}
function assertions(source) {
  // JavaScript normalizes CRLF inside template literals to LF at runtime.
  source = source.replace(/\r\n/g, '\n');
  const ast = ts.createSourceFile('checks.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['filter', 'some', 'every'].includes(node.expression.name.text)) {
      assert.ok(!node.arguments.some((arg) => arg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)),
        'Native filter/some/every cannot test asynchronous predicates; await their Boolean results explicitly');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && assertionNames.has(node.expression.text)) {
      calls.push(canonical(node, ast));
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return calls;
}

const ports = ['vouchers', 'internal_settlements', 'cash_and_bank_totals', 'no_negative_bank',
  'bank_withdrawals', 'auto_settlement_on_sale', 'layer_sales_customers', 'overview',
  'distribution_outstanding_cards', 'supplier_tracking', 'supplier_accounts_screen', 'bill_bank_account',
  'assets', 'product_delete', 'layer_ledger', 'report_fcr_card', 'asset_settlement',
  'opening_balance', 'ledger_payment_reversal', 'debt_records', 'bank_screen_sql',
  'egg_collection_cartons', 'expense_ledger_separation', 'own_farm_customers', 'product_opening_stock'];
for (const name of ports) {
  let original = readFileSync(new URL(`Talha Farm/scripts/verify/verify_${name}.js`, root), 'utf8');
  if (name === 'layer_sales_customers') {
    // This storage-specific assertion now reruns the real PostgreSQL migration
    // runner instead of the obsolete desktop ALTER loop. Only its label changes;
    // the before/after metadata equality and every expected value are preserved.
    const oldLabel = 're-running every ALTER changes nothing (they run on EVERY launch)';
    assert.equal(original.split(oldLabel).length - 1, 1);
    original = original.replace(oldLabel, 're-running PostgreSQL migrations changes nothing');
  }
  if (['supplier_tracking', 'supplier_accounts_screen', 'report_fcr_card'].includes(name)) {
    // Metadata fields keep the same names and ordering; only the engine's
    // introspection SQL changes. No expected balance, condition or tolerance moves.
    original = original.replace(/SELECT name FROM pragma_table_info\('([^']*)'\)/g,
      (_match, table) => `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' ORDER BY ordinal_position`);
  }
  if (name === 'overview') {
    // PostgreSQL requires the fixture's single-asset aggregate to group by its
    // primary key. It still compares the same overpayment against 30,000.
    const clause = 'WHERE a.asset_id = 5`';
    assert.equal(original.split(clause).length - 1, 1);
    original = original.replace(clause, 'WHERE a.asset_id = 5 GROUP BY a.asset_id`');
  }
  if (name === 'debt_records') {
    original = original.replace('PRAGMA table_info(debt_records)',
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'debt_records' ORDER BY ordinal_position");
  }
  if (name === 'egg_collection_cartons') {
    original = original.replace('re-running the ALTERs raises nothing but duplicate-column','re-running PostgreSQL migrations raises no errors')
      .replace('re-running the ALTERs leaves the schema identical','re-running PostgreSQL migrations leaves the schema identical');
  }
  if (name === 'product_opening_stock') {
    // SQLite exports and session-local row IDs do not exist in the web query
    // layer. Preserve the contract with RETURNING, explicit refusal, and actual
    // successful commit counts in place of file export counts. Business values,
    // failure/mutation cases and rollback expectations stay identical.
    original = original.replace("check('a separate SELECT last_insert_rowid() hands back 0', roundTrip.data[0].id, 0)",
      "check('a separate SELECT last_insert_rowid() is refused', roundTrip.success, false)")
      .replace("checkTrue('...so `if (productId)` was false and the batch block was skipped', !roundTrip.data[0].id)",
      "checkTrue('the refusal tells callers to use the write result', /take the id from the run\\(\\) result/.test(roundTrip.error))")
      .replaceAll('the whole save wrote the file once','the whole save committed once')
      .replaceAll('nothing reached the file','nothing was committed');
  }
  const port = readFileSync(new URL(`scripts/verify/verify_${name}_pg.mjs`, root), 'utf8');
  // Application adapters must preserve error result objects. runSql() throws
  // deliberately for fixture setup, so using it as svc.run masks the contract.
  const ast = ts.createSourceFile('port.mjs', port, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function verifyAdapters(node) {
    if (ts.isVariableDeclaration(node) && ['svc', 'dbShim'].includes(node.name.getText(ast))
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const method of node.initializer.properties) {
        if (!ts.isMethodDeclaration(method)) continue;
        const target = { get: 'get', run: 'run', runBatch: 'batch' }[method.name.getText(ast)];
        if (!target) continue;
        assert.equal(method.body.statements.length, 1, `${name}: adapter must directly return the driver result`);
        const statement = method.body.statements[0];
        assert.ok(ts.isReturnStatement(statement) && statement.expression && ts.isCallExpression(statement.expression));
        assert.equal(statement.expression.expression.getText(ast), `db.${target}`,
          `${name}: service adapter must preserve { success: false, error }`);
      }
    }
    ts.forEachChild(node, verifyAdapters);
  }
  verifyAdapters(ast);
  const expected = assertions(original);
  const actual = assertions(port);
  assert.ok(expected.length > 0, `No assertions found in ${name}`);
  assert.deepEqual(actual, expected, `${name}: original assertion expressions must be preserved`);
  console.log(`  PASS  ${name}: ${expected.length} original assertion expressions preserved`);
}
console.log(`ALL CHECKS PASSED — ${ports.length} business ports retain their original assertions and driver result contracts (documented storage adapters normalized)`);
