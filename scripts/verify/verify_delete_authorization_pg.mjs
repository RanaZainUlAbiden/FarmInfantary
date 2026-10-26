import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createScratchDb,loadEnv} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {hashPassword} from '../../server/src/auth/password.js';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {buildServer} from '../../server/src/server.js';
import {BUSINESS_TABLES} from '../../db/tenant-tables.mjs';
import {registerOwnerData} from '../../server/src/routes/owner-data.js';
if(!loadEnv())throw new Error('DATABASE_URL required');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg'),f=await createScratchDb('delete_auth');
const q=(sql,params=[])=>f.pool.query(sql,params),role='vp_delete_'+randomBytes(6).toString('hex'),runtimePassword=randomBytes(32).toString('base64url');
const origin='http://localhost:4200',password='delete authorization account password',code='private delete code 26';
 let runtime,app,session,created=false,passed=0,now=Date.now(),a,d,b,staff,admin;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const req=(method,url,payload,cookie=a,headers={})=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{}),...headers}});
const ok=r=>{assert.equal(r.statusCode,200,r.body);assert.equal(r.json().success,true,r.body);return r.json();};
const login=async username=>{const r=await req('POST','/api/auth/login',{username,password},null);ok(r);return r.headers['set-cookie'].split(';')[0];};
const remove=(cookie=a,extra={})=>req('POST','/api/db/run',{sql:'DELETE FROM products WHERE product_name=?',params:['delete target'],...extra},cookie);
const verify=(cookie=a,value=code)=>req('POST','/api/account/delete-code/verify',{code:value},cookie);
try {
 await q(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
 await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta',baseline:true});
 await q("INSERT INTO farms(farm_id,farm_name,password_hash,staff_seat_limit) VALUES(1,'Delete A','unused',3),(2,'Delete B','unused',3)");
 const hash=await hashPassword(password);
 await q("INSERT INTO users(farm_id,username,password_hash,role) VALUES(1,'delete.owner',$1,'farm_admin'),(2,'delete.other',$1,'farm_admin'),(1,'delete.staff',$1,'staff'),(NULL,'delete.admin',$1,'super_admin')",[hash]);
 for(const id of [1,2]){const c=await f.pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.farm_id',$1,true)",[String(id)]);await c.query("INSERT INTO products(product_name) VALUES('delete target')");await c.query('COMMIT');}finally{c.release();}}
 await provisionRuntimeRole(f.pool,{role,password:runtimePassword,schema:f.schema});created=true;
 const url=new URL(process.env.DATABASE_URL);url.username=role;url.password=runtimePassword;url.search='';runtime=new Pool({connectionString:url.toString(),max:3});
 ({app,session}=await buildServer({env:{...process.env,NODE_ENV:'development',AUTH_MODE:'session',APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex'),DATABASE_SCHEMA:f.schema},pool:f.pool,runtimePool:runtime,authOptions:{clock:()=>now}}));
 a=await login('delete.owner');d=await login('delete.owner');b=await login('delete.other');staff=await login('delete.staff');admin=await login('delete.admin');
 await check('owner exports include only owned business rows, safe metadata and download headers',async()=>{
  const r=await req('GET','/api/account/export'),data=r.json();assert.equal(r.statusCode,200);assert.match(r.headers['content-disposition'],/attachment/);assert.equal(r.headers['cache-control'],'no-store');
  assert.equal(data.format,'FarmInfantary-owner-export');assert.deepEqual(Object.keys(data.tables).sort(),[...BUSINESS_TABLES].sort());assert.deepEqual(data.tables.products.map(p=>p.farm_id),[1]);
  assert.ok(!r.body.includes('argon2id'));assert.ok(!('users' in data.tables));assert.equal((await req('GET','/api/account/export',undefined,staff)).statusCode,403);assert.equal((await req('GET','/api/account/export',undefined,admin)).statusCode,403);
  assert.equal(ok(await req('GET','/api/account/entitlement')).active,true);
 });
 await check('oversized exports fail without partial data and release the runtime connection',async()=>{
  const Fastify=(await import('../../server/node_modules/fastify/fastify.js')).default,small=Fastify();registerOwnerData(small,{session,runtime,schema:f.schema,maxBytes:1});
  try{const r=await small.inject({method:'GET',url:'/api/account/export',headers:{origin,cookie:a}});assert.equal(r.statusCode,413);assert.equal(r.json().success,false);assert.ok(!r.body.includes('delete target'));}finally{await small.close();}
 });
 await check('direct DELETE fails without confirmation despite forged client flags',async()=>{assert.equal((await remove(a,{deleteAuthorized:true})).json().success,false);assert.equal((await q('SELECT count(*)::int AS n FROM products')).rows[0].n,2);});
 await check('fresh farms have no default code and code metadata stays inaccessible',async()=>{
  assert.deepEqual(ok(await req('GET','/api/account/delete-code')),{success:true,configured:false});assert.equal((await verify(a,'qwer@789')).statusCode,409);
  for(const table of ['farm_security','auth_delete_grants'])assert.equal((await req('POST','/api/db/get',{sql:'SELECT * FROM '+table})).json().success,false);
 });
 await check('configuration requires origin, farm admin and current password without ending a valid login on typo',async()=>{
  for(const c of [staff,admin])assert.equal((await req('PUT','/api/account/delete-code',{currentPassword:password,newCode:code},c)).statusCode,403);
  assert.equal((await req('PUT','/api/account/delete-code',{currentPassword:password,newCode:code},a,{origin:'https://evil.example'})).statusCode,403);
  assert.equal((await req('PUT','/api/account/delete-code',{currentPassword:'wrong password',newCode:code})).statusCode,400);ok(await req('GET','/api/auth/me'));
  ok(await req('PUT','/api/account/delete-code',{currentPassword:password,newCode:code}));assert.match((await q('SELECT delete_code_hash FROM farm_security')).rows[0].delete_code_hash,/^\$argon2id\$/);
 });
 await check('wrong code stays locked and confirmation returns no bearer token',async()=>{assert.equal((await verify(a,'incorrect code')).statusCode,400);assert.equal((await remove()).json().success,false);assert.deepEqual(ok(await verify()),{success:true,validSeconds:60});});
 await check('authorization is scoped to the exact device and farm',async()=>{assert.equal((await remove(d)).json().success,false);assert.equal((await remove(b,{farmId:1})).json().success,false);ok(await remove());assert.deepEqual((await q('SELECT farm_id FROM products')).rows,[{farm_id:2}]);});
 await check('unconfirmed mixed batch is rejected before its first mutation',async()=>{
  const r=await req('POST','/api/db/batch',{ops:[{sql:"UPDATE products SET product_name='changed'"},{sql:'DELETE FROM products'}]},d);assert.equal(r.json().success,false);assert.equal((await q('SELECT product_name FROM products')).rows[0].product_name,'delete target');
 });
 await check('confirmation expires after 60 seconds while the login remains valid',async()=>{now+=61_000;assert.equal((await remove()).json().success,false);ok(await req('GET','/api/auth/me'));ok(await verify());});
 await check('changing the code revokes all previous confirmations',async()=>{ok(await req('PUT','/api/account/delete-code',{currentPassword:password,newCode:'replacement private code'}));assert.equal((await remove()).json().success,false);assert.equal((await verify()).statusCode,400);ok(await verify(a,'replacement private code'));});
 await check('logout invalidates grants and another login does not inherit them',async()=>{ok(await req('POST','/api/auth/logout',{}));assert.equal((await remove()).statusCode,401);a=await login('delete.owner');assert.equal((await remove()).json().success,false);});
 await check('runtime login cannot read or mutate code/grant metadata',async()=>{for(const t of ['farm_security','auth_delete_grants']){await assert.rejects(runtime.query('SELECT * FROM '+t));await assert.rejects(runtime.query('DELETE FROM '+t));}});
 await check('audit stores the security change without code/password/hash values',async()=>{const rows=(await q("SELECT details FROM audit_events WHERE action='security.delete-code'")).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>JSON.stringify(r.details)==='{}'));});
 await check('repeated wrong codes are throttled before further verification',async()=>{now+=61_000;for(let i=0;i<5;i++)assert.equal((await verify(a,'wrong delete code')).statusCode,400);assert.equal((await verify(a,'replacement private code')).statusCode,429);});
 console.log('ALL CHECKS PASSED — '+passed+' delete authorization scenarios');
} finally {await app?.close();await runtime?.end();await q(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();if(created){const p=new Pool({connectionString:process.env.DATABASE_URL});try{await p.query('DROP ROLE '+role);}finally{await p.end();}}}
