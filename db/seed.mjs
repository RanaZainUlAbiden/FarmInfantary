#!/usr/bin/env node
/**
 * Seeds inherited development/parity fixtures, not server user credentials.
 *
 *   node db/seed.mjs              # seed into DATABASE_URL
 *   node db/seed.mjs --reset      # wipe every table first
 *
 * Historical desktop login: demo / demo123. It cannot sign in to the web app.
 *
 * The account is `business_type = 'all'` on purpose, so the sidebar shows the
 * broiler, layer and distribution tabs and every screen is reachable.
 *
 * THE PASSWORD HASH IS THE APP'S OWN, DELIBERATELY
 * ------------------------------------------------
 * The former `auth.service.ts` hashed with a 32-bit non-cryptographic function (Java's
 * String.hashCode, bit-shifted and hex-encoded). It is reproduced here so a
 * parity fixture retains its historical shape. The migrated browser never uses it.
 *
 * It is NOT an endorsement: docs/DECISIONS.md D7 replaces it with argon2id in
 * the separate server login path. Under D14 no old hashes are imported or
 * rehashed on login; fresh server users use Argon2id. Seeded demo accounts
 * are throwaway fixtures for inherited development/parity tests only.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.');
  process.exit(2);
}

const pg = require(join(ROOT, 'server', 'node_modules', 'pg'));
const { registerTypeParsers } = await import(new URL('../server/src/db/types.js', import.meta.url));
registerTypeParsers(pg);

/** Historical desktop hashPassword(), retained for parity fixture shape only. */
function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

try {
  if (process.argv.includes('--reset')) {
    const tables = await q(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    const names = tables.map((t) => `"${t.tablename}"`).join(', ');
    if (names) {
      await client.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
      console.log(`Reset ${tables.length} tables.`);
    }
  }

  await client.query('BEGIN');

  // ── account ──────────────────────────────────────────────
  const farm = await one(
    `INSERT INTO farms (farm_name, password_hash, business_type)
     VALUES ($1, $2, 'all') RETURNING farm_id`,
    ['demo', hashPassword('demo123')]
  );
  const F = farm.farm_id;
  await client.query("SELECT set_config('app.farm_id',$1,true)",[String(F)]);

  // Physical sites. `farms` is the login account; these are what the client
  // calls "Farms" in the interface.
  const unitBroiler = await one(
    `INSERT INTO farm_units (farm_id, module_type, unit_name, location)
     VALUES ($1,'broiler','Sahiwal Shed','Sahiwal') RETURNING unit_id`, [F]);
  const unitLayer = await one(
    `INSERT INTO farm_units (farm_id, module_type, unit_name, location)
     VALUES ($1,'layer','Okara Layer House','Okara') RETURNING unit_id`, [F]);

  // ── banking ──────────────────────────────────────────────
  const hbl = await one(
    `INSERT INTO bank_accounts (farm_id, bank_name, account_number, account_holder,
       opening_balance, current_balance)
     VALUES ($1,'HBL Main','1234-5678','Talha',500000,500000) RETURNING bank_id`, [F]);
  await client.query(
    `INSERT INTO bank_ledger (bank_id, transaction_date, description, debit, credit, balance,
       reference_type, reference_id)
     VALUES ($1,'2026-01-01','Opening balance',0,500000,500000,'opening',0)`, [hbl.bank_id]);

  // ── broiler ──────────────────────────────────────────────
  const flock = await one(
    `INSERT INTO flocks (farm_id, flock_name, start_date, status, unit_id)
     VALUES ($1,'Flock A-2026','2026-01-05','active',$2) RETURNING flock_id`,
    [F, unitBroiler.unit_id]);
  const FL = flock.flock_id;

  const chickTrader = await one(
    `INSERT INTO chick_traders (flock_id, trader_name, module_type)
     VALUES ($1,'Sadiq Hatchery','broiler') RETURNING trader_id`, [FL]);
  await client.query(
    `INSERT INTO chick_entries (trader_id, flock_id, date, chick_name, quantity,
       price_per_unit, total_amount, module_type)
     VALUES ($1,$2,'2026-01-05','Day-old chicks',5000,95,475000,'broiler')`,
    [chickTrader.trader_id, FL]);

  const feedTrader = await one(
    `INSERT INTO feed_traders (flock_id, trader_name, module_type)
     VALUES ($1,'Al-Noor Feeds','broiler') RETURNING trader_id`, [FL]);
  for (const [d, name, qty, rate] of [
    ['2026-01-06', 'Starter', 80, 6200],
    ['2026-01-20', 'Grower', 120, 6050],
    ['2026-02-03', 'Finisher', 140, 5900],
  ]) {
    await client.query(
      `INSERT INTO feed_entries (trader_id, flock_id, date, feed_name, quantity,
         price_per_unit, total_amount, module_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'broiler')`,
      [feedTrader.trader_id, FL, d, name, qty, rate, qty * rate]);
  }

  const medTrader = await one(
    `INSERT INTO medicine_traders (flock_id, trader_name, module_type)
     VALUES ($1,'City Pharma','broiler') RETURNING trader_id`, [FL]);
  await client.query(
    `INSERT INTO medicine_entries (trader_id, flock_id, date, medicine_name, quantity,
       price_per_unit, total_amount, module_type)
     VALUES ($1,$2,'2026-01-12','Multivitamin',20,850,17000,'broiler')`,
    [medTrader.trader_id, FL]);

  // Weekly health rows. week_number is misnamed: it holds a 1-based DAY index
  // (docs/LANDMINES.md line 350).
  let birds = 5000;
  for (const [day, mortality, feedUsed, weight] of [
    [7, 60, 900, 0.18], [14, 45, 2100, 0.44], [21, 38, 3600, 0.82],
    [28, 30, 5200, 1.35], [35, 25, 6800, 1.92],
  ]) {
    birds -= mortality;
    await client.query(
      `INSERT INTO flock_health (flock_id, week_number, total_birds, mortality, feed_used, avg_weight, fcr)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [FL, day, birds, mortality, feedUsed, weight, +(feedUsed / (birds * weight)).toFixed(3)]);
  }

  await client.query(
    `INSERT INTO brokers (flock_id, broker_name) VALUES ($1,'Rashid Traders')`, [FL]);
  await client.query(
    `INSERT INTO sales (flock_id, date, vehicle_number, broker, empty_weight, load_weight,
       bird_weight, rate, total_amount, payment_type, module_type, payment_source, bank_id)
     VALUES ($1,'2026-02-12','LHR-4411','Rashid Traders',2100,6300,4200,430,1806000,'bank','broiler','bank',$2)`,
    [FL, hbl.bank_id]);

  for (const [d, desc, amt] of [
    ['2026-01-08', 'Electricity', 18000],
    ['2026-01-25', 'Sawdust and bedding', 9500],
    ['2026-02-05', 'Vehicle fuel', 7200],
  ]) {
    await client.query(
      `INSERT INTO expenses (flock_id, date, description, amount, module_type, payment_source)
       VALUES ($1,$2,$3,$4,'broiler','cash')`, [FL, d, desc, amt]);
  }
  await client.query(
    `INSERT INTO income (flock_id, date, description, amount, module_type, payment_source)
     VALUES ($1,'2026-02-14','Manure sale',24000,'broiler','cash')`, [FL]);

  const ledger = await one(
    `INSERT INTO ledgers (flock_id, ledger_name) VALUES ($1,'Rashid Traders') RETURNING ledger_id`, [FL]);
  await client.query(
    `INSERT INTO ledger_entries (ledger_id, flock_id, date, description, amount, type)
     VALUES ($1,$2,'2026-02-12','Sale proceeds',1806000,'credit')`, [ledger.ledger_id, FL]);

  const labour = await one(
    `INSERT INTO labour (farm_id, labour_name, phone, role)
     VALUES ($1,'Akram','0300-1112233','Shed worker') RETURNING labour_id`, [F]);
  await client.query(
    `INSERT INTO labour_payments (labour_id, flock_id, date, description, amount, module_type, payment_source)
     VALUES ($1,$2,'2026-02-01','January wages',35000,'broiler','cash')`, [labour.labour_id, FL]);

  // ── layer ────────────────────────────────────────────────
  const batch = await one(
    `INSERT INTO batches (farm_id, batch_name, start_date, initial_birds, breed, status, unit_id)
     VALUES ($1,'Batch L-1','2025-09-01',3000,'Lohmann Brown','active',$2) RETURNING batch_id`,
    [F, unitLayer.unit_id]);
  const B = batch.batch_id;

  for (const [d, total, broken] of [
    ['2026-02-10', 2520, 31], ['2026-02-11', 2496, 24], ['2026-02-12', 2544, 28],
  ]) {
    await client.query(
      `INSERT INTO egg_collection (batch_id, date, total_eggs, broken_eggs, collection_mode)
       VALUES ($1,$2,$3,$4,'per_egg')`, [B, d, total, broken]);
  }
  await client.query(
    `INSERT INTO egg_sales (batch_id, date, customer_name, grade, quantity, rate_per_egg,
       total_amount, payment_type, sale_mode, payment_source, bank_id)
     VALUES ($1,'2026-02-12','Okara Eggs','medium',7200,18.5,133200,'bank','per_egg','bank',$2)`,
    [B, hbl.bank_id]);
  await client.query(
    `INSERT INTO hen_sales (batch_id, date, customer_name, quantity, rate_per_hen,
       total_amount, payment_type, pricing_mode, payment_source)
     VALUES ($1,'2026-02-13','Local market',180,620,111600,'cash','per_hen','cash')`, [B]);
  await client.query(
    `INSERT INTO vaccinations (batch_id, date, vaccine_name, dose, cost, done)
     VALUES ($1,'2026-01-15','Newcastle','0.5ml',14000,1)`, [B]);

  // Layer rows reuse the flock_id COLUMN to hold a batch_id when
  // module_type = 'layer' (docs/LANDMINES.md line 151).
  await client.query(
    `INSERT INTO expenses (flock_id, date, description, amount, module_type, payment_source)
     VALUES ($1,'2026-02-02','Layer shed repairs',22000,'layer','cash')`, [B]);

  // ── distribution ─────────────────────────────────────────
  const customer = await one(
    `INSERT INTO customers (farm_id, customer_name, phone, address, customer_type)
     VALUES ($1,'Bilal Poultry Mart','0321-4455667','Lahore','external') RETURNING customer_id`, [F]);
  const supplier = await one(
    `INSERT INTO suppliers (farm_id, supplier_name, phone, products_supplied)
     VALUES ($1,'Pak Feed Mills','0333-7788990','Feed, supplements') RETURNING supplier_id`, [F]);

  const product = await one(
    `INSERT INTO products (farm_id, product_name, category, unit, current_stock,
       min_stock_alert, cost_price, selling_price)
     VALUES ($1,'Broiler Starter 50kg','Feed','bag',140,20,5900,6400) RETURNING product_id`, [F]);

  await client.query(
    `INSERT INTO product_batches (farm_id, product_id, batch_code, quantity, purchase_price,
       manufacturing_date, expiry_date, status)
     VALUES ($1,$2,'PB-2026-01',140,5900,'2026-01-28','2026-09-30','active')`,
    [F, product.product_id]);

  await client.query(
    `INSERT INTO purchase_orders (farm_id, supplier_id, product_id, date, quantity,
       cost_price, total_amount, payment_type, payment_source, bank_id)
     VALUES ($1,$2,$3,'2026-01-28',200,5900,1180000,'bank','bank',$4)`,
    [F, supplier.supplier_id, product.product_id, hbl.bank_id]);

  const bill = await one(
    `INSERT INTO bills (farm_id, bill_number, customer_id, customer_name, bill_date,
       subtotal, total_amount, amount_paid, payment_type, status)
     VALUES ($1,'INV-1001',$2,'Bilal Poultry Mart','2026-02-09',384000,384000,200000,'cash','completed')
     RETURNING bill_id`, [F, customer.customer_id]);
  await client.query(
    `INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, total_price)
     VALUES ($1,$2,'Broiler Starter 50kg',60,6400,384000)`, [bill.bill_id, product.product_id]);
  await client.query(
    `INSERT INTO customer_ledger (customer_id, transaction_date, description, debit, credit, balance,
       reference_type, reference_id)
     VALUES ($1,'2026-02-09','Invoice INV-1001',384000,0,384000,'bill',$2)`,
    [customer.customer_id, bill.bill_id]);
  await client.query(
    `INSERT INTO supplier_ledger (supplier_id, transaction_date, description, debit, credit, balance,
       reference_type, reference_id)
     VALUES ($1,'2026-01-28','Purchase order',0,1180000,1180000,'purchase',1)`, [supplier.supplier_id]);

  await client.query(
    `INSERT INTO expense_ledger (farm_id, transaction_date, description, amount, category, payment_type)
     VALUES ($1,'2026-02-04','Warehouse rent',60000,'Rent','cash')`, [F]);

  // ── owner level ──────────────────────────────────────────
  const asset = await one(
    `INSERT INTO assets (farm_id, asset_name, category, purchase_date, total_price,
       purchase_amount, payment_source, status)
     VALUES ($1,'Delivery Van','Vehicle','2025-11-20',2200000,2200000,'bank','active')
     RETURNING asset_id`, [F]);
  await client.query(
    `INSERT INTO asset_payments (asset_id, farm_id, date, amount, payment_source, bank_id)
     VALUES ($1,$2,'2025-11-20',2200000,'bank',$3)`, [asset.asset_id, F, hbl.bank_id]);

  await client.query(
    `INSERT INTO loans (farm_id, direction, party_name, phone, date, principal, payment_source)
     VALUES ($1,'given','Imran','0300-9988776','2026-01-10',150000,'cash')`, [F]);
  await client.query(
    `INSERT INTO loans (farm_id, direction, party_name, date, principal, payment_source)
     VALUES ($1,'received','Nadia','2026-01-18',90000,'cash')`, [F]);

  const cat = await one(
    `INSERT INTO categories (farm_id, category_name, category_type)
     VALUES ($1,'Household','expense') RETURNING category_id`, [F]);
  await client.query(
    `INSERT INTO personal_expenses (farm_id, date, category, category_id, description, amount, payment_source)
     VALUES ($1,'2026-02-01','Household',$2,'Groceries',46000,'cash')`, [F, cat.category_id]);

  await client.query(
    `INSERT INTO debt_records (farm_id, person_name, phone, date, amount, status, notes)
     VALUES ($1,'Shahid','0345-1122334','2026-02-06',38000,'pending','Notebook entry only')`, [F]);

  await client.query('COMMIT');

  // ── report ───────────────────────────────────────────────
  // Real COUNT(*), not pg_stat_user_tables: n_live_tup is a statistics
  // estimate that is still zero immediately after an insert, which made the
  // first run report "0 tables populated" on a seed that had worked.
  const tableNames = await q(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const counts = [];
  for (const t of tableNames) {
    const r = await one(`SELECT count(*)::int AS n FROM "${t.tablename}"`);
    if (r.n > 0) counts.push({ table: t.tablename, rows: r.n });
  }

  console.log('\nSeeded.');
  console.log(`  legacy parity fixture: farm_id ${F}, business_type 'all'; no server user created`);
  console.log(`  broiler flock ${FL} · layer batch ${B} · bank ${hbl.bank_id}`);
  console.log(`\n  ${counts.length} tables populated:`);
  console.log('  ' + counts.map((c) => `${c.table}=${c.rows}`).join(', '));
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nSeed failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
