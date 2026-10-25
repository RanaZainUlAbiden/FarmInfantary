/**
 * MIRROR of src/app/shared/utils/sql-error.util.ts.
 *
 * The real implementation is TypeScript inside the Angular tree and cannot be
 * imported by the Node test runner without a build step. The three patterns
 * below are copied VERBATIM from it.
 *
 * A copy that drifts silently is worse than no test, so
 * scripts/verify/verify_sql_error_sync.mjs fails the build if these three
 * regex sources stop matching the TypeScript ones character for character.
 * If that check fires, copy the source across — do not "fix" it here.
 */

const SQLITE_ERROR_PATTERN =
  /constraint failed|SQLITE_|no such (table|column)|datatype mismatch/i;

const POSTGRES_ERROR_PATTERN =
  /(relation|column|function|operator|type|schema|role)\b.*does not exist|violates (not-null|unique|check|foreign key|exclusion) constraint|invalid input syntax for|division by zero|out of range|could not determine|cannot be cast|permission denied for|deadlock detected|canceling statement due to|too many connections|current transaction is aborted/i;

const COMMON_ERROR_PATTERN = /syntax error|bind message|prepared statement/i;

const DRIVER_ERROR_PATTERN = new RegExp(
  [SQLITE_ERROR_PATTERN.source, POSTGRES_ERROR_PATTERN.source, COMMON_ERROR_PATTERN.source].join('|'),
  'i'
);

export function friendlySqlError(error, fallback) {
  if (!error) return fallback;
  return DRIVER_ERROR_PATTERN.test(error) ? fallback : error;
}
