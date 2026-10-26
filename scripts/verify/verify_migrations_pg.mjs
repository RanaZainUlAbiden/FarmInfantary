// Exercises real DDL, history, rollback and concurrent deploys in private schemas.
// Never changes public business rows or the real migration history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { loadEnv } from '../../server/src/server.js';
import { migrate, MIGRATIONS_DIR, schemaSnapshot } from '../../db/migration-runner.mjs';
import { registerTypeParsers } from '../../server/src/db/types.js';

loadEnv();
if (!process.env.DATABASE_URL) {
  console.log('SKIP — no DATABASE_URL configured; PostgreSQL migrations are unverified');
  process.exit(0);
}
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const pg = require('pg');
registerTypeParsers(pg);
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
const prefix = `vm_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const schemas = [];
const directory = mkdtempSync(join(tmpdir(), 'farm-migrations-'));
const baselineSql = readFileSync(join(MIGRATIONS_DIR, '001_initial_schema.sql'), 'utf8');
writeFileSync(join(directory, '001_initial_schema.sql'), baselineSql);
let passed = 0;
const check = async (label, work) => {
  await work();
  console.log(`  PASS  ${label}`);
  passed++;
};
async function fixture(label) {
  const schema = `${prefix}_${label}`;
  const historySchema = `${schema}_meta`;
  schemas.push(schema, historySchema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return { schema, historySchema, directory };
}
const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;
const history = (f) => rows(`SELECT version,applied_via FROM "${f.historySchema}".schema_migrations ORDER BY version`);

try {
  const fresh = await fixture('fresh');
  await check('fresh setup applies baseline once', async () => {
    const r = await migrate(pool, fresh);
    assert.deepEqual(r.applied, ['001_initial_schema.sql']);
    assert.equal(r.version, 1);
    assert.equal(r.baselined, false);
  });
  await check('all 60 tables, 555 columns, 49 non-primary indexes are installed', async () => {
    const s = await schemaSnapshot(pool, fresh.schema);
    assert.equal(s.tables.length, 60);
    assert.equal(s.columns.length, 555);
    assert.equal(s.indexes.filter((i) => !i.index_name.endsWith('_pkey')).length, 49);
    assert.equal(s.columns.filter((c) => c.type === 'double precision').length, 86);
    assert.equal(s.columns.filter((c) => c.attidentity).length, 58);
    assert.equal(s.constraints.filter((c) => c.contype === 'f').length, 0);
  });
  await check('second run applies nothing and keeps one history entry', async () => {
    assert.deepEqual((await migrate(pool, fresh)).applied, []);
    assert.deepEqual(await history(fresh), [{ version: 1, applied_via: 'migration' }]);
  });
  await check('schema history cannot be mixed into the application schema', async () => {
    await assert.rejects(migrate(pool, { ...fresh, historySchema: fresh.schema }), /outside/);
  });

  const existing = await fixture('existing');
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query(`SET LOCAL search_path TO "${existing.schema}",public`);
    await setup.query(baselineSql);
    // All fields lost by the historical vaccination rebuild get sentinels.
    await setup.query(`INSERT INTO vaccinations
      (vaccination_id,flock_id,batch_id,vaccine_name,date,cost,bill_id,bill_number)
      VALUES (700,123,NULL,'Preserve me','2026-10-25',987.5,456,'SENTINEL')`);
    await setup.query('COMMIT');
  } finally { setup.release(); }
  const originalRows = await rows(`SELECT * FROM "${existing.schema}".vaccinations`);
  await check('unversioned database requires explicit --baseline and remains untouched', async () => {
    await assert.rejects(migrate(pool, existing), /--baseline/);
    assert.deepEqual(await rows(`SELECT * FROM "${existing.schema}".vaccinations`), originalRows);
    assert.equal((await rows('SELECT 1 FROM pg_namespace WHERE nspname=$1', [existing.historySchema])).length, 0);
  });
  await check('explicit baseline validates structure and preserves vaccination data', async () => {
    const r = await migrate(pool, { ...existing, baseline: true });
    assert.equal(r.baselined, true);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(await history(existing), [{ version: 1, applied_via: 'baseline' }]);
    assert.deepEqual(await rows(`SELECT * FROM "${existing.schema}".vaccinations`), originalRows);
  });
  await check('baseline refuses a database that already has history', async () => {
    await assert.rejects(migrate(pool, { ...existing, baseline: true }), /already has/);
  });
  const empty = await fixture('empty');
  await check('baseline refuses an empty schema', async () => {
    await assert.rejects(migrate(pool, { ...empty, baseline: true }), /empty schema/);
  });
  const drift = await fixture('drift');
  const copy = await pool.connect();
  try {
    await copy.query('BEGIN');
    await copy.query(`SET LOCAL search_path TO "${drift.schema}",public`);
    await copy.query(baselineSql);
    await copy.query('ALTER TABLE vaccinations DROP COLUMN bill_number');
    await copy.query('COMMIT');
  } finally { copy.release(); }
  await check('baseline rejects schema drift without recording history', async () => {
    await assert.rejects(migrate(pool, { ...drift, baseline: true }), /differs.*columns/);
    assert.equal((await rows('SELECT 1 FROM pg_namespace WHERE nspname=$1', [drift.historySchema])).length, 0);
  });
  await check('baseline rejects changed money types and missing indexes', async () => {
    await pool.query(`ALTER TABLE "${drift.schema}".vaccinations ADD COLUMN bill_number text`);
    // Use another full clone to keep column order identical to the baseline.
    const changed = await fixture('changed');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${changed.schema}",public`);
      await client.query(baselineSql);
      await client.query('ALTER TABLE vaccinations ALTER COLUMN cost TYPE numeric');
      await client.query('COMMIT');
    } finally { client.release(); }
    await assert.rejects(migrate(pool, { ...changed, baseline: true }), /differs.*columns/);
    await pool.query(`ALTER TABLE "${changed.schema}".vaccinations ALTER COLUMN cost TYPE double precision`);
    await pool.query(`DROP INDEX "${changed.schema}".idx_asset_payments_date`);
    await assert.rejects(migrate(pool, { ...changed, baseline: true }), /differs.*indexes/);
  });
  await check('a failed migration rolls back its DDL and history together', async () => {
    writeFileSync(join(directory, '002_upgrade.sql'),
      'CREATE TABLE upgrade_marker (id integer PRIMARY KEY); INSERT INTO no_such_table VALUES (1);');
    await assert.rejects(migrate(pool, fresh), /no_such_table/);
    assert.equal((await rows('SELECT to_regclass($1) AS table_name', [`${fresh.schema}.upgrade_marker`]))[0].table_name, null);
    assert.equal((await history(fresh)).length, 1);
  });
  await check('failed initial deploy rolls back earlier pending versions and metadata too', async () => {
    const failed = await fixture('failed');
    await assert.rejects(migrate(pool, failed), /no_such_table/);
    assert.equal((await schemaSnapshot(pool, failed.schema)).tables.length, 0);
    assert.equal((await rows('SELECT 1 FROM pg_namespace WHERE nspname=$1', [failed.historySchema])).length, 0);
  });
  await check('corrected pending migration upgrades once; repeated run preserves data', async () => {
    writeFileSync(join(directory, '002_upgrade.sql'),
      'CREATE TABLE upgrade_marker (id integer PRIMARY KEY); INSERT INTO upgrade_marker VALUES (1);');
    assert.deepEqual((await migrate(pool, fresh)).applied, ['002_upgrade.sql']);
    assert.deepEqual((await migrate(pool, fresh)).applied, []);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM "${fresh.schema}".upgrade_marker`))[0].n, 1);
  });
  await check('editing an applied migration is refused', async () => {
    writeFileSync(join(directory, '002_upgrade.sql'), 'SELECT 1;');
    await assert.rejects(migrate(pool, fresh), /history differs/);
    assert.equal((await history(fresh)).length, 2);
    writeFileSync(join(directory, '002_upgrade.sql'),
      'CREATE TABLE upgrade_marker (id integer PRIMARY KEY); INSERT INTO upgrade_marker VALUES (1);');
  });
  await check('missing applied migrations are refused', async () => {
    await assert.rejects(migrate(pool, { ...fresh, directory: MIGRATIONS_DIR }), /history differs/);
  });
  const concurrent = await fixture('concurrent');
  await check('concurrent first deploys serialize and apply each version exactly once', async () => {
    const results = await Promise.all([migrate(pool, concurrent), migrate(pool, concurrent)]);
    assert.deepEqual(results.map((r) => r.applied.length).sort(), [0, 2]);
    assert.equal((await history(concurrent)).length, 2);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM "${concurrent.schema}".upgrade_marker`))[0].n, 1);
  });
  await check('advisory lock wait has a timeout and leaves no history behind', async () => {
    const locked = await fixture('locked');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
        ['FarmInfantary migrations', locked.schema]);
      await assert.rejects(migrate(pool, { ...locked, lockTimeoutMs: 50 }), /lock timeout/);
      assert.equal((await rows('SELECT 1 FROM pg_namespace WHERE nspname=$1', [locked.historySchema])).length, 0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    assert.equal((await migrate(pool, locked)).version, 2);
  });
  console.log(`ALL CHECKS PASSED — ${passed} migration scenarios`);
} finally {
  for (const schema of schemas.reverse()) {
    // Names are generated here, never read from user/application data.
    assert.ok(schema.startsWith(`${prefix}_`) && /^[a-z0-9_]+$/.test(schema));
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await pool.end();
  assert.equal(dirname(directory), tmpdir());
  assert.ok(basename(directory).startsWith('farm-migrations-'));
  rmSync(directory, { recursive: true });
}
