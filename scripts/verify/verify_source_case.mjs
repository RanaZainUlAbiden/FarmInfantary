import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),failures=[];let references=0;
function exact(path){const rel=relative(root,path);if(rel.startsWith('..'))return true;let at=root;for(const part of rel.split(/[\\/]/)){if(!readdirSync(at).includes(part))return false;at=join(at,part);}return true;}
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(/\.(?:ts|js|mjs)$/.test(entry.name)){
 const source=readFileSync(path,'utf8');
 const refs=[...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\btemplateUrl\s*:\s*|\bstyleUrl\s*:\s*)['"](\.[^'"]+)['"]/g)].map(m=>m[1]);
 for(const match of source.matchAll(/\bstyleUrls\s*:\s*\[([^\]]*)\]/g))for(const item of match[1].matchAll(/['"](\.[^'"]+)['"]/g))refs.push(item[1]);
 for(const ref of refs){const base=resolve(dirname(path),ref),target=[base,base+'.ts',base+'.js',join(base,'index.ts'),join(base,'index.js')].find(p=>existsSync(p)&&/\.[^\\/.]+$/.test(p));if(!target)continue;references++;if(!exact(target))failures.push(relative(root,path)+': '+ref);}
}}}
for(const dir of ['src','server/src','db','scripts/ops'])walk(join(root,dir));
if(failures.length){console.error('FAIL Linux filename casing mismatches:\n'+failures.join('\n'));process.exitCode=1;}
else console.log('PASS Linux filename casing matches for '+references+' relative code/template/style references.');
