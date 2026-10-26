// SECURITY ARTEFACT: derive keys from the active sidebar and registered routes.
// This catalogue describes screens, not authority to any business table.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),ts=require('typescript');
export const ROOT=fileURLToPath(new URL('../',import.meta.url));
const menus={broilerMenu:'broiler',layerMenu:'layer',distributionMenu:'distribution',overviewMenu:'owner'};
const fail=message=>{throw new Error(message);};
const text=node=>node&&ts.isStringLiteralLike(node)?node.text:fail('Expected a literal string.');
const properties=node=>new Map(node.properties.map(p=>ts.isPropertyAssignment(p)?[p.name.getText(),p.initializer]:fail('Dynamic menu properties require review.')));
export function deriveCatalogue({layout,routes}) {
 const source=ts.createSourceFile('layout.ts',layout,ts.ScriptTarget.Latest,true);
 const routing=ts.createSourceFile('routes.ts',routes,ts.ScriptTarget.Latest,true);
 const routeComponents=new Map();
 const visitRoutes=node=>{
  if(ts.isObjectLiteralExpression(node)) {
   const props=new Map(node.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(),p.initializer]));
   if(props.has('path')&&props.has('loadComponent')) {
    let component;
    const find=n=>{if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword)component=text(n.arguments[0]);ts.forEachChild(n,find);};
    find(props.get('loadComponent'));
    const path=text(props.get('path'));
    if(!component||routeComponents.has(path))fail('Ambiguous component route '+path);
    routeComponents.set(path,component);
   }
  }
  ts.forEachChild(node,visitRoutes);
 };visitRoutes(routing);
 const entries=new Map(),seen=new Set();
 const visit=node=>{
  if(ts.isPropertyDeclaration(node)&&node.name.getText() in menus) {
   const menu=node.name.getText(),module=menus[menu];seen.add(menu);
   if(!node.initializer||!ts.isArrayLiteralExpression(node.initializer))fail('Dynamic menu '+menu);
   for(const item of node.initializer.elements) {
    if(!ts.isObjectLiteralExpression(item))fail('Dynamic menu item');
    const props=properties(item),route=text(props.get('route')),label=text(props.get('label'));
    if(!/^[a-z][a-z0-9-]*$/.test(route)||!routeComponents.has(route))fail('Unregistered menu route '+route);
    const key=module+'.'+route;
    if(entries.has(key)) {
     // Add Batch is a query-string shortcut onto Batches, not a second grant.
     if(!props.has('queryParams'))fail('Unexplained duplicate permission '+key);
     entries.get(key).shortcuts.push(label);continue;
    }
    entries.set(key,{key,module,route,label,component:routeComponents.get(route),shortcuts:[],
     source:{file:'src/app/layout/layout.component.ts',menu,line:source.getLineAndCharacterOfPosition(item.getStart(source)).line+1}});
   }
  }
  ts.forEachChild(node,visit);
 };visit(source);
 if(seen.size!==Object.keys(menus).length)fail('An active menu is missing.');
 return {schemaVersion:1,authority:'catalogue-only; no table access is implied',
  sourceDigest:createHash('sha256').update(layout.replaceAll('\r\n','\n')+'\0'+routes.replaceAll('\r\n','\n')).digest('hex'),
  entries:[...entries.values()].sort((a,b)=>a.key.localeCompare(b.key,'en'))};
}
export function currentCatalogue() {
 return deriveCatalogue({layout:readFileSync(resolve(ROOT,'src/app/layout/layout.component.ts'),'utf8'),routes:readFileSync(resolve(ROOT,'src/app/app.routes.ts'),'utf8')});
}
export const encodeCatalogue=catalogue=>JSON.stringify(catalogue,null,2)+'\n';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const catalogue=currentCatalogue(),target=resolve(ROOT,'db/seeds/permission-catalogue.json'),encoded=encodeCatalogue(catalogue);
 if(process.argv.includes('--write')) {mkdirSync(dirname(target),{recursive:true});writeFileSync(target,encoded);}
 else if(!existsSync(target)||readFileSync(target,'utf8').replaceAll('\r\n','\n')!==encoded)fail('Permission catalogue drift. Review menu/route changes and regenerate with --write.');
 console.log('Permission catalogue: '+catalogue.entries.length+' distinct keys; '+JSON.stringify(Object.fromEntries(Object.values(menus).map(module=>[module,catalogue.entries.filter(p=>p.module===module).length]))));
}
