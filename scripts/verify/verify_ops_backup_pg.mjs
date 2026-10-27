// Real encrypted pg_dump -> authenticated decrypt -> pg_restore into a NEW DB.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import * as fs from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {loadEnv,ROOT} from './lib/pg-harness.mjs';
import {migrate} from '../../db/migration-runner.mjs';
import {createBackup,restoreBackup} from '../ops/backup.mjs';
if(!loadEnv())throw new Error('DATABASE_URL required');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg'),admin=new Pool({connectionString:process.env.DATABASE_URL});
const suffix=randomBytes(6).toString('hex'),names=['vp_backup_source_'+suffix,'vp_backup_target_'+suffix],urls=names.map(name=>{const u=new URL(process.env.DATABASE_URL);u.pathname='/'+name;u.search='';return u.toString();});
const directory=resolve(ROOT,'qa-results','backup-'+suffix),secret=randomBytes(32);let source,target,created=[],passed=0;
const check=async(label,fn)=>{await fn();passed++;console.log('  PASS  '+label);};
try {
 for(const name of names){assert.match(name,/^vp_backup_(source|target)_[a-f0-9]{12}$/);await admin.query('CREATE DATABASE '+name);created.push(name);}
 source=new Pool({connectionString:urls[0]});target=new Pool({connectionString:urls[1]});await migrate(source);
 await source.query("INSERT INTO farms(farm_id,farm_name,password_hash) VALUES(1,'Backup money fixture','unused')");
 await source.query("INSERT INTO users(user_id,farm_id,username,password_hash,role) VALUES(1,1,'backup.owner','$argon2id$fixture','farm_admin')");
 const c=await source.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.farm_id','1',true)");await c.query("INSERT INTO expenses(flock_id,date,amount,description) VALUES(404,'2026-10-26',1234.56,'private financial fixture')");await c.query('COMMIT');}finally{c.release();}
 await source.query('INSERT INTO auth_sessions(token_hash,user_id,auth_version,created_at,last_seen_at,expires_at) VALUES($1,1,1,1,1,9999999999)',['a'.repeat(64)]);
 await source.query('INSERT INTO auth_delete_grants(session_hash,user_id,farm_id,auth_version,expires_at) VALUES($1,1,1,1,9999999999)',['a'.repeat(64)]);
 let backup;
 await check('backup rejects missing keys and produces an encrypted archive with a checksum',async()=>{
  await assert.rejects(createBackup({connectionString:urls[0],outputDir:directory,encryptionKey:'short'}));
  backup=await createBackup({connectionString:urls[0],outputDir:directory,encryptionKey:secret});assert.match(backup.sha256,/^[a-f0-9]{64}$/);assert.ok(backup.bytes>100);
  assert.ok(!(await fs.readFile(backup.path)).includes(Buffer.from('private financial fixture')));
 });
 await check('wrong encryption key fails before any SQL reaches the empty target',async()=>{
  await assert.rejects(restoreBackup({connectionString:urls[1],path:backup.path,encryptionKey:randomBytes(32)}));
  assert.equal(Number((await target.query("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n),0);
 });
 await check('a real restored database preserves money, date text, orphans and migration history',async()=>{
  await restoreBackup({connectionString:urls[1],path:backup.path,encryptionKey:secret});
  const row=(await target.query('SELECT amount,date,flock_id FROM expenses')).rows[0];assert.equal(row.amount,1234.56);assert.equal(row.date,'2026-10-26');assert.equal(Number(row.flock_id),404);
  assert.equal(Number((await target.query('SELECT max(version) AS n FROM farminfantary_meta.schema_migrations')).rows[0].n),13);
 });
 await check('restored sessions and delete confirmations are revoked before startup',async()=>{assert.equal(Number((await target.query('SELECT count(*) AS n FROM auth_sessions')).rows[0].n),0);assert.equal(Number((await target.query('SELECT count(*) AS n FROM auth_delete_grants')).rows[0].n),0);});
 await check('restore refuses to overwrite an occupied database',async()=>{await assert.rejects(restoreBackup({connectionString:urls[1],path:backup.path,encryptionKey:secret}),/empty database/);assert.equal((await target.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n,1);});
 await check('retention removes only owned backup files and preserves unrelated files',async()=>{
  await fs.writeFile(join(directory,'keep-me.txt'),'unrelated');await createBackup({connectionString:urls[0],outputDir:directory,encryptionKey:secret,retentionCount:1});
  assert.equal((await fs.readdir(directory)).filter(n=>n.endsWith('.fibak')).length,1);assert.equal(await fs.readFile(join(directory,'keep-me.txt'),'utf8'),'unrelated');
 });
 console.log('ALL CHECKS PASSED — '+passed+' operator backup/restore scenarios');
} finally {
 await source?.end();await target?.end();for(const name of created)await admin.query('DROP DATABASE '+name);await admin.end();
 const base=resolve(ROOT,'qa-results');if(dirname(directory)!==base||!basename(directory).startsWith('backup-'))throw new Error('Unsafe test cleanup');await fs.rm(directory,{recursive:true,force:true});
}
