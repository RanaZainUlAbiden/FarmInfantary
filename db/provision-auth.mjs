import {createRequire} from 'node:module';
import {loadEnv} from '../server/src/server.js';
import {provisionAuthRole,attestAuthRole} from './auth-role.mjs';
let migration,auth;
try{loadEnv();if(process.argv.includes('--help'))console.log('Set MIGRATION_DATABASE_URL and a new DATABASE_URL auth login; run node db/provision-auth.mjs.');
 else{const source=new URL(process.env.MIGRATION_DATABASE_URL),target=new URL(process.env.DATABASE_URL);
  if(!['postgres:','postgresql:'].includes(target.protocol)||target.search||source.hostname!==target.hostname||(source.port||'5432')!==(target.port||'5432')||source.pathname!==target.pathname)throw new Error('Use auth/migration URLs for the same database, without auth startup options.');
  const {Pool}=createRequire(new URL('../server/package.json',import.meta.url))('pg'),schema=process.env.DATABASE_SCHEMA||'public';migration=new Pool({connectionString:source.toString(),max:1});
  await provisionAuthRole(migration,{role:decodeURIComponent(target.username),password:decodeURIComponent(target.password),schema});auth=new Pool({connectionString:target.toString(),max:1});await attestAuthRole(auth,{schema});console.log('Private auth role provisioned and attested.');
 }}catch(error){console.error('Auth provisioning failed: '+(error.code||error.message));process.exitCode=1;}finally{await auth?.end();await migration?.end();}
