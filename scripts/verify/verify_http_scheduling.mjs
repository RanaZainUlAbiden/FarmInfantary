import assert from 'node:assert/strict';
import {loadBrowserSource,rx} from './lib/browser-source-harness.mjs';
const core={'@angular/core':{Injectable:()=>target=>target}};
const {HttpPlatformApi}=loadBrowserSource('src/app/shared/platform/http-platform-api.ts',core);
const {distributionBillsOnly}=loadBrowserSource('src/app/shared/utils/bill-source.util.ts',{});
const {OverviewService}=loadBrowserSource('src/app/shared/services/overview.service.ts',{
  ...core,'../utils/bill-source.util':{distributionBillsOnly},
  '../utils/sql-error.util':{friendlySqlError:message=>message},
});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
let passed=0;
const check=async(label,work)=>{await work();passed++;console.log('  PASS  '+label);};
function controlled(){
  const requests=[];
  const api=new HttpPlatformApi({post:(url,body)=>{const result=new rx.Subject();requests.push({url,body,result});return result;}});
  const finish=(index,result={success:true,data:[]})=>{requests[index].result.next(result);requests[index].result.complete();};
  return {api,requests,finish};
}
await check('actual 39-query Overview completes under latency without overflowing an eight-slot server',async()=>{
  let active=0,peak=0,calls=0;
  const api=new HttpPlatformApi({post:()=>rx.defer(async()=>{
    calls++;if(active>=8)return {success:false,error:'Database capacity is unavailable.'};
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    return {success:true,data:[]};
  })});
  const summary=await new OverviewService({get:(...args)=>api.dbGet(...args)}).getSummary(1,{});
  assert.equal(calls,39);assert.equal(peak,4);assert.equal(summary.warnings.length,0);assert.equal(active,0);
});
await check('queued mutations retain their original payload and run once in admission order',async()=>{
  const f=controlled(),first=Array.from({length:4},()=>f.api.dbGet('SELECT 1'));
  const params=['original'],ops=[{sql:'INSERT INTO products(product_name) VALUES(?)',params:['batch-original']}];
  const write=f.api.dbRun('INSERT INTO products(product_name) VALUES(?)',params),batch=f.api.dbRunBatch(ops);
  params[0]='changed';ops[0].params[0]='changed';assert.equal(f.requests.length,4);
  f.finish(0);await tick();assert.equal(f.requests[4].body.params[0],'original');
  f.finish(1);await tick();assert.equal(f.requests[5].body.ops[0].params[0],'batch-original');
  [2,3,4,5].forEach(i=>f.finish(i));await Promise.all([...first,write,batch]);assert.equal(f.requests.length,6);
});
await check('identity reset cancels queued writes before transmission and rejects old in-flight results',async()=>{
  const f=controlled(),active=Array.from({length:4},()=>f.api.dbGet('SELECT 1'));
  const queued=f.api.dbRun('UPDATE products SET product_name=?',['old-user-data']);f.api.resetSession();
  assert.equal((await queued).success,false);assert.equal(f.requests.length,4);
  [0,1,2,3].forEach(i=>f.finish(i));assert.ok((await Promise.all(active)).every(r=>!r.success));await tick();
  const fresh=f.api.dbGet('SELECT 2');assert.equal(f.requests.length,5);assert.equal(f.requests[4].body.token,null);f.finish(4);assert.equal((await fresh).success,true);
});
await check('transport failures release a slot, preserve result shapes and never retry a write',async()=>{
  const f=controlled(),work=Array.from({length:5},()=>f.api.dbRun('UPDATE products SET current_stock=?',[1]));
  f.requests[0].result.error({status:429,error:{error:'Too many requests.'}});await tick();
  assert.equal(f.requests.length,5);[1,2,3,4].forEach(i=>f.finish(i,{success:true,lastId:null}));
  const results=await Promise.all(work);assert.equal(results[0].success,false);assert.equal(results[0].error,'Too many requests.');assert.equal(f.requests.length,5);
});
await check('queue is bounded and cancellation settles every pending operation without sending it',async()=>{
  const f=controlled(),work=Array.from({length:133},()=>f.api.dbGet('SELECT 1'));
  assert.equal(f.requests.length,4);assert.equal((await work[132]).success,false);f.api.resetSession();
  [0,1,2,3].forEach(i=>f.finish(i));assert.ok((await Promise.all(work)).every(r=>!r.success));assert.equal(f.requests.length,4);
});
console.log(`\n${passed} HTTP scheduling scenarios passed.`);
