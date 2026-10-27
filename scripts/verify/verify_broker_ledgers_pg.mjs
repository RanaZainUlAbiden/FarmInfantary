import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadEnv,createScratchDb} from './lib/pg-harness.mjs';
import {migrate,readMigrations,MIGRATIONS_DIR} from '../../db/migration-runner.mjs';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {buildServer} from '../../server/src/server.js';
import {hashPassword} from '../../server/src/auth/password.js';
if(!loadEnv())throw new Error('DATABASE_URL is required');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg'),f=await createScratchDb('broker'),q=(s,v=[])=>f.pool.query(s,v);
const dir=mkdtempSync(join(tmpdir(),'broker-migration-')),role='vp_broker_'+randomBytes(6).toString('hex'),password='Broker verification password 2026',origin='http://localhost:4200';
let app,runtime,created=false,passed=0,owner,other,staff,root,brokerId,saleId;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const req=(method,url,payload,cookie=owner)=>app.inject({method,url,payload,headers:{origin,...(cookie?{cookie}:{})}});
const ok=r=>{assert.equal(r.statusCode,200,r.body);const b=r.json();assert.equal(b.success,true);return b;};
const login=async name=>{const r=await req('POST','/api/auth/login',{username:name,password},null);ok(r);return r.headers['set-cookie'].split(';')[0];};
const payment=(amount,method='cash',bankId=null)=>({amount,date:'2026-10-27',method,bankId,reference:method==='other'?'Cheque 42':'',note:''});
const sale=(amount=0)=>({flockId:1,date:'2026-10-27',vehicle:'QA-1',driver:'Driver',phone:'',emptyWeight:0,loadWeight:10,rate:10,payment:payment(amount),requestId:randomUUID()});
try{
 for(const m of readMigrations().slice(0,7))copyFileSync(join(MIGRATIONS_DIR,m.filename),join(dir,m.filename));
 await q(readFileSync(join(MIGRATIONS_DIR,'001_initial_schema.sql'),'utf8'));await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta',directory:dir,baseline:true});
 await q("INSERT INTO farms(farm_id,farm_name,password_hash,business_type,staff_seat_limit) VALUES(1,'Broker A','unused','all',3),(2,'Broker B','unused','all',3)");
 const hp=await hashPassword(password);for(const [name,farm,role] of [['owner',1,'farm_admin'],['other',2,'farm_admin'],['staff',1,'staff'],['root',null,'super_admin']])await q('INSERT INTO users(username,farm_id,role,password_hash) VALUES($1,$2,$3,$4)',[name,farm,role,hp]);
 await q("SELECT set_config('app.farm_id','1',false)");
 await q("INSERT INTO farm_units(unit_id,farm_id,unit_name,module_type) VALUES(1,1,'Farm A','broiler'),(2,1,'Farm B','broiler')");
 await q("INSERT INTO flocks(flock_id,farm_id,flock_name,start_date,unit_id) VALUES(1,1,'Flock A','2026-10-01',1),(2,1,'Flock B','2026-10-01',2)");
 await q("SELECT set_config('app.farm_id','2',false)");await q("INSERT INTO flocks(flock_id,farm_id,flock_name,start_date) VALUES(3,2,'Other Flock','2026-10-01')");await q("SELECT set_config('app.farm_id','1',false)");
 await q("INSERT INTO brokers(flock_id,broker_name) VALUES(1,'Ali'),(2,' ali ')");
 await q("INSERT INTO sales(flock_id,date,broker,rate,bird_weight,total_amount,payment_type,module_type) VALUES(1,'2026-10-20','Ali',1,100,100,'cash','broiler'),(2,'2026-10-20','ali',1,200,200,'credit',NULL),(1,'2026-10-20','Ali',1,999,999,'cash','layer')");
 await q("INSERT INTO bank_accounts(bank_id,farm_id,bank_name,customer_id) VALUES(1,1,'House',NULL),(2,1,'Customer',99)");
 await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta'});
 await check('forward migration unifies same-name brokers within a farm and preserves legacy payment facts and layer rows',async()=>{
  assert.equal((await q('SELECT count(*)::int AS n FROM brokers WHERE merged_into IS NULL')).rows[0].n,1);
  const rows=(await q('SELECT broker_id,broker_managed,broker_legacy_paid FROM sales ORDER BY sale_id')).rows;
  assert.equal(rows[0].broker_id,rows[1].broker_id);assert.equal(rows[2].broker_id,null);assert.equal(rows[0].broker_managed,0);assert.equal(rows[0].broker_legacy_paid,null);
 });
 const secret=randomBytes(32).toString('base64url');await provisionRuntimeRole(f.pool,{role,password:secret,schema:f.schema});created=true;
 const url=new URL(process.env.DATABASE_URL);url.username=role;url.password=secret;url.search='';runtime=new Pool({connectionString:url.toString(),max:4});
 ({app}=await buildServer({env:{...process.env,NODE_ENV:'development',AUTH_MODE:'session',APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex'),DATABASE_SCHEMA:f.schema},pool:f.pool,runtimePool:runtime}));
 owner=await login('owner');other=await login('other');staff=await login('staff');root=await login('root');
 await check('broker routes require owner identity, matching context and origin; staff and root remain denied',async()=>{
  assert.equal((await req('GET','/api/brokers',undefined,null)).statusCode,401);for(const c of [staff,root])assert.equal((await req('GET','/api/brokers',undefined,c)).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/brokers',payload:{name:'bad'},headers:{origin:'https://evil.example',cookie:owner}})).statusCode,403);
  assert.equal((await app.inject({method:'GET',url:'/api/brokers',headers:{cookie:owner,'x-fi-session-context':'999:2'}})).statusCode,409);
 });
 await check('legacy cash is paid, legacy credit is pending; shared Layer sales are excluded',async()=>{
  const r=ok(await req('GET','/api/brokers/1'));assert.deepEqual(r.summary,{total:300,paid:100,pending:200});assert.equal(r.sales.length,2);
  assert.equal(ok(await req('GET','/api/brokers/1?flockId=1')).summary.total,100);assert.equal(ok(await req('GET','/api/brokers',undefined,other)).brokers.length,0);
 });
 await check('Distribution broker totals and outstanding balances identify each physical farm and flock',async()=>{
  const list=ok(await req('GET','/api/brokers'));assert.deepEqual(list.summary,{total:300,paid:100,pending:200});
  const paged=ok(await req('GET','/api/brokers?offset=30'));assert.equal(paged.brokers.length,0);assert.deepEqual(paged.summary,list.summary);
  const r=ok(await req('GET','/api/brokers/1'));assert.deepEqual(r.breakdown.map(b=>({farm:b.farm_name,flock:b.flock_name,pending:b.pending})),[{farm:'Farm A',flock:'Flock A',pending:0},{farm:'Farm B',flock:'Flock B',pending:200}]);
  assert.deepEqual(ok(await req('GET','/api/brokers',undefined,other)).summary,{total:0,paid:0,pending:0});
 });
 await check('farm-wide broker create/edit validates fields, duplicate names and revisions',async()=>{
  const b=ok(await req('POST','/api/brokers',{name:'New Broker',phone:'0300',notes:'QA'})).broker;brokerId=b.broker_id;
  assert.equal((await req('POST','/api/brokers',{name:' new broker '})).statusCode,409);
  assert.equal((await req('POST','/api/brokers',{name:'spoof',farmId:2})).statusCode,400);
  ok(await req('PUT','/api/brokers/'+brokerId,{name:'New Broker',phone:'0300',notes:'Edited',active:true,version:1}));
  assert.equal((await req('PUT','/api/brokers/'+brokerId,{name:'New Broker',phone:'',notes:'',active:true,version:1})).statusCode,409);
 });
 await check('partial cash sale saves revenue once, records only received money and supports exact idempotent replay',async()=>{
  const b=sale(40),r=ok(await req('POST',`/api/brokers/${brokerId}/sales`,b));saleId=r.saleId;
  assert.equal(ok(await req('POST',`/api/brokers/${brokerId}/sales`,b)).saleId,saleId);
  assert.equal((await req('POST',`/api/brokers/${brokerId}/sales`,{...b,rate:11})).statusCode,409);
  const detail=ok(await req('GET',`/api/brokers/${brokerId}?flockId=1`));assert.deepEqual(detail.summary,{total:100,paid:40,pending:60});assert.equal(detail.payments.length,1);
  assert.equal((await q("SELECT amount FROM income WHERE source='sale' AND date='2026-10-27'")).rows[0].amount,100);
  assert.equal((await q('SELECT count(*)::int AS n FROM bank_ledger')).rows[0].n,0);
 });
 await check('later bank receipts post actual amount once, validate house accounts and preserve flock boundaries',async()=>{
  const base={saleId,...payment(30,'bank',1),requestId:randomUUID()};ok(await req('POST',`/api/brokers/${brokerId}/payments`,base));ok(await req('POST',`/api/brokers/${brokerId}/payments`,base));
  assert.equal((await q('SELECT current_balance FROM bank_accounts WHERE bank_id=1')).rows[0].current_balance,30);
  assert.equal((await q("SELECT count(*)::int AS n FROM bank_ledger WHERE reference_type='broker_payment'")).rows[0].n,1);
  const detail=ok(await req('GET',`/api/brokers/${brokerId}`));assert.equal(detail.sales[0].farm_name,'Farm A');assert.equal(detail.payments[0].farm_name,'Farm A');assert.equal(detail.payments[0].flock_name,'Flock A');
  assert.deepEqual(ok(await req('GET',`/api/brokers/${brokerId}?flockId=2`)).summary,{total:0,paid:0,pending:0});
  assert.equal((await req('POST',`/api/brokers/${brokerId}/payments`,{...base,amount:1,bankId:2,requestId:randomUUID()})).statusCode,400);
 });
 await check('other payment methods need a reference; overpayment and invalid values leave no partial writes',async()=>{
  for(const p of [payment(31),payment(-1),{...payment(1,'other'),reference:''},{...payment(1),date:'2026-02-30'}])assert.equal((await req('POST',`/api/brokers/${brokerId}/payments`,{saleId,...p,requestId:randomUUID()})).json().success,false);
  ok(await req('POST',`/api/brokers/${brokerId}/payments`,{saleId,...payment(10,'other'),requestId:randomUUID()}));
  assert.deepEqual(ok(await req('GET',`/api/brokers/${brokerId}`)).summary,{total:100,paid:80,pending:20});
 });
 await check('concurrent payments serialize on the broker and cannot overpay the sale',async()=>{
  const rs=await Promise.all([1,2].map(()=>req('POST',`/api/brokers/${brokerId}/payments`,{saleId,...payment(15),requestId:randomUUID()})));
  assert.deepEqual(rs.map(r=>r.statusCode).sort(),[200,409]);assert.equal(ok(await req('GET',`/api/brokers/${brokerId}`)).summary.pending,5);
 });
 await check('tenant isolation applies to broker IDs, flocks, sales, payments, and raw receipt table access',async()=>{
  assert.equal((await req('GET',`/api/brokers/${brokerId}`,undefined,other)).statusCode,404);
  assert.equal((await req('POST',`/api/brokers/${brokerId}/payments`,{saleId,...payment(1),requestId:randomUUID()},other)).statusCode,404);
  assert.equal((await req('POST',`/api/brokers/${brokerId}/sales`,{...sale(),flockId:3})).statusCode,404);
  assert.equal((await runtime.query('SELECT * FROM broker_payments')).rowCount,0);
  const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.farm_id','2',true)");assert.equal((await c.query('SELECT * FROM broker_payments')).rowCount,0);await c.query('ROLLBACK');}finally{c.release();}
 });
 await check('credit sales accept zero initial payment and inactive brokers cannot receive new sales',async()=>{
  const r=ok(await req('POST',`/api/brokers/${brokerId}/sales`,{...sale(),flockId:2}));assert.ok(r.saleId);assert.equal(ok(await req('GET',`/api/brokers/${brokerId}?flockId=2`)).summary.pending,100);
  const b=ok(await req('GET',`/api/brokers/${brokerId}`)).broker;ok(await req('PUT',`/api/brokers/${brokerId}`,{name:b.broker_name,phone:b.phone,notes:b.notes,active:false,version:b.version}));
  assert.equal((await req('POST',`/api/brokers/${brokerId}/sales`,sale())).statusCode,409);
 });
 await check('flock deletion is refused at the database boundary while broker history exists',async()=>{
  await assert.rejects(q('DELETE FROM flocks WHERE flock_id=1'),/broker sales and receipts/);
  assert.equal((await q('SELECT count(*)::int AS n FROM flocks WHERE flock_id=1')).rows[0].n,1);
 });
 await check('raw browser SQL cannot forge the trusted broker workflow or bypass receipt accounting',async()=>{
  for(const [sql,params] of [['UPDATE sales SET total_amount=? WHERE sale_id=?',[1,saleId]],['UPDATE broker_payments SET amount=? WHERE sale_id=?',[1,saleId]],["SELECT set_config('app.broker_workflow','on',true)",[]]]){
   const r=await req('POST','/api/db/run',{sql,params});assert.equal(r.json().success,false,r.body);
  }
  assert.equal(ok(await req('GET',`/api/brokers/${brokerId}`)).summary.total,200);
 });
 await check('corrections require device delete proof, preserve receipt history, and rebuild bank balance',async()=>{
  const detail=ok(await req('GET',`/api/brokers/${brokerId}`)),bank=detail.payments.find(p=>p.method==='bank'),path=`/api/brokers/${brokerId}/payments/${bank.payment_id}/reverse`;
  assert.equal((await req('POST',path,{})).statusCode,403);
  await q('INSERT INTO farm_security(farm_id,delete_code_hash) VALUES(1,$1)',[hp]);ok(await req('POST','/api/account/delete-code/verify',{code:password}));
  ok(await req('POST',path,{}));ok(await req('POST',path,{}));assert.equal((await q('SELECT current_balance FROM bank_accounts WHERE bank_id=1')).rows[0].current_balance,0);
  const after=ok(await req('GET',`/api/brokers/${brokerId}`));assert.equal(after.payments.find(p=>p.payment_id===bank.payment_id).reversed,1);assert.equal(after.summary.pending,135);
  assert.equal((await req('DELETE',`/api/brokers/${brokerId}/sales/${saleId}`)).statusCode,409);
  const unpaid=after.sales.find(s=>s.flock_id===2);ok(await req('DELETE',`/api/brokers/${brokerId}/sales/${unpaid.sale_id}`));assert.equal(ok(await req('GET',`/api/brokers/${brokerId}`)).summary.total,100);
 });
 console.log('ALL CHECKS PASSED — '+passed+' broker ledger scenarios');
}finally{await app?.close();await runtime?.end();await q(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();if(created){const p=new Pool({connectionString:process.env.DATABASE_URL});try{await p.query('DROP ROLE '+role);}finally{await p.end();}}rmSync(dir,{recursive:true,force:true});}
