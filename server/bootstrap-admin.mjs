import {createRequire} from 'node:module';
import {loadEnv} from './src/server.js';
import {bootstrapSuperAdmin} from './src/auth/bootstrap.js';
import {registerTypeParsers} from './src/db/types.js';
loadEnv();
const pg=createRequire(import.meta.url)('pg');registerTypeParsers(pg);
const env=process.env;
if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required.');
if(!env.BOOTSTRAP_SUPERADMIN_USERNAME||!env.BOOTSTRAP_SUPERADMIN_PASSWORD)throw new Error('Set BOOTSTRAP_SUPERADMIN_USERNAME and BOOTSTRAP_SUPERADMIN_PASSWORD. No credentials are generated.');
const pool=new pg.Pool({connectionString:env.MIGRATION_DATABASE_URL||env.DATABASE_URL,max:1});
try{
 const id=await bootstrapSuperAdmin(pool,env.BOOTSTRAP_SUPERADMIN_USERNAME,env.BOOTSTRAP_SUPERADMIN_PASSWORD);
 console.log(`Super admin ${id} created. Remove bootstrap credentials from the deployment environment.`);
}catch(e){
 // No failing-row detail or password/hash should reach stdout.
 console.error(e.code ? 'Bootstrap failed; check migration state and username availability.' : e.message);
 process.exitCode=1;
}finally{await pool.end();}
