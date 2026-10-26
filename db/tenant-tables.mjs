// [Codex] Explicit business boundary. Never derive runtime grants from all tables
// in a schema: users, sessions and future platform tables must stay excluded.
export const TENANT_TABLES = Object.freeze([
  'app_settings','asset_payments','assets','balance','bank_accounts','bank_ledger',
  'batch_transactions','batches','bill_items','bills','brokers','categories',
  'chick_entries','chick_traders','customer_ledger','customer_payments','customers',
  'debt_records','egg_collection','egg_sales','expense_categories','expense_ledger',
  'expenses','farm_units','farms','feed_entries','feed_traders','flock_health','flocks',
  'hen_sales','income','internal_settlements','internal_transfers','labour',
  'labour_payments','layer_health','layer_ledger_entries','layer_ledgers',
  'layer_mortality','ledger_entries','ledgers','loan_payments','loans',
  'medicine_entries','medicine_traders','payment_vouchers','personal_expenses',
  'product_batches','products','purchase_orders','purchase_returns','receive_vouchers',
  'sales','sales_orders','sales_return_items','sales_returns','supplier_ledger',
  'suppliers','vaccinations',
]);
export const BUSINESS_TABLES = Object.freeze(TENANT_TABLES.filter(name => name !== 'farms'));
export const EXCLUDED_TABLES = Object.freeze(['activation','users','auth_sessions','auth_login_limits','permission_catalogue','user_permissions','audit_events','farm_security','auth_delete_grants']);
export const FARM_READ_COLUMNS = Object.freeze(['farm_id','farm_name','business_type','created_at','status']);
export const sqlIdentifier = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid database identifier.');
  return '"' + value + '"';
};
