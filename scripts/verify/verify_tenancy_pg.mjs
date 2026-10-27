// [Codex] Full inherited tenant schema, actual login role, no superuser SET ROLE
// substitute. Isolated schemas/roles are removed even when an assertion fails.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv, createScratchDb } from './lib/pg-harness.mjs';
import { migrate, MIGRATIONS_DIR } from '../../db/migration-runner.mjs';
import { TENANT_TABLES, BUSINESS_TABLES, EXCLUDED_TABLES, FARM_READ_COLUMNS, sqlIdentifier as q } from '../../db/tenant-tables.mjs';
import { provisionRuntimeRole } from '../../db/runtime-role.mjs';
import { attestRuntimeRole } from '../../server/src/db/runtime-role.js';
import { createSessionDb } from '../../server/src/db/session-execute.js';
if (!loadEnv()) throw new Error('DATABASE_URL is required to verify tenancy');
const { Pool } = createRequire(new URL('../../server/package.json', import.meta.url))('pg');
const directory = mkdtempSync(join(tmpdir(), 'farm-tenant-'));
for (const name of ['001_initial_schema.sql','002_preserve_unique_indexes.sql','003_authentication.sql']) copyFileSync(join(MIGRATIONS_DIR,name),join(directory,name));
const fixtures = [], roles = [];
const inheritedTenants=TENANT_TABLES.filter(t=>t!=='broker_payments'),inheritedBusiness=BUSINESS_TABLES.filter(t=>t!=='broker_payments');
let runtime, scoped, passed = 0;
async function fixture(label) {
  const f = await createScratchDb(label); fixtures.push(f);
  await f.pool.query((await import('node:fs')).readFileSync(join(MIGRATIONS_DIR,'001_initial_schema.sql'),'utf8'));
  f.migrations = { schema: f.schema, historySchema: f.schema + '_meta' };
  await migrate(f.pool,{ ...f.migrations, directory, baseline: true });
  return f;
}
async function seed(f, table, overrides = {}) {
  const columns = (await f.pool.query(`SELECT column_name,data_type,is_nullable,column_default,is_identity
    FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,[f.schema,table])).rows;
  const data = { ...overrides };
  for (const c of columns) if (!(c.column_name in data) && c.is_nullable==='NO' && c.column_default==null && c.is_identity==='NO') {
    data[c.column_name] = c.data_type==='text' ? 'fixture' : 1;
  }
  const names = Object.keys(data);
  return (await f.pool.query(`INSERT INTO ${q(table)}(${names.map(q).join(',')}) VALUES(${names.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(data))).rows[0];
}
const ok = result => { assert.equal(result.success,true,result.error); return result; };
const no = result => { assert.equal(result.success,false); return result; };
const check = async (label, fn) => { await fn(); passed++; console.log('  PASS  '+label); };
try {
  const f = await fixture('tenant');
  const original = (await f.pool.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema=$1 ORDER BY table_name,ordinal_position`,[f.schema])).rows;
  const inherited = (await f.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1',[f.schema])).rows.map(r=>r.table_name);
  await seed(f,'farms',{farm_id:1,farm_name:'Farm A',password_hash:'unused'});
  await seed(f,'farms',{farm_id:2,farm_name:'Farm B',password_hash:'unused'});
  for (const table of inheritedBusiness) {
    if (!original.some(c=>c.table_name===table && c.column_name==='farm_id')) continue;
    await seed(f,table,{farm_id:table==='batches'?2:1});
  }
  const moduleTables = ['balance','chick_entries','chick_traders','expenses','feed_entries','feed_traders','income','labour_payments','medicine_entries','medicine_traders','sales'];
  for (const table of inheritedBusiness) {
    if (original.some(c=>c.table_name===table && c.column_name==='farm_id') || table==='vaccinations') continue;
    await seed(f,table,moduleTables.includes(table)?{module_type:null}:{});
    if (moduleTables.includes(table)) await seed(f,table,{module_type:'layer'});
  }
  await seed(f,'vaccinations',{flock_id:1,batch_id:null,cost:12.25,bill_id:7,bill_number:'preserve'});
  await seed(f,'vaccinations',{flock_id:null,batch_id:1,cost:7.5});
  await check('schema classification covers exactly 60 inherited tables and excludes platform identities',async()=>{
    assert.equal(inheritedTenants.length,59); assert.equal(inheritedBusiness.length,58);
    assert.deepEqual([...inheritedTenants,'activation'].sort(),inherited.filter(n=>!['users','auth_sessions','auth_login_limits'].includes(n)).sort());
    assert.equal(original.filter(c=>c.column_name==='farm_id' && BUSINESS_TABLES.includes(c.table_name)).length,28);
  });
  await check('migration backfills all 30 missing tenant ownership columns atomically',async()=>{
    const result=await migrate(f.pool,f.migrations); assert.deepEqual(result.applied,['004_tenant_isolation.sql','005_staff_permissions.sql','006_admin_seats_audit.sql','007_delete_authorization.sql','008_broker_ledgers.sql','009_broker_history_protection.sql','010_broker_workflow_boundary.sql','011_broker_payment_destinations.sql','012_broker_destination_history.sql']); assert.equal(result.version,12);
    const n=Number((await f.pool.query(`SELECT count(*) FROM information_schema.columns WHERE table_schema=$1
      AND table_name=ANY($2) AND column_name='farm_id' AND is_nullable='NO'`,[f.schema,TENANT_TABLES])).rows[0].count);
    assert.equal(n,60);
    // This API-only table intentionally refused the generic raw insert below.
    // Seed actual protected rows so subsequent UPDATE isolation checks exercise
    // rows rather than treating a zero-row UPDATE as an ownership refusal.
    const brokerClient=await f.pool.connect();try{
      await brokerClient.query('BEGIN');
      for(const tenant of [1,2]){
        await brokerClient.query("SELECT set_config('app.farm_id',$1,true),set_config('app.broker_workflow','on',true)",[String(tenant)]);
        await brokerClient.query("INSERT INTO broker_payments(broker_id,flock_id,sale_id,date,amount,method,request_id,request_hash) VALUES(1,1,1,'2026-10-27',1,'cash',$1,'fixture')",['tenant-fixture-'+tenant]);
      }
      await brokerClient.query('COMMIT');
    }finally{brokerClient.release();}
  });
  await check('module backfill distinguishes colliding flock/batch IDs and legacy NULL broiler rows',async()=>{
    for(const table of moduleTables) {
      const rows=(await f.pool.query(`SELECT farm_id,module_type FROM ${q(table)} ORDER BY farm_id`)).rows;
      assert.deepEqual(rows,[{farm_id:1,module_type:null},{farm_id:2,module_type:'layer'}]);
    }
    assert.equal((await f.pool.query('SELECT farm_id FROM batch_transactions')).rows[0].farm_id,1);
    assert.equal((await f.pool.query('SELECT farm_id FROM batches WHERE batch_id=1')).rows[0].farm_id,2);
  });
  await check('vaccination ownership preserves nullable parent fields, costs and billing data',async()=>{
    const rows=(await f.pool.query('SELECT farm_id,flock_id,batch_id,cost,bill_id,bill_number FROM vaccinations ORDER BY vaccination_id')).rows;
    assert.deepEqual(rows,[{farm_id:1,flock_id:1,batch_id:null,cost:12.25,bill_id:7,bill_number:'preserve'},
      {farm_id:2,flock_id:null,batch_id:1,cost:7.5,bill_id:null,bill_number:null}]);
  });
  await check('60 tenant policies are FORCE enabled and index-backed; all 59 business tables have stamp triggers',async()=>{
    const rows=(await f.pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2)`,[f.schema,TENANT_TABLES])).rows;
    assert.equal(rows.length,60); assert.ok(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
    assert.equal(Number((await f.pool.query(`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname='tenant_identity'`,[f.schema])).rows[0].count),59);
  });
  await check('migration changes no existing column types and adds no foreign keys',async()=>{
    const now=(await f.pool.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position`,[f.schema])).rows;
    for(const old of original) assert.deepEqual(now.find(c=>c.table_name===old.table_name&&c.column_name===old.column_name),old);
    assert.equal(Number((await f.pool.query(`SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname=$1 AND c.contype='f'`,[f.schema])).rows[0].count),0);
    assert.deepEqual((await migrate(f.pool,f.migrations)).applied,[]);
  });
  const role='vp_tenant_'+randomBytes(7).toString('hex'), password=randomBytes(32).toString('base64url');
  roles.push(role);
  await check('provisioning creates only the explicit narrow runtime grants and refuses reuse',async()=>{
    await provisionRuntimeRole(f.pool,{role,password,schema:f.schema});
    await assert.rejects(provisionRuntimeRole(f.pool,{role,password,schema:f.schema}),/already exists/);
  });
  const url=new URL(process.env.DATABASE_URL); url.username=role; url.password=password; url.search='';
  runtime=new Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:3000});
  await check('actual direct non-owner login passes runtime attestation',async()=>{
    const result=await attestRuntimeRole(runtime,{schema:f.schema}); assert.equal(result.tenantTables,60); assert.equal(result.businessTables,59);
    assert.equal((await runtime.query('SELECT current_user=session_user AS direct')).rows[0].direct,true);
  });
  await check('runtime attestation rejects overridden search paths and row-security settings',async()=>{
    const client=await runtime.connect();
    const pinned={async connect(){return {query:(...args)=>client.query(...args),release(){}};}};
    try {
      for(const setting of ['SET LOCAL search_path TO public','SET LOCAL row_security TO off']) {
        await client.query('BEGIN'); await client.query(setting);
        await assert.rejects(attestRuntimeRole(pinned,{schema:f.schema}),/overridden/);
        await client.query('ROLLBACK');
      }
    } finally {await client.query('ROLLBACK');client.release();}
  });
  scoped=createSessionDb(runtime,{authorize:()=>true,maxConnections:2}); await scoped.init(); // trusted fixture only
  const A=scoped.forActor({farmId:1,userId:10,authVersion:1,role:'farm_admin',sessionKey:'a'.repeat(64)});
  const B=scoped.forActor({farmId:2,userId:20,authVersion:1,role:'farm_admin',sessionKey:'b'.repeat(64)});
  await check('all 60 tenant tables hide foreign rows without client farm predicates',async()=>{
    for(const table of TENANT_TABLES) {
      const cols=table==='farms'?FARM_READ_COLUMNS.map(q).join(','):'*';
      for(const [scope,id] of [[A,1],[B,2]]) {
        const rows=ok(await scope.get(`SELECT ${cols} FROM ${q(table)}`)).data;
        assert.ok(rows.every(row=>row.farm_id===id),table+' leaked a row');
      }
    }
  });
  await check('missing context returns no rows and rejects business inserts',async()=>{
    assert.equal((await runtime.query('SELECT * FROM products')).rows.length,0);
    await assert.rejects(runtime.query("INSERT INTO products(product_name) VALUES('missing context')"),/context/);
  });
  await check('runtime inserts stamp farm ownership; broker receipts require the trusted workflow',async()=>{
    for(const table of BUSINESS_TABLES) {
      const columns=(await f.pool.query(`SELECT column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,[f.schema,table])).rows;
      const data={};
      for(const c of columns) if(c.column_name!=='farm_id'&&c.is_nullable==='NO'&&c.column_default==null&&c.is_identity==='NO') data[c.column_name]=c.data_type==='text'?'runtime-'+table:1;
      if(table==='app_settings') data.key='runtime';
      if(table==='broker_payments') data.method='cash';
      const names=Object.keys(data);
      const sql=`INSERT INTO ${q(table)}(${names.map(q).join(',')}) VALUES(${names.map(()=>'?').join(',')}) RETURNING farm_id`;
      if(table==='broker_payments'){no(await A.get(sql,Object.values(data)));continue;}
      const result=ok(await A.get(sql,Object.values(data))); assert.equal(result.data[0].farm_id,1,table);
    }
  });
  await check('forged insert ownership and UPDATE rehoming are rejected for every business table',async()=>{
    for(const table of BUSINESS_TABLES) no(await A.run(`UPDATE ${q(table)} SET farm_id=2`));
    no(await A.run("INSERT INTO products(farm_id,product_name) VALUES(2,'forged')"));
    no(await A.run("UPDATE products SET farm_id=NULL"));
  });
  await check('cross-tenant UPDATE and DELETE with known IDs affect no foreign rows',async()=>{
    const before=(await f.pool.query('SELECT count(*) AS n FROM batches WHERE farm_id=2')).rows[0].n;
    ok(await A.run("UPDATE batches SET batch_name='intruder' WHERE batch_id=1"));
    ok(await A.run('DELETE FROM batches WHERE batch_id=1'));
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM batches WHERE farm_id=2')).rows[0].n,before);
    assert.notEqual((await f.pool.query('SELECT batch_name FROM batches WHERE batch_id=1')).rows[0].batch_name,'intruder');
  });
  await check('joins, subqueries, CTEs and UNION remain isolated by independent row policies',async()=>{
    for(const sql of [
      'SELECT b.farm_id FROM bills b JOIN bill_items i ON i.bill_id=b.bill_id',
      'SELECT farm_id FROM (SELECT * FROM products) p',
      'WITH p AS (SELECT * FROM products) SELECT farm_id FROM p',
      'SELECT farm_id FROM products UNION ALL SELECT farm_id FROM batches',
    ]) assert.ok(ok(await A.get(sql)).data.every(r=>r.farm_id===1));
  });
  await check('parent deletion preserves child ownership and orphan rows remain editable',async()=>{
    const child=ok(await A.get('SELECT ledger_id,farm_id FROM bank_ledger LIMIT 1')).data[0];
    ok(await A.run('DELETE FROM bank_accounts WHERE bank_id=1'));
    ok(await A.run("UPDATE bank_ledger SET description='orphan retained' WHERE ledger_id=?",[child.ledger_id]));
    assert.equal(ok(await A.get('SELECT farm_id FROM bank_ledger WHERE ledger_id=?',[child.ledger_id])).data[0].farm_id,1);
    ok(await A.run("INSERT INTO customer_payments(customer_id,date,amount) VALUES(999999,'2026-10-26',1)"));
  });
  await check('platform/license tables, private metadata accessor and farm credentials are inaccessible',async()=>{
    for(const table of EXCLUDED_TABLES) no(await A.get(`SELECT * FROM ${q(table)}`));
    no(await A.get('SELECT password_hash FROM farms')); no(await A.get('SELECT * FROM farms'));
    no(await A.get('SELECT * FROM auth_farm_metadata(2)'));
    no(await A.run("UPDATE farms SET status='suspended' WHERE farm_id=1"));
    no(await A.run('TRUNCATE products')); no(await A.run('ALTER TABLE products DISABLE ROW LEVEL SECURITY'));
    no(await A.run('CREATE TABLE forbidden(id int)'));
  });
  await check('runtime cannot reset identity sequences or insert explicit business IDs through the executor',async()=>{
    no(await A.run("SELECT setval('products_product_id_seq',1)"));
    no(await A.run("INSERT INTO products(product_id,product_name) VALUES(9000,'explicit')"));
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM products WHERE product_id=9000')).rows[0].n,0);
  });
  await check('private auth metadata reads preserve caller context and reveal no password column',async()=>{
    const client=await f.pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.farm_id','1',true)");
      const row=(await client.query('SELECT * FROM auth_farm_metadata(2)')).rows[0]; assert.equal(row.farm_name,'Farm B'); assert.equal(row.password_hash,undefined);
      assert.equal((await client.query("SELECT current_setting('app.farm_id') AS farm")).rows[0].farm,'1'); await client.query('ROLLBACK');
    } finally {client.release();}
  });
  await check('runtime attestation rejects superuser credentials and disabled tenant policies',async()=>{
    await assert.rejects(attestRuntimeRole(f.pool,{schema:f.schema}),/unprivileged/);
    await f.pool.query('ALTER TABLE products DISABLE ROW LEVEL SECURITY');
    try {await assert.rejects(attestRuntimeRole(runtime,{schema:f.schema}),/protection/);} finally {await f.pool.query('ALTER TABLE products ENABLE ROW LEVEL SECURITY');}
  });
  await check('provisioning validation rolls back the new login and grants before exposing a drifted schema',async()=>{
    const refused='vp_refused_'+randomBytes(7).toString('hex'); roles.push(refused);
    await f.pool.query('CREATE POLICY unsafe_provision ON products USING(true)');
    try {
      await assert.rejects(provisionRuntimeRole(f.pool,{role:refused,password,schema:f.schema}),/policies/);
      assert.equal((await f.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[refused])).rows.length,0);
    } finally {await f.pool.query('DROP POLICY unsafe_provision ON products');}
  });
  await check('attestation rejects permissive policy additions and privileged function grants',async()=>{
    await f.pool.query('CREATE POLICY drift ON products USING(true)');
    try {await assert.rejects(attestRuntimeRole(runtime,{schema:f.schema}),/policies/);} finally {await f.pool.query('DROP POLICY drift ON products');}
    await f.pool.query(`GRANT EXECUTE ON FUNCTION auth_farm_metadata(bigint) TO ${q(role)}`);
    try {await assert.rejects(attestRuntimeRole(runtime,{schema:f.schema}),/privileged/);} finally {await f.pool.query(`REVOKE EXECUTE ON FUNCTION auth_farm_metadata(bigint) FROM ${q(role)}`);}
  });
  await check('attestation rejects leaked platform, sequence and farm credential grants',async()=>{
    for(const [grant,revoke] of [
      [`GRANT SELECT ON users TO ${q(role)}`,`REVOKE SELECT ON users FROM ${q(role)}`],
      [`GRANT UPDATE ON SEQUENCE products_product_id_seq TO ${q(role)}`,`REVOKE UPDATE ON SEQUENCE products_product_id_seq FROM ${q(role)}`],
      [`GRANT SELECT(password_hash) ON farms TO ${q(role)}`,`REVOKE SELECT(password_hash) ON farms FROM ${q(role)}`],
    ]) {await f.pool.query(grant);try {await assert.rejects(attestRuntimeRole(runtime,{schema:f.schema}));} finally {await f.pool.query(revoke);}}
    await attestRuntimeRole(runtime,{schema:f.schema});
  });
  await check('FORCE policies apply to an ordinary table owner without an owner bypass exception',async()=>{
    const owner='vp_owner_'+randomBytes(7).toString('hex'); roles.push(owner);
    const originalOwner=(await f.pool.query('SELECT current_user AS name')).rows[0].name;
    await f.pool.query(`CREATE ROLE ${q(owner)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await f.pool.query(`GRANT USAGE,CREATE ON SCHEMA ${q(f.schema)} TO ${q(owner)}`);
    await f.pool.query(`ALTER TABLE assets OWNER TO ${q(owner)}`);
    const client=await f.pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${q(owner)}`);
      assert.equal((await client.query('SELECT count(*) AS n FROM assets')).rows[0].n,0);
      await client.query("SELECT set_config('app.farm_id','1',true)");
      assert.ok((await client.query('SELECT count(*) AS n FROM assets')).rows[0].n>0);
      await client.query('ROLLBACK');
    } finally {await client.query('ROLLBACK');client.release();await f.pool.query(`ALTER TABLE assets OWNER TO ${q(originalOwner)}`);}
    await attestRuntimeRole(runtime,{schema:f.schema});
  });
  await check('unresolved pre-upgrade orphans abort without deleting rows or recording migration 004',async()=>{
    const dirty=await fixture('tenant_orphan'); await seed(dirty,'bank_ledger',{bank_id:999});
    await assert.rejects(migrate(dirty.pool,dirty.migrations),/unresolved ownership/);
    assert.equal((await dirty.pool.query('SELECT count(*) AS n FROM bank_ledger')).rows[0].n,1);
    assert.equal((await dirty.pool.query(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='bank_ledger' AND column_name='farm_id'`,[dirty.schema])).rows[0].n,0);
    assert.equal((await migrate(dirty.pool,{...dirty.migrations,directory})).version,3);
  });
  await check('conflicting dual-parent vaccinations abort and preserve every original value',async()=>{
    const dirty=await fixture('tenant_conflict'); await seed(dirty,'flocks',{farm_id:1}); await seed(dirty,'batches',{farm_id:2});
    const before=await seed(dirty,'vaccinations',{flock_id:1,batch_id:1,cost:8.75});
    await assert.rejects(migrate(dirty.pool,dirty.migrations),/conflicting vaccination/);
    assert.deepEqual((await dirty.pool.query('SELECT * FROM vaccinations')).rows[0],before);
  });
  console.log(`\nALL CHECKS PASSED — ${passed} full-schema tenancy scenarios`);
} finally {
  await scoped?.close(); await runtime?.end();
  for(const f of fixtures.reverse()) {await f.pool.query(`DROP SCHEMA IF EXISTS ${q(f.schema+'_meta')} CASCADE`);await f.close();}
  const admin=new Pool({connectionString:process.env.DATABASE_URL});
  try {for(const role of roles) await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);} finally {await admin.end();}
  // Exact mkdtemp-owned directory only; no project/user path is computed here.
  rmSync(directory,{recursive:true,force:true});
}
