#!/usr/bin/env node
/**
 * The ORACLE — canonical totals for a database, in a comparable form.
 *
 *   node scripts/verify/oracle.mjs <path-to.db>            # print
 *   node scripts/verify/oracle.mjs <path-to.db> -o out.json
 *   node scripts/verify/oracle.mjs --compare a.json b.json # diff two runs
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1 moves 60 tables from SQLite to PostgreSQL. The verify scripts prove
 * the LOGIC still behaves; this proves the NUMBERS did not move. Capture it
 * before the migration, capture it after, and diff. Any difference is a defect
 * until explained.
 *
 * It is also where the app's canonical aggregate definitions live in one place:
 *
 *   - a debt is SUM(MAX(total_amount - amount_paid, 0)) — an overpaid bill
 *     contributes zero, never a negative
 *   - broiler rows are COALESCE(module_type,'broiler') = 'broiler', NOT a
 *     strict equality, which would drop legacy NULL-module rows
 *   - layer rows are a strict module_type = 'layer'
 *
 * Those asymmetries are deliberate (see docs/LANDMINES.md line 151). Phase 1
 * must reproduce them exactly.
 *
 * OUTPUT IS GITIGNORED BY DEFAULT. The totals are a real business's financials;
 * decide deliberately before committing one.
 *
 * PHASE 1: keep every query below byte-identical where the dialect allows, and
 * run it against PostgreSQL. Differences in the SQL are differences in meaning.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REF = join(ROOT, 'Talha Farm');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);

// ── compare mode ───────────────────────────────────────────
if (argv[0] === '--compare') {
  const [, a, b] = argv;
  if (!a || !b) {
    console.error('usage: oracle.mjs --compare <before.json> <after.json>');
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(a, 'utf8'));
  const after = JSON.parse(readFileSync(b, 'utf8'));

  const keys = [...new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)])].sort();
  const diffs = [];

  for (const k of keys) {
    const x = before.metrics[k];
    const y = after.metrics[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ k, x, y });
  }

  if (diffs.length === 0) {
    console.log(`IDENTICAL — ${keys.length} metrics match`);
    process.exit(0);
  }

  console.log(`DIFFERENT — ${diffs.length} of ${keys.length} metrics moved\n`);
  for (const d of diffs) {
    console.log(`  ${d.k}`);
    console.log(`    before: ${JSON.stringify(d.x)}`);
    console.log(`    after : ${JSON.stringify(d.y)}`);
  }
  console.log('\nEvery difference is a defect until explained.');
  process.exit(1);
}

// ── capture mode ───────────────────────────────────────────
const dbPath = argv.find((a) => !a.startsWith('-'));
const outIdx = argv.findIndex((a) => a === '-o' || a === '--out');
const outPath = outIdx === -1 ? null : argv[outIdx + 1];

if (!dbPath) {
  console.error('usage: oracle.mjs <path-to.db> [-o out.json]');
  console.error('       oracle.mjs --compare <before.json> <after.json>');
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`No such database: ${dbPath}`);
  process.exit(2);
}

const initSqlJs = require(join(REF, 'node_modules', 'sql.js'));
const SQL = await initSqlJs({
  locateFile: (f) => join(REF, 'node_modules', 'sql.js', 'dist', f),
});
const db = new SQL.Database(readFileSync(dbPath));

const rows = (sql, params = []) => {
  const out = [];
  const st = db.prepare(sql);
  st.bind(params);
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
};

const tableExists = (t) =>
  rows(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, [t]).length > 0;

/** One scalar metric. Missing table => recorded as null, never a crash. */
function scalar(name, table, sql, params = []) {
  if (!tableExists(table)) return [name, null];
  try {
    const v = rows(sql, params)[0]?.v;
    return [name, v === undefined ? null : v];
  } catch (err) {
    return [name, { error: String(err.message || err) }];
  }
}

const metrics = {};
const put = ([k, v]) => {
  metrics[k] = v;
};

// ── per-account ────────────────────────────────────────────
const farms = tableExists('farms')
  ? rows(`SELECT farm_id, farm_name, business_type FROM farms ORDER BY farm_id`)
  : [];

metrics['_meta.farm_count'] = farms.length;
metrics['_meta.tables_present'] = rows(
  `SELECT COUNT(*) AS v FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
)[0].v;

for (const f of farms) {
  const id = f.farm_id;
  const p = `farm.${id}`;
  metrics[`${p}.name`] = f.farm_name;
  metrics[`${p}.business_type`] = f.business_type;

  // ── Distribution ──
  put(scalar(`${p}.bills.count`, 'bills', `SELECT COUNT(*) AS v FROM bills WHERE farm_id=?`, [id]));
  put(scalar(`${p}.bills.total`, 'bills', `SELECT COALESCE(SUM(total_amount),0) AS v FROM bills WHERE farm_id=?`, [id]));
  put(scalar(`${p}.bills.paid`, 'bills', `SELECT COALESCE(SUM(amount_paid),0) AS v FROM bills WHERE farm_id=?`, [id]));
  // The app's ONE definition of a debt. MAX(..,0) stops an overpaid bill
  // contributing a negative. Do not "simplify" this to SUM(total)-SUM(paid).
  put(scalar(`${p}.bills.outstanding`, 'bills', `SELECT COALESCE(SUM(MAX(total_amount - amount_paid, 0)),0) AS v FROM bills WHERE farm_id=?`, [id]));

  put(scalar(`${p}.purchase_orders.total`, 'purchase_orders', `SELECT COALESCE(SUM(total_amount),0) AS v FROM purchase_orders WHERE farm_id=?`, [id]));
  put(scalar(`${p}.sales_orders.total`, 'sales_orders', `SELECT COALESCE(SUM(total_amount),0) AS v FROM sales_orders WHERE farm_id=?`, [id]));
  put(scalar(`${p}.products.count`, 'products', `SELECT COUNT(*) AS v FROM products WHERE farm_id=?`, [id]));
  put(scalar(`${p}.product_batches.quantity`, 'product_batches', `SELECT COALESCE(SUM(quantity),0) AS v FROM product_batches WHERE farm_id=?`, [id]));
  put(scalar(`${p}.expense_ledger.total`, 'expense_ledger', `SELECT COALESCE(SUM(amount),0) AS v FROM expense_ledger WHERE farm_id=?`, [id]));

  // ── Banking ──
  put(scalar(`${p}.bank.accounts`, 'bank_accounts', `SELECT COUNT(*) AS v FROM bank_accounts WHERE farm_id=?`, [id]));
  put(scalar(`${p}.bank.current_balance`, 'bank_accounts', `SELECT COALESCE(SUM(current_balance),0) AS v FROM bank_accounts WHERE farm_id=?`, [id]));
  put(scalar(`${p}.bank.ledger_debit`, 'bank_ledger', `SELECT COALESCE(SUM(bl.debit),0) AS v FROM bank_ledger bl JOIN bank_accounts ba ON ba.bank_id=bl.bank_id WHERE ba.farm_id=?`, [id]));
  put(scalar(`${p}.bank.ledger_credit`, 'bank_ledger', `SELECT COALESCE(SUM(bl.credit),0) AS v FROM bank_ledger bl JOIN bank_accounts ba ON ba.bank_id=bl.bank_id WHERE ba.farm_id=?`, [id]));

  // ── Owner ──
  put(scalar(`${p}.assets.total_price`, 'assets', `SELECT COALESCE(SUM(total_price),0) AS v FROM assets WHERE farm_id=?`, [id]));
  put(scalar(`${p}.assets.sold_amount`, 'assets', `SELECT COALESCE(SUM(sale_amount),0) AS v FROM assets WHERE farm_id=? AND status='sold'`, [id]));
  put(scalar(`${p}.personal_expenses.total`, 'personal_expenses', `SELECT COALESCE(SUM(amount),0) AS v FROM personal_expenses WHERE farm_id=?`, [id]));
  put(scalar(`${p}.loans.receivable_principal`, 'loans', `SELECT COALESCE(SUM(principal),0) AS v FROM loans WHERE farm_id=? AND direction='given'`, [id]));
  put(scalar(`${p}.loans.payable_principal`, 'loans', `SELECT COALESCE(SUM(principal),0) AS v FROM loans WHERE farm_id=? AND direction='received'`, [id]));
  put(scalar(`${p}.loan_payments.total`, 'loan_payments', `SELECT COALESCE(SUM(amount),0) AS v FROM loan_payments WHERE farm_id=?`, [id]));

  // ── Broiler (COALESCE — never a strict '= broiler') ──
  put(scalar(`${p}.broiler.sales`, 'sales', `SELECT COALESCE(SUM(s.total_amount),0) AS v FROM sales s JOIN flocks f ON f.flock_id=s.flock_id WHERE f.farm_id=? AND COALESCE(s.module_type,'broiler')='broiler'`, [id]));
  put(scalar(`${p}.broiler.expenses`, 'expenses', `SELECT COALESCE(SUM(e.amount),0) AS v FROM expenses e JOIN flocks f ON f.flock_id=e.flock_id WHERE f.farm_id=? AND COALESCE(e.module_type,'broiler')='broiler'`, [id]));
  put(scalar(`${p}.broiler.income`, 'income', `SELECT COALESCE(SUM(i.amount),0) AS v FROM income i JOIN flocks f ON f.flock_id=i.flock_id WHERE f.farm_id=? AND COALESCE(i.module_type,'broiler')='broiler'`, [id]));
  put(scalar(`${p}.broiler.feed`, 'feed_entries', `SELECT COALESCE(SUM(fe.total_amount),0) AS v FROM feed_entries fe JOIN flocks f ON f.flock_id=fe.flock_id WHERE f.farm_id=? AND COALESCE(fe.module_type,'broiler')='broiler'`, [id]));
  put(scalar(`${p}.broiler.labour`, 'labour_payments', `SELECT COALESCE(SUM(lp.amount),0) AS v FROM labour_payments lp JOIN flocks f ON f.flock_id=lp.flock_id WHERE f.farm_id=? AND COALESCE(lp.module_type,'broiler')='broiler'`, [id]));
  put(scalar(`${p}.broiler.flocks`, 'flocks', `SELECT COUNT(*) AS v FROM flocks WHERE farm_id=?`, [id]));

  // ── Layer (strict module_type='layer'; flock_id column holds a batch_id) ──
  put(scalar(`${p}.layer.batches`, 'batches', `SELECT COUNT(*) AS v FROM batches WHERE farm_id=?`, [id]));
  put(scalar(`${p}.layer.egg_sales`, 'egg_sales', `SELECT COALESCE(SUM(es.total_amount),0) AS v FROM egg_sales es JOIN batches b ON b.batch_id=es.batch_id WHERE b.farm_id=?`, [id]));
  put(scalar(`${p}.layer.hen_sales`, 'hen_sales', `SELECT COALESCE(SUM(hs.total_amount),0) AS v FROM hen_sales hs JOIN batches b ON b.batch_id=hs.batch_id WHERE b.farm_id=?`, [id]));
  put(scalar(`${p}.layer.eggs_collected`, 'egg_collection', `SELECT COALESCE(SUM(ec.total_eggs),0) AS v FROM egg_collection ec JOIN batches b ON b.batch_id=ec.batch_id WHERE b.farm_id=?`, [id]));
  put(scalar(`${p}.layer.expenses`, 'expenses', `SELECT COALESCE(SUM(e.amount),0) AS v FROM expenses e JOIN batches b ON b.batch_id=e.flock_id WHERE b.farm_id=? AND e.module_type='layer'`, [id]));
  put(scalar(`${p}.layer.feed`, 'feed_entries', `SELECT COALESCE(SUM(fe.total_amount),0) AS v FROM feed_entries fe JOIN batches b ON b.batch_id=fe.flock_id WHERE b.farm_id=? AND fe.module_type='layer'`, [id]));
}

// ── global row counts ──────────────────────────────────────
// Catches rows lost in migration even where no total moves.
const allTables = rows(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
).map((r) => r.name);

for (const t of allTables) {
  metrics[`rowcount.${t}`] = rows(`SELECT COUNT(*) AS v FROM ${t}`)[0].v;
}

// ── emit ───────────────────────────────────────────────────
const report = {
  source: resolve(dbPath),
  capturedAt: new Date().toISOString(),
  metricCount: Object.keys(metrics).length,
  metrics,
};

if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${report.metricCount} metrics to ${outPath}`);
} else {
  const money = Object.entries(metrics).filter(
    ([k, v]) => !k.startsWith('rowcount.') && !k.startsWith('_meta.') && typeof v === 'number'
  );
  const nonZero = money.filter(([, v]) => v !== 0);

  console.log(`Oracle — ${resolve(dbPath)}`);
  console.log(`${report.metricCount} metrics, ${allTables.length} tables\n`);

  for (const f of farms) {
    console.log(`farm ${f.farm_id} · ${f.farm_name} · ${f.business_type}`);
  }

  console.log(`\nNon-zero totals (${nonZero.length} of ${money.length}):`);
  for (const [k, v] of nonZero) console.log(`  ${k.padEnd(44)} ${v}`);

  const populated = allTables
    .filter((t) => metrics[`rowcount.${t}`] > 0)
    .map((t) => `${t}=${metrics[`rowcount.${t}`]}`);
  console.log(`\nNon-empty tables (${populated.length}):`);
  console.log('  ' + populated.join(', '));

  console.log('\nRe-run with -o <file.json> to capture, then --compare before.json after.json');
}
