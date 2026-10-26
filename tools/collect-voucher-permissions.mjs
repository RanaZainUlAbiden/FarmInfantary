import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {ROOT} from './permission-catalogue.mjs';
import {applicationSourceDigest,traceProducerDigest} from './permission-trace.mjs';
const target=resolve(ROOT,'tools/permission-evidence/vouchers.json');
if(process.argv.includes('--check')) {
 const report=JSON.parse(readFileSync(target,'utf8'));
 if(!report.regressionPassed||report.sourceDigest!==applicationSourceDigest()||report.producerDigest!==traceProducerDigest())throw new Error('Voucher evidence is stale or failed; recapture it.');
 if(report.status!=='observations-only; not authorized policy'||report.scopes.length!==4||report.scopes.some(s=>s.unresolved||!s.observations.length))throw new Error('Voucher evidence is incomplete.');
 console.log('Voucher permission evidence matches current source; four observed workflow scopes, not an authorization policy.');
} else {
 const temporary=resolve(ROOT,'qa-results/voucher-permission-trace.json');
 mkdirSync(dirname(temporary),{recursive:true});
 const run=spawnSync(process.execPath,[resolve(ROOT,'scripts/verify/verify_vouchers_pg.mjs')],{
  cwd:ROOT,encoding:'utf8',env:{...process.env,PERMISSION_TRACE_OUTPUT:temporary},timeout:120_000,maxBuffer:8*1024*1024});
 writeFileSync(resolve(ROOT,'qa-results/voucher-permission-trace.log'),(run.stdout||'')+(run.stderr||''));
 if(run.status!==0)throw new Error('Voucher tracing failed; inspect qa-results/voucher-permission-trace.log');
 const report=JSON.parse(readFileSync(temporary,'utf8'));
 if(!report.regressionPassed||report.scopes.length!==4||report.scopes.some(s=>s.unresolved||!s.observations.length))throw new Error('Incomplete voucher observations');
 mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(report,null,2)+'\n');unlinkSync(temporary);
 for(const scope of report.scopes) {
  const writes=[...new Set(scope.observations.flatMap(o=>Object.keys(o.writeTables)))].sort();
  console.log(scope.key+' '+scope.action+': '+scope.invocations+' invocations; writes '+writes.join(', '));
 }
}
