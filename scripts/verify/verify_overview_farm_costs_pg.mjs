import assert from 'node:assert/strict';
import {createScratchDb,loadEnv} from './lib/pg-harness.mjs';
import {loadBrowserSource} from './lib/browser-source-harness.mjs';
if(!loadEnv())throw Error('DATABASE_URL required');
const utility=loadBrowserSource('src/app/shared/utils/bill-source.util.ts',{});
const {OverviewService}=loadBrowserSource('src/app/shared/services/overview.service.ts',{
 '@angular/core':{Injectable:()=>c=>c},'./database.service':{},'../utils/sql-error.util':{friendlySqlError:e=>String(e)},'../utils/bill-source.util':utility
});
const fixture=await createScratchDb('overview_farm_costs'),db=fixture.db;
const run=async(sql,params=[])=>{const r=await db.run(sql,params);assert.equal(r.success,true,r.error);return r;};
try{
 await run("INSERT INTO farms(farm_id,farm_name,password_hash) VALUES(1,'QA','unused'),(2,'Other','unused')");
 await run("INSERT INTO farm_units(unit_id,farm_id,module_type,unit_name) VALUES(1,1,'broiler','Broiler site'),(2,1,'layer','Layer site'),(3,2,'broiler','Other site')");
 await run("INSERT INTO flocks(flock_id,farm_id,flock_name,unit_id,start_date) VALUES(1,1,'Broiler',1,'2026-09-01'),(2,1,'Unassigned',NULL,'2026-09-01'),(3,2,'Foreign',3,'2026-09-01')");
 await run("INSERT INTO batches(batch_id,farm_id,batch_name,unit_id,start_date,initial_birds) VALUES(1,1,'Layer',2,'2026-09-01',100)");
 await run("INSERT INTO chick_traders(trader_id,flock_id,trader_name,module_type) VALUES(1,1,'B','broiler'),(2,1,'L','layer'),(3,2,'U','broiler'),(4,3,'F','broiler')");
 for(const [trader,flock,module,amount,date]of [[1,1,'broiler',111,'2026-10-27'],[2,1,'layer',222,'2026-10-27'],[3,2,'broiler',333,'2026-10-27'],[4,3,'broiler',9999,'2026-10-27'],[1,1,'broiler',4444,'2026-09-01']])await run('INSERT INTO chick_entries(trader_id,flock_id,date,chick_name,quantity,price_per_unit,total_amount,module_type) VALUES(?,?,?,?,?,?,?,?)',[trader,flock,date,'QA',1,amount,amount,module]);
 const summary=await new OverviewService(db).getSummary(1,{from:'2026-10-01',to:'2026-10-31'});assert.equal(summary.warnings.length,0,JSON.stringify(summary.warnings));
 const find=(module,id)=>summary.perFarm.find(f=>f.moduleType===module&&f.unitId===id);
 assert.equal(find('broiler',1).expenses,111);assert.equal(find('broiler',1).profit,-111);
 assert.equal(find('layer',2).expenses,222);assert.equal(find('layer',2).profit,-222);
 assert.equal(find('broiler',null).expenses,333);assert.equal(find('broiler',null).profit,-333);
 assert.equal(summary.expenses.chicks,666);assert.equal(summary.expenses.total,666);assert.equal(summary.profit,-666);
 assert.equal(summary.perFarm.reduce((n,f)=>n+f.expenses,0),666);assert.equal(summary.perFarm.some(f=>f.unitId===3),false);
 console.log('ALL CHECKS PASSED — 11 actual Overview farm-cost checks: Broiler, Layer, colliding IDs, unassigned, date and tenant scope.');
}finally{await fixture.close();}
