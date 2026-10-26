// Test-only historical fixtures. D14 deliberately excludes these conversions
// from production migrations. Nothing in server/ or db/ imports this module.
// Keeping the frozen algorithms here lets the inherited settlement assertions
// continue to run on PostgreSQL without inventing a production importer.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const reference = readFileSync(new URL('../../../Talha Farm/electron/database.js', import.meta.url), 'utf8');
const referenceAst = ts.createSourceFile('database.js', reference, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

async function writeFixture(db, sql, params = []) {
  const result = await db.run(sql, params);
  if (!result.success) throw new Error(result.error);
  return result;
}

export function loadReferenceBackfill(name) {
  const declaration = referenceAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!declaration) throw new Error(`Missing frozen reference function ${name}`);
  let source = declaration.getText(referenceAst);
  if (name === 'backfillAssetSaleSettlements') {
    // The three verifier-only ROUND operands must be numeric on PostgreSQL.
    // Production money stays double precision. The original rounding precision
    // and historical fixture expectations remain unchanged.
    let opens = 0, closes = 0;
    source = source.replace(/ROUND\(COALESCE\(a\.total_price, a\.purchase_amount, 0\)/g,
      () => { opens++; return 'ROUND((COALESCE(a.total_price, a.purchase_amount, 0)'; });
    source = source.replace(/WHERE p\.asset_id = a\.asset_id\), 0\), 2\)/g,
      () => { closes++; return 'WHERE p.asset_id = a.asset_id), 0))::numeric, 2)'; });
    if (opens !== 3 || closes !== 3) throw new Error('Historical ROUND shape changed; review fixture adapter');
  }
  let ast = ts.createSourceFile('backfill.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let edits = [];
  function adapters(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'selectRows') {
      edits.push({ start: node.initializer.getStart(ast), end: node.initializer.end,
        text: `async (sql, params = []) => {
          const result = await db.get(sql, params)
          if (!result.success) throw new Error(result.error)
          return result.data
        }` });
      return;
    }
    ts.forEachChild(node, adapters);
  }
  adapters(ast);
  for (const e of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,e.start)+e.text+source.slice(e.end);
  ast = ts.createSourceFile('backfill.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  edits = [{ start: 0, end: 0, text: 'async ' }];
  const functions = new Set();
  const helpers = new Set(['selectRows', 'findOwnFarmCustomer', 'findOrCreateOwnFarmCustomer']);
  function calls(node) {
    if (ts.isCallExpression(node)) {
      const write = ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast) === 'db.run';
      const read = ts.isIdentifier(node.expression) && helpers.has(node.expression.text);
      if (write) {
        edits.push({ start: node.expression.getStart(ast), end: node.expression.end, text: 'writeFixture' });
        const open = source.indexOf('(', node.expression.end);
        edits.push({ start: open+1, end: open+1, text: 'db, ' });
      }
      if (write || read) {
        const standalone = ts.isExpressionStatement(node.parent);
        edits.push({ start: node.getStart(ast), end: node.getStart(ast), text: standalone ? 'await ' : '(await ' });
        if (!standalone) edits.push({ start: node.end, end: node.end, text: ')' });
        let parent = node.parent;
        while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
        if (parent && !ts.isFunctionDeclaration(parent) && !parent.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) functions.add(parent);
      }
    }
    ts.forEachChild(node, calls);
  }
  calls(ast);
  for (const fn of functions) edits.push({ start: fn.getStart(ast), end: fn.getStart(ast), text: 'async ' });
  for (const e of edits.sort((a,b) => b.start-a.start || b.end-a.end)) source = source.slice(0,e.start)+e.text+source.slice(e.end);
  return new Function('writeFixture', `return (${source})`)(writeFixture);
}

export const backfillAssetInstallments = loadReferenceBackfill('backfillAssetInstallments');
export const backfillAssetSaleSettlements = loadReferenceBackfill('backfillAssetSaleSettlements');
