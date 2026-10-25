import { test } from 'node:test';
import assert from 'node:assert/strict';

import { insertTarget, hasReturning, withReturning, extractLastId } from '../src/db/primary-keys.js';
import { isLastIdRef, resolveParams, validateBatch } from '../src/db/batch.js';

const PK = new Map([
  ['bills', 'bill_id'],
  ['bill_items', 'item_id'],
  ['sales', 'sale_id'],
  // app_settings (composite) and activation (text key) are deliberately absent
]);

// ── RETURNING ──────────────────────────────────────────────

test('insertTarget finds the table, case-insensitively', () => {
  assert.equal(insertTarget(`INSERT INTO bills (a) VALUES (1)`), 'bills');
  assert.equal(insertTarget(`insert into Bills (a) values (1)`), 'bills');
  assert.equal(insertTarget(`INSERT INTO "bill_items" (a) VALUES (1)`), 'bill_items');
});

test('insertTarget ignores INSERT inside a string literal', () => {
  assert.equal(insertTarget(`SELECT 'INSERT INTO bills' AS note`), null);
});

test('insertTarget returns null for non-INSERTs', () => {
  assert.equal(insertTarget(`UPDATE bills SET a = 1`), null);
  assert.equal(insertTarget(`SELECT * FROM bills`), null);
});

test('withReturning appends the primary key', () => {
  const r = withReturning(`INSERT INTO bills (farm_id) VALUES ($1)`, PK);
  assert.equal(r.text, `INSERT INTO bills (farm_id) VALUES ($1) RETURNING "bill_id"`);
  assert.equal(r.idColumn, 'bill_id');
});

test('withReturning strips a trailing semicolon before appending', () => {
  const r = withReturning(`INSERT INTO sales (flock_id) VALUES ($1);`, PK);
  assert.equal(r.text, `INSERT INTO sales (flock_id) VALUES ($1) RETURNING "sale_id"`);
});

test('withReturning leaves an existing RETURNING alone', () => {
  const sql = `INSERT INTO bills (farm_id) VALUES ($1) RETURNING bill_id`;
  assert.equal(withReturning(sql, PK).text, sql);
});

test('withReturning leaves tables with no single-column integer key alone', () => {
  // app_settings has a composite key, activation a text one. Neither has a
  // generated id to hand back, and inventing one would be worse than null.
  for (const sql of [
    `INSERT INTO app_settings (farm_id, key, value) VALUES ($1,$2,$3)`,
    `INSERT INTO activation (machine_id, activation_code) VALUES ($1,$2)`,
  ]) {
    const r = withReturning(sql, PK);
    assert.equal(r.text, sql);
    assert.equal(r.idColumn, null);
  }
});

test('withReturning does not touch UPDATE or DELETE', () => {
  const sql = `UPDATE bills SET amount_paid = $1 WHERE bill_id = $2`;
  assert.equal(withReturning(sql, PK).text, sql);
});

test('extractLastId reads the id, and reports null when nothing was inserted', () => {
  assert.equal(extractLastId({ rows: [{ bill_id: 42 }] }, 'bill_id'), 42);
  // ON CONFLICT DO NOTHING that conflicted: no row, so no id. Correct, not an error.
  assert.equal(extractLastId({ rows: [] }, 'bill_id'), null);
  assert.equal(extractLastId({ rows: [{ bill_id: 1 }] }, null), null);
});

// ── $lastId ────────────────────────────────────────────────

test('isLastIdRef recognises only the marker shape', () => {
  assert.equal(isLastIdRef({ $lastId: -1 }), true);
  assert.equal(isLastIdRef({ $lastId: 0 }), true);
  for (const v of [1, 'x', null, undefined, [], { id: 1 }]) {
    assert.equal(isLastIdRef(v), false, JSON.stringify(v));
  }
});

test('$lastId -1 is the row the previous statement inserted', () => {
  // The common case: insert a bill, then its items.
  const ids = [100];
  assert.deepEqual(resolveParams([{ $lastId: -1 }, 'Feed', 2], ids, 1), [100, 'Feed', 2]);
});

test('$lastId -2 counts back two statements', () => {
  const ids = [100, 200];
  assert.deepEqual(resolveParams([{ $lastId: -2 }], ids, 2), [100]);
});

test('$lastId with a non-negative index is absolute', () => {
  const ids = [100, 200, 300];
  assert.deepEqual(resolveParams([{ $lastId: 0 }], ids, 3), [100]);
  assert.deepEqual(resolveParams([{ $lastId: 2 }], ids, 3), [300]);
});

test('several $lastId refs resolve independently in one statement', () => {
  const ids = [10, 20];
  assert.deepEqual(
    resolveParams([{ $lastId: -1 }, 'x', { $lastId: -2 }], ids, 2),
    [20, 'x', 10]
  );
});

test('plain params pass through untouched, including objects and null', () => {
  const ids = [1];
  const params = ['a', 0, null, false, { id: 7 }];
  assert.deepEqual(resolveParams(params, ids, 1), params);
});

test('a $lastId pointing at the current or a later statement is refused', () => {
  assert.throws(() => resolveParams([{ $lastId: 0 }], [], 0), /not an earlier statement/);
  assert.throws(() => resolveParams([{ $lastId: 5 }], [1], 1), /not an earlier statement/);
  // -1 on the FIRST statement: there is no previous one.
  assert.throws(() => resolveParams([{ $lastId: -1 }], [], 0), /not an earlier statement/);
});

test('a $lastId pointing at a statement that inserted nothing is REFUSED', () => {
  // This is the landmine made loud. An ON CONFLICT DO NOTHING that conflicted
  // produces no id; writing null into a foreign key orphans the row silently.
  assert.throws(
    () => resolveParams([{ $lastId: -1 }], [null], 1),
    /inserted no row and produced no id/
  );
});

test('a non-integer $lastId is refused', () => {
  assert.throws(() => resolveParams([{ $lastId: 1.5 }], [1, 2], 2), /must be an integer/);
  assert.throws(() => resolveParams([{ $lastId: '-1' }], [1, 2], 2), /must be an integer/);
});

test('error messages are 1-based, matching how people count statements', () => {
  try {
    resolveParams([{ $lastId: -1 }], [], 0);
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /Statement 1, parameter 1/);
  }
});

// ── batch shape ────────────────────────────────────────────

test('validateBatch normalises missing params to an empty array', () => {
  assert.deepEqual(validateBatch([{ sql: 'SELECT 1' }]), [{ sql: 'SELECT 1', params: [] }]);
});

test('validateBatch refuses malformed batches before anything executes', () => {
  assert.throws(() => validateBatch([]), /non-empty array/);
  assert.throws(() => validateBatch('nope'), /non-empty array/);
  assert.throws(() => validateBatch([{ params: [] }]), /Statement 1 is missing its SQL/);
  assert.throws(() => validateBatch([{ sql: 'SELECT 1' }, null]), /Statement 2 is not an object/);
  assert.throws(() => validateBatch([{ sql: 'SELECT 1', params: 'x' }]), /params must be an array/);
});
