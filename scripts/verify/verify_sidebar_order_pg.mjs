import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createScratchDb,loadEnv} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {provisionAuthRole} from '../../db/auth-role.mjs';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {hashPassword} from '../../server/src/auth/password.js';
import {buildServer} from '../../server/src/server.js';
if(!loadEnv())throw Error('DATABASE_URL required');
const f=await createScratchDb('sidebar'),q=(s,v=[])=>f.pool.query(s,v),password='Sidebar order verification 2026',origin='http://localhost:4200';
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');
const roles=[],pools=[];let app,passed=0,owner,peer,other,staff,root;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const req=(method,url,payload,cookie=owner,headers={})=>app.inject({method,url,payload,headers:{origin,...(cookie?{cookie}:{}),...headers}});
const ok=r=>{assert.equal(r.statusCode,200,r.body);assert.equal(r.json().success,true);return r.json();};
const login=async username=>{const r=await req('POST','/api/auth/login',{username,password},null);ok(r);return r.headers['set-cookie'].split(';')[0];};
const save=(module,order,cookie=owner)=>req('PUT','/api/account/sidebar-order/'+module,{order},cookie);
const read=async(cookie=owner)=>ok(await req('GET','/api/account/sidebar-order',undefined,cookie)).orders;
try{
 await q(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
 await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta',baseline:true});
 await q("INSERT INTO farms(farm_id,farm_name,password_hash,business_type,staff_seat_limit) VALUES(1,'Sidebar A','unused','all',3),(2,'Sidebar B','unused','all',3)");
 const hp=await hashPassword(password);for(const [name,farm,role] of [['owner',1,'farm_admin'],['peer',1,'farm_admin'],['other',2,'farm_admin'],['staff',1,'staff'],['root',null,'super_admin']])await q('INSERT INTO users(username,farm_id,role,password_hash) VALUES($1,$2,$3,$4)',[name,farm,role,hp]);
 for(const provision of [provisionAuthRole,provisionRuntimeRole]){const role='vp_sidebar_'+randomBytes(6).toString('hex'),secret=randomBytes(32).toString('base64url');await provision(f.pool,{role,password:secret,schema:f.schema});roles.push(role);const url=new URL(process.env.DATABASE_URL);url.username=role;url.password=secret;url.search='';pools.push(new Pool({connectionString:url.toString(),max:4}));}
 ({app}=await buildServer({env:{...process.env,NODE_ENV:'development',AUTH_MODE:'session',APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex'),DATABASE_SCHEMA:f.schema},pool:pools[0],runtimePool:pools[1]}));
 owner=await login('owner');peer=await login('peer');other=await login('other');staff=await login('staff');root=await login('root');
 await check('new users receive an empty personal order and responses are private',async()=>{const r=await req('GET','/api/account/sidebar-order');assert.equal(r.headers['cache-control'],'no-store');assert.deepEqual(ok(r).orders,{});});
 await check('sidebar order requires current owner identity, trusted origin and matching context',async()=>{
  for(const method of ['GET','PUT']){const path='/api/account/sidebar-order'+(method==='PUT'?'/broiler':'');assert.equal((await req(method,path,method==='PUT'?{order:[]}:undefined,null)).statusCode,401);for(const cookie of [staff,root])assert.equal((await req(method,path,method==='PUT'?{order:[]}:undefined,cookie)).statusCode,403);}
  assert.equal((await req('PUT','/api/account/sidebar-order/broiler',{order:[]},owner,{origin:'https://evil.example'})).statusCode,403);
  assert.equal((await req('GET','/api/account/sidebar-order',undefined,owner,{'x-fi-session-context':'999:1'})).statusCode,409);
 });
 await check('Broiler, Layer and Distribution orders persist separately with the Layer Add Batch shortcut distinct',async()=>{
  ok(await save('broiler',['sale','feed','flock-health']));ok(await save('layer',['batch-management:add','egg-sales','batch-management']));ok(await save('distribution',['supplier-management','brokers','inventory']));
  assert.deepEqual(await read(),{broiler:['sale','feed','flock-health'],layer:['batch-management:add','egg-sales','batch-management'],distribution:['supplier-management','brokers','inventory']});
 });
 await check('logout, a fresh cookie and a second device restore the saved account order',async()=>{
  const before=await read();const device=await login('owner');assert.deepEqual(await read(device),before);ok(await req('POST','/api/auth/logout',{}));owner=await login('owner');assert.deepEqual(await read(),before);
 });
 await check('another owner on the same farm and a different farm cannot see or alter this user preference',async()=>{
  assert.deepEqual(await read(peer),{});assert.deepEqual(await read(other),{});ok(await save('broiler',['medicine'],peer));assert.deepEqual((await read()).broiler,['sale','feed','flock-health']);
  const r=await req('PUT','/api/account/sidebar-order/broiler',{order:['feed'],userId:1,farmId:1},other);assert.equal(r.statusCode,400);
 });
 await check('unknown routes, modules, duplicated keys, spoofed fields and oversized lists are rejected without changes',async()=>{
  const before=await read();for(const [module,order] of [['owner',['assets']],['__proto__',[]],['broiler',['egg-sales']],['layer',['batch-management:add','batch-management:add']],['distribution',['<script>']],['broiler',null],['broiler',Array(41).fill('feed')]])assert.equal((await save(module,order)).statusCode,400);
  assert.equal((await req('PUT','/api/account/sidebar-order/broiler',{order:[],permissions:['all']})).statusCode,400);assert.deepEqual(await read(),before);
 });
 await check('repeating a confirmed order is idempotent and concurrent module updates preserve both',async()=>{
  ok(await save('broiler',['feed','sale']));ok(await save('broiler',['feed','sale']));
  const rs=await Promise.all([save('broiler',['expenses','feed']),save('distribution',['brokers','supplier-management'])]);rs.forEach(ok);
  const orders=await read();assert.deepEqual(orders.broiler,['expenses','feed']);assert.deepEqual(orders.distribution,['brokers','supplier-management']);assert.equal(orders.layer[0],'batch-management:add');
 });
 await check('the business runtime and browser SQL cannot read or forge private account preferences',async()=>{
  await assert.rejects(pools[1].query('SELECT sidebar_order FROM users'),/permission denied/);
  const r=await req('POST','/api/db/run',{sql:"UPDATE users SET sidebar_order='{}'",params:[]});assert.equal(r.json().success,false);
 });
 await check('revoked identity cannot write a sidebar order with its old cookie',async()=>{
  const before=await read();await q("UPDATE users SET auth_version=auth_version+1 WHERE username='owner'");assert.equal((await save('broiler',['medicine'])).statusCode,401);owner=await login('owner');assert.deepEqual(await read(),before);
 });
 console.log('ALL CHECKS PASSED — '+passed+' sidebar PostgreSQL/HTTP scenarios');
}finally{await app?.close();for(const pool of pools)await pool.end();await q(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();if(roles.length){const admin=new Pool({connectionString:process.env.DATABASE_URL});try{for(const role of roles)await admin.query('DROP ROLE '+role);}finally{await admin.end();}}}
