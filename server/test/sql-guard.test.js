import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'pgsql-parser';
import {createSqlGuard} from '../src/guard/sql-guard.js';
import {readPrepared,sealPrepared} from '../src/db/prepared.js';
const catalog=new Map([
 ['products',{columns:new Set(['farm_id','product_id','product_name','current_stock']),identity:'product_id'}],
 ['bills',{columns:new Set(['farm_id','bill_id','customer_name','total_amount']),identity:'bill_id'}],
 ['farms',{columns:new Set(['farm_id','farm_name','business_type','created_at','status','password_hash']),identity:'farm_id'}],
 ['app_settings',{columns:new Set(['farm_id','key','value']),identity:null}],
]);
const actor={role:'farm_admin',farmId:7};
const guard=createSqlGuard({catalog,maxRows:10,canDelete:async()=>true});
const compile=(sql,params=[],method='get',as=actor)=>guard({actor:as,method,sql,params});
const text=result=>{assert.ok(result);return readPrepared(result.query).text;};

test('prepared capabilities cannot be forged or preserved through JSON/structuredClone',()=>{
 const handle=sealPrepared({text:'SELECT 1',parameterCount:0});assert.ok(readPrepared(handle));
 for(const fake of [{},JSON.parse(JSON.stringify(handle)),structuredClone(handle),{text:'SELECT 1',parameterCount:0}])assert.equal(readPrepared(fake),undefined);
});
test('AST parsing rejects multiple statements, DDL, transaction/context operations and file/network functions',async()=>{
 for(const sql of [
  'SELECT 1; SELECT 2','SELECT 1 /* nested /* ; */ */; DROP TABLE products',
  'CREATE TEMP TABLE steal AS SELECT * FROM products','COPY products TO STDOUT','TRUNCATE products',
  'BEGIN','COMMIT','SET ROLE postgres',"SET app.farm_id='2'",'RESET ALL',
  "SELECT set_config('app.farm_id','2',true)","SELECT pg_read_file('/etc/passwd')",'SELECT pg_sleep(1)',
  "SELECT dblink('remote','SELECT 1')",'SELECT lo_import(1)','SELECT current_query()',
  'SELECT * INTO TEMP steal FROM products','SELECT * FROM products FOR UPDATE',
 ])assert.equal(await compile(sql),false,sql);
});
test('delete and soft-delete fail closed without a trusted server confirmation callback',async()=>{
 const metadata=new Map(catalog);metadata.set('products',{...catalog.get('products'),columns:new Set([...catalog.get('products').columns,'is_deleted','deleted_at'])});
 const locked=createSqlGuard({catalog:metadata});
 for(const sql of ['DELETE FROM products','UPDATE products SET is_deleted=1',"INSERT INTO products(product_name) VALUES('x') ON CONFLICT(product_name) DO UPDATE SET is_deleted=1"])
  assert.equal(await locked({actor:{...actor,deleteAuthorized:true},method:'run',sql}),false);
 assert.ok(await locked({actor,method:'get',sql:'SELECT * FROM products'}));
 const confirmed=createSqlGuard({catalog:metadata,canDelete:async a=>a.farmId===7});assert.ok(await confirmed({actor,method:'run',sql:'DELETE FROM products'}));
});
test('every table position, CTE and nested subquery is checked rather than just the first FROM',async()=>{
 for(const sql of [
  'SELECT * FROM products p JOIN users u ON true','SELECT * FROM products WHERE EXISTS(SELECT 1 FROM auth_sessions)',
  'WITH x AS (SELECT * FROM activation) SELECT * FROM x','SELECT 1 UNION SELECT user_id FROM users',
  'SELECT * FROM permission_catalogue','SELECT * FROM user_permissions',
  'WITH permission_catalogue AS (SELECT 1) SELECT * FROM permission_catalogue',
  'WITH user_permissions AS (SELECT 1) SELECT * FROM user_permissions',
  'SELECT * FROM pg_catalog.pg_roles','SELECT * FROM information_schema.tables','SELECT * FROM public.products',
  'WITH products AS (SELECT 1) SELECT * FROM products','WITH RECURSIVE x AS (SELECT 1 UNION ALL SELECT 1 FROM x) SELECT * FROM x',
  'WITH x AS (DELETE FROM products RETURNING *) SELECT * FROM x','SELECT * FROM generate_series(1,100)',
 ])assert.equal(await compile(sql),false,sql);
});
test('casts, operators, collations, special values, qualified functions and whole farm rows fail closed',async()=>{
 for(const sql of [
  "SELECT 'products'::regclass", "SELECT '1'::public.malicious",'SELECT current_user','SELECT session_user',
  'SELECT pg_catalog.lower(product_name) FROM products','SELECT product_name COLLATE "C" FROM products',
  'SELECT product_id OPERATOR(public.=) 1 FROM products','SELECT * FROM farms','SELECT f FROM farms f',
  'SELECT f.* FROM farms f','SELECT password_hash FROM farms','SELECT tableoid FROM products',
  'SELECT row_to_json(f) FROM farms f','SELECT count(*) OVER() FROM products',
 ])assert.equal(await compile(sql),false,sql);
 assert.ok(await compile('SELECT farm_id,farm_name FROM farms'));
 assert.ok(await compile('SELECT CAST(product_id AS INTEGER), product_name COLLATE NOCASE FROM products'));
});
test('statement methods, staff/platform authority, unsafe params and forged IDs are refused',async()=>{
 assert.equal(await compile('DELETE FROM products'),false);
 assert.equal(await compile('SELECT * FROM products',[],'run'),false);
 for(const as of [null,{...actor,role:'staff'},{...actor,role:'super_admin'},{...actor,farmId:0},{...actor,farmId:'1;SET ROLE postgres'}])assert.equal(await compile('SELECT 1',[],'get',as),false);
 for(const params of [[NaN],[{}],[[]],[{$lastId:0}]])assert.equal(await compile('SELECT ?',params),false);
 for(const sql of ["INSERT INTO farms(farm_name) VALUES('x')","UPDATE products SET farm_id=2",'UPDATE products SET product_id=2',"INSERT INTO products(product_id,product_name) VALUES(1,'x')"])
  assert.equal(await compile(sql,[],'run'),false,sql);
});
test('server farm stamping removes the client farm expression and safely rebinds remaining values',async()=>{
 const result=await compile('INSERT INTO products(farm_id,product_name) VALUES(?,?)',[999,'name?'],'run');
 assert.deepEqual(result.params,[7,'name?']);assert.equal(readPrepared(result.query).idColumn,'product_id');
 assert.match(text(result),/RETURNING product_id/);
 const omitted=await compile('INSERT INTO products(product_name) VALUES(?)',['new'],'run');assert.deepEqual(omitted.params,['new',7]);
 const source=await compile('INSERT INTO products(farm_id,product_name) SELECT farm_id,product_name FROM products WHERE product_id=?',[1],'run');
 assert.ok(source);assert.ok(source.params.includes(7));assert.ok(!source.params.includes(999));
 assert.equal(await compile("INSERT INTO products(farm_id,product_name) VALUES(set_config('app.farm_id','2',true)::bigint,'x')",[],'run'),false);
});
test('joins, CTEs, scalar subqueries and both UNION branches receive explicit tenant predicates',async()=>{
 for(const sql of [
  'SELECT p.product_id FROM products p LEFT JOIN bills b ON b.bill_id=p.product_id',
  'WITH x AS (SELECT * FROM products) SELECT * FROM x',
  'SELECT * FROM products WHERE product_id IN (SELECT bill_id FROM bills)',
  'SELECT product_id FROM products UNION ALL SELECT bill_id FROM bills',
 ]) {
  const result=await compile(sql);const parsed=await parse(text(result));
  assert.match(JSON.stringify(parsed),/farm_id/);assert.ok(result.params.includes(7));
 }
 const left=text(await compile('SELECT p.product_id FROM products p LEFT JOIN bills b ON b.bill_id=p.product_id'));
 assert.match(left,/b\.farm_id IS NULL/);assert.match(left,/p\.farm_id =/);
});
test('upserts are scoped, client RETURNING is refused, and malformed SQL never escapes as a throw',async()=>{
 const result=await compile('INSERT INTO app_settings(farm_id,key,value) VALUES(?,?,?) ON CONFLICT(farm_id,key) DO UPDATE SET value=excluded.value',[2,'key','value'],'run');
 assert.ok(result);assert.match(text(result),/app_settings\.farm_id =/);assert.ok(!result.params.includes(2));
 for(const sql of ['SELEKT 1','SELECT','INSERT INTO products DEFAULT VALUES','DELETE FROM products RETURNING *','UPDATE products SET current_stock=1 RETURNING *'])assert.equal(await compile(sql,[],'run'),false);
});
test('row caps and complexity/SQL-size limits are applied without rewriting literals as code',async()=>{
 const result=await compile("SELECT 'DROP TABLE users; ?' AS note FROM products LIMIT ?",[2]);
 assert.match(text(result),/DROP TABLE users; \?/);assert.match(text(result),/LEAST/);assert.equal(readPrepared(result.query).rowLimit,10);
 const tiny=createSqlGuard({catalog,maxSqlBytes:12});assert.equal(await tiny({actor,method:'get',sql:'SELECT * FROM products'}),false);
 const shallow=createSqlGuard({catalog,maxNodes:2});assert.equal(await shallow({actor,method:'get',sql:'SELECT * FROM products'}),false);
});
