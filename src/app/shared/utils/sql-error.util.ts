// `db.run()`/`db.get()` resolve `{ success: false, error }` for a SQL failure
// rather than throwing, and `error` is whatever sql.js's driver raised —
// "NOT NULL constraint failed: assets.purchase_amount", not anything a user
// should see. Most of that error text is deliberately authored by app code
// (e.g. "Choose which bank account the payment came from.") and must reach
// the dialog unchanged; only the raw driver text needs swapping out.
const SQL_ERROR_PATTERN = /constraint failed|SQLITE_|no such (table|column)|syntax error|datatype mismatch/i;

export function friendlySqlError(error: string | undefined | null, fallback: string): string {
  if (!error) return fallback;
  return SQL_ERROR_PATTERN.test(error) ? fallback : error;
}
