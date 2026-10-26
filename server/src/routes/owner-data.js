import {BUSINESS_TABLES,sqlIdentifier} from '../../../db/tenant-tables.mjs';
import {sameOriginRequest} from '../auth/config.js';
import {sameSessionContext} from '../auth/context.js';
export function registerOwnerData(app,{session,runtime,schema='public',maxBytes=25*1024*1024}) {
 let exporting=0;
 const scope={preHandler:async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!sameOriginRequest(req,session.config,false))return reply.code(403).send({success:false,error:'Request origin is not allowed.'});
  const actor=await session.resolve(req);if(!actor)return reply.code(401).send({success:false,error:'Please sign in.'});
  if(!sameSessionContext(req,actor))return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
  if(actor.role!=='farm_admin')return reply.code(403).send({success:false,error:'Farm administrator access is required.'});req.ownerDataActor=actor;
 },errorHandler:(_e,_req,reply)=>reply.code(503).send({success:false,error:'Farm data is temporarily unavailable.'})};
 app.decorateRequest('ownerDataActor',null);
 app.get('/api/account/entitlement',scope,async req=>({success:true,active:true,farmId:req.ownerDataActor.farmId}));
 app.get('/api/account/export',scope,async(req,reply)=>{
  if(!runtime)return reply.code(503).send({success:false,error:'Farm data export needs the restricted runtime connection.'});
  const actor=req.ownerDataActor;
  if(exporting>=2)return reply.code(503).send({success:false,error:'Another export is in progress. Try again shortly.'});
  if(!await session.store.throttle(req.ip,String(actor.userId),'export',{windowSeconds:3600,ipAttempts:20,userAttempts:5}))return reply.code(429).send({success:false,error:'Export limit reached. Try again later.'});
  exporting++;let c;
  try {
   c=await runtime.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SELECT set_config('app.farm_id',$1,true),set_config('app.user_id',$2,true),set_config('statement_timeout','10000',true)",[String(actor.farmId),String(actor.userId)]);
   const tables={},deadline=Date.now()+60_000;let bytes=0;
   for(const table of BUSINESS_TABLES) {
    if(Date.now()>deadline)throw new Error('Export deadline');
    const rows=(await c.query(`SELECT * FROM ${sqlIdentifier(schema)}.${sqlIdentifier(table)} LIMIT 50001`)).rows;
    if(rows.length>50_000){await c.query('ROLLBACK');return reply.code(413).send({success:false,error:'This farm needs an operator-assisted export because one table is too large.'});}
    bytes+=Buffer.byteLength(JSON.stringify(rows));if(bytes>maxBytes){await c.query('ROLLBACK');return reply.code(413).send({success:false,error:'This farm needs an operator-assisted export because its data is too large.'});}
    tables[table]=rows;
   }
   await c.query('COMMIT');
   const result={format:'FarmInfantary-owner-export',version:1,exportedAt:new Date().toISOString(),farm:actor.farm,tables};
   reply.header('Content-Disposition',`attachment; filename="farminfantary-${actor.farmId}-${new Date().toISOString().slice(0,10)}.json"`);
   reply.header('X-Content-Type-Options','nosniff');return reply.type('application/json; charset=utf-8').send(JSON.stringify(result));
  }catch(error){if(c)await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c?.release();exporting--;}
 });
}
