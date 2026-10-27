/**
 * The FarmInfantary API.
 *
 * Replaces the desktop app's Electron main process: the ipcMain handlers become
 * HTTP endpoints, and sql.js becomes a PostgreSQL pool.
 *
 * NOT YET PRESENT, by phase:
 *   Phase 1  settings, backup, entitlement endpoints
 *   Phase 3  browser session integration and delete PIN handling
 *   Phase 4  the admin routes and permission enforcement
 *
 * Session mode now wires real auth, the AST guard, restricted runtime role,
 * tenant RLS and bounded session transactions. Browser/staff/operations work
 * and independent security review remain; production startup is still blocked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createDb } from './db/execute.js';
import { registerTypeParsers } from './db/types.js';
import { createDevSession } from './session.js';
import { registerDbRoutes } from './routes/db.routes.js';
import { createAuthentication } from './auth/auth.js';
import { sameOriginRequest } from './auth/config.js';
import { sameSessionContext } from './auth/context.js';
import { attestRuntimeRole } from './db/runtime-role.js';
import { createSessionDb } from './db/session-execute.js';
import { createSqlGuard, loadGuardCatalog } from './guard/sql-guard.js';
import { registerAdminRoutes } from './admin/routes.js';
import { createDeleteAuthorization } from './auth/delete-auth.js';
import { registerOwnerData } from './routes/owner-data.js';
import { registerBrokerRoutes } from './brokers/routes.js';
import {registerSidebarOrder} from './auth/sidebar-order.js';
import { attestAuthRole } from '../../db/auth-role.mjs';
import { productionApproved } from './release.js';
import { isIP } from 'node:net';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Load .env (gitignored) without a dependency. */
export function loadEnv(root = ROOT, env = process.env) {
  const path = join(root, '.env');
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim();
  }
  return env;
}

/**
 * Builds the app without listening, so tests can drive it with `inject()`.
 * @returns {Promise<{ app: import('fastify').FastifyInstance, db: any, pool: any }>}
 */
export async function buildServer({ env = process.env, logger = false, pool: suppliedPool, runtimePool: suppliedRuntimePool, authOptions } = {}) {
  // Real identity alone does not make a raw SQL endpoint safe. Production
  // remains fail-closed until browser/staff/operations integration and review.
  const production=productionApproved(env);
  const mode = env.AUTH_MODE ?? 'development';
  if (!['development','session'].includes(mode)) throw new Error('AUTH_MODE must be development or session.');
  const developmentSession = mode === 'development' ? createDevSession(env) : null;
  const pg = require('pg');
  registerTypeParsers(pg);

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  const pool = suppliedPool ?? new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: Number(env.PG_POOL_MAX ?? 10),
    // Compatibility demo only: the server's fixed farm, never browser input.
    // Real session execution uses transaction-local context on the runtime pool.
    ...(developmentSession ? { options: `-c app.farm_id=${developmentSession.resolve().farmId}` } : {}),
    // A statement that runs away must not hold a pooled connection forever.
    // Phase 3 tightens this and adds per-session rate limits; an endpoint that
    // accepts arbitrary SELECTs is a denial-of-service vector.
    statement_timeout: Number(env.STATEMENT_TIMEOUT_MS ?? 10_000),
  });

  const Fastify = (await import('fastify')).default;
  const proxies=env.TRUST_PROXY?env.TRUST_PROXY.split(',').map(v=>v.trim()):[];
  if(proxies.some(v=>!isIP(v)))throw new Error('TRUST_PROXY must list explicit trusted proxy IP addresses.');
  const app = Fastify({ logger: logger === true ? {redact:['req.headers.cookie','req.body.password','req.body.currentPassword','req.body.newPassword']} : logger,
    trustProxy:proxies.length?proxies:false,
    bodyLimit: Number(env.BODY_LIMIT_BYTES ?? 2_000_000) });

  try {
    if(production)await attestAuthRole(pool,{schema:env.DATABASE_SCHEMA??'public'});
    app.addHook('onSend',async(_req,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','same-origin');if(production)reply.header('Strict-Transport-Security','max-age=31536000');return payload;});
    const db = createDb(pool);
    const keyCount = await db.init();

    let sessionDb=null, runtime=null, deleteAuthorization=null;
    const requestLimit=Number(env.RATE_LIMIT_PER_MINUTE??600);
    if(!Number.isSafeInteger(requestLimit)||requestLimit<1||requestLimit>10_000)throw new Error('Invalid SQL request limit.');
    if(mode==='session'&&(env.RUNTIME_DATABASE_URL||suppliedRuntimePool)) {
      const schema=env.DATABASE_SCHEMA??'public';
      runtime=suppliedRuntimePool??new pg.Pool({connectionString:env.RUNTIME_DATABASE_URL,max:8,
        connectionTimeoutMillis:5000,statement_timeout:10_000});
      app.addHook('onClose',async()=>{await sessionDb?.close();if(!suppliedRuntimePool)await runtime.end();});
      await attestRuntimeRole(runtime,{schema});
      const infoSql='SELECT current_database() AS db,current_schema() AS schema,inet_server_addr()::text AS addr,inet_server_port() AS port';
      const [authInfo,runtimeInfo]=await Promise.all([pool.query(infoSql),runtime.query(infoSql)]);
      if(authInfo.rows[0].schema!==schema||JSON.stringify(authInfo.rows[0])!==JSON.stringify(runtimeInfo.rows[0])) {
        throw new Error('Auth and runtime pools must use the same PostgreSQL database and tenant schema.');
      }
      const maxRows=Number(env.MAX_ROWS_PER_QUERY??50_000);
      if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>100_000)throw new Error('Invalid SQL row limit.');
      const authorize=createSqlGuard({catalog:await loadGuardCatalog(runtime,{schema}),schema,maxRows,canDelete:actor=>deleteAuthorization?.canDelete(actor)??false});
      sessionDb=createSessionDb(runtime,{authorize});await sessionDb.init();
    }
    const session = mode === 'session' ? await createAuthentication(pool,env,{...authOptions,
      onRevokeSession:async key=>{await sessionDb?.revokeSession(key);await authOptions?.onRevokeSession?.(key);},
      onRevokeUser:async id=>{await sessionDb?.revokeUser(id);await authOptions?.onRevokeUser?.(id);},
    }) : developmentSession;
    if (!session.stub) {
      session.register(app);
      registerSidebarOrder(app,{session,pool});
      deleteAuthorization=createDeleteAuthorization(pool,session,{clock:authOptions?.clock});deleteAuthorization.register(app);
      registerOwnerData(app,{session,runtime,schema:env.DATABASE_SCHEMA??'public'});
      registerBrokerRoutes(app,{session,runtime,deleteAuthorization});
      registerAdminRoutes(app,{pool,session,onRevokeUser:async id=>{await sessionDb?.revokeUser(id);await authOptions?.onRevokeUser?.(id);}});
      app.decorateRequest('farmActor',null);
      app.addHook('preHandler',async(req,reply)=>{
        if (!req.routeOptions.url?.startsWith('/api/db/')) return;
        reply.header('Cache-Control','no-store');
        if (!sameOriginRequest(req,session.config,true)) return reply.code(403).send({success:false,error:'Request origin is not allowed.'});
        let actor;
        try { actor = await session.resolve(req); }
        catch { return reply.code(503).send({success:false,error:'Authentication is temporarily unavailable.'}); }
        if (!actor) return reply.code(401).send({success:false,error:'Please sign in.'});
        if (!sameSessionContext(req,actor)) return reply.code(409).send({success:false,code:'SESSION_CHANGED',error:'Your sign-in changed. Sign in again.'});
        if (actor.role === 'super_admin') return reply.code(403).send({success:false,error:'Platform administrators cannot use the business SQL endpoint.'});
        if(!sessionDb)return reply.code(503).send({success:false,error:'Business access is pending tenant security setup.'});
        if(actor.role!=='farm_admin')return reply.code(403).send({success:false,error:'Staff SQL access is pending permission setup.'});
        let allowed;
        try{allowed=await session.store.throttle(req.ip,String(actor.userId),'sql',
          {windowSeconds:60,ipAttempts:requestLimit,userAttempts:requestLimit});}
        catch{return reply.code(503).send({success:false,error:'Database access is temporarily unavailable.'});}
        if(!allowed){reply.header('Retry-After','60');return reply.code(429).send({success:false,error:'Too many database requests. Try again shortly.'});}
        req.farmActor=actor;
      });
    }

    app.get('/api/health', async () => ({
      ok: true,
      primaryKeys: keyCount,
      openTransactions: sessionDb?.openTransactions??db.openTransactions,
      // Stated in the response so it is obvious from outside that this build
      // authenticates nobody.
      session: session.stub ? 'development stub — no authentication' : sessionDb
        ? 'cookie session — guarded tenant SQL for farm admins; staff permissions pending'
        : 'cookie session — business SQL disabled pending restricted runtime setup',
    }));
    let readiness=null,lastReadiness=null,lastProbe=0;
    app.get('/api/ready',async(_req,reply)=>{
      if(Date.now()-lastProbe>1000||!lastReadiness){if(!readiness)readiness=Promise.all([pool.query('SELECT 1'),...(runtime?[runtime.query('SELECT 1')]:[])]).then(()=>({ready:true}),()=>({ready:false})).then(result=>{lastReadiness=result;lastProbe=Date.now();readiness=null;return result;});await readiness;}
      return reply.code(lastReadiness?.ready?200:503).send(lastReadiness);
    });

    registerDbRoutes(app, { db, session:session.stub?session:{resolve:req=>req.farmActor}, sessionDb,guarded:!session.stub });

    app.setNotFoundHandler((req, reply) =>
      reply.code(404).send({ success: false, error: `No route for ${req.method} ${req.url}` })
    );

    return { app, db, pool, session, sessionDb };
  } catch (error) {
    await app.close();
    if (!suppliedPool) await pool.end();
    throw error;
  }
}

/** Entry point when run directly. */
async function main() {
  loadEnv();
  const { app, pool } = await buildServer({ logger: true });
  const port = Number(process.env.PORT ?? 3000);

  const shutdown = async (signal) => {
    app.log.info(`${signal} — shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    console.error('Startup failed: '+(err.code??err.message));
    process.exit(1);
  });
}
