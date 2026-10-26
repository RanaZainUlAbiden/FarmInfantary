// Instrument real application IO inside explicit workflow scopes. Never infer a
// permission action from SQL verbs: creating a sale can UPDATE several ledgers.
// This produces observations for review, NEVER an executable grant policy.
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {ROOT,currentCatalogue} from './permission-catalogue.mjs';
const actions=new Set(['view','create','edit','delete']);
const hash=text=>createHash('sha256').update(text).digest('hex');
export function applicationSourceDigest() {
 const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):e.name.endsWith('.ts')?[join(dir,e.name)]:[]);
 return hash(files(join(ROOT,'src/app')).sort().map(file=>relative(ROOT,file).replaceAll('\\','/')+'\0'+readFileSync(file,'utf8').replaceAll('\r\n','\n')).join('\0'));
}
export function traceProducerDigest() {
 return hash(['tools/permission-trace.mjs','tools/sql-access.mjs','tools/permission-catalogue.mjs','scripts/verify/verify_vouchers_pg.mjs']
  .map(file=>file+'\0'+readFileSync(join(ROOT,file),'utf8').replaceAll('\r\n','\n')).join('\0'));
}
// Keep libpg-query's offline analysis in a bounded process. This Windows Node
// 24 runtime crashes in V8's optimizing Wasm compiler; baseline compilation
// avoids that failure. These flags apply to this local tool, not the API.
// Only SQL text and parameter COUNT cross the local process boundary.
export async function sqlAccess(sql,params=[]) {
 const run=spawnSync(process.execPath,['--liftoff-only','--no-wasm-tier-up',join(ROOT,'tools/sql-access.mjs')],{
  input:JSON.stringify({sql,parameterCount:params.length}),encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});
 if(run.status!==0)throw new Error('SQL access analysis failed');
 return JSON.parse(run.stdout);
}
export function createPermissionRecorder({catalogue=currentCatalogue(),sourceDigest=applicationSourceDigest()}={}) {
 const context=new AsyncLocalStorage(),known=new Set(catalogue.entries.map(p=>p.key)),records=new Map(),accessCache=new Map();
 const scopeRecord=({key,action,scenario})=>{
  if(!known.has(key)||!actions.has(action)||typeof scenario!=='string'||!/^[a-z0-9][a-z0-9 ._-]{0,99}$/i.test(scenario))throw new Error('Invalid permission trace scope');
  const id=key+':'+action+':'+scenario;
  if(!records.has(id))records.set(id,{key,action,scenario,invocations:0,failedResults:0,thrownResults:0,failedWorkflows:0,thrownWorkflows:0,observations:new Map(),unresolved:0});
  return records.get(id);
 };
 async function observe(record,sql,params) {
  try {
   const digest=hash(sql.replaceAll('\r\n','\n'));
   const cacheKey=digest+':'+params.length;
   if(!accessCache.has(cacheKey)) {
    if(accessCache.size>=1000)accessCache.delete(accessCache.keys().next().value);
    accessCache.set(cacheKey,sqlAccess(sql,params));
   }
   const access=await accessCache.get(cacheKey);
   record.observations.set(digest,{sqlDigest:digest,...access});
  } catch {record.unresolved++;} // No SQL text, params or DB error contents persist.
 }
 async function io(db,method,args) {
  const record=context.getStore();
  if(record) {
   if(method==='batch') {
    if(!Array.isArray(args[0]))record.unresolved++;
    else for(const op of args[0])await observe(record,op?.sql,op?.params||[]);
   }
   else await observe(record,args[0],args[1]||[]);
  }
  try {const result=await db[method](...args);if(record&&result?.success===false)record.failedResults++;return result;}
  catch(error){if(record)record.thrownResults++;throw error;}
 }
 return {
  run(scope,work) {
   const record=scopeRecord(scope),parent=context.getStore();
   if(parent&&parent!==record)throw new Error('Cannot relabel a nested permission workflow');
   record.invocations++;return context.run(record,async()=>{
    try {const result=await work();if(result?.success===false)record.failedWorkflows++;return result;}
    catch(error){record.thrownWorkflows++;throw error;}
   });
  },
  wrap(db) {
   return new Proxy(db,{get(target,key){
    if(['get','run','batch'].includes(key))return (...args)=>io(target,key,args);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
  },
  report() {
   return {schemaVersion:1,status:'observations-only; not authorized policy',sourceDigest,catalogueDigest:catalogue.sourceDigest,producerDigest:traceProducerDigest(),
    scopes:[...records.values()].sort((a,b)=>(a.key+a.action+a.scenario).localeCompare(b.key+b.action+b.scenario)).map(r=>({
     key:r.key,action:r.action,scenario:r.scenario,invocations:r.invocations,failedResults:r.failedResults,thrownResults:r.thrownResults,
     failedWorkflows:r.failedWorkflows,thrownWorkflows:r.thrownWorkflows,
     unresolved:r.unresolved,observations:[...r.observations.values()].sort((a,b)=>a.sqlDigest.localeCompare(b.sqlDigest)),
    }))};
  },
 };
}
