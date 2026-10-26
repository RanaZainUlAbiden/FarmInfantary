// [Codex] Keep the 29-script migration gate explicit and non-shrinking.
import assert from 'node:assert/strict';
import {readdirSync,existsSync,readFileSync} from 'node:fs';
import {loadEnv} from './lib/pg-harness.mjs';
if(!loadEnv())throw new Error('DATABASE_URL is required: a skipped PostgreSQL suite cannot close Phase 1');
const reference=new URL('../../Talha Farm/scripts/verify/',import.meta.url);
const names=readdirSync(reference).filter(f=>/^verify_.*\.js$/.test(f)).sort();
assert.equal(names.length,29,'The inherited suite inventory changed; review the gate');
for(const name of names){
 const stem=name.slice(0,-3);
 const target=name==='verify_change_announcements.js'?'verify_change_announcements_web.mjs':name==='verify_migrations.js'?'verify_legacy_migrations_pg.mjs':stem+'_pg.mjs';
 const file=new URL(target,import.meta.url);assert.ok(existsSync(file),`Missing web/PostgreSQL coverage: ${name}`);
 if(name==='verify_change_announcements.js')assert.ok(readFileSync(file,'utf8').endsWith(readFileSync(new URL(name,reference),'utf8')),'Source-only scanner must retain its original checks');
 console.log(`  PASS  ${name} -> ${target}`);
}
console.log('ALL CHECKS PASSED — all 29 inherited gates mapped (28 PostgreSQL, 1 source-only)');
