// Operator-only encrypted PostgreSQL backups. Never imported by the HTTP API.
import {spawn} from 'node:child_process';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import {pipeline,finished} from 'node:stream/promises';
import {resolve,join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');
const MAGIC=Buffer.from('FARMINFANTARY-BACKUP-1\n'),pattern=/^farminfantary-\d{17}-[a-f0-9]{16}\.fibak$/;
function key(value){const k=Buffer.isBuffer(value)?value:Buffer.from(value||'','base64');if(k.length!==32)throw new Error('BACKUP_ENCRYPTION_KEY must contain 32 random bytes encoded as base64.');return k;}
function clientEnv(connectionString){
 const u=new URL(connectionString);if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||!u.username||!u.pathname.slice(1))throw new Error('A complete PostgreSQL URL is required.');
 const env={};for(const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','HOME','LANG','LC_ALL'])if(process.env[name])env[name]=process.env[name];
 return {...env,PGCONNECT_TIMEOUT:'10',PGHOST:u.hostname.replace(/^\[|\]$/g,''),PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),...(u.searchParams.has('sslmode')?{PGSSLMODE:u.searchParams.get('sslmode')}:{})};
}
function command(bin,args,connectionString){
 const child=spawn(bin,args,{env:clientEnv(connectionString),windowsHide:true,stdio:['ignore','pipe','pipe']});
 // Do not print tool stderr: backup operations must never expose credentials or rows.
 child.stderr.resume();const done=new Promise((ok,no)=>{const timer=setTimeout(()=>{child.kill();no(new Error('PostgreSQL backup tool timed out.'));},20*60*1000);timer.unref();child.once('error',()=>{clearTimeout(timer);no(new Error('PostgreSQL backup tool could not start.'));});child.once('close',code=>{clearTimeout(timer);code===0?ok():no(new Error('PostgreSQL backup tool failed. Check tool version and operator privileges.'));});});
 return {child,done};
}
export async function createBackup({connectionString,outputDir,encryptionKey,pgDump='pg_dump',schema=null,retentionCount=7}) {
 clientEnv(connectionString);const secret=key(encryptionKey);if(!Number.isSafeInteger(retentionCount)||retentionCount<1||retentionCount>365)throw new Error('Retention must be 1 to 365 backup files.');
 if(schema&&!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid backup schema.');
 await fs.mkdir(outputDir,{recursive:true,mode:0o700});const directory=await fs.realpath(outputDir);
 const name='farminfantary-'+new Date().toISOString().replace(/\D/g,'')+'-'+randomBytes(8).toString('hex')+'.fibak';
 const target=join(directory,name),partial=target+'.partial',iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv,{authTagLength:16});cipher.setAAD(MAGIC);
 const out=createWriteStream(partial,{flags:'wx',mode:0o600});out.write(Buffer.concat([MAGIC,iv]));
 const {child,done}=command(pgDump,['--format=custom','--no-owner','--no-acl',...(schema?['--schema',schema]:[])],connectionString);
 try {
  await Promise.all([pipeline(child.stdout,cipher,out,{end:false}),done]);out.end(cipher.getAuthTag());await finished(out);await fs.rename(partial,target);
  const own=(await fs.readdir(directory,{withFileTypes:true})).filter(e=>e.isFile()&&pattern.test(e.name)).map(e=>e.name).sort().reverse();
  for(const old of own.filter(file=>file!==name).slice(retentionCount-1)){const path=resolve(directory,old);if(dirname(path)!==directory)throw new Error('Unsafe retention path');await fs.unlink(path);}
  const digest=createHash('sha256');for await(const chunk of createReadStream(target))digest.update(chunk);
  return {path:target,sha256:digest.digest('hex'),bytes:(await fs.stat(target)).size};
 }catch(error){child.kill();out.destroy();await fs.unlink(partial).catch(()=>{});throw error;}
}
export async function restoreBackup({connectionString,path,encryptionKey,pgRestore='pg_restore',schema='public'}) {
 const target=clientEnv(connectionString);if(['postgres','template0','template1'].includes(target.PGDATABASE))throw new Error('Restore requires a dedicated new empty database.');
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid restore schema.');const secret=key(encryptionKey),pool=new Pool({connectionString,max:1});
 let directory;
 const empty=async()=>{const r=await pool.query("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'");if(Number(r.rows[0].n)!==0)throw new Error('Restore requires a new empty database. Existing data will not be overwritten.');};
 try {
  await empty();const size=(await fs.stat(path)).size;if(size<=MAGIC.length+28)throw new Error('Invalid encrypted backup.');
  const handle=await fs.open(path,'r'),header=Buffer.alloc(MAGIC.length+12),tag=Buffer.alloc(16);
  try{await handle.read(header,0,header.length,0);await handle.read(tag,0,16,size-16);}finally{await handle.close();}
  if(!header.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('Unsupported backup format.');
  directory=await fs.mkdtemp(join(tmpdir(),'farminfantary-restore-'));const plain=join(directory,'verified.dump');
  const decipher=createDecipheriv('aes-256-gcm',secret,header.subarray(MAGIC.length),{authTagLength:16});decipher.setAAD(MAGIC);decipher.setAuthTag(tag);
  // Authenticate the WHOLE archive before pg_restore can execute any SQL.
  await pipeline(createReadStream(path,{start:header.length,end:size-17}),decipher,createWriteStream(plain,{flags:'wx',mode:0o600}));
  await empty();const {child,done}=command(pgRestore,['--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',clientEnv(connectionString).PGDATABASE,plain],connectionString);child.stdout.resume();await done;
  const exists=await pool.query('SELECT to_regclass($1) AS sessions,to_regclass($2) AS grants',[schema+'.auth_sessions',schema+'.auth_delete_grants']);
  if(exists.rows[0].sessions)await pool.query(`DELETE FROM "${schema}".auth_sessions`);if(exists.rows[0].grants)await pool.query(`DELETE FROM "${schema}".auth_delete_grants`);
  return {success:true,sessionsRevoked:true};
 }finally{await pool.end();if(directory){const actual=await fs.realpath(directory),base=await fs.realpath(tmpdir());if(dirname(actual)!==base||!basename(actual).startsWith('farminfantary-restore-'))throw new Error('Unsafe restore staging path');await fs.rm(actual,{recursive:true,force:true});}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const envPath=resolve('.env');try{for(const line of (await fs.readFile(envPath,'utf8')).split('\n')){const m=/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].trim();}}catch{}
  if(process.argv[2]==='create')console.log(JSON.stringify(await createBackup({connectionString:process.env.BACKUP_DATABASE_URL,outputDir:process.env.BACKUP_DIR||resolve('backups'),encryptionKey:process.env.BACKUP_ENCRYPTION_KEY,pgDump:process.env.PG_DUMP_BIN||'pg_dump',retentionCount:Number(process.env.BACKUP_RETAIN||7)})));
  else if(process.argv[2]==='restore'&&process.argv[3])console.log(JSON.stringify(await restoreBackup({connectionString:process.env.RESTORE_DATABASE_URL,path:resolve(process.argv[3]),encryptionKey:process.env.BACKUP_ENCRYPTION_KEY,pgRestore:process.env.PG_RESTORE_BIN||'pg_restore',schema:process.env.DATABASE_SCHEMA||'public'})));
  else throw new Error('Usage: node scripts/ops/backup.mjs create | restore <encrypted-file>; restore target must be a new empty database.');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
