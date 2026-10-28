import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createScratchDb,loadEnv} from './lib/pg-harness.mjs';
import {loadBrowserSource} from './lib/browser-source-harness.mjs';
if(!loadEnv())throw Error('DATABASE_URL required');
const f=await createScratchDb('purchase_dates');let token=null;
const platform={dbGet:(s,p)=>f.db.get(s,p,token),dbRun:(s,p)=>f.db.run(s,p,token),dbRunBatch:o=>f.db.batch(o,token),dbBeginTransaction:async()=>{const r=await f.db.begin();if(r.success)token=r.token;return r;},dbCommitTransaction:async()=>{const t=token;token=null;return f.db.commit(t);},dbRollbackTransaction:async()=>{const t=token;token=null;return f.db.rollback(t);}};
const date={toLocalDateString:()=> '2026-10-28'},friendly={friendlySqlError:e=>String(e||'failed')};
const {DatabaseService}=loadBrowserSource('src/app/shared/services/database.service.ts',{'@angular/core':{Injectable:()=>c=>c,inject:()=>platform},'../platform/platform.token':{PLATFORM_API:{}},'../utils/date.util':date,'../utils/sql-error.util':friendly});
const db=new DatabaseService({run:fn=>fn()});
const path='src/app/purchase-orders/purchase-orders.component.ts',imports={},blank=new Proxy({},{get:()=>class{}});
for(const m of readFileSync(new URL('../../'+path,import.meta.url),'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)){
 const key=m[1];imports[key]=key==='@angular/core'?{Component:()=>c=>c}:key.includes('/utils/date.util')?date:key.includes('/utils/sql-error.util')?friendly:key.includes('/utils/bank-source.util')?loadBrowserSource('src/app/shared/utils/bank-source.util.ts',{}):key.includes('/utils/purchase-settlement.util')?loadBrowserSource('src/app/shared/utils/purchase-settlement.util.ts',{}):blank;
}
const {PurchaseOrdersComponent}=loadBrowserSource(path,imports),q=(s,p=[])=>f.pool.query(s,p);
const screen=()=>{const c=new PurchaseOrdersComponent(db,{getCurrentFarm:()=>({farm_id:1})},{detectChanges(){}},{getState(){},saveState(){},clearState(){}});c.currentFarm={farm_id:1};return c;};
let passed=0;const check=async(name,work)=>{await work();passed++;console.log('PASS '+name);};
try{
 await q("INSERT INTO farms(farm_id,farm_name,password_hash) VALUES(1,'QA','unused')");
 await q("INSERT INTO suppliers(supplier_id,farm_id,supplier_name) VALUES(1,1,'Supplier A'),(2,1,'Supplier B')");
 await q("INSERT INTO products(product_id,farm_id,product_name,cost_price) VALUES(1,1,'Feed',100)");
 await check('Backdated new purchase posts its supplier claim on the purchase date',async()=>{
  const c=screen();await c.loadData();c.pendingRows=[{...c.makeNewRow(),supplier_id:1,product_id:1,date:'2026-09-10',quantity:5,cost_price:100,payment_type:'credit',notes:'Backdated claim',batch_code:'DATE-QA'}];await c.saveAllRows();assert.equal(c.errorMessage,'');assert.equal(c.pendingRows.length,0);
  const rows=(await q('SELECT po.date,sl.transaction_date FROM purchase_orders po JOIN supplier_ledger sl ON sl.reference_id=po.purchase_id')).rows;assert.equal(rows.length,1);assert.equal(rows[0].date,'2026-09-10');assert.equal(rows[0].transaction_date,rows[0].date);
 });
 await check('Purchase date correction updates the existing supplier statement without duplication',async()=>{
  const c=screen();await c.loadData();c.startEdit(c.orders[0]);c.editForm.date='2026-09-11';c.editForm.notes='Corrected date';await c.saveEdit(c.editingId);assert.equal(c.errorMessage,'');
  const rows=(await q('SELECT transaction_date,description,credit,debit FROM supplier_ledger')).rows;assert.equal(rows.length,1);assert.equal(rows[0].transaction_date,'2026-09-11');assert.match(rows[0].description,/Corrected date/);assert.equal(rows[0].credit-rows[0].debit,500);
 });
 await check('Changing the supplier preserves the corrected date and removes the old claim',async()=>{
  const c=screen();await c.loadData();c.startEdit(c.orders[0]);c.editForm.supplier_id=2;c.editForm.date='2026-09-12';await c.saveEdit(c.editingId);assert.equal(c.errorMessage,'');
  const rows=(await q('SELECT supplier_id,transaction_date,credit,debit FROM supplier_ledger')).rows;assert.equal(rows.length,1);assert.equal(rows[0].supplier_id,2);assert.equal(rows[0].transaction_date,'2026-09-12');assert.equal(rows[0].credit-rows[0].debit,500);assert.equal((await q('SELECT SUM(quantity) AS n FROM product_batches')).rows[0].n,5);
 });
 console.log(`ALL CHECKS PASSED — ${passed} actual purchase-date and correction PostgreSQL scenarios`);
}finally{if(token)await platform.dbRollbackTransaction();await f.close();}
