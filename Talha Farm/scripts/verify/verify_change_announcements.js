/**
 * verify_change_announcements.js
 *
 * Static check for the one invalidation rule this app has.
 *
 * Every screen is a lazy standalone component destroyed on navigation, so for
 * almost every table **navigation is the invalidation** — a screen re-reads in
 * its own ngOnInit (or resolver) and nobody needs telling.
 *
 * Three entities are the exception:
 *
 *   farm_units, flocks, batches
 *
 * They are displayed by LayoutComponent, which mounts once per login at /app
 * and is never destroyed, and they are cached in root services (FlockService,
 * FarmUnitService) that every screen reads. Nothing about a navigation
 * refreshes those. A writer that does not announce leaves the sidebar, the
 * current-flock slot and the "create your first flock" banner stale — which is
 * exactly the bug that kept coming back on new paths.
 *
 * The rule: any renderer file that writes to one of those three tables must
 * also call dataChange.announce('<scope>').
 *
 * This is a source check, not a database check — unlike its neighbours in this
 * directory it opens no DB. Selection state lives in the renderer, and there is
 * no runtime harness that can reach it (no test runner is configured), so a
 * static check on the writers is the enforceable half.
 *
 * Run:  node scripts/verify/verify_change_announcements.js
 * Exits non-zero on a violation, so it can gate a build.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'app');

// table -> the DataScope a writer must announce
const WATCHED = {
  farm_units: 'units',
  flocks: 'flocks',
  batches: 'batches'
};

/**
 * Not every writer spells its SQL inline. farm_units is written through thin
 * wrappers on database.service.ts, so a caller of one of those is a writer too
 * — without this the Farms screen is invisible to the check and could silently
 * stop announcing.
 */
const HELPERS = {
  farm_units: ['addFarmUnit', 'updateFarmUnit', 'deleteFarmUnit'],
  flocks: [],
  batches: []
};

// Writes we care about. Deletes matter as much as inserts: an unannounced
// delete leaves the selection pointing at a row that no longer exists, and
// every screen goes on querying it.
function writePatterns(table) {
  return [
    new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i'),
    new RegExp(`UPDATE\\s+${table}\\s+SET\\b`, 'i'),
    new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i'),
    ...HELPERS[table].map(fn => new RegExp(`\\.\\s*${fn}\\s*\\(`))
  ];
}

/**
 * database.service.ts wraps the farm_units writes that farm-units.component.ts
 * calls (addFarmUnit/updateFarmUnit/deleteFarmUnit). It is a thin SQL wrapper
 * with no business logic and no knowledge of what is on screen, so the
 * announcement belongs to its caller, not to it. Same for the resolvers, which
 * only read.
 */
const EXEMPT = new Set([
  path.join('shared', 'services', 'database.service.ts')
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const problems = [];
const writers = [];

for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file);
  if (EXEMPT.has(rel)) continue;

  const source = fs.readFileSync(file, 'utf8');

  for (const [table, scope] of Object.entries(WATCHED)) {
    const hits = writePatterns(table).filter(re => re.test(source));
    if (hits.length === 0) continue;

    writers.push({ rel, table, scope });

    const announced = new RegExp(`announce\\(\\s*['"]${scope}['"]\\s*\\)`).test(source);
    if (!announced) {
      problems.push(
        `${rel}\n    writes ${table} but never calls dataChange.announce('${scope}')`
      );
    }
  }
}

console.log('Change-announcement check');
console.log('='.repeat(60));

if (writers.length === 0) {
  console.error('FAIL: found no writers at all — the patterns have drifted from the code.');
  process.exit(1);
}

for (const w of writers) {
  const ok = !problems.some(p => p.startsWith(w.rel + '\n') && p.includes(`'${w.scope}'`));
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${w.rel}  ->  ${w.table} / announce('${w.scope}')`);
}

console.log('='.repeat(60));

if (problems.length > 0) {
  console.error(`\n${problems.length} unannounced writer(s):\n`);
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\nAdd dataChange.announce(<scope>) after the write — on create, edit AND delete.\n' +
    'See the invalidation landmine in CLAUDE.md.'
  );
  process.exit(1);
}

console.log(`\nAll ${writers.length} writer(s) announce their scope.`);
process.exit(0);
