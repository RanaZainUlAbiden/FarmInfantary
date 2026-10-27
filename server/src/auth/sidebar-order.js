import {readFileSync} from 'node:fs';
import {sameOriginRequest} from './config.js';
import {sameSessionContext} from './context.js';

const catalogue=JSON.parse(readFileSync(new URL('../../../db/seeds/permission-catalogue.json',import.meta.url),'utf8'));
const allowed=Object.fromEntries(['broiler','layer','distribution'].map(module=>[module,new Set(catalogue.entries.filter(e=>e.module===module).flatMap(e=>[e.route,...(e.shortcuts.length?[e.route+':add']:[])]))]));
export function validSidebarOrder(module,order){return Object.hasOwn(allowed,module)&&Array.isArray(order)&&order.length<=40&&new Set(order).size===order.length&&order.every(key=>typeof key==='string'&&allowed[module].has(key));}

export function registerSidebarOrder(app,{session,pool}) {
 const scope={bodyLimit:4096,preHandler:async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!sameOriginRequest(req,session.config,req.method!=='GET'))return reply.code(403).send({success:false,error:'Request origin is not allowed.'});
  const actor=await session.resolve(req);if(!actor)return reply.code(401).send({success:false,error:'Please sign in.'});
  if(!sameSessionContext(req,actor))return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
  if(actor.role!=='farm_admin')return reply.code(403).send({success:false,error:'Farm administrator access is required.'});
  if(!await session.store.throttle(req.ip,String(actor.userId),'sidebar-order',{windowSeconds:60,ipAttempts:240,userAttempts:120}))return reply.code(429).send({success:false,error:'Too many sidebar changes. Try again shortly.'});
  req.sidebarActor=actor;
 },errorHandler:(err,req,reply)=>{req.log.error({code:err.code??'SIDEBAR_ORDER'},'Sidebar preference request failed');return reply.code(err.statusCode===413?413:503).send({success:false,error:'Could not confirm the sidebar order. Try again.'});}};
 app.decorateRequest('sidebarActor',null);
 const current=`user_id=$1 AND farm_id=$2 AND auth_version=$3 AND role='farm_admin' AND status='active'
  AND EXISTS(SELECT 1 FROM auth_farm_metadata($2) f WHERE f.status='active')`;
 app.get('/api/account/sidebar-order',scope,async(req,reply)=>{
  const a=req.sidebarActor,r=await pool.query(`SELECT sidebar_order FROM users WHERE ${current}`,[a.userId,a.farmId,a.authVersion]);
  return r.rowCount?{success:true,orders:r.rows[0].sidebar_order}:reply.code(401).send({success:false,error:'Your account changed. Sign in again.'});
 });
 app.put('/api/account/sidebar-order/:module',scope,async(req,reply)=>{
  const b=req.body,module=req.params.module;
  if(!b||typeof b!=='object'||Object.keys(b).length!==1||!validSidebarOrder(module,b.order))return reply.code(400).send({success:false,error:'Choose a valid sidebar order for this module.'});
  const a=req.sidebarActor,r=await pool.query(`UPDATE users SET sidebar_order=jsonb_set(sidebar_order,ARRAY[$4::text],$5::jsonb) WHERE ${current} RETURNING user_id`,[a.userId,a.farmId,a.authVersion,module,JSON.stringify(b.order)]);
  return r.rowCount?{success:true}:reply.code(401).send({success:false,error:'Your account changed. Sign in again.'});
 });
}
