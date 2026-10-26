#!/usr/bin/env node
import { createRequire } from 'node:module';
import { loadEnv } from '../server/src/server.js';
import { migrate } from './migration-runner.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node db/migrate.mjs [--baseline]\n' +
    'Fresh database: no flags. Existing manual setup: --baseline validates before recording.\n' +
    'MIGRATION_DATABASE_URL (or DATABASE_URL) must use a DDL-capable migration role.');
} else {
  let pool;
  try {
    if (args.some((arg) => arg !== '--baseline')) throw new Error('Unknown option. Use --help.');
    loadEnv();
    const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL in .env.');
    const require = createRequire(new URL('../server/package.json', import.meta.url));
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
    const result = await migrate(pool, { baseline: args.includes('--baseline') });
    if (result.baselined) console.log('Validated existing schema and recorded baseline 001.');
    for (const filename of result.applied) console.log(`Applied ${filename}`);
    console.log(`Database is at migration ${String(result.version).padStart(3, '0')}.`);
  } catch (error) {
    // Do not print the pool/configuration: connection URLs contain credentials.
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
