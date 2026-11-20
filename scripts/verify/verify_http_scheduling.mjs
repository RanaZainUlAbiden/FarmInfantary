import assert from 'node:assert/strict';
import {loadBrowserSource,rx} from './lib/browser-source-harness.mjs';
const core={'@angular/core':{Injectable:()=>target=>target}};
const {HttpPlatformApi}=loadBrowserSource('src/app/shared/platform/http-platform-api.ts',core);
const {distributionBillsOnly}=loadBrowserSource('src/app/shared/utils/bill-source.util.ts',{});
const {OverviewService}=loadBrowserSource('src/app/shared/services/overview.service.ts',{
  ...core,'../utils/bill-source.util':{distributionBillsOnly},
  '../utils/sql-error.util':{friendlySqlError:message=>message},
});
const plain=x=>JSON.parse(JSON.stringify(x));
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
let passed=0;
const check=async(label,work)=>{await work();passed++;console.log('  PASS  '+label);};
function controlled(){
  const requests=[];
  const api=new HttpPlatformApi({post:(url,body)=>{const result=new rx.Subject();requests.push({url,body,result});return result;}});
  const finish=(index,result={success:true,data:[]})=>{requests[index].result.next(result);requests[index].result.complete();};
  return {api,requests,finish};
}
const slot=api=>api.dbRun('UPDATE products SET current_stock=?',[1]);
await check('actual 39-query Overview travels as ONE batched request, not 39',async()=>{
  const seen=[];
  const api=new HttpPlatformApi({post:(url,body)=>rx.defer(async()=>{
    seen.push(url);await new Promise(resolve=>setTimeout(resolve,5));
    return url==='api/db/get-many'?{success:true,results:body.queries.map(()=>({success:true,data:[]}))}:{success:true,data:[]};
  })});
  const summary=await new OverviewService({get:(...args)=>api.dbGet(...args)}).getSummary(1,{});
  assert.deepEqual(plain(seen),['api/db/get-many']);assert.equal(summary.warnings.length,0);
});
await check('a query that fails inside a batch is repeated on its own and keeps its exact error',async()=>{
  const f=controlled(),reads=[f.api.dbGet('SELECT 1'),f.api.dbGet('SELECT 2'),f.api.dbGet('SELECT 3')];
  await tick();assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'api/db/get-many');
  assert.deepEqual(plain(f.requests[0].body.queries.map(q=>q.sql)),['SELECT 1','SELECT 2','SELECT 3']);
  f.finish(0,{success:true,results:[{success:true,data:[1]},{success:false,error:'Database operation failed.'},{success:false,error:'Database operation failed.'}]});
  await tick();assert.equal(f.requests.length,3);assert.equal(f.requests[1].url,'api/db/get');assert.equal(f.requests[1].body.sql,'SELECT 2');
  f.finish(1,{success:false,error:'bad column'});f.finish(2,{success:true,data:[3]});
  const [one,two,three]=await Promise.all(reads);
  assert.deepEqual(plain(one.data),[1]);assert.equal(two.error,'bad column');assert.deepEqual(plain(three.data),[3]);
});
await check('a lone read, a write, and anything inside a transaction are never batched',async()=>{
  const f=controlled(),lone=f.api.dbGet('SELECT 1');await tick();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'api/db/get');f.finish(0);await lone;
  const write=f.api.dbGet('UPDATE products SET current_stock=1 RETURNING product_id'),read=f.api.dbGet('SELECT 1');await tick();
  assert.deepEqual(plain(f.requests.slice(1).map(r=>r.url)),['api/db/get','api/db/get']);[1,2].forEach(i=>f.finish(i));await Promise.all([write,read]);
  const begin=f.api.dbBeginTransaction();f.finish(3,{success:true,token:'tok'});await begin;
  const a=f.api.dbGet('SELECT 1'),b=f.api.dbGet('SELECT 2');await tick();
  assert.deepEqual(plain(f.requests.slice(4).map(r=>r.url)),['api/db/get','api/db/get']);assert.equal(f.requests[4].body.token,'tok');
  [4,5].forEach(i=>f.finish(i));await Promise.all([a,b]);
});
await check('more than forty reads are split into batches of forty',async()=>{
  const f=controlled(),reads=Array.from({length:95},(_,i)=>f.api.dbGet('SELECT '+i));await tick();
  assert.deepEqual(plain(f.requests.map(r=>r.body.queries.length)),[40,40,15]);
  f.requests.forEach((r,i)=>f.finish(i,{success:true,results:r.body.queries.map(()=>({success:true,data:[]}))}));
  assert.ok((await Promise.all(reads)).every(r=>r.success));
});
await check('queued mutations retain their original payload and run once in admission order',async()=>{
  const f=controlled(),first=Array.from({length:6},()=>slot(f.api));
  const params=['original'],ops=[{sql:'INSERT INTO products(product_name) VALUES(?)',params:['batch-original']}];
  const write=f.api.dbRun('INSERT INTO products(product_name) VALUES(?)',params),batch=f.api.dbRunBatch(ops);
  params[0]='changed';ops[0].params[0]='changed';assert.equal(f.requests.length,6);
  f.finish(0,{success:true,lastId:null});await tick();assert.equal(f.requests[6].body.params[0],'original');
  f.finish(1,{success:true,lastId:null});await tick();assert.equal(f.requests[7].body.ops[0].params[0],'batch-original');
  [2,3,4,5,6,7].forEach(i=>f.finish(i,{success:true,lastId:null}));await Promise.all([...first,write,batch]);assert.equal(f.requests.length,8);
});
await check('identity reset cancels queued writes and waiting reads before transmission and rejects old in-flight results',async()=>{
  const f=controlled(),active=Array.from({length:6},()=>slot(f.api));
  const queued=f.api.dbRun('UPDATE products SET product_name=?',['old-user-data']),waiting=f.api.dbGet('SELECT 9');f.api.resetSession();
  assert.equal((await queued).success,false);assert.equal((await waiting).success,false);assert.equal(f.requests.length,6);
  [0,1,2,3,4,5].forEach(i=>f.finish(i,{success:true,lastId:null}));assert.ok((await Promise.all(active)).every(r=>!r.success));await tick();
  const fresh=f.api.dbGet('SELECT 2');await tick();assert.equal(f.requests.length,7);assert.equal(f.requests[6].body.token,null);f.finish(6);assert.equal((await fresh).success,true);
});
await check('transport failures release a slot, preserve result shapes and never retry a write',async()=>{
  const f=controlled(),work=Array.from({length:7},()=>f.api.dbRun('UPDATE products SET current_stock=?',[1]));
  f.requests[0].result.error({status:429,error:{error:'Too many requests.'}});await tick();
  assert.equal(f.requests.length,7);[1,2,3,4,5,6].forEach(i=>f.finish(i,{success:true,lastId:null}));
  const results=await Promise.all(work);assert.equal(results[0].success,false);assert.equal(results[0].error,'Too many requests.');assert.equal(f.requests.length,7);
});
await check('queue is bounded and cancellation settles every pending operation without sending it',async()=>{
  const f=controlled(),work=Array.from({length:135},()=>slot(f.api));
  assert.equal(f.requests.length,6);assert.equal((await work[134]).success,false);f.api.resetSession();
  [0,1,2,3,4,5].forEach(i=>f.finish(i,{success:true,lastId:null}));assert.ok((await Promise.all(work)).every(r=>!r.success));assert.equal(f.requests.length,6);
});
console.log(`\n${passed} HTTP scheduling scenarios passed.`);
