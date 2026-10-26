// Synthetic review metadata exercises the gate; it is NOT real release approval.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {loadEnv,createScratchDb} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {provisionAuthRole,attestAuthRole} from '../../db/auth-role.mjs';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {bootstrapSuperAdmin} from '../../server/src/auth/bootstrap.js';
import {releaseDigest,productionApproved} from '../../server/src/release.js';
import {buildServer} from '../../server/src/server.js';
if(!loadEnv())throw new Error('DATABASE_URL required');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg'),f=await createScratchDb('owner_release');
const roles=['vp_release_auth_'+randomBytes(5).toString('hex'),'vp_release_run_'+randomBytes(5).toString('hex')],created=[];
const password='owner release verification password',origin='https://release.example.invalid';let app,auth,runtime,passed=0;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const base={...process.env,NODE_ENV:'production',AUTH_MODE:'session',RELEASE_PROFILE:'owner-only',APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex'),DATABASE_SCHEMA:f.schema,MIGRATION_DATABASE_URL:'',SECURITY_REVIEWER:'synthetic test fixture - not real approval',REVIEWED_RELEASE_SHA:releaseDigest()};
try{
 await f.pool.query(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta',baseline:true});
 await bootstrapSuperAdmin(f.pool,'release.admin',password);
 const urls=[];
 for(const [i,role] of roles.entries()){const pass=randomBytes(32).toString('base64url');await (i===0?provisionAuthRole:provisionRuntimeRole)(f.pool,{role,password:pass,schema:f.schema});created.push(role);const u=new URL(process.env.DATABASE_URL);u.username=role;u.password=pass;u.search='';urls.push(u.toString());}
 auth=new Pool({connectionString:urls[0],max:4});runtime=new Pool({connectionString:urls[1],max:3});base.DATABASE_URL=urls[0];base.RUNTIME_DATABASE_URL=urls[1];
 await check('production refuses missing or stale review, insecure origin, wrong profile and migration credentials',async()=>{
  for(const patch of [{NODE_ENV:undefined},{REVIEWED_RELEASE_SHA:'wrong'},{SECURITY_REVIEWER:''},{APP_ORIGIN:'http://example.invalid'},{RELEASE_PROFILE:'staff-enabled'},{AUTH_MODE:'development'},{MIGRATION_DATABASE_URL:process.env.DATABASE_URL},{RUNTIME_DATABASE_URL:''}])assert.throws(()=>productionApproved({...base,...patch}),/Refusing/);
  assert.equal(productionApproved(base),true);assert.equal(productionApproved({NODE_ENV:'development'}),false);
 });
 await check('startup rejects privileged auth pools and auth/runtime role confusion',async()=>{
  await assert.rejects(buildServer({env:base,pool:f.pool,runtimePool:runtime}),/unprivileged/);
  await assert.rejects(buildServer({env:base,pool:auth,runtimePool:auth}));
 });
 ({app}=await buildServer({env:base,pool:auth,runtimePool:runtime}));
 const request=(method,url,payload,cookie)=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{})}});
 const ok=r=>{assert.equal(r.statusCode,200,r.body);assert.equal(r.json().success,true);return r.json();};
 const login=async name=>{const r=await request('POST','/api/auth/login',{username:name,password});ok(r);return r;};
 const rootResponse=await login('release.admin'),root=rootResponse.headers['set-cookie'].split(';')[0];
 await check('production cookies and response headers enforce the HTTPS session contract',async()=>{
  const cookie=rootResponse.headers['set-cookie'];assert.match(cookie,/__Host-/);assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.equal(rootResponse.headers['x-content-type-options'],'nosniff');assert.match(rootResponse.headers['strict-transport-security'],/31536000/);
 });
 const farm=ok(await request('POST','/api/admin/farms',{farmName:'Production fixture farm',businessType:'all',username:'release.owner',password},root));
 const owner=(await login('release.owner')).headers['set-cookie'].split(';')[0];
 await check('reviewed owner-only profile runs real guarded SQL and safe owner exports',async()=>{
  ok(await request('POST','/api/db/get',{sql:'SELECT farm_id,farm_name FROM farms',params:[]},owner));assert.equal(ok(await request('GET','/api/account/entitlement',undefined,owner)).active,true);
  const exportResult=await request('GET','/api/account/export',undefined,owner);assert.equal(exportResult.statusCode,200);assert.equal(exportResult.json().farm.farm_id,farm.farmId);
  assert.equal((await request('POST','/api/db/run',{sql:'DELETE FROM products',deleteAuthorized:true},owner)).json().success,false);
 });
 await check('concurrent owner reads stay scoped and bounded, and readiness checks both pools',async()=>{
  const start=Date.now(),results=await Promise.all(Array.from({length:20},()=>request('POST','/api/db/get',{sql:'SELECT farm_id,farm_name FROM farms',params:[]},owner)));
  assert.ok(results.every(r=>r.statusCode===200));assert.ok(results.some(r=>r.json().success));for(const r of results)if(r.json().success)assert.ok(r.json().data.every(row=>row.farm_id===farm.farmId));
  assert.equal((await app.inject({method:'GET',url:'/api/ready'})).statusCode,200);console.log('  Concurrent smoke: 20 reads in '+(Date.now()-start)+'ms');
 });
 await check('platform metadata administration never grants a platform business SQL bypass',async()=>{assert.equal((await request('POST','/api/db/get',{sql:'SELECT * FROM products'},root)).statusCode,403);});
 await check('staff remain denied in the production owner-only profile',async()=>{
  const meta=ok(await request('GET','/api/admin/farms/'+farm.farmId,undefined,root)).farm;
  ok(await request('PUT','/api/admin/farms/'+farm.farmId,{farmName:meta.farm_name,businessType:meta.business_type,status:'active',seatLimit:1,allowStaffCreation:false,expectedVersion:meta.admin_version},root));
  ok(await request('POST',`/api/admin/farms/${farm.farmId}/staff`,{username:'release.staff',password},root));const staff=(await login('release.staff')).headers['set-cookie'].split(';')[0];
  assert.equal((await request('POST','/api/db/get',{sql:'SELECT 1',role:'farm_admin'},staff)).statusCode,403);assert.equal((await request('GET','/api/account/export',undefined,staff)).statusCode,403);
 });
 await check('unexpected private-role business grants are detected as deployment drift',async()=>{
  await f.pool.query(`GRANT SELECT ON ${f.schema}.expenses TO ${roles[0]}`);await assert.rejects(attestAuthRole(auth,{schema:f.schema}),/business/);await f.pool.query(`REVOKE SELECT ON ${f.schema}.expenses FROM ${roles[0]}`);await attestAuthRole(auth,{schema:f.schema});
 });
 console.log('ALL CHECKS PASSED — '+passed+' owner-release security scenarios');
}finally{await app?.close();await auth?.end();await runtime?.end();await f.pool.query(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();const pool=new Pool({connectionString:process.env.DATABASE_URL});try{for(const role of created)await pool.query('DROP ROLE '+role);}finally{await pool.end();}}
