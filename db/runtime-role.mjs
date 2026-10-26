import { BUSINESS_TABLES,FARM_READ_COLUMNS,sqlIdentifier } from './tenant-tables.mjs';
import { attestRoleBeforeCommit } from '../server/src/db/runtime-role.js';

// Fresh role only: never silently rotate credentials or reuse a role carrying
// inherited grants. Provisioning is atomic and never grants broad schema ACLs.
export async function provisionRuntimeRole(pool, { role, password, schema = 'public' }) {
  const quotedRole = sqlIdentifier(role), quotedSchema = sqlIdentifier(schema);
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new Error('Use a 32–128 character random base64url runtime password.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) throw new Error('Runtime role already exists; refusing to change it.');
    // Validate tenant migration 004 before granting anything; final attestation
    // also requires the latest private permission tables from migration 005.
    // Role creation cannot make
    // unfinished tenant schemas remotely accessible.
    const ready = (await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2) AND c.relrowsecurity AND c.relforcerowsecurity`, [schema, [...BUSINESS_TABLES, 'farms']])).rows[0].n;
    if (ready !== BUSINESS_TABLES.length + 1) throw new Error('Apply tenant migration 004 before provisioning.');
    await client.query(`CREATE ROLE ${quotedRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      NOREPLICATION NOINHERIT CONNECTION LIMIT 12 PASSWORD '${password}'`);
    for (const name of new Set([schema,'public'])) {
      if ((await client.query("SELECT has_schema_privilege($1,$2,'CREATE') AS allowed",[role,name])).rows[0].allowed) {
        throw new Error('PUBLIC grants schema CREATE; correct schema ACLs before provisioning.');
      }
    }
    await client.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
    for (const name of BUSINESS_TABLES) {
      const table = `${quotedSchema}.${sqlIdentifier(name)}`;
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO ${quotedRole}`);
      const seqs = (await client.query(`SELECT pg_get_serial_sequence($1,a.attname) AS name
        FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attidentity<>''`, [table])).rows;
      for (const seq of seqs) {
        if (!seq.name) throw new Error('Missing business identity sequence.');
        // pg_get_serial_sequence is server-controlled, but quote both identifier
        // parts through catalogs instead of interpolating its returned SQL text.
        const sequence = (await client.query('SELECT c.relname FROM pg_class c WHERE c.oid=$1::regclass', [seq.name])).rows[0].relname;
        await client.query(`GRANT USAGE ON SEQUENCE ${quotedSchema}.${sqlIdentifier(sequence)} TO ${quotedRole}`);
      }
    }
    await client.query(`GRANT SELECT(${FARM_READ_COLUMNS.map(sqlIdentifier).join(',')}) ON ${quotedSchema}.farms TO ${quotedRole}`);
    const path = [schema, 'pg_catalog', ...(schema === 'public' ? [] : ['public']), 'pg_temp'].map(sqlIdentifier).join(',');
    await client.query(`ALTER ROLE ${quotedRole} SET search_path TO ${path}`);
    await client.query(`ALTER ROLE ${quotedRole} SET statement_timeout TO '10s'`);
    await client.query(`ALTER ROLE ${quotedRole} SET lock_timeout TO '10s'`);
    await client.query(`ALTER ROLE ${quotedRole} SET idle_in_transaction_session_timeout TO '65s'`);
    await attestRoleBeforeCommit(client,{role,schema});
    await client.query('COMMIT');
    return { role, schema, businessTables: BUSINESS_TABLES.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
