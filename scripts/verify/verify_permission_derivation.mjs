import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,currentCatalogue,deriveCatalogue,encodeCatalogue} from '../../tools/permission-catalogue.mjs';
import {sqlAccess,createPermissionRecorder,applicationSourceDigest,traceProducerDigest} from '../../tools/permission-trace.mjs';
let passed=0;const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
const catalogue=currentCatalogue(),layout=readFileSync(resolve(ROOT,'src/app/layout/layout.component.ts'),'utf8'),routes=readFileSync(resolve(ROOT,'src/app/app.routes.ts'),'utf8');
await check('catalogue is deterministic, generated from 50 current menu routes and matches its committed snapshot',()=>{
 assert.equal(encodeCatalogue(catalogue),readFileSync(resolve(ROOT,'db/seeds/permission-catalogue.json'),'utf8').replaceAll('\r\n','\n'));
 assert.equal(catalogue.entries.length,50);assert.deepEqual(['broiler','layer','distribution','owner'].map(m=>catalogue.entries.filter(p=>p.module===m).length),[14,15,15,6]);
 assert.equal(new Set(catalogue.entries.map(e=>e.key)).size,50);
 assert.deepEqual(catalogue.entries.find(e=>e.key==='layer.batch-management').shortcuts,['Add Batch']);
 assert.ok(catalogue.entries.find(e=>e.key==='broiler.medicine'));assert.ok(catalogue.entries.find(e=>e.key==='layer.medicine'));
});
await check('catalogue rejects missing registered routes, dynamic menus and unexplained duplicates',()=>{
 assert.throws(()=>deriveCatalogue({layout:layout.replace("route: 'flock-health'","route: 'missing-screen'"),routes}),/Unregistered/);
 assert.throws(()=>deriveCatalogue({layout:layout.replace('broilerMenu: any[] = [','broilerMenu: any[] = makeMenu('),routes}));
 assert.throws(()=>deriveCatalogue({layout:layout.replace("queryParams: { add: 1 }",'unrecognizedShortcut: true'),routes}),/duplicate/);
});
await check('SQL table reads include every nested CTE, join, subquery and set branch',async()=>{
 const a=await sqlAccess('WITH x AS (SELECT * FROM products) SELECT * FROM x LEFT JOIN categories c ON true WHERE EXISTS(SELECT 1 FROM suppliers) UNION ALL SELECT * FROM customers');
 assert.deepEqual(a.readTables,['categories','customers','products','suppliers']);assert.deepEqual(a.writeTables,{});
});
await check('mutation observations distinguish target writes from source reads and nested reads',async()=>{
 const a=await sqlAccess('UPDATE products SET current_stock=(SELECT count(*) FROM bills) WHERE product_id IN (SELECT product_id FROM product_batches)');
 assert.deepEqual(a.readTables,['bills','product_batches','products']);assert.deepEqual(a.writeTables,{products:['update']});
 const b=await sqlAccess('INSERT INTO customers(farm_id,customer_name) SELECT farm_id,product_name FROM products');
 assert.deepEqual(b.readTables,['products']);assert.deepEqual(b.writeTables,{customers:['insert']});
});
await check('upsert observations include both insert and update dependencies',async()=>{
 const a=await sqlAccess('INSERT INTO app_settings(farm_id,key,value) VALUES(?,?,?) ON CONFLICT(farm_id,key) DO UPDATE SET value=excluded.value',[1,'x','y']);
 assert.deepEqual(a.readTables,['app_settings']);assert.deepEqual(a.writeTables,{app_settings:['insert','update']});
});
await check('unclassified tables, utility commands, multiple statements and table functions are unresolved rather than silently authorized',async()=>{
 for(const sql of ['SELECT * FROM users','SELECT * FROM public.products','DROP TABLE products','SELECT 1; SELECT 2','SELECT * FROM generate_series(1,3)'])await assert.rejects(sqlAccess(sql));
});
const fake={get:async()=>({success:true,data:[]}),run:async()=>({success:true,lastId:1}),batch:async()=>({success:true,results:[]})};
await check('concurrent action contexts remain separate and read-only setup outside a scope is not attributed',async()=>{
 const r=createPermissionRecorder({sourceDigest:'test'}),db=r.wrap(fake);
 await db.get('SELECT * FROM loans');
 await Promise.all([
  r.run({key:'distribution.receive-voucher',action:'create',scenario:'receipt'},async()=>{await db.get('SELECT * FROM bills');await db.batch([{sql:'UPDATE bank_accounts SET current_balance=?',params:[5]},{sql:'INSERT INTO receive_vouchers(farm_id,amount) VALUES(?,?)',params:[1,2]}]);}),
  r.run({key:'owner.assets',action:'view',scenario:'asset list'},()=>db.get('SELECT * FROM assets')),
 ]);
 const scopes=r.report().scopes;assert.equal(scopes.length,2);
 const receipt=scopes.find(s=>s.action==='create');assert.equal(receipt.observations.length,3);
 assert.ok(receipt.observations.some(o=>o.writeTables.bank_accounts?.includes('update')));
 assert.ok(!JSON.stringify(scopes).includes('loans'));
});
await check('invalid scopes and nested relabel attempts are refused',async()=>{
 const r=createPermissionRecorder({sourceDigest:'test'});
 assert.throws(()=>r.run({key:'invented',action:'view',scenario:'test'},()=>{}));
 assert.throws(()=>r.run({key:'owner.assets',action:'grant',scenario:'test'},()=>{}));
 await assert.rejects(r.run({key:'owner.assets',action:'view',scenario:'test'},async()=>r.run({key:'owner.loans',action:'view',scenario:'test'},()=>{})),/relabel/);
});
await check('observations preserve failure contracts and never save SQL literals, parameters or error contents',async()=>{
 const r=createPermissionRecorder({sourceDigest:'test'}),db=r.wrap({...fake,run:async()=>({success:false,error:'PRIVATE database detail'})});
 const result=await r.run({key:'owner.assets',action:'create',scenario:'failure'},()=>db.run("INSERT INTO assets(asset_name) VALUES('PRIVATE literal')",[]));
 assert.equal(result.success,false);const report=r.report();assert.equal(report.scopes[0].failedResults,1);assert.equal(report.scopes[0].failedWorkflows,1);assert.ok(!JSON.stringify(report).includes('PRIVATE'));
 await r.run({key:'owner.assets',action:'view',scenario:'unknown'},()=>db.get('SELECT * FROM secret_table'));
 assert.equal(r.report().scopes.find(s=>s.scenario==='unknown').unresolved,1);assert.match(report.status,/not authorized/);
});
await check('captured real voucher workflows match current source and expose wider bank/ledger write sets',()=>{
 const report=JSON.parse(readFileSync(resolve(ROOT,'tools/permission-evidence/vouchers.json'),'utf8'));
 assert.equal(report.sourceDigest,applicationSourceDigest());assert.equal(report.producerDigest,traceProducerDigest());assert.equal(report.catalogueDigest,catalogue.sourceDigest);assert.equal(report.regressionPassed,true);assert.equal(report.scopes.length,4);
 for(const scope of report.scopes) {assert.equal(scope.unresolved,0);assert.ok(scope.invocations>0);assert.ok(scope.observations.some(o=>o.writeTables.bank_ledger));assert.ok(scope.observations.some(o=>o.writeTables.bank_accounts));}
 assert.ok(report.scopes.find(s=>s.key==='distribution.receive-voucher'&&s.action==='create').observations.some(o=>o.writeTables.customer_ledger));
 assert.ok(report.scopes.find(s=>s.key==='distribution.payment-voucher'&&s.action==='create').observations.some(o=>o.writeTables.supplier_ledger));
});
console.log('ALL CHECKS PASSED — '+passed+' permission derivation scenarios');
