import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {translateStrict} from '../../../server/src/db/dialect.js';
import {extractFn} from './pg-harness.mjs';
const ts=createRequire(import.meta.url)('typescript');
const source=readFileSync(new URL('../../../src/app/shared/services/database.service.ts',import.meta.url),'utf8');
const loadMethod=name=>{const body=extractFn(source,name,'async ').replace(/^async\s+/,'async function ');return (0,eval)('('+ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None}}).outputText.trim().replace(/;$/,'')+')');};

export async function checkBrokerDestinations({q,req,ok,check,sale,payment,other,staff,root}) {
 const create=async name=>ok(await req('POST','/api/brokers',{name})).broker.broker_id;
 const bid=await create('Destination broker'),base=`/api/brokers/${bid}`;
 const a=ok(await req('POST',base+'/sales',{...sale(),date:'2026-10-21'})).saleId;
 const b=ok(await req('POST',base+'/sales',{...sale(),flockId:2,date:'2026-10-22'})).saleId;
 const post=p=>req('POST',base+'/collections',{...payment(1),destination:'own',requestId:randomUUID(),...p});
 const scalar=async(sql,p=[])=>Object.values((await q(sql,p)).rows[0])[0];
 const detail=async()=>ok(await req('GET',base));
 await q("INSERT INTO suppliers(supplier_id,farm_id,supplier_name) VALUES(1,1,'Destination Supplier')");
 await q("INSERT INTO supplier_ledger(supplier_id,transaction_date,description,debit,credit,balance) VALUES(1,'2026-10-01','Opening payable',0,180,180)");
 await q("INSERT INTO customers(customer_id,farm_id,customer_name) VALUES(100,1,'Destination Customer'),(101,1,'No account customer')");
 await q("INSERT INTO bank_accounts(bank_id,farm_id,bank_name,customer_id) VALUES(3,1,'Customer Deposit',100),(4,1,'Other Customer Deposit',101)");
 await q("SELECT set_config('app.farm_id','2',false)");
 await q("INSERT INTO suppliers(supplier_id,farm_id,supplier_name) VALUES(999,2,'Foreign supplier')");
 await q("INSERT INTO customers(customer_id,farm_id,customer_name) VALUES(999,2,'Foreign customer')");
 await q("SELECT set_config('app.farm_id','1',false)");

 await check('destination options search and page tenant recipients, return only the selected customer accounts, and deny other roles',async()=>{
  const s=ok(await req('GET',base+'/payment-options?type=supplier&search=Destination'));assert.equal(s.parties.length,1);assert.equal(s.parties[0].outstanding,180);
  const c=ok(await req('GET',base+'/payment-options?type=customer&customerId=100'));assert.deepEqual(c.banks.map(x=>x.bank_id),[3]);assert.equal(c.parties.some(x=>x.id===999),false);
  assert.equal(ok(await req('GET',base+'/payment-options?type=customer&offset=30')).parties.length,0);
  assert.equal(ok(await req('GET',base+'/payment-options?type=customer&customerId=101')).banks.length,1);
  for(const cookie of [other,staff,root])assert.notEqual((await req('GET',base+'/payment-options?type=supplier',undefined,cookie)).statusCode,200);
 });
 let supplierReceipt;
 await check('a supplier overpayment on a later sale allocation rolls back the entire grouped receipt',async()=>{
  assert.equal((await post({amount:190,destination:'supplier',supplierId:1,method:'other'})).statusCode,409);
  assert.equal((await detail()).payments.length,0);assert.equal((await detail()).summary.pending,200);
  assert.equal(await scalar('SELECT SUM(credit-debit) FROM supplier_ledger WHERE supplier_id=1'),180);
 });
 await check('supplier direct receipt allocates oldest sales across farms and reduces payable without moving house cash or bank money',async()=>{
  const houseBefore=await scalar('SELECT current_balance FROM bank_accounts WHERE bank_id=1');
  supplierReceipt={amount:150,destination:'supplier',supplierId:1,method:'other',bankId:null,requestId:randomUUID()};
  const r=ok(await post(supplierReceipt));assert.deepEqual(r.allocations.map(x=>[x.saleId,x.amount]),[[a,100],[b,50]]);
  assert.equal(await scalar('SELECT SUM(credit-debit) FROM supplier_ledger WHERE supplier_id=1'),30);
  assert.equal(await scalar('SELECT current_balance FROM bank_accounts WHERE bank_id=1'),houseBefore);
  const d=await detail();assert.equal(d.summary.pending,50);assert.equal(d.payments.every(x=>x.destination==='supplier'&&x.supplier_name==='Destination Supplier'&&x.collection_amount===150),true);
  assert.equal(await scalar("SELECT COUNT(*)::int FROM broker_payments WHERE broker_id=$1 AND method='cash'",[bid]),0);
 });
 await check('group replay saves no duplicates; changed recipient and amount are refused',async()=>{
  assert.equal(ok(await post(supplierReceipt)).replayed,true);
  assert.equal((await post({...supplierReceipt,amount:149})).statusCode,409);
  assert.equal((await post({...supplierReceipt,destination:'own',supplierId:null,method:'cash'})).statusCode,409);
  assert.equal((await detail()).payments.length,2);
 });
 await check('supplier report methods label direct payment separately from cash and refuse independent deletion',async()=>{
  const svc={get:async(sql,params)=>{const {toNumberedPlaceholders}=await import('../../../server/src/db/placeholders.js');return {success:true,data:(await q(toNumberedPlaceholders(translateStrict(sql)).text,params)).rows};}};
  const rows=await loadMethod('getSupplierLedgerWithBalance').call(svc,1,1);assert.equal(rows.data.filter(x=>x.reference_type==='broker_payment').every(x=>x.payment_source==='broker'),true);
  const groups=await loadMethod('getSupplierPaymentsByAccount').call(svc,1,1);assert.equal(groups.data.find(x=>x.payment_source==='broker').total_paid,150);
  const row=rows.data.find(x=>x.reference_type==='broker_payment');const refused=await loadMethod('deleteSupplierLedgerEntry').call(svc,row.ledger_id);assert.equal(refused.success,false);assert.match(refused.error,/broker account/);
 });
 await check('raw SQL cannot remove or rewrite either broker-owned ledger mirror',async()=>{
  for(const sql of ["DELETE FROM supplier_ledger WHERE reference_type='broker_payment'","UPDATE supplier_ledger SET debit=0 WHERE reference_type='broker_payment'"]){const r=await req('POST','/api/db/run',{sql,params:[]});assert.equal(r.json().success,false,r.body);}
  assert.equal(await scalar('SELECT SUM(credit-debit) FROM supplier_ledger WHERE supplier_id=1'),30);
 });
 await check('overpay, wrong tenant recipient, invalid identity, early date and sub-cent amount roll back fully',async()=>{
  for(const p of [{amount:31,destination:'supplier',supplierId:1,method:'other'},{destination:'supplier',supplierId:999,method:'other'},{destination:'customer',customerId:999,bankId:3,method:'bank'},{destination:'customer',customerId:100,bankId:4,method:'bank'},{destination:'own',bankId:3,method:'bank'},{destination:'own',supplierId:1},{amount:51},{amount:0.00000001},{amount:1,date:'2026-10-01'}])assert.equal((await post(p)).json().success,false,JSON.stringify(p));
  assert.equal((await detail()).summary.pending,50);assert.equal(await scalar('SELECT SUM(credit-debit) FROM supplier_ledger WHERE supplier_id=1'),30);
 });
 await check('supplier history cannot be orphaned by removing the recipient',async()=>{await assert.rejects(q('DELETE FROM suppliers WHERE supplier_id=1'),/broker receipt history/);});
 await check('reversing any allocation reverses the whole grouped supplier receipt exactly once',async()=>{
  const p=(await detail()).payments[0],url=base+'/payments/'+p.payment_id+'/reverse';ok(await req('POST',url,{}));ok(await req('POST',url,{}));
  assert.equal((await detail()).summary.pending,200);assert.equal((await detail()).payments.every(x=>x.reversed===1),true);
  assert.equal(await scalar('SELECT SUM(credit-debit) FROM supplier_ledger WHERE supplier_id=1'),180);assert.equal((await post(supplierReceipt)).statusCode,409);
 });
 let customerPayment;
 await check('customer receipt credits only its deposit account and leaves customer bill debt and house accounts unchanged',async()=>{
  const house=await scalar('SELECT current_balance FROM bank_accounts WHERE bank_id=1');
  const before=await scalar('SELECT outstanding_balance FROM customers WHERE customer_id=100');
  const r=ok(await post({amount:120,destination:'customer',customerId:100,method:'bank',bankId:3}));customerPayment=r.allocations[0].paymentId;
  assert.equal(await scalar('SELECT current_balance FROM bank_accounts WHERE bank_id=3'),120);assert.equal(await scalar('SELECT current_balance FROM bank_accounts WHERE bank_id=1'),house);
  assert.equal(await scalar('SELECT outstanding_balance FROM customers WHERE customer_id=100'),before);assert.equal(await scalar('SELECT COUNT(*)::int FROM customer_ledger WHERE customer_id=100'),0);
  assert.equal((await detail()).summary.pending,80);
  for(const sql of ["DELETE FROM bank_ledger WHERE bank_id=3","UPDATE bank_ledger SET debit=1 WHERE bank_id=3"]){assert.equal((await req('POST','/api/db/run',{sql,params:[]})).json().success,false);}
  await assert.rejects(q('DELETE FROM customers WHERE customer_id=100'),/broker receipt history/);
  await assert.rejects(q('UPDATE bank_accounts SET customer_id=101 WHERE bank_id=3'),/broker receipt history/);
 });
 await check('customer group reversal cannot overdraw or partially reverse allocations',async()=>{
  await q("SELECT set_config('app.farm_id','1',false); INSERT INTO bank_ledger(bank_id,transaction_date,description,debit,credit,balance) VALUES(3,'2026-10-27','Later withdrawal',0,50,70)");
  assert.equal((await req('POST',base+'/payments/'+customerPayment+'/reverse',{})).statusCode,409);
  assert.equal((await detail()).summary.pending,80);assert.equal(await scalar('SELECT COUNT(*)::int FROM broker_payments WHERE broker_id=$1 AND destination=$2 AND reversed=0',[bid,'customer']),2);
  await q("DELETE FROM bank_ledger WHERE bank_id=3 AND description='Later withdrawal'");ok(await req('POST',base+'/payments/'+customerPayment+'/reverse',{}));
  assert.equal((await detail()).summary.pending,200);assert.equal(await scalar('SELECT current_balance FROM bank_accounts WHERE bank_id=3'),0);
 });
 await check('broker-level own receipts obey flock and sale limits and keep cash and bank methods distinct',async()=>{
  ok(await post({amount:40,flockId:2}));assert.equal(ok(await req('GET',base+'?flockId=1')).summary.pending,100);assert.equal(ok(await req('GET',base+'?flockId=2')).summary.pending,60);
  assert.equal((await post({amount:61,flockId:2})).statusCode,409);
  const r=ok(await post({amount:30,saleId:a,method:'bank',bankId:1}));assert.equal(r.allocations.length,1);assert.equal(r.allocations[0].saleId,a);
  assert.equal((await detail()).summary.pending,130);
 });
 await check('concurrent grouped receipts cannot overpay a broker or reuse a save identifier across brokers',async()=>{
  const rs=await Promise.all([1,2].map(()=>post({amount:100})));assert.deepEqual(rs.map(x=>x.statusCode).sort(),[200,409]);
  const c=await create('Other destination broker');ok(await req('POST',`/api/brokers/${c}/sales`,sale()));
  const requestId=randomUUID(),payload={...payment(1),destination:'own',requestId};const reuse=await Promise.all([req('POST',base+'/collections',payload),req('POST',`/api/brokers/${c}/collections`,payload)]);assert.deepEqual(reuse.map(x=>x.statusCode).sort(),[200,409]);
 });
 await check('concurrent receipts from different brokers serialize supplier payable and roll back the losing receipt',async()=>{
  const ids=await Promise.all(['Supplier contender A','Supplier contender B'].map(create));for(const id of ids)ok(await req('POST',`/api/brokers/${id}/sales`,sale()));
  const rs=await Promise.all(ids.map(id=>req('POST',`/api/brokers/${id}/collections`,{...payment(100,'other'),destination:'supplier',supplierId:1,requestId:randomUUID()})));
  assert.deepEqual(rs.map(x=>x.statusCode).sort(),[200,409]);assert.equal(await scalar('SELECT SUM(credit-debit) FROM supplier_ledger WHERE supplier_id=1'),80);
 });
}
