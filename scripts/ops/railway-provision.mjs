// One-off private operator job. Never used as the web service start command.
import {createRequire} from 'node:module';
import {migrate} from '../../db/migration-runner.mjs';
import {provisionAuthRole,attestAuthRole} from '../../db/auth-role.mjs';
import {provisionRuntimeRole} from '../../db/runtime-role.mjs';
import {attestRuntimeRole} from '../../server/src/db/runtime-role.js';
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');
let admin,auth,runtime;
try {
 const migrationUrl=new URL(process.env.MIGRATION_DATABASE_URL);
 const authUrl=new URL(process.env.DATABASE_URL),runtimeUrl=new URL(process.env.RUNTIME_DATABASE_URL);
 for(const target of [authUrl,runtimeUrl])if(target.host!==migrationUrl.host||target.pathname!==migrationUrl.pathname||target.search)throw new Error('All operator connections must target this same database without startup options.');
 admin=new Pool({connectionString:migrationUrl.toString(),max:1,connectionTimeoutMillis:10000});
 const migration=await migrate(admin,{schema:'public'});
 const provision=async(url,fn)=>{const role=decodeURIComponent(url.username);if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await fn(admin,{role,password:decodeURIComponent(url.password),schema:'public'});};
 await provision(authUrl,provisionAuthRole);await provision(runtimeUrl,provisionRuntimeRole);
 auth=new Pool({connectionString:authUrl.toString(),max:1});runtime=new Pool({connectionString:runtimeUrl.toString(),max:1});
 await attestAuthRole(auth,{schema:'public'});await attestRuntimeRole(runtime,{schema:'public'});
 if(process.env.ROTATED_OPERATOR_PASSWORD){
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(process.env.ROTATED_OPERATOR_PASSWORD))throw new Error('Invalid operator password format.');
  const sql=await admin.query('SELECT format(\'ALTER ROLE %I PASSWORD %L\',current_user,$1::text) AS sql',[process.env.ROTATED_OPERATOR_PASSWORD]);
  await admin.query(sql.rows[0].sql);
 }
 console.log(JSON.stringify({ready:true,migration:String(migration.version).padStart(3,'0'),authRoleAttested:true,runtimeRoleAttested:true,operatorPasswordRotated:!!process.env.ROTATED_OPERATOR_PASSWORD}));
}catch(error){console.error(JSON.stringify({ready:false,error:error.code||'OPERATOR_SETUP_FAILED'}));process.exitCode=1;}
finally{await auth?.end();await runtime?.end();await admin?.end();}
