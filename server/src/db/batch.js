/**
 * `$lastId` back-references inside a batch.
 *
 * A batch is an ordered list of `{ sql, params }` that commit together. A param
 * of `{ $lastId: n }` is replaced with the id inserted by operation `n` of the
 * SAME batch:
 *
 *   n < 0   counts back from the current operation, so `{ $lastId: -1 }` is
 *           "the row the previous statement just inserted"
 *   n >= 0  is an absolute index into the batch
 *
 * 54 call sites depend on this, and it is how a bill and its items, or a
 * settlement and its ledger entries, are written in one atomic step without a
 * round trip between each.
 *
 * WHY IT IS STRICT
 * ----------------
 * Every failure here is refused rather than coerced. A `$lastId` that resolves
 * to null is the exact shape of the desktop landmine: null does not throw, it
 * gets written into a foreign key column, and the row is silently orphaned.
 * There is no safe default for "the id of a row that was not inserted", so this
 * refuses the batch and the whole thing rolls back.
 */

import { readPrepared } from './prepared.js';
/** @typedef {{ sql: string, params?: unknown[] }} BatchOp */

/** True for the `{ $lastId: n }` marker shape. */
export function isLastIdRef(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.prototype.hasOwnProperty.call(v, '$lastId')
  );
}

/**
 * Resolves one operation's params against the ids produced so far.
 *
 * @param {unknown[]} params      the operation's params, possibly with markers
 * @param {(number|null)[]} ids   lastId per completed operation, in order
 * @param {number} index          index of the operation being resolved
 * @returns {unknown[]}
 */
export function resolveParams(params, ids, index) {
  if (!Array.isArray(params)) return [];

  return params.map((p, slot) => {
    if (!isLastIdRef(p)) return p;

    const raw = p.$lastId;
    if (!Number.isInteger(raw)) {
      throw new Error(
        `Statement ${index + 1}, parameter ${slot + 1}: $lastId must be an integer, got ${JSON.stringify(raw)}.`
      );
    }

    // Negative counts back from this operation; non-negative is absolute.
    const target = raw < 0 ? index + raw : raw;

    if (target < 0 || target >= index) {
      throw new Error(
        `Statement ${index + 1}, parameter ${slot + 1}: $lastId ${raw} refers to ` +
        `operation ${target + 1}, which is not an earlier statement in this batch ` +
        `(1..${index} are available).`
      );
    }

    const id = ids[target];
    if (id === null || id === undefined) {
      throw new Error(
        `Statement ${index + 1}, parameter ${slot + 1}: $lastId ${raw} refers to ` +
        `statement ${target + 1}, which inserted no row and produced no id. ` +
        `Writing null here would orphan the row.`
      );
    }
    return id;
  });
}

/**
 * Validates a batch's shape before any of it executes, so a malformed
 * operation fails before the transaction opens rather than halfway through.
 *
 * @param {unknown} ops
 * @returns {BatchOp[]}
 */
export function validateBatch(ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('A batch must be a non-empty array of { sql, params } operations.');
  }
  return ops.map((op, i) => {
    if (!op || typeof op !== 'object') {
      throw new Error(`Statement ${i + 1} is not an object.`);
    }
    if (!op.sql || (typeof op.sql !== 'string' && !readPrepared(op.sql))) {
      throw new Error(`Statement ${i + 1} is missing its SQL.`);
    }
    if (op.params !== undefined && !Array.isArray(op.params)) {
      throw new Error(`Statement ${i + 1}: params must be an array.`);
    }
    return { sql: op.sql, params: op.params ?? [] };
  });
}
