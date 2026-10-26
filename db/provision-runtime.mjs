#!/usr/bin/env node
import { createRequire } from 'node:module';
import { loadEnv } from '../server/src/server.js';
import { provisionRuntimeRole } from './runtime-role.mjs';
import { attestRuntimeRole } from '../server/src/db/runtime-role.js';
let admin, runtime;
try {
  loadEnv();
  if (process.argv.includes('--help')) {
    console.log('Usage: node db/provision-runtime.mjs\n' +
      'Requires MIGRATION_DATABASE_URL and a new RUNTIME_DATABASE_URL with a random base64url password.\n' +
      'Never reuses/resets existing roles. Optional DATABASE_SCHEMA defaults to public.');
  } else {
    if (process.argv.length > 2) throw new Error('Unknown arguments.');
    if (!process.env.MIGRATION_DATABASE_URL || !process.env.RUNTIME_DATABASE_URL) throw new Error('Set MIGRATION_DATABASE_URL and RUNTIME_DATABASE_URL.');
    const url = new URL(process.env.RUNTIME_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL runtime URL.');
    if (url.search) throw new Error('Runtime URL must not include startup option overrides.');
    const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL);
    if (url.hostname !== migrationUrl.hostname || (url.port||'5432') !== (migrationUrl.port||'5432') || url.pathname !== migrationUrl.pathname) {
      throw new Error('Migration and runtime URLs must target the same server and database.');
    }
    const role = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const schema = process.env.DATABASE_SCHEMA || 'public';
    const { Pool } = createRequire(new URL('../server/package.json', import.meta.url))('pg');
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
    await provisionRuntimeRole(admin, { role, password, schema });
    runtime = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 10000 });
    const result = await attestRuntimeRole(runtime, { schema });
    console.log(`Runtime role provisioned and verified for ${result.tenantTables} tenant tables.`);
  }
} catch (error) {
  // Never print a connection URL, SQL text or database error DETAIL/password.
  console.error('Runtime provisioning failed: ' + (error.code ? `database error ${error.code}` : error.message));
  process.exitCode = 1;
} finally { await runtime?.end(); await admin?.end(); }
