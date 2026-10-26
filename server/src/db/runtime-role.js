// [Codex] Deployment preflight, independent of SQL authorization. A configured
// login must prove it cannot own tables, bypass RLS, SET ROLE or touch auth data.
import { TENANT_TABLES, BUSINESS_TABLES, EXCLUDED_TABLES, FARM_READ_COLUMNS,
  sqlIdentifier } from '../../../db/tenant-tables.mjs';

async function inspectRuntimeRole(client, { schema = 'public', roleName = null, directLogin = true } = {}) {
  sqlIdentifier(schema);
  {
    const role = (await client.query(`SELECT r.oid,r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreatedb,
      r.rolcreaterole,r.rolreplication,r.rolcanlogin,current_user=session_user AND current_user=r.rolname AS direct_login,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS membership
      FROM pg_roles r WHERE r.rolname=COALESCE($1,current_user)`,[roleName])).rows[0];
    if (!role || (directLogin && !role.direct_login) || !role.rolcanlogin || role.membership ||
      role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.rolreplication) {
      throw new Error('Runtime role must be a direct unprivileged login without memberships.');
    }
    for (const name of new Set([schema, 'public'])) {
      const canCreate = (await client.query('SELECT has_schema_privilege($1,$2,\'CREATE\') AS allowed', [role.rolname,name])).rows[0].allowed;
      if (canCreate) throw new Error('Runtime role must not create schema objects.');
    }
    const tables = (await client.query(`SELECT c.oid,c.relname,c.relowner=$2::oid AS owns,
      c.relrowsecurity,c.relforcerowsecurity,a.attnotnull,
      EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisvalid AND i.indkey[0]=a.attnum) AS indexed,
      EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=c.oid AND t.tgname='tenant_identity' AND t.tgenabled='O' AND t.tgtype=23
        AND p.proname='stamp_tenant_identity' AND p.pronamespace=c.relnamespace AND NOT p.prosecdef) AS stamped
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='farm_id' AND NOT a.attisdropped
      WHERE n.nspname=$1 AND c.relkind IN ('r','p')`, [schema, String(role.oid)])).rows;
    for (const name of TENANT_TABLES) {
      const table = tables.find(t => t.relname === name);
      if (!table || table.owns || !table.relrowsecurity || !table.relforcerowsecurity ||
        !table.attnotnull || !table.indexed || (name !== 'farms' && !table.stamped)) {
        throw new Error('Tenant table protection is incomplete: ' + name);
      }
      const policies = (await client.query(`SELECT polname,polcmd,polpermissive,polroles::text,
        pg_get_expr(polqual,polrelid) AS using_expr,pg_get_expr(polwithcheck,polrelid) AS check_expr
        FROM pg_policy WHERE polrelid=$1::oid`, [String(table.oid)])).rows;
      const expected = "(farm_id=(NULLIF(current_setting('app.farm_id'::text,true),''::text))::bigint)";
      const normalize = value => value?.replace(/\s+/g, '');
      if (policies.length !== 1 || policies[0].polname !== 'tenant_isolation' || policies[0].polcmd !== '*' ||
        !policies[0].polpermissive || policies[0].polroles !== '{0}' ||
        normalize(policies[0].using_expr) !== expected || normalize(policies[0].check_expr) !== expected) {
        throw new Error('Unexpected tenant policies: ' + name);
      }
    }
    for (const table of tables) {
      if (table.owns) throw new Error('Runtime role owns an application table.');
      const qualified = `${sqlIdentifier(schema)}.${sqlIdentifier(table.relname)}`;
      const access = (await client.query(`SELECT
        has_table_privilege($2,$1,'SELECT') AS rd,
        has_table_privilege($2,$1,'INSERT') AS ins,
        has_table_privilege($2,$1,'UPDATE') AS upd,
        has_table_privilege($2,$1,'DELETE') AS del,
        has_table_privilege($2,$1,'TRUNCATE,REFERENCES,TRIGGER') AS extra,
        has_any_column_privilege($2,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS cols`, [qualified,role.rolname])).rows[0];
      if (BUSINESS_TABLES.includes(table.relname)) {
        if (!access.rd || !access.ins || !access.upd || !access.del || access.extra) throw new Error('Unexpected business grants.');
      } else if (table.relname === 'farms') {
        if (access.rd || access.ins || access.upd || access.del || access.extra) throw new Error('Farm metadata requires column-only read access.');
        const cols = (await client.query(`SELECT a.attname,
          has_column_privilege($2,$1,a.attname,'SELECT') AS rd,
          has_column_privilege($2,$1,a.attname,'INSERT,UPDATE,REFERENCES') AS wr
          FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped`, [qualified,role.rolname])).rows;
        if (cols.some(c => c.wr || c.rd !== FARM_READ_COLUMNS.includes(c.attname))) throw new Error('Unexpected farm column grants.');
      } else if (Object.values(access).some(Boolean)) throw new Error('Runtime access to a platform/unclassified table.');
    }
    // Missing excluded tables is also drift, not permission to omit the check.
    if (EXCLUDED_TABLES.some(name => !tables.some(t => t.relname === name))) throw new Error('Platform schema is incomplete.');
    const dangerous = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.prosecdef AND has_function_privilege($2,p.oid,'EXECUTE')) AS allowed`, [schema,role.rolname])).rows[0].allowed;
    if (dangerous) throw new Error('Runtime role can execute a privileged application function.');
    const sequences = (await client.query(`SELECT c.oid,c.relowner=$2::oid AS owns,
      has_sequence_privilege($3,c.oid,'UPDATE') AS can_reset
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S'`, [schema, String(role.oid),role.rolname])).rows;
    if (sequences.some(s => s.owns || s.can_reset)) throw new Error('Runtime role can reset/own identity sequences.');
    return { role: role.rolname, schema, tenantTables: TENANT_TABLES.length, businessTables: BUSINESS_TABLES.length };
  }
}

export async function attestRuntimeRole(pool, { schema = 'public' } = {}) {
  const client = await pool.connect();
  try {
    const result = await inspectRuntimeRole(client,{schema});
    const settings = (await client.query("SELECT current_schemas(false)::text[] AS path,current_setting('row_security') AS rls, NULLIF(current_setting('app.farm_id',true),'') AS farm, NULLIF(current_setting('app.user_id',true),'') AS usr")).rows[0];
    const expected = [schema,'pg_catalog',...(schema==='public'?[]:['public'])];
    // pg_temp is explicitly last in the role setting. If a temp namespace is
    // active, it may appear last in current_schemas; never accept it earlier.
    const path = settings.path;
    const trailingTemp = path.length===expected.length+1 && /^pg_temp_[0-9]+$/.test(path.at(-1));
    if (settings.rls!=='on' || settings.farm!==null || settings.usr!==null || JSON.stringify(trailingTemp?path.slice(0,-1):path)!==JSON.stringify(expected)) {
      throw new Error('Runtime search path or row-security settings were overridden.');
    }
    return result;
  }
  finally { client.release(); }
}

// Provisioner-only catalog validation inside the same DDL transaction, before
// the new role can log in. Runtime attestation above ALWAYS checks direct login.
export async function attestRoleBeforeCommit(client, { role, schema = 'public' }) {
  sqlIdentifier(role);
  return inspectRuntimeRole(client,{schema,roleName:role,directLogin:false});
}
