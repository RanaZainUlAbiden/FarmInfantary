import {verifyPassword,hashPassword,validLoginPassword} from './password.js';
import {sameOriginRequest} from './config.js';
import {sameSessionContext} from './context.js';
export function createDeleteAuthorization(pool,session,{clock=()=>Date.now()}={}) {
 const now=()=>Math.floor(clock()/1000);
 const eligible=a=>a?.role==='farm_admin'&&a.sessionKey;
 async function canDelete(actor) {
  if(!eligible(actor))return false;
  const r=await pool.query(`SELECT 1 FROM auth_delete_grants g JOIN users u ON u.user_id=g.user_id
   JOIN auth_sessions s ON s.token_hash=g.session_hash AND s.user_id=u.user_id
   JOIN LATERAL auth_farm_metadata(u.farm_id) f ON f.status='active'
   WHERE g.session_hash=$1 AND g.user_id=$2 AND g.farm_id=$3 AND g.auth_version=$4 AND g.expires_at>$5
    AND u.auth_version=g.auth_version AND s.auth_version=u.auth_version AND u.role='farm_admin' AND u.status='active'`,
   [actor.sessionKey,actor.userId,actor.farmId,actor.authVersion,now()]);return r.rowCount===1;
 }
 const validCode=code=>typeof code==='string'&&[...code].length>=8&&[...code].length<=128&&Buffer.byteLength(code)<=1024&&!/[\x00-\x1f]/.test(code);
 function register(app) {
  const scope={bodyLimit:4096,preHandler:async(req,reply)=>{
   reply.header('Cache-Control','no-store');if(!sameOriginRequest(req,session.config,req.method!=='GET'))return reply.code(403).send({success:false,error:'Request origin is not allowed.'});
   const actor=await session.resolve(req);if(!actor)return reply.code(401).send({success:false,error:'Please sign in.'});
   if(!sameSessionContext(req,actor))return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
   if(!eligible(actor))return reply.code(403).send({success:false,error:'Farm administrator access is required.'});req.deleteActor=actor;
  },errorHandler:(e,req,reply)=>{req.log.error({code:e.code??'DELETE_AUTH'},'Delete authorization failed');return reply.code(e.statusCode===413?413:503).send({success:false,error:'Delete authorization is temporarily unavailable.'});}};
  app.decorateRequest('deleteActor',null);
  app.get('/api/account/delete-code',scope,async req=>({success:true,configured:(await pool.query('SELECT 1 FROM farm_security WHERE farm_id=$1',[req.deleteActor.farmId])).rowCount===1}));
  app.put('/api/account/delete-code',scope,async(req,reply)=>{
   const a=req.deleteActor,b=req.body;
   if(!b||Object.keys(b).some(k=>!['currentPassword','newCode'].includes(k))||!validLoginPassword(b.currentPassword)||!validCode(b.newCode))return reply.code(400).send({success:false,error:'Use your current password and a delete code of 8 to 128 characters.'});
   if(!await session.store.throttle(req.ip,String(a.userId),'delete-config',{windowSeconds:60,ipAttempts:15,userAttempts:5}))return reply.code(429).send({success:false,error:'Too many attempts. Try again later.'});
   const result=await session.passwordWork(async()=>{
    const user=await session.store.findUser(a.username);if(!user||user.auth_version!==a.authVersion||!await verifyPassword(user.password_hash,b.currentPassword))return false;
    const hash=await hashPassword(b.newCode),c=await pool.connect();
    try{await c.query('BEGIN');const fresh=await c.query("SELECT user_id FROM users WHERE user_id=$1 AND farm_id=$2 AND auth_version=$3 AND role='farm_admin' AND status='active' FOR SHARE",[a.userId,a.farmId,a.authVersion]);
     if(!fresh.rowCount){await c.query('ROLLBACK');return false;}
     await c.query('INSERT INTO farm_security(farm_id,delete_code_hash) VALUES($1,$2) ON CONFLICT(farm_id) DO UPDATE SET delete_code_hash=excluded.delete_code_hash',[a.farmId,hash]);
     await c.query('DELETE FROM auth_delete_grants WHERE farm_id=$1',[a.farmId]);
     await c.query("INSERT INTO audit_events(actor_id,farm_id,action,target_id) VALUES($1,$2,'security.delete-code',$2)",[a.userId,a.farmId]);await c.query('COMMIT');return true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
   });
   if(result.busy)return reply.code(503).send({success:false,error:'Verification is busy. Try again shortly.'});
   return result.value?{success:true}:reply.code(400).send({success:false,error:'The current password could not be verified.'});
  });
  app.post('/api/account/delete-code/verify',scope,async(req,reply)=>{
   const a=req.deleteActor,b=req.body;if(!b||Object.keys(b).some(k=>k!=='code')||!validCode(b.code))return reply.code(400).send({success:false,error:'Enter a valid delete code.'});
   if(!await session.store.throttle(req.ip,String(a.userId),'delete-verify',{windowSeconds:60,ipAttempts:20,userAttempts:5}))return reply.code(429).send({success:false,error:'Too many attempts. Try again later.'});
   const record=(await pool.query('SELECT delete_code_hash FROM farm_security WHERE farm_id=$1',[a.farmId])).rows[0];
   if(!record)return reply.code(409).send({success:false,error:'Set a delete code in Manage staff & security before deleting.'});
   const result=await session.passwordWork(()=>verifyPassword(record.delete_code_hash,b.code));
   if(result.busy)return reply.code(503).send({success:false,error:'Verification is busy. Try again shortly.'});
   if(!result.value)return reply.code(400).send({success:false,error:'Incorrect delete code.'});
   // Conditional insert closes races with code changes and actor revocation.
   const r=await pool.query(`INSERT INTO auth_delete_grants(session_hash,user_id,farm_id,auth_version,expires_at)
    SELECT $1,u.user_id,u.farm_id,u.auth_version,$5 FROM users u
    JOIN farm_security f ON f.farm_id=u.farm_id AND f.delete_code_hash=$6
    JOIN auth_sessions s ON s.token_hash=$1 AND s.user_id=u.user_id AND s.auth_version=u.auth_version
    WHERE u.user_id=$2 AND u.farm_id=$3 AND u.auth_version=$4 AND u.role='farm_admin' AND u.status='active' FOR SHARE OF u,f,s
    ON CONFLICT(session_hash) DO UPDATE SET expires_at=excluded.expires_at`,[a.sessionKey,a.userId,a.farmId,a.authVersion,now()+60,record.delete_code_hash]);
   await pool.query('DELETE FROM auth_delete_grants WHERE expires_at<=$1',[now()]);
   return r.rowCount?{success:true,validSeconds:60}:reply.code(409).send({success:false,error:'Your account or delete code changed. Try again.'});
  });
 }
 return {canDelete,register};
}
