import {createAdminStore,AdminError} from './store.js';
import {sameOriginRequest} from '../auth/config.js';
import {sameSessionContext} from '../auth/context.js';
import {normalizeUsername} from '../auth/store.js';
import {validNewPassword,hashPassword} from '../auth/password.js';
const bad=message=>{throw new AdminError(400,message);};
const id=value=>{const n=Number(value);if(!/^[1-9][0-9]*$/.test(String(value))||!Number.isSafeInteger(n))bad('Use a valid identifier.');return n;};
function body(value,keys) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))bad('Invalid administration request.');return value;
}
const status=v=>{if(!['active','suspended'].includes(v))bad('Choose active or suspended.');return v;};
const name=v=>{if(typeof v!=='string'||v.trim().length<1||v.trim().length>100||/[\x00-\x1f]/.test(v))bad('Enter a farm name of 1 to 100 characters.');return v.trim();};
const type=v=>{if(!['broiler_distribution','layer_distribution','all'].includes(v))bad('Choose Broiler + Distribution, Layers + Distribution, or all three modules.');return v;};
function userInput(value,extra=[]) {const b=body(value,['username','password',...extra]),username=normalizeUsername(b.username);if(!username||!validNewPassword(b.password))bad('Use a valid username and a password of 15 to 128 characters.');return {...b,username};}
export function registerAdminRoutes(app,{pool,session,onRevokeUser}) {
 const store=createAdminStore(pool,{onRevokeUser});
 const scope=roles=>({bodyLimit:16384,preHandler:async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!sameOriginRequest(req,session.config,req.method!=='GET'))return reply.code(403).send({success:false,error:'Request origin is not allowed.'});
  const actor=await session.resolve(req);if(!actor)return reply.code(401).send({success:false,error:'Please sign in.'});
  if(!sameSessionContext(req,actor))return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
  if(!roles.includes(actor.role))return reply.code(403).send({success:false,error:'Administrator access is required.'});
  if(!await session.store.throttle(req.ip,String(actor.userId),'admin',{windowSeconds:60,ipAttempts:120,userAttempts:90}))return reply.code(429).send({success:false,error:'Too many administration requests. Try again shortly.'});
  req.adminActor=actor;
 },errorHandler:(error,req,reply)=>{
  if(error instanceof AdminError)return reply.code(error.status).send({success:false,error:error.message});
  if(error.code==='23505')return reply.code(409).send({success:false,error:'That username is already in use.'});
  if(error.code==='23514'&&error.message==='Staff seat limit reached')return reply.code(409).send({success:false,error:'Staff seat limit reached. Contact the platform administrator.'});
  if(error.statusCode===413)return reply.code(413).send({success:false,error:'Administration request is too large.'});
  if(error.statusCode>=400&&error.statusCode<500)return reply.code(error.statusCode).send({success:false,error:'Invalid administration request.'});
  req.log.error({code:error.code??'ADMIN_ERROR'},'Administration request failed');return reply.code(503).send({success:false,error:'Administration is temporarily unavailable.'});
 }});
 const root=scope(['super_admin']),owner=scope(['farm_admin']);
 app.decorateRequest('adminActor',null);
 const page=req=>({before:req.query.before===undefined?null:id(req.query.before),limit:req.query.limit===undefined?50:Math.min(id(req.query.limit),100)});
 async function withPassword(input,work,reply) {
  const result=await session.passwordWork(async()=>work({...input,passwordHash:await hashPassword(input.password)}));
  if(result.busy)return reply.code(503).send({success:false,error:'Account creation is busy. Try again shortly.'});
  return {success:true,...result.value};
 }
 app.get('/api/admin/farms',root,async req=>{const p=page(req);return {success:true,farms:await store.listFarms(req.adminActor,p.before,p.limit)};});
 app.get('/api/admin/farms/:farmId',root,async req=>({success:true,farm:await store.getFarm(req.adminActor,id(req.params.farmId))}));
 app.post('/api/admin/farms',root,async(req,reply)=>{
  const b=userInput(req.body,['farmName','businessType']);b.farmName=name(b.farmName);b.businessType=type(b.businessType);
  return withPassword(b,input=>store.createFarm(req.adminActor,input),reply);
 });
 app.put('/api/admin/farms/:farmId',root,async req=>{
  const b=body(req.body,['farmName','businessType','status','seatLimit','allowStaffCreation','expectedVersion']);
  if(!Number.isSafeInteger(b.seatLimit)||b.seatLimit<0||b.seatLimit>1_000_000||typeof b.allowStaffCreation!=='boolean')bad('Choose valid staff settings.');
  return {success:true,...await store.updateFarm(req.adminActor,id(req.params.farmId),{...b,farmName:name(b.farmName),businessType:type(b.businessType),status:status(b.status),expectedVersion:id(b.expectedVersion)})};
 });
 app.get('/api/admin/farms/:farmId/users',root,async req=>{const p=page(req);return {success:true,users:await store.listUsers(req.adminActor,id(req.params.farmId),p.before,p.limit)};});
 app.post('/api/admin/farms/:farmId/staff',root,async(req,reply)=>withPassword(userInput(req.body),input=>store.createStaff(req.adminActor,id(req.params.farmId),input),reply));
 app.get('/api/account/staff',owner,async req=>{const p=page(req);return {success:true,...await store.ownTeam(req.adminActor,p.before,p.limit)};});
 app.post('/api/account/staff',owner,async(req,reply)=>withPassword(userInput(req.body),input=>store.createStaff(req.adminActor,req.adminActor.farmId,input),reply));
 app.put('/api/admin/users/:userId/status',root,async req=>{const b=body(req.body,['status','expectedVersion']);return {success:true,...await store.setStatus(req.adminActor,id(req.params.userId),{status:status(b.status),expectedVersion:id(b.expectedVersion)})};});
 app.post('/api/admin/users/:userId/password',root,async(req,reply)=>{
  const b=body(req.body,['password','expectedVersion']);if(!validNewPassword(b.password))bad('Use a password of 15 to 128 characters.');b.expectedVersion=id(b.expectedVersion);
  return withPassword(b,input=>store.resetPassword(req.adminActor,id(req.params.userId),input),reply);
 });
 app.get('/api/admin/permissions',root,async req=>({success:true,permissions:await store.catalogue(req.adminActor)}));
 app.get('/api/admin/users/:userId/permissions',root,async req=>({success:true,...await store.permissions(req.adminActor,id(req.params.userId))}));
 app.put('/api/admin/users/:userId/permissions',root,async req=>{
  const b=body(req.body,['expectedVersion','grants']);if(!Array.isArray(b.grants)||b.grants.length>100)bad('Invalid permission list.');
  for(const g of b.grants) {body(g,['key','view','create','edit','delete']);if(typeof g.key!=='string'||!['view','create','edit','delete'].every(k=>typeof g[k]==='boolean')||(!g.view&&(g.create||g.edit||g.delete)))bad('Mutation access requires view access.');}
  if(new Set(b.grants.map(g=>g.key)).size!==b.grants.length)bad('Duplicate permission key.');
  return {success:true,...await store.setPermissions(req.adminActor,id(req.params.userId),{expectedVersion:id(b.expectedVersion),grants:b.grants})};
 });
 app.get('/api/admin/audit',root,async req=>{const p=page(req);return {success:true,events:await store.audit(req.adminActor,p.before,p.limit)};});
 return store;
}
