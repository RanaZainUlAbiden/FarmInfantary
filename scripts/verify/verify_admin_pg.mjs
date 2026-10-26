import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createScratchDb,loadEnv} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {bootstrapSuperAdmin} from '../../server/src/auth/bootstrap.js';
import {buildServer} from '../../server/src/server.js';
import {provisionAuthRole,attestAuthRole} from '../../db/auth-role.mjs';
import {createRequire} from 'node:module';
if(!loadEnv())throw new Error('DATABASE_URL required');
const f=await createScratchDb('admin'),q=(sql,params=[])=>f.pool.query(sql,params),password='admin workflow verification password';
const origin='http://localhost:4200',env={...process.env,NODE_ENV:'development',AUTH_MODE:'session',APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex')};
let app,authPool,authCreated=false,root,ownerCookie,staffCookie,farmId,ownerId,staffId,passed=0;const revoked=[];
const authRole='vp_auth_'+randomBytes(6).toString('hex');
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const req=(method,url,payload,cookie=root,headers={})=>app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{origin,...(cookie?{cookie}:{}),...headers}});
const ok=r=>{assert.equal(r.statusCode,200,r.body);assert.equal(r.json().success,true,r.body);return r.json();};
const login=async(username,secret=password)=>{const r=await req('POST','/api/auth/login',{username,password:secret},null);ok(r);return r.headers['set-cookie'].split(';')[0];};
const farms=async()=>ok(await req('GET','/api/admin/farms')).farms;
const currentFarm=async()=> (await farms()).find(x=>x.farm_id===farmId);
const currentUser=async()=>ok(await req('GET',`/api/admin/farms/${farmId}/users`)).users.find(u=>u.user_id===staffId);
const saveFarm=async overrides=>{const a=await currentFarm();return req('PUT',`/api/admin/farms/${farmId}`,{farmName:a.farm_name,businessType:a.business_type,status:a.status,seatLimit:a.staff_seat_limit,allowStaffCreation:a.can_admin_add_staff===1,expectedVersion:a.admin_version,...overrides});};
try {
 await q(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
 await migrate(f.pool,{schema:f.schema,historySchema:f.schema+'_meta',baseline:true});
 await bootstrapSuperAdmin(f.pool,'admin.root',password);
 const authPassword=randomBytes(32).toString('base64url');await provisionAuthRole(f.pool,{role:authRole,password:authPassword,schema:f.schema});authCreated=true;
 const url=new URL(process.env.DATABASE_URL);url.username=authRole;url.password=authPassword;url.search='';const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');authPool=new Pool({connectionString:url.toString(),max:4});await attestAuthRole(authPool,{schema:f.schema});
 ({app}=await buildServer({env,pool:authPool,authOptions:{onRevokeUser:async id=>revoked.push(id)}}));root=await login('admin.root');
 await check('private auth login has no business access, audit mutation or credential reset via role reuse',async()=>{
  await assert.rejects(authPool.query('SELECT * FROM expenses'));await assert.rejects(authPool.query('DELETE FROM audit_events'));await assert.rejects(authPool.query('SELECT password_hash FROM farms'));
  await assert.rejects(provisionAuthRole(f.pool,{role:authRole,password:randomBytes(32).toString('base64url'),schema:f.schema}),/already exists/);
 });
 await check('admin endpoints require cookie identity and same origin without leaking errors',async()=>{
  assert.equal((await req('GET','/api/admin/farms',undefined,null)).statusCode,401);
  assert.equal((await req('POST','/api/admin/farms',{},{origin:'https://evil.example'})).statusCode,401); // malformed cookie is not an identity
  assert.equal((await req('POST','/api/admin/farms',{},root,{origin:'https://evil.example'})).statusCode,403);
  assert.equal((await req('GET','/api/admin/farms',undefined,root,{'x-fi-session-context':'999:platform'})).statusCode,409);
 });
 await check('new farm and its Argon2id owner are provisioned atomically with zero staff seats',async()=>{
  const r=ok(await req('POST','/api/admin/farms',{farmName:'Admin QA Farm',businessType:'all',username:'admin.owner',password}));farmId=r.farmId;ownerId=r.user.user_id;
  assert.equal(r.user.role,'farm_admin');assert.ok(!JSON.stringify(r).includes('password_hash'));
  const a=await currentFarm();assert.equal(a.staff_seat_limit,0);assert.equal(a.can_admin_add_staff,0);
  assert.match((await q('SELECT password_hash FROM users WHERE user_id=$1',[ownerId])).rows[0].password_hash,/^\$argon2id\$/);
  ownerCookie=await login('admin.owner');
 });
 await check('duplicate usernames roll back farm creation and its audit event',async()=>{
  const before=(await farms()).length,events=Number((await q('SELECT count(*) AS n FROM audit_events')).rows[0].n);
  assert.equal((await req('POST','/api/admin/farms',{farmName:'Rollback Farm',businessType:'broiler',username:'admin.owner',password})).statusCode,409);
  assert.equal((await farms()).length,before);assert.equal(Number((await q('SELECT count(*) AS n FROM audit_events')).rows[0].n),events);
 });
 await check('farm admins cannot call platform endpoints or grant themselves delegation',async()=>{
  for(const path of ['/api/admin/farms','/api/admin/permissions','/api/admin/audit'])assert.equal((await req('GET',path,undefined,ownerCookie)).statusCode,403);
  assert.equal((await req('POST','/api/account/staff',{username:'forged.staff',password,role:'super_admin'},ownerCookie)).statusCode,400);
  assert.equal((await req('POST','/api/account/staff',{username:'delegation.denied',password},ownerCookie)).statusCode,403);
 });
 await check('zero seat quota is enforced for platform creation too',async()=>{
  assert.equal((await req('POST',`/api/admin/farms/${farmId}/staff`,{username:'quota.denied',password})).statusCode,409);
 });
 await check('quota and delegated creation are explicit and metadata updates reject stale revisions',async()=>{
  const old=await currentFarm();ok(await saveFarm({seatLimit:2,allowStaffCreation:true}));
  assert.equal((await saveFarm({expectedVersion:old.admin_version,seatLimit:99})).statusCode,409);
  const r=ok(await req('POST','/api/account/staff',{username:'admin.staff',password},ownerCookie));staffId=r.user.user_id;staffCookie=await login('admin.staff');
  const team=ok(await req('GET','/api/account/staff',undefined,ownerCookie));assert.equal(team.farm.active_staff,1);assert.equal(team.users.length,1);
 });
 await check('delegated creation derives farm and role from the session and staff cannot administer',async()=>{
  assert.equal((await req('POST','/api/account/staff',{username:'spoof.staff',password,farmId:999},ownerCookie)).statusCode,400);
  assert.equal((await req('GET','/api/account/staff',undefined,staffCookie)).statusCode,403);
  assert.equal((await req('GET','/api/admin/farms',undefined,staffCookie)).statusCode,403);
 });
 await check('permission assignment is validated, audited and immediately revokes the affected device',async()=>{
  const u=await currentUser();
  assert.equal((await req('PUT',`/api/admin/users/${staffId}/permissions`,{expectedVersion:u.auth_version,grants:[{key:'invented',view:true,create:false,edit:false,delete:false}]})).statusCode,400);
  ok(await req('PUT',`/api/admin/users/${staffId}/permissions`,{expectedVersion:u.auth_version,grants:[{key:'distribution.inventory',view:true,create:false,edit:false,delete:false}]}));
  assert.ok(revoked.includes(staffId));assert.equal((await req('GET','/api/auth/me',undefined,staffCookie)).statusCode,401);
  const grants=ok(await req('GET',`/api/admin/users/${staffId}/permissions`));assert.equal(grants.grants.length,1);
 });
 await check('unchanged permission saves keep sessions and stale editors cannot overwrite newer grants',async()=>{
  staffCookie=await login('admin.staff');const u=await currentUser(),payload={expectedVersion:u.auth_version,grants:[{key:'distribution.inventory',view:true,create:false,edit:false,delete:false}]};
  assert.equal(ok(await req('PUT',`/api/admin/users/${staffId}/permissions`,payload)).changed,false);ok(await req('GET','/api/auth/me',undefined,staffCookie));
  assert.equal((await req('PUT',`/api/admin/users/${staffId}/permissions`,{...payload,expectedVersion:u.auth_version-1})).statusCode,409);
 });
 await check('lowering quota below usage is allowed and blocks new active staff',async()=>{
  ok(await saveFarm({seatLimit:0}));assert.equal((await req('POST',`/api/admin/farms/${farmId}/staff`,{username:'quota.full',password})).statusCode,409);
 });
 await check('suspension frees seats and reactivation must acquire a seat',async()=>{
  let u=await currentUser();ok(await req('PUT',`/api/admin/users/${staffId}/status`,{expectedVersion:u.auth_version,status:'suspended'}));
  u=await currentUser();assert.equal((await req('PUT',`/api/admin/users/${staffId}/status`,{expectedVersion:u.auth_version,status:'active'})).statusCode,409);
  ok(await saveFarm({seatLimit:1}));ok(await req('PUT',`/api/admin/users/${staffId}/status`,{expectedVersion:u.auth_version,status:'active'}));
 });
 await check('concurrent insertions cannot exceed the row-locked quota',async()=>{
  ok(await saveFarm({seatLimit:3}));const hash=(await q('SELECT password_hash FROM users WHERE user_id=$1',[staffId])).rows[0].password_hash;
  const results=await Promise.allSettled(Array.from({length:10},(_,i)=>q("INSERT INTO users(farm_id,username,password_hash,role) VALUES($1,$2,$3,'staff')",[farmId,'race.staff.'+i,hash])));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await currentFarm()).active_staff,3);
 });
 await check('disabling delegation takes effect on the next create request',async()=>{
  ok(await saveFarm({allowStaffCreation:false,seatLimit:4}));assert.equal((await req('POST','/api/account/staff',{username:'delegation.revoked',password},ownerCookie)).statusCode,403);
 });
 await check('password resets revoke devices and never put passwords or hashes in audit JSON',async()=>{
  staffCookie=await login('admin.staff');const u=await currentUser();ok(await req('POST',`/api/admin/users/${staffId}/password`,{expectedVersion:u.auth_version,password:'replacement workflow password'}));
  assert.equal((await req('GET','/api/auth/me',undefined,staffCookie)).statusCode,401);
  const events=ok(await req('GET','/api/admin/audit')).events;assert.ok(events.some(e=>e.action==='user.password'));assert.ok(!JSON.stringify(events).includes(password));assert.ok(!JSON.stringify(events).includes('argon2'));
 });
 await check('suspending a farm revokes all farm sessions and reactivation does not revive old cookies',async()=>{
  ok(await saveFarm({status:'suspended'}));assert.equal((await req('GET','/api/auth/me',undefined,ownerCookie)).statusCode,401);
  ok(await saveFarm({status:'active'}));assert.equal((await req('GET','/api/auth/me',undefined,ownerCookie)).statusCode,401);ownerCookie=await login('admin.owner');
 });
 await check('audit failure rolls back the entire mutation and returns sanitized failure',async()=>{
  await q("CREATE FUNCTION fail_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE AUDIT DETAILS'; END; $$");
  await q('CREATE TRIGGER fail_audit_fixture BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit_fixture()');
  const count=(await farms()).length,r=await req('POST','/api/admin/farms',{farmName:'Atomic rollback',businessType:'all',username:'audit.rollback',password});
  assert.equal(r.statusCode,503);assert.ok(!r.body.includes('PRIVATE'));assert.equal((await farms()).length,count);
  assert.equal((await q("SELECT count(*)::int AS n FROM users WHERE username='audit.rollback'")).rows[0].n,0);await q('DROP TRIGGER fail_audit_fixture ON audit_events');
 });
 await check('platform owner cannot be suspended or reset through tenant user routes and cannot enter SQL',async()=>{
  const id=(await q("SELECT user_id FROM users WHERE role='super_admin'")).rows[0].user_id;
  assert.equal((await req('PUT',`/api/admin/users/${id}/status`,{expectedVersion:1,status:'suspended'})).statusCode,404);
  assert.equal((await req('POST','/api/db/get',{sql:'SELECT * FROM users'})).statusCode,403);
  assert.equal((await req('GET','/api/admin/farms?limit=100000')).json().farms.length,1);
 });
 await check('farm owners can prepare all 50 screen grants for their own staff without platform access',async()=>{
  const catalogue=ok(await req('GET','/api/account/permissions',undefined,ownerCookie));assert.equal(catalogue.permissions.length,50);
  const before=ok(await req('GET',`/api/account/staff/${staffId}/permissions`,undefined,ownerCookie));assert.equal(before.user.farm_id,farmId);
  staffCookie=await login('admin.staff','replacement workflow password');
  const payload={expectedVersion:before.user.auth_version,grants:[{key:'broiler.income',view:true,create:true,edit:false,delete:false}]};
  ok(await req('PUT',`/api/account/staff/${staffId}/permissions`,payload,ownerCookie));
  assert.equal((await req('GET','/api/auth/me',undefined,staffCookie)).statusCode,401);
  const after=ok(await req('GET',`/api/account/staff/${staffId}/permissions`,undefined,ownerCookie));
  assert.equal(after.grants.length,1);assert.equal(after.grants[0].permission_key,'broiler.income');assert.equal(after.grants[0].can_create,1);
  assert.equal((await req('PUT',`/api/account/staff/${staffId}/permissions`,payload,ownerCookie)).statusCode,409);
  assert.equal((await req('GET','/api/admin/permissions',undefined,ownerCookie)).statusCode,403);
 });
 await check('owner grant routes reject spoofed identities, invalid flags, unknown keys and stale contexts',async()=>{
  const before=await currentUser(),path=`/api/account/staff/${staffId}/permissions`,grant={key:'broiler.income',view:true,create:false,edit:false,delete:false};
  for(const grants of [[{...grant,key:'invented'}],[{...grant,view:false,create:true}],[grant,grant],[{...grant,delete:1}]])
   assert.equal((await req('PUT',path,{expectedVersion:before.auth_version,grants},ownerCookie)).statusCode,400);
  assert.equal((await req('PUT',path,{expectedVersion:before.auth_version,grants:[grant],farmId:999},ownerCookie)).statusCode,400);
  assert.equal((await req('GET',path,undefined,ownerCookie,{'x-fi-session-context':'999:999'})).statusCode,409);
  assert.equal((await currentUser()).auth_version,before.auth_version);
 });
 await check('owners cannot read or mutate another farm staff, themselves or platform administrators',async()=>{
  const other=ok(await req('POST','/api/admin/farms',{farmName:'Other staff farm',businessType:'all',username:'other.owner',password}));
  await q('UPDATE farms SET staff_seat_limit=1 WHERE farm_id=$1',[other.farmId]);
  const otherStaff=ok(await req('POST',`/api/admin/farms/${other.farmId}/staff`,{username:'other.staff',password})).user;
  const rootId=(await q("SELECT user_id FROM users WHERE role='super_admin'")).rows[0].user_id;
  for(const targetId of [otherStaff.user_id,ownerId,rootId]){
   const base=`/api/account/staff/${targetId}`;
   assert.equal((await req('GET',base+'/permissions',undefined,ownerCookie)).statusCode,404);
   assert.equal((await req('PUT',base+'/permissions',{expectedVersion:1,grants:[]},ownerCookie)).statusCode,404);
   assert.equal((await req('PUT',base+'/status',{expectedVersion:1,status:'suspended'},ownerCookie)).statusCode,404);
   assert.equal((await req('POST',base+'/password',{expectedVersion:1,password},ownerCookie)).statusCode,404);
  }
  const unchanged=(await q('SELECT status,auth_version FROM users WHERE user_id=$1',[otherStaff.user_id])).rows[0];assert.equal(unchanged.status,'active');assert.equal(unchanged.auth_version,1);
 });
 await check('owners can suspend and reset own staff; staff cannot administer or run prepared business grants',async()=>{
  staffCookie=await login('admin.staff','replacement workflow password');
  assert.equal((await req('GET','/api/account/permissions',undefined,staffCookie)).statusCode,403);
  assert.equal((await req('GET',`/api/account/staff/${staffId}/permissions`,undefined,staffCookie)).statusCode,403);
  let u=await currentUser();ok(await req('PUT',`/api/account/staff/${staffId}/status`,{expectedVersion:u.auth_version,status:'suspended'},ownerCookie));
  assert.equal((await req('GET','/api/auth/me',undefined,staffCookie)).statusCode,401);
  u=await currentUser();ok(await req('PUT',`/api/account/staff/${staffId}/status`,{expectedVersion:u.auth_version,status:'active'},ownerCookie));
  u=await currentUser();ok(await req('POST',`/api/account/staff/${staffId}/password`,{expectedVersion:u.auth_version,password},ownerCookie));
  staffCookie=await login('admin.staff');assert.equal((await req('POST','/api/db/get',{sql:'SELECT * FROM income',params:[]},staffCookie)).statusCode,503); // This metadata-only fixture has no runtime pool.
  const events=ok(await req('GET','/api/admin/audit')).events;assert.ok(events.some(e=>e.actor_id===ownerId&&e.action==='user.permissions'));assert.ok(!JSON.stringify(events).includes(password));
 });
 console.log('ALL CHECKS PASSED — '+passed+' admin provisioning/seat/audit scenarios');
} finally {await app?.close();await authPool?.end();await q(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();if(authCreated){const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg'),p=new Pool({connectionString:process.env.DATABASE_URL});try{await p.query('DROP ROLE '+authRole);}finally{await p.end();}}}
