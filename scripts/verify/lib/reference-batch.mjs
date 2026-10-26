// Frozen, unused Electron twin retained only as a regression fixture. No runtime
// import. Its SQL/conditional logic stays intact; IO uses PostgreSQL RETURNING.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('typescript');
const source=readFileSync(new URL('../../../Talha Farm/electron/database.js',import.meta.url),'utf8');
const ast=ts.createSourceFile('database.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const fn=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
export function makeReferenceBatch({run,rows,toLocalDateString}) {
 let log=fn('addBatchTransaction');
 const sql=log.match(/db\.prepare\(`([\s\S]*?)`\)/)[1];
 const args=log.match(/stmt\.run\((\[[^\n]*\])\)/)[1];
 log=log.replace(/const stmt = db\.prepare\([\s\S]*?stmt\.free\(\)/,
  ()=>`const result = await run(${JSON.stringify(sql)}, ${args}); if (!result.success) return result`)
  .replace('function addBatchTransaction','async function addBatchTransaction');
 const addBatchTransaction=new Function('run',`return (${log})`)(run);
 let batch=fn('addBatch');
 batch=batch.replace(/const stmt = db\.prepare\(`SELECT COUNT\(\*\) as count FROM product_batches WHERE product_id = \?`\)[\s\S]*?stmt\.free\(\)/,
  "const result = (await rows('SELECT COUNT(*) as count FROM product_batches WHERE product_id = ?', [product_id]))[0]");
 const insert=batch.match(/const stmt = db\.prepare\(`([\s\S]*?)`\)/)[1];
 const values=batch.match(/stmt\.run\((\[[^\n]*\])\)/)[1];
 batch=batch.replace(/const stmt = db\.prepare\([\s\S]*?stmt\.free\(\)/,
  ()=>`const inserted = await run(${JSON.stringify(insert)}, ${values}); if (!inserted.success) return inserted`)
  .replace("getLastInsertId('product_batches', 'batch_id')",'inserted.lastId')
  .replace('const logged = addBatchTransaction(','const logged = await addBatchTransaction(')
  .replace('function addBatch(','async function addBatch(');
 return new Function('run','rows','addBatchTransaction','toLocalDateString',`return (${batch})`)(run,rows,addBatchTransaction,toLocalDateString);
}
