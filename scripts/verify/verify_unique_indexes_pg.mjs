// [Codex] Exercise the real 002 upgrade and its failure/rollback contract.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createScratchDb,loadEnv} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
if(!loadEnv())throw new Error('DATABASE_URL is required to verify unique indexes');
const fixtures=[];
async function fixture(label){
 const f=await createScratchDb(label,{farmContext:1});fixtures.push(f);
 await f.pool.query(readFileSync(new URL('../../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
 return f;
}
async function run(f,sql,params=[]){const r=await f.db.run(sql,params);assert.ok(r.success,r.error);return r;}
async function runAsFarm(f,farm,sql){
 const tx=await f.db.begin();assert.ok(tx.success,tx.error);
 try{assert.ok((await f.db.get("SELECT set_config('app.farm_id',?,true)",[String(farm)],tx.token)).success);
 const r=await f.db.run(sql,[],tx.token);assert.ok(r.success,r.error);assert.ok((await f.db.commit(tx.token)).success);}
 finally{await f.db.rollback(tx.token);}
}
async function count(f,sql){const r=await f.db.get(sql);assert.ok(r.success,r.error);return Object.values(r.data[0])[0];}
let passed=0;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
try{
 const f=await fixture('unique_indexes');
 const options={schema:f.schema,historySchema:f.schema+'_meta'};
 await check('unversioned 001 baseline upgrades through immutable 002',async()=>{
  const r=await migrate(f.pool,{...options,baseline:true});assert.deepEqual(r.applied,['002_preserve_unique_indexes.sql','003_authentication.sql','004_tenant_isolation.sql','005_staff_permissions.sql','006_admin_seats_audit.sql','007_delete_authorization.sql','008_broker_ledgers.sql','009_broker_history_protection.sql','010_broker_workflow_boundary.sql']);assert.equal(r.version,10);
 });
 await check('three unique indexes include NOCASE and the partial predicate',async()=>{
  const r=await f.pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('idx_expense_categories_unique','idx_layer_health_source','idx_categories_farm_type_name')",[f.schema]);
  assert.equal(r.rows.length,3);assert.ok(r.rows.every(r=>/CREATE UNIQUE INDEX/.test(r.indexdef)));
  assert.match(r.rows.find(r=>r.indexname==='idx_expense_categories_unique').indexdef,/COLLATE (?:public\.)?nocase/);
  assert.match(r.rows.find(r=>r.indexname==='idx_layer_health_source').indexdef,/WHERE \(source_mortality_id IS NOT NULL\)/);
 });
 await check('case-insensitive category duplicates fail at the database boundary',async()=>{
  await run(f,"INSERT INTO expense_categories(farm_id,category_name) VALUES(1,'Household')");
  assert.equal((await f.db.run("INSERT INTO expense_categories(farm_id,category_name) VALUES(1,'household')")).success,false);
  assert.equal(await count(f,'SELECT COUNT(*) FROM expense_categories'),1);
 });
 await check('same category name is allowed for a different account',async()=>{await runAsFarm(f,2,"INSERT INTO expense_categories(farm_id,category_name) VALUES(2,'household')");});
 await check('one source mortality row cannot generate duplicate layer health rows',async()=>{
  await run(f,'INSERT INTO layer_health(batch_id,day_number,source_mortality_id) VALUES(1,1,7)');
  assert.equal((await f.db.run('INSERT INTO layer_health(batch_id,day_number,source_mortality_id) VALUES(1,2,7)')).success,false);
 });
 await check('multiple manual layer health rows with NULL sources are allowed',async()=>{await run(f,'INSERT INTO layer_health(batch_id,day_number) VALUES(1,3),(1,4)');});
 await check('category uniqueness includes account and category type',async()=>{
  await run(f,"INSERT INTO categories(farm_id,category_name,category_type) VALUES(1,'Feed','product')");
  assert.equal((await f.db.run("INSERT INTO categories(farm_id,category_name,category_type) VALUES(1,'Feed','product')")).success,false);
  await run(f,"INSERT INTO categories(farm_id,category_name,category_type) VALUES(1,'Feed','expense')");
  await runAsFarm(f,2,"INSERT INTO categories(farm_id,category_name,category_type) VALUES(2,'Feed','product')");
 });
 await check('repeating the production migration applies nothing',async()=>{assert.deepEqual((await migrate(f.pool,options)).applied,[]);});
 const dirty=await fixture('unique_rollback');
 await run(dirty,"INSERT INTO expense_categories(farm_id,category_name) VALUES(1,'Household'),(1,'household')");
 await check('duplicate data aborts upgrade without deleting rows or old indexes',async()=>{
  await assert.rejects(migrate(dirty.pool,{schema:dirty.schema,historySchema:dirty.schema+'_meta',baseline:true}),/unique|duplicat/i);
  assert.equal(await count(dirty,'SELECT COUNT(*) FROM expense_categories'),2);
  const r=await dirty.pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',[dirty.schema,'idx_expense_categories_unique']);
  assert.equal(r.rows.length,1);assert.ok(!r.rows[0].indexdef.includes('UNIQUE'));
 });
 console.log(`ALL CHECKS PASSED — ${passed} unique-index scenarios`);
}finally{
 for(const f of fixtures.reverse()){await f.pool.query(`DROP SCHEMA IF EXISTS ${f.schema}_meta CASCADE`);await f.close();}
}
