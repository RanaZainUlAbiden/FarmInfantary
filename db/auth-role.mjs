// Private API metadata login, distinct from both migration and business roles.
import {TENANT_TABLES,sqlIdentifier as qi} from './tenant-tables.mjs';
const full=['users','auth_sessions','auth_login_limits','user_permissions','farm_security','auth_delete_grants'];
const reads=['farm_id','farm_name','business_type','status','staff_seat_limit','can_admin_add_staff','admin_version'];
const inserts=['farm_id','farm_name','business_type','password_hash'];
const updates=['farm_name','business_type','status','staff_seat_limit','can_admin_add_staff'];
async function inspect(client,{schema,role=null,direct=false}) {
 const r=(await client.query(`SELECT r.*,current_user AS current_name,session_user AS session_name FROM pg_roles r WHERE r.rolname=COALESCE($1,current_user)`,[role])).rows[0];
 if(!r||!r.rolcanlogin||r.rolsuper||r.rolbypassrls||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolinherit)throw new Error('Auth role must be an unprivileged direct login.');
 if(direct&&(r.current_name!==r.rolname||r.session_name!==r.rolname))throw new Error('Auth pool must use its direct login.');
 if((await client.query('SELECT 1 FROM pg_auth_members WHERE member=$1',[r.oid])).rowCount)throw new Error('Auth role cannot have memberships.');
 if((await client.query("SELECT has_database_privilege($1,current_database(),'CREATE') AS db_create,has_schema_privilege($1,$2,'CREATE') AS schema_create,has_schema_privilege($1,'public','CREATE') AS public_create",[r.rolname,schema])).rows.some(x=>Object.values(x).some(Boolean)))throw new Error('Auth role cannot create database/schema objects.');
 const tables=(await client.query("SELECT c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f')",[schema])).rows;
 for(const name of [...full,'permission_catalogue','audit_events','farms'])if(!tables.some(t=>t.relname===name))throw new Error('Apply all current metadata migrations before auth provisioning.');
 for(const t of tables){if(String(t.relowner)===String(r.oid))throw new Error('Auth role cannot own application tables.');const table=qi(schema)+'.'+qi(t.relname);
  const a=(await client.query(`SELECT has_table_privilege($1,$2,'SELECT') AS rd,has_table_privilege($1,$2,'INSERT') AS ins,has_table_privilege($1,$2,'UPDATE') AS upd,has_table_privilege($1,$2,'DELETE') AS del,has_table_privilege($1,$2,'TRUNCATE,REFERENCES,TRIGGER') AS extra,has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS cols`,[r.rolname,table])).rows[0];
  if(full.includes(t.relname)){if(!a.rd||!a.ins||!a.upd||!a.del||a.extra)throw new Error('Unexpected auth metadata grants.');}
  else if(t.relname==='audit_events'){if(!a.rd||!a.ins||a.upd||a.del||a.extra)throw new Error('Audit grants must be append/read only.');}
  else if(t.relname==='permission_catalogue'){if(!a.rd||a.ins||a.upd||a.del||a.extra)throw new Error('Catalogue must be read only.');}
  else if(t.relname==='farms'){
   if(a.rd||a.ins||a.upd||a.del||a.extra)throw new Error('Auth farm metadata needs column grants only.');
   const columns=(await client.query(`SELECT a.attname,has_column_privilege($1,$2,a.attname,'SELECT') AS rd,has_column_privilege($1,$2,a.attname,'INSERT') AS ins,has_column_privilege($1,$2,a.attname,'UPDATE') AS upd FROM pg_attribute a WHERE a.attrelid=$2::regclass AND a.attnum>0 AND NOT a.attisdropped`,[r.rolname,table])).rows;
   if(columns.some(c=>c.rd!==reads.includes(c.attname)||c.ins!==inserts.includes(c.attname)||c.upd!==updates.includes(c.attname)))throw new Error('Unexpected auth farm column grants.');
  }else if(Object.values(a).some(Boolean))throw new Error('Auth role cannot access business/unclassified tables.');
 }
 const funcs=(await client.query(`SELECT p.proname,p.prosecdef,p.proconfig,has_function_privilege($1,p.oid,'EXECUTE') AS allowed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2`,[r.rolname,schema])).rows;
 for(const name of ['auth_farm_metadata','admin_farm_metadata'])if(!funcs.some(f=>f.proname===name&&f.allowed&&f.prosecdef&&JSON.stringify(f.proconfig)===JSON.stringify(['search_path=pg_catalog'])))throw new Error('Private metadata function grants/configuration are missing.');
 if(funcs.some(f=>f.prosecdef&&f.allowed&&!['auth_farm_metadata','admin_farm_metadata'].includes(f.proname)))throw new Error('Auth role can execute an unexpected privileged function.');
 const seqs=(await client.query(`SELECT c.relname,c.relowner,has_sequence_privilege($1,c.oid,'UPDATE') AS reset,has_sequence_privilege($1,c.oid,'USAGE') AS usage FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relkind='S'`,[r.rolname,schema])).rows;
 const allowedSequences=[];for(const [table,col] of [['users','user_id'],['audit_events','event_id'],['farms','farm_id']])allowedSequences.push((await client.query('SELECT c.relname FROM pg_class c WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass',[qi(schema)+'.'+qi(table),col])).rows[0]?.relname);
 if(seqs.some(s=>s.reset||String(s.relowner)===String(r.oid)||s.usage!==allowedSequences.includes(s.relname)))throw new Error('Unexpected auth sequence grants.');
 if(direct){if((await client.query('SELECT current_schema() AS schema')).rows[0].schema!==schema)throw new Error('Unexpected auth search path.');const state=(await client.query("SELECT current_setting('row_security') AS rls,current_setting('app.farm_id',true) AS farm,current_setting('app.user_id',true) AS user_id")).rows[0];if(state.rls!=='on'||state.farm||state.user_id)throw new Error('Auth role has unsafe default context.');}
 return {role:r.rolname,schema};
}
export async function attestAuthRole(pool,{schema='public'}={}){qi(schema);const c=await pool.connect();try{return await inspect(c,{schema,direct:true});}finally{c.release();}}
export async function provisionAuthRole(pool,{role,password,schema='public'}) {
 qi(role);qi(schema);if(!/^[A-Za-z0-9_-]{32,128}$/.test(password))throw new Error('Use a 32–128 character random base64url auth password.');
 const c=await pool.connect();try{await c.query('BEGIN');if((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)throw new Error('Auth role already exists; refusing to reset it.');
  await c.query(`CREATE ROLE ${qi(role)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT CONNECTION LIMIT 12 PASSWORD '${password}'`);
  await c.query(`GRANT USAGE ON SCHEMA ${qi(schema)} TO ${qi(role)}`);
  for(const table of full)await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${qi(schema)}.${qi(table)} TO ${qi(role)}`);
  await c.query(`GRANT SELECT ON ${qi(schema)}.permission_catalogue TO ${qi(role)}`);await c.query(`GRANT SELECT,INSERT ON ${qi(schema)}.audit_events TO ${qi(role)}`);
  for(const [verb,columns] of [['SELECT',reads],['INSERT',inserts],['UPDATE',updates]])await c.query(`GRANT ${verb}(${columns.map(qi).join(',')}) ON ${qi(schema)}.farms TO ${qi(role)}`);
  for(const [table,column] of [['users','user_id'],['audit_events','event_id'],['farms','farm_id']]){const seq=(await c.query('SELECT c.relname FROM pg_class c WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass',[qi(schema)+'.'+qi(table),column])).rows[0]?.relname;if(!seq)throw new Error('Missing auth identity sequence');await c.query(`GRANT USAGE ON SEQUENCE ${qi(schema)}.${qi(seq)} TO ${qi(role)}`);}
  for(const name of ['auth_farm_metadata','admin_farm_metadata'])await c.query(`GRANT EXECUTE ON FUNCTION ${qi(schema)}.${qi(name)}(bigint) TO ${qi(role)}`);
  const path=[schema,'pg_catalog',...(schema==='public'?[]:['public']),'pg_temp'].map(qi).join(',');await c.query(`ALTER ROLE ${qi(role)} SET search_path TO ${path}`);
  await c.query(`ALTER ROLE ${qi(role)} SET statement_timeout TO '10s'`);await c.query(`ALTER ROLE ${qi(role)} SET lock_timeout TO '10s'`);
  await inspect(c,{schema,role});await c.query('COMMIT');return {role,schema};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
