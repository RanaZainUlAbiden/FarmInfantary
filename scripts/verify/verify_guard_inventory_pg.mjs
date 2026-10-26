// [Codex] Every current static SQL statement must either compile through the
// real AST guard and PREPARE in PG. Browser auth must contain no raw SQL at all.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createRequire} from 'node:module';
import {ROOT,loadEnv} from './lib/pg-harness.mjs';
import {collectSqlLiterals} from './lib/sql-literals.mjs';
import {createSqlGuard,loadGuardCatalog} from '../../server/src/guard/sql-guard.js';
import {readPrepared} from '../../server/src/db/prepared.js';
import {toNumberedPlaceholders} from '../../server/src/db/placeholders.js';
if(!loadEnv())throw new Error('DATABASE_URL is required to verify the SQL guard inventory');
const {Pool}=createRequire(new URL('../../server/package.json',import.meta.url))('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):e.name.endsWith('.ts')&&!e.name.endsWith('.spec.ts')?[join(dir,e.name)]:[]);
let prepared=0,interpolated=0,fragments=0;
try {
 // Offline PREPARE only: assume a verified delete step-up; this grants no HTTP access.
 const guard=createSqlGuard({catalog:await loadGuardCatalog(pool),canDelete:async()=>true});
 for(const file of files(join(ROOT,'src/app'))) {
  const path=relative(ROOT,file).replaceAll('\\','/');
  const inventory=collectSqlLiterals(readFileSync(file,'utf8'));interpolated+=inventory.interpolated;fragments+=inventory.fragments;
  if(path==='src/app/shared/services/auth.service.ts'||path.startsWith('src/app/auth/')) {
   assert.equal(inventory.statements.length,0,'Browser identity screens/services cannot use SQL: '+path);
  }
  for(const sql of inventory.statements) {
   const result=await guard({actor:{farmId:1,role:'farm_admin'},method:/^\s*SELECT/i.test(sql)?'get':'run',sql,params:Array(toNumberedPlaceholders(sql).count).fill(1)});
   assert.ok(result,'Guard rejected business SQL in '+path+'\n'+sql);
   const name='guard_inventory_'+(++prepared);
   try {await pool.query(`PREPARE ${name} AS ${readPrepared(result.query).text}`);}
   catch(error){throw new Error(path+': '+error.message+'\n'+sql,{cause:error});}
   finally {await pool.query('DEALLOCATE ALL');}
   console.log('  PASS  guarded static statement '+prepared+' — '+path);
  }
 }
 console.log('  PASS  browser auth contains no raw account SQL');
 console.log(`Guard inventory: ${prepared} prepared; ${interpolated} interpolated and ${fragments} concatenated gaps (not claimed as static coverage).`);
} finally {await pool.end();}
