// `db.run()`/`db.get()` resolve `{ success: false, error }` for a SQL failure
// rather than throwing, and `error` is whatever the driver raised — "NOT NULL
// constraint failed: assets.purchase_amount", not anything a user should see.
// Most of that error text is deliberately authored by app code (e.g. "Choose
// which bank account the payment came from.") and must reach the dialog
// unchanged; only the raw driver text needs swapping out.
//
// POSTGRESQL WORDS ITS ERRORS DIFFERENTLY, AND THAT LEAKED
// -------------------------------------------------------
// The original pattern was written against sql.js. PostgreSQL shares only one
// phrase with it — "syntax error" — so everything else came through verbatim
// and would have been shown to a user:
//
//     relation "product_batches" does not exist
//     null value in column "amount" of relation "expenses" violates not-null constraint
//     duplicate key value violates unique constraint "farms_pkey"
//     operator does not exist: text >= date
//
// Eight of the nine shapes below leaked before this was widened.
//
// Erring toward HIDING is deliberate: an app-authored sentence that is wrongly
// hidden costs the user a generic message, while leaked driver text exposes
// table and column names and tells them nothing useful.

const SQLITE_ERROR_PATTERN =
  /constraint failed|SQLITE_|no such (table|column)|datatype mismatch/i;

const POSTGRES_ERROR_PATTERN =
  /(relation|column|function|operator|type|schema|role)\b.*does not exist|violates (not-null|unique|check|foreign key|exclusion) constraint|invalid input syntax for|division by zero|out of range|could not determine|cannot be cast|permission denied for|deadlock detected|canceling statement due to|too many connections|current transaction is aborted/i;

/** Shared by both engines. */
const COMMON_ERROR_PATTERN = /syntax error|bind message|prepared statement/i;

const DRIVER_ERROR_PATTERN = new RegExp(
  [SQLITE_ERROR_PATTERN.source, POSTGRES_ERROR_PATTERN.source, COMMON_ERROR_PATTERN.source].join('|'),
  'i'
);

/**
 * Replaces raw driver text with `fallback`, passing app-authored messages
 * through unchanged.
 *
 * `fallback` is what the user actually reads when a statement fails, so give
 * it something they can act on. "unknown error" tells nobody anything — and
 * because failures are returned rather than thrown, a useless fallback plus no
 * server log is a failure that is invisible from both ends. Set
 * LOG_SQL_ERRORS=1 on the API to record the real statement.
 */
export function friendlySqlError(error: string | undefined | null, fallback: string): string {
  if (!error) return fallback;
  return DRIVER_ERROR_PATTERN.test(error) ? fallback : error;
}
