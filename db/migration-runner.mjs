import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, splitStatements } from '../server/src/db/scan.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

function identifier(name) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid schema name: ${name}`);
  return `"${name}"`;
}

/** Applied SQL is immutable. Normalize line endings so Windows and Linux agree. */
export function readMigrations(directory = MIGRATIONS_DIR) {
  const files = readdirSync(directory).filter((name) => /\.sql$/i.test(name)).sort();
  if (!files.length) throw new Error('No SQL migrations found.');
  return files.map((filename, index) => {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(filename);
    if (!match || Number(match[1]) !== index + 1) {
      throw new Error(`Migrations must be numbered consecutively from 001: ${filename}`);
    }
    const sql = readFileSync(join(directory, filename), 'utf8').replace(/\r\n/g, '\n');
    const statements = splitStatements(sql);
    if (!statements.some((s) => codeOnly(s).trim())) throw new Error(`Empty migration: ${filename}`);
    for (const statement of statements) {
      if (/^\s*(?:BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|START\s+TRANSACTION|PREPARE\s+TRANSACTION)\b/i.test(codeOnly(statement))) {
        throw new Error(`Transaction control belongs to the runner: ${filename}`);
      }
    }
    return {
      version: index + 1, filename, sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

/** Structure only: never compare row contents or sequence positions. */
export async function schemaSnapshot(client, schema) {
  const queries = {
    tables: `SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
    columns: `SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin,d.adrelid) AS default_value,
      co.collname AS collation
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`,
    constraints: `SELECT c.relname, con.conname, con.contype, con.condeferrable,
      con.condeferred, con.convalidated, pg_get_constraintdef(con.oid,true) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
      ORDER BY c.relname,con.conname`,
    indexes: `SELECT c.relname, ic.relname AS index_name, i.indisvalid,
      pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
      JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 ORDER BY c.relname,ic.relname`,
    triggers: `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal
      ORDER BY c.relname,t.tgname`,
    // These are metadata limits, not application ids. int8 parsers correctly
    // refuse 9223372036854775807 as a JS Number; compare exact text instead.
    sequences: `SELECT sequencename,data_type,start_value::text,min_value::text,max_value::text,
      increment_by::text,cycle,cache_size::text
      FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    const { rows } = await client.query(sql, [schema]);
    // pg_get_* may qualify identifiers differently depending on search_path.
    result[name] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'string'
        ? value.replaceAll(`"${schema}".`, '__schema__.').replaceAll(`${schema}.`, '__schema__.')
        : value]
    )));
  }
  return result;
}

async function assertCollation(client) {
  const { rows } = await client.query(`SELECT c.collprovider,c.collisdeterministic,
    COALESCE(to_jsonb(c)->>'colllocale',to_jsonb(c)->>'colliculocale') AS locale
    FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
    WHERE n.nspname='public' AND c.collname='nocase'`);
  if (rows.length !== 1 || rows[0].collprovider !== 'i' || rows[0].collisdeterministic !== false
      || rows[0].locale !== 'und-u-ks-level2') {
    throw new Error('public.nocase must be the ICU und-u-ks-level2 nondeterministic collation from 000_collations.sql.');
  }
}

async function assertBaseline(client, schema, first) {
  await assertCollation(client);
  const reference = `migration_reference_${randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE SCHEMA ${identifier(reference)}`);
  await client.query(`SET LOCAL search_path TO ${identifier(reference)}, public`);
  await client.query(first.sql);
  // Use the same search path for both snapshots so deparsing is consistent.
  await client.query('SET LOCAL search_path TO pg_catalog');
  const actual = await schemaSnapshot(client, schema);
  const expected = await schemaSnapshot(client, reference);
  for (const section of Object.keys(expected)) {
    if (JSON.stringify(actual[section]) !== JSON.stringify(expected[section])) {
      const at = expected[section].findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(actual[section][i]));
      throw new Error(`Cannot baseline: ${schema} differs from migration 001 (${section}; ` +
        `expected ${expected[section].length}, found ${actual[section].length} entries` +
        (at < 0 ? ').' : `; first mismatch ${JSON.stringify(expected[section][at])}).`));
    }
  }
  await client.query(`DROP SCHEMA ${identifier(reference)} CASCADE`);
}

/**
 * Dedicated deploy command, NOT an API startup hook. The migration role needs
 * DDL privileges; the future least-privilege API role must never run this.
 * One transaction owns the advisory lock, all pending DDL, and history writes.
 */
export async function migrate(pool, {
  directory = MIGRATIONS_DIR, schema = 'public', historySchema = 'farminfantary_meta',
  baseline = false, lockTimeoutMs = 15_000, statementTimeoutMs = 60_000,
} = {}) {
  const target = identifier(schema);
  const history = identifier(historySchema);
  if (schema === historySchema) throw new Error('Migration history must be outside the application schema.');
  const migrations = readMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`]);
    // Take the lock BEFORE creating the history schema/table: first deploy races too.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      ['FarmInfantary migrations', schema]);
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    if (!exists.rowCount) throw new Error(`Target schema does not exist: ${schema}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${history}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${history}.schema_migrations (
      version integer PRIMARY KEY, filename text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (length(checksum)=64),
      applied_via text NOT NULL CHECK (applied_via IN ('migration','baseline')),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows: installed } = await client.query(`SELECT version,filename,checksum FROM ${history}.schema_migrations ORDER BY version`);
    installed.forEach((row, i) => {
      const file = migrations[i];
      if (!file || row.version !== file.version || row.filename !== file.filename || row.checksum !== file.checksum) {
        throw new Error(`Migration history differs from files at version ${row.version}. Restore applied files; add a new migration instead.`);
      }
    });
    const record = (file, via) => client.query(
      `INSERT INTO ${history}.schema_migrations(version,filename,checksum,applied_via) VALUES ($1,$2,$3,$4)`,
      [file.version, file.filename, file.checksum, via]);
    let offset = installed.length;
    const applied = [];
    let baselined = false;
    if (!offset) {
      const { rows } = await client.query(`SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f','S')`, [schema]);
      if (baseline) {
        if (!rows.length) throw new Error('Cannot baseline an empty schema. Run without --baseline.');
        await assertBaseline(client, schema, migrations[0]);
        await record(migrations[0], 'baseline');
        offset = 1;
        baselined = true;
      } else if (rows.length) {
        throw new Error('Existing unversioned schema. Use --baseline to validate it against migration 001 before recording it. No application rows were changed.');
      }
    } else if (baseline) {
      throw new Error('This database already has migration history. Run without --baseline.');
    }
    await client.query(`SET LOCAL search_path TO ${target}, public`);
    for (const file of migrations.slice(offset)) {
      await client.query(file.sql);
      await record(file, 'migration');
      applied.push(file.filename);
    }
    await assertCollation(client);
    await client.query('COMMIT');
    return { applied, baselined, version: migrations.at(-1).version };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain the original error */ }
    throw error;
  } finally {
    client.release();
  }
}
