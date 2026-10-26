// Review aid only: a call graph is NOT an action authorization policy. In
// particular, an UPDATE reached while creating a sale does not grant Edit.
import {createRequire} from 'node:module';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ROOT,currentCatalogue} from './permission-catalogue.mjs';
import {applicationSourceDigest} from './permission-trace.mjs';
import {collectSqlLiterals} from '../scripts/verify/lib/sql-literals.mjs';
const ts=createRequire(import.meta.url)('typescript');
const primitive=new Set(['get','run','runBatch','beginTransaction','commitTransaction','rollbackTransaction']);
const hash=text=>createHash('sha256').update(text).digest('hex');
export function inspectClass(source,file,className) {
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),imports=new Map();let klass;
 for(const node of ast.statements){
  if(ts.isImportDeclaration(node)&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings))
   for(const item of node.importClause.namedBindings.elements)imports.set(item.name.text,{path:node.moduleSpecifier.text,name:item.propertyName?.text||item.name.text});
  if(ts.isClassDeclaration(node)&&(!className||node.name?.text===className))klass=node;
 }
 if(!klass)return null;
 const dependencies=new Map(),methods=new Map();
 for(const member of klass.members){
  if(ts.isConstructorDeclaration(member))for(const p of member.parameters){const type=p.type?.getText(ast);if(type&&imports.has(type))dependencies.set(p.name.getText(ast),imports.get(type));}
  if(ts.isPropertyDeclaration(member)&&member.initializer&&ts.isCallExpression(member.initializer)&&member.initializer.expression.getText(ast)==='inject'){
   const type=member.initializer.arguments[0]?.getText(ast);if(imports.has(type))dependencies.set(member.name.getText(ast),imports.get(type));
  }
  if(!ts.isMethodDeclaration(member)||!member.body)continue;
  const name=member.name.getText(ast),calls=[],unresolved=[];
  const visit=node=>{
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
    const receiver=node.expression.expression;
    if(receiver.kind===ts.SyntaxKind.ThisKeyword)calls.push({method:node.expression.name.text});
    else if(ts.isPropertyAccessExpression(receiver)&&receiver.expression.kind===ts.SyntaxKind.ThisKeyword)
     calls.push({dependency:receiver.name.text,method:node.expression.name.text});
   }
   // A dynamically indexed call cannot be resolved by this graph.
   if(ts.isCallExpression(node)&&ts.isElementAccessExpression(node.expression))unresolved.push('computed-call');
   ts.forEachChild(node,visit);
  };visit(member.body);
  const sql=collectSqlLiterals(member.body.getText(ast));
  methods.set(name,{name,line:ast.getLineAndCharacterOfPosition(member.getStart(ast)).line+1,calls,unresolved,
   sqlDigests:[...new Set(sql.statements.map(hash))].sort(),dynamicSql:sql.interpolated+sql.fragments});
 }
 return {name:klass.name.text,file,dependencies,methods};
}
export function buildWorkflowInventory(){
 const catalogue=currentCatalogue(),cache=new Map();
 const getClass=(file,name)=>{
  const key=file+'#'+(name||'');if(cache.has(key))return cache.get(key);
  const result=existsSync(file)?inspectClass(readFileSync(file,'utf8'),file,name):null;cache.set(key,result);return result;
 };
 const ref=(klass,method)=>relative(ROOT,klass.file).replaceAll('\\','/')+'#'+klass.name+'.'+method;
 function trace(klass,method,seen=new Set(),result={methods:[],primitives:new Set(),unresolved:new Set(),sql:new Set(),dynamicSql:0}){
  if(!klass||!klass.methods.has(method))return result;
  const id=ref(klass,method);if(seen.has(id))return result;seen.add(id);
  const item=klass.methods.get(method);result.methods.push({id,line:item.line});item.sqlDigests.forEach(x=>result.sql.add(x));result.dynamicSql+=item.dynamicSql;item.unresolved.forEach(x=>result.unresolved.add(id+':'+x));
  if(klass.name==='DatabaseService'&&primitive.has(method)){result.primitives.add(method);return result;}
  for(const call of item.calls){
   if(!call.dependency){if(klass.methods.has(call.method))trace(klass,call.method,seen,result);continue;}
   const dependency=klass.dependencies.get(call.dependency);
   if(!dependency?.path.startsWith('.'))continue;
   const target=getClass(resolve(dirname(klass.file),dependency.path+'.ts'),dependency.name);
   if(target?.methods.has(call.method))trace(target,call.method,seen,result);
   else if(target)result.unresolved.add(id+':'+call.dependency+'.'+call.method);
  }
  return result;
 }
 const screens=catalogue.entries.map(entry=>{
  const file=resolve(ROOT,'src/app',entry.component+'.ts'),klass=getClass(file);
  if(!klass)throw new Error('Missing screen class: '+entry.key);
  const template=file.replace(/\.ts$/,'.html'),roots=new Map();
  if(klass.methods.has('ngOnInit'))roots.set('ngOnInit',new Set(['initialization']));
  if(existsSync(template))for(const binding of readFileSync(template,'utf8').matchAll(/\((click|ngSubmit|confirmed|cancelled|change|ngModelChange)\)\s*=\s*"([^"]*)"/g)){
   const expression=ts.createSourceFile('event.ts',binding[2],ts.ScriptTarget.Latest,true);
   const visit=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&klass.methods.has(node.expression.text)){
    const name=node.expression.text;if(!roots.has(name))roots.set(name,new Set());roots.get(name).add(binding[1]);
   }ts.forEachChild(node,visit);};visit(expression);
  }
  return {key:entry.key,component:relative(ROOT,file).replaceAll('\\','/'),roots:[...roots].sort(([a],[b])=>a.localeCompare(b)).map(([method,events])=>{
   const result=trace(klass,method);return {method,events:[...events].sort(),primitives:[...result.primitives].sort(),
    methods:result.methods.sort((a,b)=>a.id.localeCompare(b.id)),sqlDigests:[...result.sql].sort(),dynamicSql:result.dynamicSql,unresolved:[...result.unresolved].sort(),
    intent:'unreviewed; do not infer View/Create/Edit/Delete from SQL verbs'};
  })};
 });
 const producerDigest=hash(['tools/staff-workflow-inventory.mjs','scripts/verify/lib/sql-literals.mjs','tools/permission-catalogue.mjs']
  .map(file=>file+'\0'+readFileSync(resolve(ROOT,file),'utf8').replaceAll('\r\n','\n')).join('\0'));
 return {schemaVersion:1,status:'source-call-graph only; not execution evidence or authorization policy',producerDigest,
  limitations:['Event handlers and self/constructor-service calls only; free functions, resolver wiring and runtime-selected calls require separate review.',
   'A mutation candidate is not a supported staff action. Classify its business intent, validate inputs, and trace successful/refused execution before authorizing it.'],
  sourceDigest:applicationSourceDigest(),catalogueDigest:catalogue.sourceDigest,screens};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=buildWorkflowInventory(),output=JSON.stringify(result,null,2)+'\n',target=resolve(ROOT,'tools/permission-evidence/workflow-inventory.json');
 if(process.argv.includes('--check')){if(!existsSync(target)||readFileSync(target,'utf8').replaceAll('\r\n','\n')!==output)throw new Error('Staff workflow inventory is stale');}
 else writeFileSync(target,output);
 console.log(JSON.stringify({screens:result.screens.length,roots:result.screens.reduce((n,s)=>n+s.roots.length,0),
  mutationCandidates:result.screens.reduce((n,s)=>n+s.roots.filter(r=>r.primitives.some(p=>['run','runBatch'].includes(p))).length,0),authority:result.status}));
}
