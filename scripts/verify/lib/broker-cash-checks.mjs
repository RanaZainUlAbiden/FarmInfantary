import assert from 'node:assert/strict';
export async function verifyBrokerCash(service,db){
 const before=await service.getCashPosition(1),datedBefore=await service.getCashPosition(1,'2026-12-31');
 const farmBefore=await service.getFarmCashPosition(1,'broiler',1),layerBefore=await service.getFarmCashPosition(1,'layer',2);
 const r=await db.run(`INSERT INTO broker_payments(farm_id,broker_id,flock_id,sale_id,date,amount,method,request_id,request_hash,reversed)
  VALUES(1,1,1,1,'2027-01-01',11,'cash','cash-broker','hash',0),
   (1,1,1,1,'2027-01-01',13,'bank','bank-broker','hash',0),
   (1,1,1,1,'2027-01-01',17,'other','other-broker','hash',0),
   (1,1,1,1,'2027-01-01',19,'cash','reversed-broker','hash',1),
   (2,2,2,2,'2027-01-01',23,'cash','foreign-broker','hash',0)`);
 assert.equal(r.success,true,r.error);
 const after=await service.getCashPosition(1);assert.deepEqual(after.warnings,[]);assert.equal(after.cashInHand,before.cashInHand+11);
 assert.equal((await service.getCashPosition(1,'2026-12-31')).cashInHand,datedBefore.cashInHand);
 assert.equal((await service.getFarmCashPosition(1,'broiler',1)).farmCashInHand,farmBefore.farmCashInHand+11);
 assert.equal((await service.getFarmCashPosition(1,'layer',2)).farmCashInHand,layerBefore.farmCashInHand);
 console.log('  PASS  broker receipts: actual cash, cut-off, farm and module isolation');
}
