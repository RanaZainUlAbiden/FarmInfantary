#!/usr/bin/env node
/**
 * Runs the whole verification suite and reports one summary.
 *
 * This suite is the ONLY regression net for the conversion — there is no unit
 * test suite. A red run is a build failure, not cleanup for later.
 *
 *   node scripts/verify/run-all.mjs            # summary only
 *   node scripts/verify/run-all.mjs -v         # full output from failures
 *   node scripts/verify/run-all.mjs --only bank# run scripts matching a substring
 *   node scripts/verify/run-all.mjs --dir <d>  # run a different script directory
 *
 * PHASE 0: scripts live in the frozen desktop app and run against sql.js.
 * PHASE 1: re-point --dir (or DEFAULT_DIR) at the ported suite running against
 *          PostgreSQL. The gate is that the SAME scripts stay green.
 *
 * Scripts signal failure by exit code. They do not share an output format —
 * some print "PASS", some "OK", verify_migrations asserts by throwing — so the
 * check counts below are indicative only. Never treat a check count as the
 * pass condition; the exit code is the contract.
 */

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// Two sources, both part of one suite:
//   HERE  — scripts written for the conversion (money types, and later the
//           tenancy and permission suites)
//   REF   — the 29 inherited scripts, still running against the frozen app
// Phase 1 re-points REF at the ported suite. The gate is that the same scripts
// stay green, so the list must never shrink silently.
const DEFAULT_DIRS = [HERE, join(ROOT, 'Talha Farm', 'scripts', 'verify')];

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
const verbose = argv.includes('-v') || argv.includes('--verbose');
const only = arg('--only');
const dirs = arg('--dir') ? [arg('--dir')] : DEFAULT_DIRS;

for (const d of dirs) {
  if (!existsSync(d)) {
    console.error(`No such directory: ${d}`);
    process.exit(2);
  }
}

let scripts = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.startsWith('verify_') && (f.endsWith('.js') || f.endsWith('.mjs')))
    .map((f) => ({ dir: d, file: f }))
);

scripts.sort((a, b) => a.file.localeCompare(b.file));

if (only) scripts = scripts.filter((s) => s.file.includes(only));

if (scripts.length === 0) {
  console.error(only ? `No scripts match "${only}"` : 'No verify_*.js / .mjs found');
  process.exit(2);
}

console.log(`Verification suite — ${scripts.length} script(s)`);
for (const d of dirs) console.log(`  ${d}`);
console.log();

const started = Date.now();
const failures = [];
let totalChecks = 0;

for (const { dir, file } of scripts) {
  const name = basename(file, file.endsWith('.mjs') ? '.mjs' : '.js');
  const t0 = Date.now();

  // cwd is the script's own tree: these scripts resolve sql.js and the source
  // files they read relative to their own location.
  const run = spawnSync(process.execPath, [join(dir, file)], {
    encoding: 'utf8',
    cwd: dir,
    maxBuffer: 64 * 1024 * 1024,
  });

  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const ms = Date.now() - t0;

  // Indicative only — the formats differ between scripts.
  const checks = (out.match(/^\s*(PASS|OK)\b/gm) ?? []).length;
  totalChecks += checks;

  if (run.status === 0) {
    console.log(`  pass  ${name.padEnd(42)} ${String(checks).padStart(4)} checks  ${ms}ms`);
  } else {
    const bad = (out.match(/^\s*FAIL\b/gm) ?? []).length;
    console.log(
      `  FAIL  ${name.padEnd(42)} ${String(checks).padStart(4)} ok, ${bad} bad  (exit ${run.status})`
    );
    failures.push({ name, out });
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n' + '─'.repeat(72));

if (failures.length === 0) {
  console.log(`GREEN — ${scripts.length}/${scripts.length} scripts, ~${totalChecks} checks, ${seconds}s`);
  process.exit(0);
}

console.log(`RED — ${failures.length}/${scripts.length} failing, ${seconds}s`);
for (const f of failures) console.log(`       ${f.name}`);

if (verbose) {
  for (const f of failures) {
    console.log('\n' + '═'.repeat(72));
    console.log(f.name);
    console.log('═'.repeat(72));
    console.log(f.out.trimEnd());
  }
} else {
  console.log('\nRe-run with -v for full output, or --only <name> for one script.');
}

process.exit(1);
