import { randomBytes } from 'node:crypto';
import { authConfig, readSessionToken, sameOriginRequest, sessionCookie } from './config.js';
import { createAuthStore, normalizeUsername } from './store.js';
import { sameSessionContext } from './context.js';
import { hashPassword, verifyPassword, validLoginPassword, validNewPassword, createPasswordWorkLimit } from './password.js';

export async function createAuthentication(pool, env, options = {}) {
  const config = authConfig(env);
  const store = createAuthStore(pool,config,options);
  const work = createPasswordWorkLimit();
  // Unknown users perform the same expensive verification as known users.
  const dummy = await hashPassword(randomBytes(32).toString('base64url'));
  const token = req => readSessionToken(req,config.cookieName);
  const resolve = async req => {
    const cookie=token(req), actor=await store.resolveToken(cookie);
    // A stale/expired/suspended identity also closes its device's outstanding
    // business transaction through the same durable revocation callback.
    if(!actor&&cookie)await store.revoke(cookie);
    return actor;
  };
  const fail = (reply,status,error) => reply.code(status).send({success:false,error});
  const publicUser = actor => { const {authVersion,sessionKey,...user} = actor; return user; };
  function register(app) {
    const scope = { bodyLimit: 4096, errorHandler: (err,req,reply) => {
      if (err.statusCode === 413) return fail(reply,413,'Authentication request is too large.');
      if (err.statusCode >= 400 && err.statusCode < 500) return fail(reply,err.statusCode,'Invalid authentication request.');
      // SQL error detail can contain a failing password-hash row. Do not send
      // it to the client or include it in application logs.
      req.log.error({code:err.code ?? 'AUTH_ERROR'},'Authentication request failed');
      return fail(reply,503,'Authentication is temporarily unavailable.');
    }, preHandler: async (req,reply) => {
      reply.header('Cache-Control','no-store');
      if (!sameOriginRequest(req,config,req.method !== 'GET')) return fail(reply,403,'Request origin is not allowed.');
    }};
    app.post('/api/auth/login',scope,async(req,reply)=>{
      const username = normalizeUsername(req.body?.username);
      const password = req.body?.password;
      if (!username || !validLoginPassword(password)) return fail(reply,400,'Enter a valid username and password.');
      if (!await store.throttle(req.ip,username)) { reply.header('Retry-After',config.loginWindowSeconds); return fail(reply,429,'Too many login attempts. Try again later.'); }
      const result = await work(async()=>{
        const user = await store.findUser(username);
        const ok = await verifyPassword(user?.password_hash ?? dummy,password);
        if (!ok || !user || user.status !== 'active' || (user.role !== 'super_admin' && user.farm_status !== 'active')) return null;
        return store.issue(user,token(req));
      });
      if (result.busy) return fail(reply,503,'Sign-in is busy. Try again shortly.');
      if (!result.value) return fail(reply,401,'Invalid username or password.');
      reply.header('Set-Cookie',sessionCookie(config,result.value.token));
      return {success:true,user:publicUser(result.value.actor)};
    });
    app.get('/api/auth/me',scope,async(req,reply)=>{
      const user = await resolve(req);
      if (!user) { reply.header('Set-Cookie',sessionCookie(config,'',true)); return fail(reply,401,'Please sign in.'); }
      return {success:true,user:publicUser(user)};
    });
    app.post('/api/auth/logout',scope,async(req,reply)=>{
      await store.revoke(token(req));
      reply.header('Set-Cookie',sessionCookie(config,'',true));
      return {success:true};
    });
    app.patch('/api/account/business-type',scope,async(req,reply)=>{
      const actor=await resolve(req);
      if(!actor)return fail(reply,401,'Please sign in.');
      if(!sameSessionContext(req,actor))return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
      // Retire the owner mutation explicitly so older open clients cannot
      // change their assigned bundle. Platform changes use /api/admin/farms.
      return fail(reply,403,'Only a super administrator can assign account modules through platform administration.');
    });
    app.post('/api/auth/password',scope,async(req,reply)=>{
      const user = await resolve(req);
      if (!user) return fail(reply,401,'Please sign in.');
      const old = req.body?.currentPassword, next = req.body?.newPassword;
      if (!validLoginPassword(old) || !validNewPassword(next)) return fail(reply,400,'Use a new password of 15 to 128 characters.');
      if (!await store.throttle(req.ip,String(user.userId),'password')) return fail(reply,429,'Too many attempts. Try again later.');
      const result = await work(async()=>{
        const record = await store.findUser(user.username);
        if (!record || !await verifyPassword(record.password_hash,old)) return false;
        return store.changePassword(user,record.password_hash,await hashPassword(next));
      });
      if (result.busy) return fail(reply,503,'Password changes are busy. Try again shortly.');
      if (!result.value) return fail(reply,401,'The password could not be changed.');
      reply.header('Set-Cookie',sessionCookie(config,'',true));
      return {success:true,signInRequired:true};
    });
  }
  return {stub:false,config,store,resolve,register,passwordWork:work};
}
