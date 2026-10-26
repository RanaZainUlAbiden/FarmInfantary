// SQL inventory only. This is not the security guard or a SQL parser.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

/** Read all JavaScript/TypeScript quote styles and report dynamic SQL gaps. */
export function collectSqlLiterals(source) {
  const ast = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = [];
  let interpolated = 0;
  let fragments = 0;
  function visit(node) {
    const dynamic = ts.isTemplateExpression(node);
    if (ts.isStringLiteralLike(node) || dynamic) {
      const text = dynamic ? source.slice(node.getStart(ast) + 1, node.end - 1) : node.text;
      const kind = /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(text)?.[1]?.toUpperCase();
      const needs = {
        SELECT: /\bFROM\b/i, INSERT: /\bINTO\b[\s\S]*\b(VALUES|SELECT)\b/i,
        UPDATE: /\bSET\b/i, DELETE: /\bFROM\b/i,
      }[kind];
      if (needs?.test(text)) {
        let parent = node.parent;
        while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
        if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) fragments++;
        else if (dynamic) interpolated++;
        else statements.push(text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { statements, interpolated, fragments };
}
