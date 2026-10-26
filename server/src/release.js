import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const PROJECT_ROOT=fileURLToPath(new URL('../../',import.meta.url));
export function releaseDigest(root=PROJECT_ROOT){
 const files=[];const walk=dir=>{if(!existsSync(dir))return;for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())walk(path);else if(/\.(ts|js|mjs|html|scss|css|json|sql|yaml|yml|webmanifest|svg|png|ico)$/.test(e.name))files.push(path);}};
 for(const dir of ['src','public','server/src','db','scripts/ops','ops'])walk(join(root,dir));
 for(const name of ['package.json','package-lock.json','server/package.json','server/package-lock.json','Dockerfile','.dockerignore','railway.json','angular.json','tsconfig.json','tsconfig.app.json','ops/Dockerfile.web','ops/Caddyfile','ops/Dockerfile.railway','ops/Caddyfile.railway','ops/farminfantary-backup.service','ops/farminfantary-backup.timer'])if(existsSync(join(root,name)))files.push(join(root,name));
 const hash=createHash('sha256');for(const file of [...new Set(files)].sort((a,b)=>relative(root,a).replaceAll('\\','/')<relative(root,b).replaceAll('\\','/')?-1:1)){hash.update(relative(root,file).replaceAll('\\','/')+'\0');hash.update(/\.(png|ico)$/.test(file)?readFileSync(file):readFileSync(file,'utf8').replaceAll('\r\n','\n'));hash.update('\0');}return hash.digest('hex');
}
export function productionApproved(env){
 if(env.NODE_ENV==='development')return false;
 let secure=false;try{secure=new URL(env.APP_ORIGIN).protocol==='https:';}catch{}
 if(env.NODE_ENV!=='production'||env.RELEASE_PROFILE!=='owner-only'||env.AUTH_MODE!=='session'||!secure||!env.RUNTIME_DATABASE_URL||env.MIGRATION_DATABASE_URL||
  typeof env.SECURITY_REVIEWER!=='string'||!env.SECURITY_REVIEWER.trim()||env.REVIEWED_RELEASE_SHA!==releaseDigest())
  throw new Error('Refusing to start: production requires the owner-only session profile, HTTPS, separate runtime credentials, no migration credentials, and independent review of this exact release digest.');
 return true;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify({profile:'owner-only',releaseSha:releaseDigest(),reviewRequired:true,staffSql:'disabled'},null,2));
