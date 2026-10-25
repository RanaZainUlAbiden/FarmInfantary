/**
 * friendlySqlError — what a user sees when a statement fails.
 *
 * The rule: raw DRIVER text is replaced by the caller's fallback; text the APP
 * authored passes through unchanged. Getting it wrong either way is bad —
 * leaked driver text exposes table and column names and tells the user
 * nothing, while a wrongly-hidden app message loses the one sentence that
 * would have told them what to fix.
 *
 * The original pattern was written against sql.js. PostgreSQL shares only one
 * phrase with it ("syntax error"), so eight of the nine shapes below leaked
 * verbatim to users until the pattern was widened.
 *
 * The utility lives in the Angular tree (src/app/shared/utils/sql-error.util.ts)
 * and is TypeScript, so the pattern is mirrored here rather than imported.
 * verify_sql_error_sync.mjs asserts the two stay identical — a copy that
 * silently drifts is worse than no test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { friendlySqlError } from './helpers/sql-error.mjs';

const FALLBACK = 'Could not save. Please try again.';

test('PostgreSQL driver text is hidden behind the fallback', () => {
  for (const msg of [
    'syntax error at or near ")"',
    'relation "product_batches" does not exist',
    'column "nope" does not exist',
    'operator does not exist: text >= date',
    'function max(double precision, integer) does not exist',
    'null value in column "amount" of relation "expenses" violates not-null constraint',
    'duplicate key value violates unique constraint "farms_pkey"',
    'insert or update on table "bills" violates foreign key constraint',
    'new row for relation "flocks" violates check constraint "flocks_status_check"',
    'invalid input syntax for type bigint: "abc"',
    'division by zero',
    'bigint out of range',
    'current transaction is aborted, commands ignored until end of transaction block',
    'canceling statement due to statement timeout',
    'deadlock detected',
    'permission denied for table farms',
  ]) {
    assert.equal(friendlySqlError(msg, FALLBACK), FALLBACK, msg);
  }
});

test('SQLite driver text stays hidden too — the desktop app is still the reference', () => {
  for (const msg of [
    'NOT NULL constraint failed: assets.purchase_amount',
    'UNIQUE constraint failed: farms.farm_name',
    'SQLITE_BUSY: database is locked',
    'no such table: product_batches',
    'no such column: bl.total',
    'datatype mismatch',
  ]) {
    assert.equal(friendlySqlError(msg, FALLBACK), FALLBACK, msg);
  }
});

test('app-authored messages pass through UNCHANGED', () => {
  // These are the sentences the app writes to tell a user what to fix. They
  // must survive: losing them is the whole cost of erring toward hiding.
  for (const msg of [
    'Choose which bank account the payment came from.',
    'This flock already has a sale on that date.',
    'Enter a quantity greater than zero.',
    'A purchase order requires a supplier.',
    'That category still has 2 entries, so it cannot be deleted.',
    'No bank account has enough to cover this payment.',
  ]) {
    assert.equal(friendlySqlError(msg, FALLBACK), msg, msg);
  }
});

test('a missing error falls back rather than rendering undefined', () => {
  assert.equal(friendlySqlError(undefined, FALLBACK), FALLBACK);
  assert.equal(friendlySqlError(null, FALLBACK), FALLBACK);
  assert.equal(friendlySqlError('', FALLBACK), FALLBACK);
});
