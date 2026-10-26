// [Codex] Real private grant storage, revocation and runtime denial. Does not
// activate staff SQL: incomplete observations never become grant authority.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {loadEnv,createScratchDb} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {createAuthStore} from '../../server/src/auth/store.js';
import {authConfig} from '../../server/src/auth/config.js';
import {loadStaffPermissions} from '../../server/src/auth/permissions.js';
import {buildServer} from '../../server/src/server.js';
import {hashPassword} from '../../server/src/auth/password.js';
import {currentCatalogue} from '../../tools/permission-catalogue.mjs';
if(!loadEnv())throw new Error('DATABASE_URL is required for staff permission verification');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');
const f=await createScratchDb('staff_permissions'),q=(text,values=[])=>f.pool.query(text,values);
const role='vp_permissions_'+randomBytes(6).toString('hex'),password=randomBytes(32).toString('base64url');
const origin='http://localhost:4200',env={...process.env,NODE_ENV:'development',AUTH_MODE:'session',APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex'),DATABASE_SCHEMA:f.schema};
let runtime,app,created=false,passed=0,staff,other,owner,admin,store;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const user=async id=>(await q('SELECT * FROM users WHERE user_id=$1',[id])).rows[0];
const issue=async id=>store.issue(await user(id));
const grant=(id=staff,farm=1,key='distribution.receive-voucher',flags=[1,1,0,0])=>q('INSERT INTO user_permissions(user_id,farm_id,permission_key,can_view,can_create,can_edit,can_delete) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,farm,key,...flags]);
const revokeAll=()=>q('DELETE FROM user_permissions');
try {
 await q(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
 const installed=await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta',baseline:true});
 await check('migration 005 installs the exact generated 50-key catalogue without adding foreign keys',async()=>{
  assert.equal(installed.version,7);
  const rows=(await q('SELECT permission_key AS key,module,route,label FROM permission_catalogue ORDER BY permission_key')).rows;
  assert.deepEqual(rows,currentCatalogue().entries.map(({key,module,route,label})=>({key,module,route,label})).sort((a,b)=>a.key.localeCompare(b.key)));
  assert.equal((await q("SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'",[f.schema])).rows[0].n,0);
 });
 await q("INSERT INTO farms(farm_id,farm_name,password_hash,business_type) VALUES(1,'Permissions A','unused','all'),(2,'Permissions B','unused','all')");
 await q('UPDATE farms SET staff_seat_limit=10');
 const hash=await hashPassword('permission verification password');
 for(const [name,farm,kind] of [['perm.staff',1,'staff'],['perm.other',2,'staff'],['perm.owner',1,'farm_admin'],['perm.admin',null,'super_admin']]) {
  const id=(await q('INSERT INTO users(username,farm_id,role,password_hash) VALUES($1,$2,$3,$4) RETURNING user_id',[name,farm,kind,hash])).rows[0].user_id;
  if(kind==='farm_admin')owner=id;else if(kind==='super_admin')admin=id;else if(farm===1)staff=id;else other=id;
 }
 store=createAuthStore(f.pool,authConfig(env));
 await check('new staff have no grants and the snapshot requires a current positive server actor',async()=>{
  const {actor}=await issue(staff);const snapshot=await loadStaffPermissions(f.pool,actor);assert.deepEqual(snapshot.grants,[]);assert.ok(Object.isFrozen(snapshot.grants));
  for(const actor of [null,{userId:staff,farmId:1,authVersion:1,role:'farm_admin'},{userId:-1,farmId:1,authVersion:1,role:'staff'}])assert.equal(await loadStaffPermissions(f.pool,actor),null);
 });
 await check('unknown, cross-farm, orphan and non-staff grant targets are rejected',async()=>{
  for(const args of [[staff,2],[other,1],[99999,1],[owner,1],[admin,1],[staff,1,'distribution.invented']])await assert.rejects(grant(...args));
  assert.equal((await q('SELECT count(*)::int AS n FROM user_permissions')).rows[0].n,0);
 });
 await check('grant flags are integer 0/1 and mutation flags require view access',async()=>{
  for(const flags of [[2,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1],[-1,0,0,0]])await assert.rejects(grant(staff,1,'distribution.receive-voucher',flags));
 });
 await check('grant creation revokes existing device cookies and an old actor snapshot',async()=>{
  const a=await issue(staff),b=await issue(staff);await grant();
  assert.equal(await store.resolveToken(a.token),null);assert.equal(await store.resolveToken(b.token),null);
  assert.equal(await loadStaffPermissions(f.pool,a.actor),null);
  const current=await issue(staff),snapshot=await loadStaffPermissions(f.pool,current.actor);
  assert.deepEqual(snapshot.grants,[{key:'distribution.receive-voucher',view:true,create:true,edit:false,delete:false}]);assert.ok(Object.isFrozen(snapshot.grants[0]));
 });
 await check('grant rows have immutable identity and duplicate keys cannot create broader parallel grants',async()=>{
  await assert.rejects(grant());
  for(const [column,value] of [['user_id',other],['farm_id',2],['permission_key','distribution.payment-voucher']])await assert.rejects(q(`UPDATE user_permissions SET ${column}=$1 WHERE user_id=$2`,[value,staff]));
 });
 await check('no-op saves preserve sessions while an actual permission change expires them',async()=>{
  const a=await issue(staff);await q('UPDATE user_permissions SET can_view=can_view WHERE user_id=$1',[staff]);assert.ok(await store.resolveToken(a.token));
  await q('UPDATE user_permissions SET can_delete=1 WHERE user_id=$1',[staff]);assert.equal(await store.resolveToken(a.token),null);
 });
 await check('revoking and re-granting cannot revive a device cookie',async()=>{
  const a=await issue(staff);await revokeAll();await grant();assert.equal(await store.resolveToken(a.token),null);
 });
 await check('rolled-back grant changes preserve both previous grants and session validity',async()=>{
  const a=await issue(staff),client=await f.pool.connect();
  try {await client.query('BEGIN');await client.query('UPDATE user_permissions SET can_delete=1 WHERE user_id=$1',[staff]);await client.query('ROLLBACK');}finally{client.release();}
  assert.ok(await store.resolveToken(a.token));assert.equal((await loadStaffPermissions(f.pool,a.actor)).grants[0].delete,false);
 });
 await check('one farm user cannot load another user or farm snapshot',async()=>{
  await grant(other,2,'owner.assets',[1,0,0,0]);const a=await issue(staff),b=await issue(other);
  assert.deepEqual((await loadStaffPermissions(f.pool,a.actor)).grants.map(p=>p.key),['distribution.receive-voucher']);
  assert.deepEqual((await loadStaffPermissions(f.pool,b.actor)).grants.map(p=>p.key),['owner.assets']);
  assert.equal(await loadStaffPermissions(f.pool,{...a.actor,farmId:2}),null);
 });
 await check('suspended users and farms have no permission snapshot',async()=>{
  const a=await issue(staff);await q("UPDATE users SET status='suspended' WHERE user_id=$1",[staff]);assert.equal(await loadStaffPermissions(f.pool,a.actor),null);
  await q("UPDATE users SET status='active' WHERE user_id=$1",[staff]);const b=await issue(staff);
  await q("UPDATE farms SET status='suspended' WHERE farm_id=1");assert.equal(await loadStaffPermissions(f.pool,b.actor),null);
  await q("UPDATE farms SET status='active' WHERE farm_id=1");
 });
 await check('moving staff between farms clears old grants and moving back does not restore them',async()=>{
  await q('UPDATE users SET farm_id=2 WHERE user_id=$1',[staff]);await q('UPDATE users SET farm_id=1 WHERE user_id=$1',[staff]);
  assert.equal((await q('SELECT count(*)::int AS n FROM user_permissions WHERE user_id=$1',[staff])).rows[0].n,0);
 });
 await check('role changes clear grants rather than reactivating them when staff status returns',async()=>{
  await grant();await q("UPDATE users SET role='farm_admin' WHERE user_id=$1",[staff]);await q("UPDATE users SET role='staff' WHERE user_id=$1",[staff]);
  assert.deepEqual((await loadStaffPermissions(f.pool,(await issue(staff)).actor)).grants,[]);
 });
 await check('user deletion cleans private grant rows without changing business orphan semantics',async()=>{
  await grant(other,2,'owner.loans',[1,0,0,0]);await q('DELETE FROM users WHERE user_id=$1',[other]);
  assert.equal((await q('SELECT count(*)::int AS n FROM user_permissions WHERE user_id=$1',[other])).rows[0].n,0);
 });
 await provisionRuntimeRole(f.pool,{role,password,schema:f.schema});created=true;
 const url=new URL(process.env.DATABASE_URL);url.username=role;url.password=password;url.search='';runtime=new Pool({connectionString:url.toString(),max:3});
 await check('runtime login cannot read, write or invoke private permission metadata',async()=>{
  for(const table of ['permission_catalogue','user_permissions']) {
   await assert.rejects(runtime.query('SELECT * FROM '+table));await assert.rejects(runtime.query('DELETE FROM '+table));
  }
  assert.equal((await runtime.query("SELECT has_function_privilege(current_user,'validate_staff_permission()','EXECUTE') AS allowed")).rows[0].allowed,false);
 });
 ({app}=await buildServer({env,pool:f.pool,runtimePool:runtime}));
 await check('even fully granted staff cannot use SQL before reviewed operation/module policy is installed',async()=>{
  for(const entry of currentCatalogue().entries)await grant(staff,1,entry.key,[1,1,1,1]);
  const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:'perm.staff',password:'permission verification password'}});assert.equal(login.statusCode,200);
  const cookie=login.headers['set-cookie'].split(';')[0];
  for(const method of ['get','run','batch']) {
   const result=await app.inject({method:'POST',url:'/api/db/'+method,headers:{origin,cookie},payload:{sql:'SELECT * FROM products',permissions:['*'],role:'farm_admin'}});
   assert.equal(result.statusCode,403);
  }
 });
 console.log('ALL CHECKS PASSED — '+passed+' staff permission scenarios');
} finally {
 await app?.close();await runtime?.end();await q(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();
 if(created){const adminPool=new Pool({connectionString:process.env.DATABASE_URL});try{await adminPool.query('DROP ROLE '+role);}finally{await adminPool.end();}}
}
