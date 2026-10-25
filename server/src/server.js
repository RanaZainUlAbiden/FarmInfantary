/**
 * The FarmInfantary API.
 *
 * Replaces the desktop app's Electron main process: the ipcMain handlers become
 * HTTP endpoints, and sql.js becomes a PostgreSQL pool.
 *
 * NOT YET PRESENT, by phase:
 *   Phase 1  settings, backup, entitlement endpoints
 *   Phase 3  real sessions, the SQL guard, row-level security, rate limits
 *   Phase 4  the admin routes and permission enforcement
 *
 * Until Phase 3 there is no authentication and no tenancy enforcement. The
 * development session stub refuses to start outside NODE_ENV=development
 * precisely so that cannot be deployed by accident.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createDb } from './db/execute.js';
import { registerTypeParsers } from './db/types.js';
import { createDevSession } from './session.js';
import { registerDbRoutes } from './routes/db.routes.js';

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
export async function buildServer({ env = process.env, logger = false } = {}) {
  const pg = require('pg');
  registerTypeParsers(pg);

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: Number(env.PG_POOL_MAX ?? 10),
    // A statement that runs away must not hold a pooled connection forever.
    // Phase 3 tightens this and adds per-session rate limits; an endpoint that
    // accepts arbitrary SELECTs is a denial-of-service vector.
    statement_timeout: Number(env.STATEMENT_TIMEOUT_MS ?? 10_000),
  });

  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger, bodyLimit: Number(env.BODY_LIMIT_BYTES ?? 2_000_000) });

  const db = createDb(pool);
  const keyCount = await db.init();

  const session = createDevSession(env);

  app.get('/api/health', async () => ({
    ok: true,
    primaryKeys: keyCount,
    openTransactions: db.openTransactions,
    // Stated in the response so it is obvious from outside that this build
    // authenticates nobody.
    session: session.stub ? 'development stub — no authentication' : 'session',
  }));

  registerDbRoutes(app, { db, session });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ success: false, error: `No route for ${req.method} ${req.url}` })
  );

  return { app, db, pool };
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
    console.error(err);
    process.exit(1);
  });
}
