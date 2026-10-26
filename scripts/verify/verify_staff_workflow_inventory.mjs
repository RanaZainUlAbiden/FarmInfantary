import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildWorkflowInventory,inspectClass} from '../../tools/staff-workflow-inventory.mjs';
let passed=0;const check=(name,work)=>{work();passed++;console.log('  PASS  '+name);};
const inventory=buildWorkflowInventory(),byKey=new Map(inventory.screens.map(s=>[s.key,s]));
check('all 50 module-specific screens are inventoried deterministically without authorizing actions',()=>{
 assert.equal(inventory.screens.length,50);assert.equal(byKey.size,50);assert.match(inventory.status,/not execution evidence or authorization policy/);
 assert.deepEqual(JSON.parse(readFileSync(new URL('../../tools/permission-evidence/workflow-inventory.json',import.meta.url),'utf8')),inventory);
 assert.ok(byKey.has('broiler.income'));assert.ok(byKey.has('layer.income'));
});
check('Income create, edit and delete entry points stay separate despite shared helper writes',()=>{
 const roots=byKey.get('broiler.income').roots;
 for(const method of ['saveAllRows','saveEdit','onDeleteConfirmed']){
  const root=roots.find(r=>r.method===method);assert.ok(root);assert.ok(root.primitives.includes('runBatch'));assert.match(root.intent,/unreviewed/);
 }
});
check('actual sales save traverses transaction, stock and bank helpers rather than relying on its name',()=>{
 const root=byKey.get('distribution.sales-orders').roots.find(r=>r.method==='saveBill');assert.ok(root);
 for(const kind of ['beginTransaction','commitTransaction','rollbackTransaction','runBatch'])assert.ok(root.primitives.includes(kind));
 assert.ok(root.methods.some(m=>m.id.includes('database.service.ts#DatabaseService.')));assert.ok(root.methods.length>10);assert.ok(root.dynamicSql>0);
});
check('constructor aliases and computed calls are distinguished for review',()=>{
 const klass=inspectClass("import {DatabaseService} from './database'; class Example {constructor(private records:DatabaseService){} async save(){await this.records.run('UPDATE products SET current_stock=?',[1]);this[this.handler]();}}",'example.ts','Example');
 assert.equal(klass.dependencies.get('records').name,'DatabaseService');assert.ok(klass.methods.get('save').calls.some(c=>c.dependency==='records'&&c.method==='run'));
 assert.ok(klass.methods.get('save').unresolved.includes('computed-call'));
});
check('the inventory stores source references and hashes, never SQL text or query values',()=>{
 const text=JSON.stringify(inventory);assert.ok(!text.includes('SELECT * FROM'));assert.ok(!text.includes('UPDATE products SET'));assert.ok(!text.includes('INSERT INTO'));
 for(const screen of inventory.screens)for(const root of screen.roots)for(const digest of root.sqlDigests)assert.match(digest,/^[a-f0-9]{64}$/);
});
console.log(`ALL CHECKS PASSED — ${passed} staff workflow inventory scenarios`);
