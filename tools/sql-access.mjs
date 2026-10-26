import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {translate} from '../server/src/db/dialect.js';
import {prepare} from '../server/src/db/placeholders.js';
import {TENANT_TABLES} from '../db/tenant-tables.mjs';
const {parse}=createRequire(new URL('../server/package.json',import.meta.url))('pgsql-parser');
const allowed=new Set(TENANT_TABLES),sorted=values=>[...values].sort();
export async function sqlAccess(sql,params=[]) {
 const translated=translate(sql);if(translated.unhandled.length)throw new Error('Untranslated SQL');
 const ast=await parse(prepare(translated.text,params).text);
 if(ast.stmts?.length!==1)throw new Error('Expected one statement');
 const reads=new Set(),writes=new Map();let visited=0;
 const add=(relation,scope,verb=null)=>{
  const name=relation?.relname;
  if(scope.has(name)&&!verb)return;
  if(relation?.schemaname||!allowed.has(name))throw new Error('Unclassified relation');
  if(verb){if(!writes.has(name))writes.set(name,new Set());writes.get(name).add(verb);}
  if(verb!=='insert')reads.add(name);
 };
 function walk(value,scope=new Set()) {
  if(value==null||typeof value!=='object')return;
  if(++visited>25_000)throw new Error('Trace AST limit');
  if(Array.isArray(value)){value.forEach(n=>walk(n,scope));return;}
  const kind=['SelectStmt','InsertStmt','UpdateStmt','DeleteStmt'].find(k=>value[k]);
  if(kind) {
   const node=value[kind],local=new Set(scope),withClause=node.withClause;
   if(withClause?.recursive)throw new Error('Recursive trace requires review');
   for(const entry of withClause?.ctes||[]) {
    const cte=entry.CommonTableExpr;walk(cte.ctequery,local);local.add(cte.ctename);
   }
   if(kind!=='SelectStmt') {
    const verb={InsertStmt:'insert',UpdateStmt:'update',DeleteStmt:'delete'}[kind];
    add(node.relation,local,verb);
    if(node.onConflictClause?.action==='ONCONFLICT_UPDATE')add(node.relation,local,'update');
   }
   for(const [key,child] of Object.entries(node))if(key!=='withClause'&&!(key==='relation'&&kind!=='SelectStmt'))walk(child,local);
   return;
  }
  if(value.RangeVar){add(value.RangeVar,scope);return;}
  if(value.RangeFunction)throw new Error('Table functions require review');
  Object.values(value).forEach(child=>walk(child,scope));
 }
 if(!['SelectStmt','InsertStmt','UpdateStmt','DeleteStmt'].some(k=>ast.stmts[0].stmt[k]))throw new Error('Unsupported trace command');
 walk(ast.stmts[0].stmt);
 return {readTables:sorted(reads),writeTables:Object.fromEntries([...writes].sort(([a],[b])=>a.localeCompare(b)).map(([table,verbs])=>[table,sorted(verbs)]))};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const {sql,parameterCount}=JSON.parse(readFileSync(0,'utf8'));
  if(!Number.isSafeInteger(parameterCount)||parameterCount<0||parameterCount>2000||typeof sql!=='string'||sql.length>262144)throw new Error('Invalid trace');
  console.log(JSON.stringify(await sqlAccess(sql,Array(parameterCount).fill(null))));
 } catch {process.stderr.write('SQL access analysis failed');process.exitCode=1;}
}
