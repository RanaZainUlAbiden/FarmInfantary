import {createHash} from 'node:crypto';
import {sameOriginRequest} from '../auth/config.js';
import {sameSessionContext} from '../auth/context.js';
class BrokerError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new BrokerError(status,message);};
const id=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)fail(400,'Invalid record.');return n;};
const text=(v,max=200)=>{if(typeof v!=='string'||v.length>max)fail(400,'Invalid text field.');return v.trim();};
const number=(v,min=0)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>1e12)fail(400,'Invalid amount or weight.');return v;};
const date=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail(400,'Use a valid date.');return v;};
const body=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail(400,'Invalid request fields.');return v;};
const token=v=>{if(typeof v!=='string'||!/^[-a-zA-Z0-9]{16,80}$/.test(v))fail(400,'Invalid save identifier.');return v;};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const paid=`COALESCE(s.broker_legacy_paid,CASE WHEN s.broker_managed=0 AND COALESCE(s.payment_type,'cash')<>'credit' THEN s.total_amount ELSE 0 END)
 + COALESCE((SELECT SUM(p.amount) FROM broker_payments p WHERE p.sale_id=s.sale_id AND p.farm_id=s.farm_id AND p.reversed=0),0)`;
export function registerBrokerRoutes(app,{session,runtime,deleteAuthorization}) {
 const scope={bodyLimit:32_768,preHandler:async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!sameOriginRequest(req,session.config,req.method!=='GET'))return reply.code(403).send({success:false,error:'Request origin is not allowed.'});
  const actor=await session.resolve(req);if(!actor)return reply.code(401).send({success:false,error:'Please sign in.'});
  if(!sameSessionContext(req,actor))return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
  if(actor.role!=='farm_admin')return reply.code(403).send({success:false,error:'Farm administrator access is required.'});
  if(!runtime)return reply.code(503).send({success:false,error:'Broker accounts require the restricted database connection.'});
  if(!await session.store.throttle(req.ip,String(actor.userId),'brokers',{windowSeconds:60,ipAttempts:300,userAttempts:300}))return reply.code(429).send({success:false,error:'Too many requests. Try again shortly.'});
  req.brokerActor=actor;
 },errorHandler:(e,req,reply)=>{
  req.log.error({code:e.code??'BROKER_OPERATION'},'Broker operation refused');
  const duplicate=e.code==='23505';return reply.code(e.status??(duplicate?409:503)).send({success:false,error:e instanceof BrokerError?e.message:duplicate?'That name or save identifier already exists. Reload to check the saved record.':'Could not confirm this change. Reload the broker account before trying again.'});
 }};
 app.decorateRequest('brokerActor',null);
 async function tx(req,work){const c=await runtime.connect();try{
  await c.query('BEGIN');const a=req.brokerActor;
  await c.query("SELECT set_config('app.farm_id',$1,true),set_config('app.user_id',$2,true),set_config('statement_timeout','10000',true)",[String(a.farmId),String(a.userId)]);
  await c.query("SELECT set_config('app.broker_workflow','on',true)");
  const result=await work(c,a);
  const fresh=await session.resolve(req);if(!fresh||fresh.userId!==a.userId||fresh.farmId!==a.farmId||fresh.authVersion!==a.authVersion)fail(401,'Your account changed. Sign in again.');
  await c.query('COMMIT');return {success:true,...result};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async function broker(c,brokerId,lock=false){const r=(await c.query(`SELECT * FROM brokers WHERE broker_id=$1 AND merged_into IS NULL ${lock?'FOR UPDATE':''}`,[brokerId])).rows[0];if(!r)fail(404,'Broker not found.');return r;}
 const flock=async(c,flockId)=>{const f=(await c.query('SELECT flock_id FROM flocks WHERE flock_id=$1 FOR SHARE',[flockId])).rows[0];if(!f)fail(404,'Flock not found.');return f;};
 const page=req=>{const n=Number(req.query.offset??0);if(!Number.isSafeInteger(n)||n<0||n>100000)fail(400,'Invalid page.');return n;};
 async function syncIncome(c,flockId,day){
  await c.query("DELETE FROM income WHERE flock_id=$1 AND date=$2 AND source='sale' AND COALESCE(module_type,'broiler')='broiler'",[flockId,day]);
  await c.query(`INSERT INTO income(flock_id,date,description,amount,source,module_type)
   SELECT $1,$2,'Sale — '||SUM(bird_weight)::text||' kg',SUM(total_amount),'sale','broiler' FROM sales
   WHERE flock_id=$1 AND date=$2 AND COALESCE(module_type,'broiler')='broiler' HAVING COUNT(*)>0`,[flockId,day]);
 }
 const rebuild=async(c,bankId)=>c.query('UPDATE bank_accounts SET current_balance=(SELECT COALESCE(SUM(debit-credit),0) FROM bank_ledger WHERE bank_id=$1) WHERE bank_id=$1',[bankId]);
 function paymentInput(input){const method=text(input.method,20);if(!['cash','bank','other'].includes(method))fail(400,'Choose cash, bank or another payment method.');
  const reference=text(input.reference??'',120),note=text(input.note??'',500);if(method==='other'&&!reference)fail(400,'Describe the other payment method or reference.');
  if(method==='bank'&&(!Number.isSafeInteger(Number(input.bankId))||Number(input.bankId)<1))fail(400,'Choose the receiving bank account.');
  return {amount:number(input.amount),date:date(input.date),method,bankId:method==='bank'?id(input.bankId):null,reference,note};}
 async function receipt(c,s,p,requestId,requestHash){
  if(!(p.amount>0))fail(400,'Payment must be greater than zero.');
  const totalPaid=(await c.query(`SELECT ${paid} AS paid FROM sales s WHERE sale_id=$1`,[s.sale_id])).rows[0].paid;
  if(p.amount>s.total_amount-totalPaid+0.000001)fail(409,'Payment exceeds the outstanding amount. Reload this sale.');
  if(p.date<s.date)fail(400,'Payment date cannot precede the sale.');
  if(p.bankId){const b=(await c.query('SELECT bank_id FROM bank_accounts WHERE bank_id=$1 AND customer_id IS NULL FOR UPDATE',[p.bankId])).rows[0];if(!b)fail(400,'Choose one of the farm’s own bank accounts.');}
  const r=(await c.query(`INSERT INTO broker_payments(broker_id,flock_id,sale_id,date,amount,method,bank_id,reference,note,request_id,request_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[s.broker_id,s.flock_id,s.sale_id,p.date,p.amount,p.method,p.bankId,p.reference,p.note,requestId,requestHash])).rows[0];
  if(p.bankId){await c.query(`INSERT INTO bank_ledger(bank_id,transaction_date,description,debit,credit,balance,reference_type,reference_id,transaction_number)
   VALUES($1,$2,$3,$4,0,(SELECT COALESCE(SUM(debit-credit),0) FROM bank_ledger WHERE bank_id=$1)+$4,'broker_payment',$5,$6)`,
   [p.bankId,p.date,'Broker receipt — '+s.broker+' / Sale #'+s.sale_id,p.amount,String(r.payment_id),'BR-'+r.payment_id]);await rebuild(c,p.bankId);}
  return r;
 }
 app.get('/api/brokers',scope,req=>tx(req,async c=>{
  const search=text(String(req.query.search??''),100),offset=page(req);
  const rows=(await c.query(`SELECT b.*,COALESCE(t.total,0) AS total,COALESCE(t.paid,0) AS paid,COALESCE(t.total-t.paid,0) AS pending
   FROM brokers b LEFT JOIN LATERAL(SELECT SUM(s.total_amount) AS total,SUM(${paid}) AS paid FROM sales s WHERE s.broker_id=b.broker_id AND COALESCE(s.module_type,'broiler')='broiler') t ON true
   WHERE b.merged_into IS NULL AND b.broker_name ILIKE '%'||$1||'%' ORDER BY b.broker_name,b.broker_id LIMIT 31 OFFSET $2`,[search,offset])).rows;
  return {brokers:rows.slice(0,30),more:rows.length>30};
 }));
 app.post('/api/brokers',scope,req=>tx(req,async c=>{
  const b=body(req.body,['name','phone','notes']),name=text(b.name,120);if(!name)fail(400,'Enter the broker name.');
  return {broker:(await c.query('INSERT INTO brokers(broker_name,phone,notes) VALUES($1,$2,$3) RETURNING *',[name,text(b.phone??'',40),text(b.notes??'',500)])).rows[0]};
 }));
 app.put('/api/brokers/:brokerId',scope,req=>tx(req,async c=>{
  const b=body(req.body,['name','phone','notes','active','version']),old=await broker(c,id(req.params.brokerId),true),name=text(b.name,120);
  if(!name||typeof b.active!=='boolean')fail(400,'Enter a name and valid status.');if(old.version!==id(b.version))fail(409,'Broker changed. Reload before saving.');
  return {broker:(await c.query('UPDATE brokers SET broker_name=$1,phone=$2,notes=$3,is_active=$4,version=version+1 WHERE broker_id=$5 RETURNING *',[name,text(b.phone??'',40),text(b.notes??'',500),Number(b.active),old.broker_id])).rows[0]};
 }));
 app.get('/api/brokers/:brokerId',scope,req=>tx(req,async c=>{
  const b=await broker(c,id(req.params.brokerId)),flockId=req.query.flockId?id(req.query.flockId):null,offset=page(req);if(flockId)await flock(c,flockId);
  const summary=(await c.query(`SELECT COALESCE(SUM(total_amount),0) AS total,COALESCE(SUM(${paid}),0) AS paid FROM sales s
   WHERE broker_id=$1 AND ($2::bigint IS NULL OR flock_id=$2) AND COALESCE(module_type,'broiler')='broiler'`,[b.broker_id,flockId])).rows[0];
  const sales=(await c.query(`SELECT s.*,${paid} AS amount_paid,f.flock_name FROM sales s LEFT JOIN flocks f ON f.flock_id=s.flock_id
   WHERE s.broker_id=$1 AND ($2::bigint IS NULL OR s.flock_id=$2) AND COALESCE(s.module_type,'broiler')='broiler' ORDER BY s.date DESC,s.sale_id DESC LIMIT 31 OFFSET $3`,[b.broker_id,flockId,offset])).rows;
  const payments=(await c.query(`SELECT p.*,b.bank_name FROM broker_payments p LEFT JOIN bank_accounts b ON b.bank_id=p.bank_id
   WHERE p.broker_id=$1 AND ($2::bigint IS NULL OR p.flock_id=$2) ORDER BY p.date DESC,p.payment_id DESC LIMIT 31 OFFSET $3`,[b.broker_id,flockId,offset])).rows;
  return {broker:b,summary:{...summary,pending:summary.total-summary.paid},sales:sales.slice(0,30),payments:payments.slice(0,30),moreSales:sales.length>30,morePayments:payments.length>30};
 }));
 app.post('/api/brokers/:brokerId/sales',scope,req=>tx(req,async c=>{
  const b=body(req.body,['flockId','date','vehicle','driver','phone','emptyWeight','loadWeight','rate','payment','requestId']),brokerId=id(req.params.brokerId),br=await broker(c,brokerId,true);
  if(!br.is_active)fail(409,'This broker is inactive. Activate the broker before adding sales.');
  const flockId=id(b.flockId);await flock(c,flockId);const day=date(b.date),empty=number(b.emptyWeight),load=number(b.loadWeight),rate=number(b.rate),requestId=token(b.requestId);
  if(load<=empty||rate<=0)fail(400,'Load weight must exceed empty weight and rate must be positive.');
  const total=Math.round((load-empty)*rate*100)/100;if(!Number.isFinite(total)||total<=0||total>1e12)fail(400,'Sale amount must be positive and within the supported range.');
  const payment=paymentInput(body(b.payment,['amount','date','method','bankId','reference','note']));if(payment.amount>total)fail(400,'Payment exceeds the sale amount.');
  const vehicle=text(b.vehicle??'',80),driver=text(b.driver??'',120),phone=text(b.phone??'',40),fingerprint=hash({brokerId,flockId,day,empty,load,rate,payment,vehicle,driver,phone});
  const old=(await c.query('SELECT sale_id,broker_request_hash FROM sales WHERE broker_request_id=$1',[requestId])).rows[0];
  if(old){if(old.broker_request_hash!==fingerprint)fail(409,'This save identifier belongs to a different sale. Reload the account.');return {saleId:old.sale_id,replayed:true};}
  const s=(await c.query(`INSERT INTO sales(flock_id,date,vehicle_number,driver_name,driver_phone,broker,broker_id,empty_weight,load_weight,bird_weight,rate,total_amount,payment_type,module_type,broker_managed,broker_request_id,broker_request_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'credit','broiler',1,$13,$14) RETURNING *`,[flockId,day,vehicle,driver,phone,br.broker_name,brokerId,empty,load,load-empty,rate,total,requestId,fingerprint])).rows[0];
  if(payment.amount>0)await receipt(c,s,payment,requestId,hash({initial:true,saleId:s.sale_id,payment}));
  await syncIncome(c,flockId,day);return {saleId:s.sale_id};
 }));
 app.post('/api/brokers/:brokerId/payments',scope,req=>tx(req,async c=>{
  const b=body(req.body,['saleId','amount','date','method','bankId','reference','note','requestId']),brokerId=id(req.params.brokerId);await broker(c,brokerId,true);
  const saleId=id(b.saleId),p=paymentInput(b),requestId=token(b.requestId),fingerprint=hash({brokerId,saleId,p});
  const old=(await c.query('SELECT payment_id,request_hash FROM broker_payments WHERE request_id=$1',[requestId])).rows[0];if(old){if(old.request_hash!==fingerprint)fail(409,'This save identifier belongs to another payment.');return {paymentId:old.payment_id,replayed:true};}
  const s=(await c.query("SELECT * FROM sales WHERE sale_id=$1 AND broker_id=$2 AND COALESCE(module_type,'broiler')='broiler' FOR UPDATE",[saleId,brokerId])).rows[0];if(!s)fail(404,'Sale not found for this broker.');
  if(!s.broker_managed){await c.query("UPDATE sales SET broker_legacy_paid=CASE WHEN COALESCE(payment_type,'cash')='credit' THEN 0 ELSE total_amount END,broker_managed=1 WHERE sale_id=$1",[saleId]);}
  const result=await receipt(c,s,p,requestId,fingerprint);return {paymentId:result.payment_id};
 }));
 app.post('/api/brokers/:brokerId/payments/:paymentId/reverse',scope,req=>tx(req,async c=>{
  body(req.body,[]);if(!await deleteAuthorization.canDelete(req.brokerActor))fail(403,'Confirm the delete code on this device first.');
  await broker(c,id(req.params.brokerId),true);
  const p=(await c.query('SELECT * FROM broker_payments WHERE payment_id=$1 AND broker_id=$2 FOR UPDATE',[id(req.params.paymentId),id(req.params.brokerId)])).rows[0];if(!p)fail(404,'Payment not found.');if(p.reversed)return {reversed:true};
  if(p.bank_id){await c.query('SELECT bank_id FROM bank_accounts WHERE bank_id=$1 FOR UPDATE',[p.bank_id]);
   const current=(await c.query('SELECT COALESCE(SUM(debit-credit),0) AS balance FROM bank_ledger WHERE bank_id=$1',[p.bank_id])).rows[0].balance;if(current+0.000001<p.amount)fail(409,'Reversing this payment would overdraw the account.');
   await c.query("DELETE FROM bank_ledger WHERE reference_type='broker_payment' AND reference_id=$1",[String(p.payment_id)]);await rebuild(c,p.bank_id);}
  await c.query('UPDATE broker_payments SET reversed=1 WHERE payment_id=$1',[p.payment_id]);return {reversed:true};
 }));
 app.delete('/api/brokers/:brokerId/sales/:saleId',scope,req=>tx(req,async c=>{
  if(!await deleteAuthorization.canDelete(req.brokerActor))fail(403,'Confirm the delete code on this device first.');await broker(c,id(req.params.brokerId),true);
  const s=(await c.query(`SELECT s.*,${paid} AS paid FROM sales s WHERE sale_id=$1 AND broker_id=$2 AND broker_managed=1 AND COALESCE(module_type,'broiler')='broiler' FOR UPDATE`,[id(req.params.saleId),id(req.params.brokerId)])).rows[0];
  if(!s)fail(404,'Managed sale not found.');if(s.paid>0)fail(409,'Reverse recorded payments before deleting this sale.');
  await c.query('DELETE FROM sales WHERE sale_id=$1',[s.sale_id]);await syncIncome(c,s.flock_id,s.date);return {deleted:true};
 }));
}
