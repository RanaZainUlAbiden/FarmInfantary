// [Codex] Real cookies -> matched HTTP routes -> AST rewrite -> session-owned
// transaction -> direct restricted PostgreSQL login -> FORCE RLS.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes,createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadEnv,createScratchDb} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {sqlIdentifier as q} from '../../db/tenant-tables.mjs';
import {buildServer} from '../../server/src/server.js';
import {hashPassword} from '../../server/src/auth/password.js';
import {loadGuardCatalog,createSqlGuard} from '../../server/src/guard/sql-guard.js';
import {createSessionDb} from '../../server/src/db/session-execute.js';
if(!loadEnv())throw new Error('DATABASE_URL is required for guarded HTTP verification');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');
const fixture=await createScratchDb('guardhttp');
const role='vp_guard_'+randomBytes(7).toString('hex'),password=randomBytes(32).toString('base64url');
let runtime,app,sessionDb,ownerScoped,created=false,passed=0,now=Date.UTC(2026,9,26,12);
const secret=randomBytes(32).toString('hex'),origin='http://localhost:4200',loginPassword='guard HTTP verification password';
const env={...process.env,NODE_ENV:'development',AUTH_MODE:'session',DATABASE_SCHEMA:fixture.schema,
 APP_ORIGIN:origin,SESSION_SECRET:secret,MAX_ROWS_PER_QUERY:'2',RATE_LIMIT_PER_MINUTE:'600'};
let a,b,d,staff,admin,ownerId,product1,foreignProduct;
const ok=r=>{assert.equal(r.success,true,r.error);return r;};
const no=r=>{assert.equal(r.success,false);return r;};
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const sql=(text,params=[])=>fixture.pool.query(text,params);
async function asFarm(farm,text,params=[]) {
 const client=await fixture.pool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.farm_id',$1,true)",[String(farm)]);
 const result=await client.query(text,params);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function request(path,payload={},cookie=a,headers={}) {
 return app.inject({method:'POST',url:path,payload,headers:{origin,...(cookie?{cookie}:{}),...headers}});
}
const db=(method,body,cookie=a,headers={})=>request('/api/db/'+method,body,cookie,headers);
const query=async(text,params=[],cookie=a,token=null)=>ok((await db('get',{sql:text,params,token},cookie)).json());
const run=async(text,params=[],cookie=a,token=null)=>ok((await db('run',{sql:text,params,token},cookie)).json());
async function login(username,previous=null) {
 const r=await request('/api/auth/login',{username,password:loginPassword},previous);assert.equal(r.statusCode,200,JSON.stringify(r.json()));const cookie=r.headers['set-cookie'].split(';')[0];
 if(r.json().user.role==='farm_admin')assert.equal((await request('/api/account/delete-code/verify',{code:loginPassword},cookie)).statusCode,200);
 return cookie;
}
try {
 await sql(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
 await migrate(fixture.pool,{schema:fixture.schema,historySchema:fixture.schema+'_meta',baseline:true});
 await sql("INSERT INTO farms(farm_id,farm_name,password_hash) VALUES(1,'Farm A','unused'),(2,'Farm B','unused')");
 await sql('UPDATE farms SET staff_seat_limit=10');
 const hash=await hashPassword(loginPassword);
 await sql('INSERT INTO farm_security(farm_id,delete_code_hash) VALUES(1,$1),(2,$1)',[hash]);
 ownerId=(await sql("INSERT INTO users(farm_id,username,password_hash,role) VALUES(1,'guard.owner',$1,'farm_admin') RETURNING user_id",[hash])).rows[0].user_id;
 await sql("INSERT INTO users(farm_id,username,password_hash,role) VALUES(2,'guard.other',$1,'farm_admin'),(1,'guard.staff',$1,'staff'),(NULL,'guard.admin',$1,'super_admin')",[hash]);
 product1=(await asFarm(1,"INSERT INTO products(product_name,current_stock) VALUES('A1',10) RETURNING product_id")).rows[0].product_id;
 await asFarm(1,"INSERT INTO products(product_name,current_stock) VALUES('A2',20)");
 foreignProduct=(await asFarm(2,"INSERT INTO products(product_name,current_stock) VALUES('B1',30) RETURNING product_id")).rows[0].product_id;
 await asFarm(2,"INSERT INTO bills(bill_number,bill_date,subtotal,total_amount,amount_paid,customer_name) VALUES('B-foreign','2026-10-26',1,1,0,'foreign-customer')");
 await provisionRuntimeRole(fixture.pool,{role,password,schema:fixture.schema});created=true;
 const url=new URL(process.env.DATABASE_URL);url.username=role;url.password=password;url.search='';
 runtime=new Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:3000});
 ({app,sessionDb}=await buildServer({env,pool:fixture.pool,runtimePool:runtime,authOptions:{clock:()=>now}}));
 a=await login('guard.owner');b=await login('guard.other');d=await login('guard.owner');staff=await login('guard.staff');admin=await login('guard.admin');
 await check('only attested runtime credentials enable guarded development session SQL',async()=>{
  const health=(await app.inject({method:'GET',url:'/api/health'})).json();assert.match(health.session,/guarded tenant SQL/);assert.ok(sessionDb);
  await assert.rejects(buildServer({env,pool:fixture.pool,runtimePool:fixture.pool}),/unprivileged/);
  await assert.rejects(buildServer({env:{...env,DATABASE_SCHEMA:'public'},pool:fixture.pool,runtimePool:runtime}));
  await assert.rejects(buildServer({env:{...env,NODE_ENV:'production'},pool:fixture.pool,runtimePool:runtime}),/Refusing/);
 });
 await check('anonymous, cross-origin, staff and platform SQL cannot reach the executor',async()=>{
  assert.equal((await db('get',{sql:'SELECT 1'},null)).statusCode,401);
  assert.equal((await db('get',{sql:'SELECT 1'},a,{origin:'https://evil.example'})).statusCode,403);
  for(const cookie of [staff,admin])assert.equal((await db('get',{sql:'SELECT 1'},cookie)).statusCode,403);
 });
 await check('server identity ignores body/header impersonation and filters reads without a WHERE',async()=>{
  const r=await db('get',{sql:'SELECT product_name FROM products ORDER BY product_id',farmId:2,role:'super_admin'},a,{'x-farm-id':'2'});
  assert.deepEqual(ok(r.json()).data.map(r=>r.product_name),['A1','A2']);
  assert.deepEqual((await query('SELECT product_name FROM products',[],b)).data.map(r=>r.product_name),['B1']);
 });
 await check('stale browser account context refuses reads and writes without becoming an identity source',async()=>{
  const before=(await sql('SELECT current_stock FROM products WHERE product_id=$1',[product1])).rows[0].current_stock;
  for(const method of ['get','run']) {
   const r=await db(method,{sql:method==='get'?'SELECT * FROM products':'UPDATE products SET current_stock=999'},a,{'x-fi-session-context':'999:2'});
   assert.equal(r.statusCode,409);assert.equal(r.json().code,'SESSION_CHANGED');
  }
  const r=await db('get',{sql:'SELECT product_id FROM products'},a,{'x-fi-session-context':`${ownerId}:1`});assert.equal(r.statusCode,200);ok(r.json());
  assert.equal((await sql('SELECT current_stock FROM products WHERE product_id=$1',[product1])).rows[0].current_stock,before);
 });
 await check('business type updates use current server ownership, exact origin and farm-admin authority',async()=>{
  const patch=(body,cookie=a,headers={})=>app.inject({method:'PATCH',url:'/api/account/business-type',payload:body,headers:{origin,...(cookie?{cookie}:{}),...headers}});
  assert.equal((await patch({businessType:'all'},null)).statusCode,401);
  assert.equal((await patch({businessType:'all'},a,{origin:'https://evil.example'})).statusCode,403);
  for(const cookie of [staff,admin])assert.equal((await patch({businessType:'all'},cookie)).statusCode,403);
  assert.equal((await patch({businessType:'invalid'})).statusCode,400);
  assert.equal((await patch({businessType:'all'},a,{'x-fi-session-context':'999:2'})).statusCode,409);
  const result=await patch({businessType:'all',farmId:2,userId:999});assert.equal(result.statusCode,200);assert.equal(result.json().user.farmId,1);assert.equal(result.json().user.farm.business_type,'all');
  assert.equal(result.json().user.sessionKey,undefined);assert.equal((await sql('SELECT business_type FROM farms WHERE farm_id=2')).rows[0].business_type,'broiler');
 });
 await check('known foreign IDs, OR conditions, CTEs, subqueries and UNION cannot cross accounts',async()=>{
  assert.equal((await query('SELECT * FROM products WHERE product_id=?',[foreignProduct])).data.length,0);
  for(const text of [
   'SELECT farm_id FROM products WHERE farm_id=2 OR 1=1',
   'WITH x AS (SELECT * FROM products) SELECT farm_id FROM x',
   'SELECT farm_id FROM (SELECT * FROM products) p',
   'SELECT farm_id FROM products WHERE product_id IN(SELECT product_id FROM products)',
   'SELECT farm_id FROM products UNION SELECT farm_id FROM bills',
  ])assert.ok((await query(text)).data.every(row=>row.farm_id===1));
 });
 await check('outer joins preserve unmatched owned rows while hiding foreign matches',async()=>{
  for(const join of ['LEFT','FULL']) {
   const rows=(await query(`SELECT p.product_name,b.customer_name FROM products p ${join} JOIN bills b ON b.bill_id=p.product_id ORDER BY p.product_id`)).data;
   assert.deepEqual(rows,[{product_name:'A1',customer_name:null},{product_name:'A2',customer_name:null}]);
  }
  assert.deepEqual((await query('SELECT product_id,product_name FROM products GROUP BY product_id ORDER BY product_id')).data.map(r=>r.product_name),['A1','A2']);
 });
 await check('AST predicates independently isolate data even with a privileged fixture connection',async()=>{
  ownerScoped=createSessionDb(fixture.pool,{authorize:createSqlGuard({catalog:await loadGuardCatalog(fixture.pool,{schema:fixture.schema}),schema:fixture.schema,canDelete:async()=>true})});await ownerScoped.init();
  const owner=ownerScoped.forActor({farmId:1,userId:ownerId,authVersion:1,role:'farm_admin',sessionKey:'c'.repeat(64)});
  const rows=ok(await owner.get('SELECT farm_id FROM products WHERE 1=1 OR farm_id=2')).data;assert.ok(rows.length>0&&rows.every(r=>r.farm_id===1));
  const cte=ok(await owner.get('WITH x AS(SELECT farm_id FROM products) SELECT * FROM x')).data;assert.ok(cte.every(r=>r.farm_id===1));await ownerScoped.close();
 });
 await check('inserted ownership comes from the session and generated numeric lastId is preserved',async()=>{
  const result=await run('INSERT INTO products(farm_id,product_name) VALUES(?,?)',[2,'stamped']);assert.equal(typeof result.lastId,'number');
  assert.equal((await query('SELECT farm_id FROM products WHERE product_id=?',[result.lastId])).data[0].farm_id,1);
  await run('DELETE FROM products WHERE product_id=?',[result.lastId]);
 });
 await check('forged ownership updates and explicit identities are rejected before mutation',async()=>{
  for(const [text,params] of [['UPDATE products SET farm_id=2',[]],['UPDATE products SET product_id=99',[]],['INSERT INTO products(product_id,product_name) VALUES(?,?)',[9000,'explicit']]])no((await db('run',{sql:text,params})).json());
  assert.equal((await sql('SELECT count(*) AS n FROM products WHERE product_id=9000')).rows[0].n,0);
 });
 await check('foreign UPDATE/DELETE targets remain unchanged',async()=>{
  await run('UPDATE products SET current_stock=999 WHERE product_id=?',[foreignProduct]);await run('DELETE FROM products WHERE product_id=?',[foreignProduct]);
  assert.equal((await query('SELECT current_stock FROM products WHERE product_id=?',[foreignProduct],b)).data[0].current_stock,30);
 });
 await check('batches preserve lastId back-references through rewritten parameter ordering',async()=>{
  const result=ok((await db('batch',{ops:[
   {sql:'INSERT INTO bills(farm_id,bill_number,bill_date,subtotal,total_amount,amount_paid) VALUES(?,?,?,?,?,?)',params:[2,'A-batch','2026-10-26',5,5,0]},
   {sql:'INSERT INTO bill_items(bill_id,product_name,quantity,unit_price,total_price) VALUES(?,?,?,?,?)',params:[{$lastId:-1},'item',1,5,5]},
  ]})).json());
  assert.ok(result.results[0].lastId>0&&result.results[1].lastId>0);
  const rows=(await query('SELECT i.farm_id,i.bill_id FROM bill_items i WHERE item_id=?',[result.results[1].lastId])).data;
  assert.deepEqual(rows,[{farm_id:1,bill_id:result.results[0].lastId}]);
 });
 await check('batch authorization completes before writes and mid-batch database failure rolls back',async()=>{
  const before=(await sql('SELECT count(*) AS n FROM products')).rows[0].n;
  for(const second of [
   {sql:"SELECT set_config('app.farm_id','2',true)"},
   {sql:'INSERT INTO products(product_name,current_stock) VALUES(?,?)',params:['bad','not-a-number']},
  ])no((await db('batch',{ops:[{sql:'INSERT INTO products(product_name) VALUES(?)',params:['must-rollback']},second]})).json());
  assert.equal((await sql('SELECT count(*) AS n FROM products')).rows[0].n,before);
 });
 await check('explicit transactions are device-bound and nested savepoints survive failed batches',async()=>{
  const token=ok((await db('tx/begin')).json()).token;
  for(const cookie of [b,d])no((await db('get',{sql:'SELECT 1',token},cookie)).json());
  no((await db('tx/commit',{token},d)).json());
  await run('UPDATE products SET current_stock=? WHERE product_id=?',[11,product1],a,token);
  no((await db('batch',{token,ops:[{sql:'UPDATE products SET current_stock=? WHERE product_id=?',params:[12,product1]},
   {sql:'INSERT INTO products(product_name,current_stock) VALUES(?,?)',params:['fail','bad-number']}]})).json());
  assert.equal((await query('SELECT current_stock FROM products WHERE product_id=?',[product1],a,token)).data[0].current_stock,11);
  ok((await db('tx/commit',{token})).json());assert.equal((await query('SELECT current_stock FROM products WHERE product_id=?',[product1])).data[0].current_stock,11);
 });
 await check('row limits fail without partial data and client LIMIT zero still works',async()=>{
  const extra=await run('INSERT INTO products(product_name) VALUES(?)',['overflow']);
  const result=no((await db('get',{sql:'SELECT * FROM products'})).json());assert.equal(result.data,undefined);
  assert.deepEqual((await query('SELECT * FROM products LIMIT 0')).data,[]);
  await run('DELETE FROM products WHERE product_id=?',[extra.lastId]);
 });
 await check('hostile SQL is refused in HTTP with contractual generic failures',async()=>{
  for(const text of [
   "SELECT set_config('app.farm_id','2',true)",'SELECT 1; DELETE FROM products',
   'SELECT * FROM pg_catalog.pg_roles','SELECT * FROM information_schema.tables','SELECT * FROM users',
   'SELECT * FROM auth_sessions','SELECT * FROM activation','SELECT password_hash FROM farms','SELECT * FROM farms',
   'SELECT pg_sleep(1)',"SELECT pg_read_file('secret')",'SELECT * INTO TEMP evil FROM products',
   'WITH changed AS(DELETE FROM products RETURNING *) SELECT * FROM changed','SELECT * FROM products FOR UPDATE',
  ]) {
   const response=await db('get',{sql:text});assert.equal(response.statusCode,200);assert.equal(no(response.json()).error,'Database access is not allowed.');
  }
  for(const text of ['TRUNCATE products','ALTER TABLE products DISABLE ROW LEVEL SECURITY','SET ROLE postgres','CREATE TEMP TABLE evil(id int)'])no((await db('run',{sql:text})).json());
 });
 await check('matched-route authentication cannot be skipped with encoded paths or query strings',async()=>{
  for(const path of ['/api/%64b/get','/%61pi/db/get','/api/db/get?next=/public']) {
   const r=await request(path,{sql:'SELECT * FROM users'},null);
   assert.ok([401,404].includes(r.statusCode),String(r.statusCode));assert.equal(r.json().success,false);
  }
 });
 await check('login rotation and logout immediately roll back that device transaction',async()=>{
  let token=ok((await db('tx/begin')).json()).token;await run('UPDATE products SET current_stock=50 WHERE product_id=?',[product1],a,token);
  a=await login('guard.owner',a);assert.equal(sessionDb.openTransactions,0);assert.equal((await query('SELECT current_stock FROM products WHERE product_id=?',[product1])).data[0].current_stock,11);
  token=ok((await db('tx/begin')).json()).token;await run('UPDATE products SET current_stock=60 WHERE product_id=?',[product1],a,token);
  ok((await request('/api/auth/logout',{},a)).json());assert.equal(sessionDb.openTransactions,0);a=await login('guard.owner');
 });
 await check('status revocation on the next request closes the stale session transaction',async()=>{
  const token=ok((await db('tx/begin')).json()).token;await run('UPDATE products SET current_stock=70 WHERE product_id=?',[product1],a,token);
  await sql("UPDATE users SET status='suspended' WHERE user_id=$1",[ownerId]);
  assert.equal((await db('tx/commit',{token})).statusCode,401);assert.equal(sessionDb.openTransactions,0);
  await sql("UPDATE users SET status='active' WHERE user_id=$1",[ownerId]);a=await login('guard.owner');
  assert.equal((await query('SELECT current_stock FROM products WHERE product_id=?',[product1])).data[0].current_stock,11);
 });
 await check('atomic SQL throttles return 429 before execution and reopen after the window',async()=>{
  const bucket=createHmac('sha256',secret).update('sql:username\0'+String(ownerId)).digest('hex');
  await sql('UPDATE auth_login_limits SET attempts=600 WHERE bucket=$1',[bucket]);
  const r=await db('run',{sql:'UPDATE products SET current_stock=999'});assert.equal(r.statusCode,429);assert.equal(r.headers['retry-after'],'60');
  now+=61_000;assert.equal((await query('SELECT current_stock FROM products WHERE product_id=?',[product1])).data[0].current_stock,11);
 });
 await check('guarded pooled connections retain no farm/user settings between requests',async()=>{
  const clients=await Promise.all([runtime.connect(),runtime.connect()]);
  try{for(const c of clients){assert.deepEqual((await c.query("SELECT NULLIF(current_setting('app.farm_id',true),'') AS farm,NULLIF(current_setting('app.user_id',true),'') AS usr")).rows[0],{farm:null,usr:null});}}
  finally{clients.forEach(c=>c.release());}
 });
 await check('application shutdown rolls back pending session writes',async()=>{
  const token=ok((await db('tx/begin')).json()).token;await run('UPDATE products SET current_stock=80 WHERE product_id=?',[product1],a,token);
  await app.close();assert.equal(sessionDb.activeConnections,0);assert.equal((await sql('SELECT current_stock FROM products WHERE product_id=$1',[product1])).rows[0].current_stock,11);
 });
 console.log(`\nALL CHECKS PASSED — ${passed} guarded HTTP/PostgreSQL scenarios`);
} finally {
 await ownerScoped?.close();await app?.close();await runtime?.end();
 await sql(`DROP SCHEMA IF EXISTS ${q(fixture.schema+'_meta')} CASCADE`);await fixture.close();
 if(created){const adminPool=new Pool({connectionString:process.env.DATABASE_URL});try{await adminPool.query(`DROP ROLE ${q(role)}`);}finally{await adminPool.end();}}
}
