/**
 * The query layer — the PostgreSQL replacement for electron/database.js's
 * runQuery / getQuery / runBatch and its transaction handling.
 *
 * RESULT SHAPES ARE CONTRACTUAL. 341 call sites check `.success` on these:
 *
 *   get   -> { success: true, data: rows[] }
 *   run   -> { success: true, lastId }
 *   batch -> { success: true, results: [{ lastId }], lastId }
 *   any failure -> { success: false, error, ... }
 *
 * NOTHING HERE THROWS to the caller. On the desktop a failure came back as a
 * result object, never a rejected promise, and every call site was written
 * against that. If this layer started rejecting, error handling across the
 * whole app would silently change shape — screens would show nothing instead
 * of a message, and `catch` blocks that were never written would be needed
 * everywhere.
 *
 * WHAT THE DESKTOP DID THAT WE DELIBERATELY DO NOT
 * ------------------------------------------------
 * Every write called `db.export()` + `writeFileSync` — the entire database
 * serialised to disk, per statement — and transaction state lived in module
 * globals (`inTransaction`, `savepointCounter`, `poisonedConnection`) on one
 * shared connection, policed by a 60-second watchdog. None of that survives
 * concurrent users, and none of it is needed here: a pooled connection with a
 * real transaction does the same job correctly.
 */

import { translate } from './dialect.js';
import { prepare } from './placeholders.js';
import {
  withReturning, extractLastId, loadPrimaryKeys, insertsExplicitPk, resyncSequenceSql,
} from './primary-keys.js';
import { validateBatch, resolveParams } from './batch.js';

/** Turn any thrown thing into the error string the renderer expects. */
function message(err) {
  if (!err) return 'Unknown database error';
  // PostgreSQL errors carry useful position/detail that a bare message drops.
  const base = err.message || String(err);
  return err.detail ? `${base} (${err.detail})` : base;
}

/**
 * Prepares one statement: dialect translation, then placeholder renumbering,
 * then RETURNING for inserts. Order matters — translation can introduce text
 * containing neither `?` nor a RETURNING clause, and must happen first.
 */
function compile(sql, params, primaryKeys) {
  const t = translate(sql);
  if (t.unhandled.length) {
    throw new Error(`Untranslatable SQL: ${t.unhandled.join('; ')}`);
  }
  const withRet = withReturning(t.text, primaryKeys);
  const { text, values } = prepare(withRet.text, params);

  // An INSERT that supplies its own id leaves the identity sequence behind.
  // SQLite advances AUTOINCREMENT in that case; PostgreSQL does not, so the
  // sequence is pushed past the new maximum afterwards to match.
  const pk = withRet.table ? primaryKeys.get(withRet.table) : null;
  const resync = pk && insertsExplicitPk(t.text, withRet.table, pk)
    ? resyncSequenceSql(withRet.table, pk)
    : null;

  return { text, values, idColumn: withRet.idColumn, resync };
}

export function createDb(pool) {
  /** @type {Map<string,string>} */
  let primaryKeys = new Map();

  /** Open transactions, by token. Phase 3 binds these to a session. */
  const transactions = new Map();
  let tokenSeq = 0;

  /** Abandoned transactions must not hold a pooled connection forever. */
  const TRANSACTION_TIMEOUT_MS = 60_000;

  async function init() {
    const client = await pool.connect();
    try {
      primaryKeys = await loadPrimaryKeys(client);
    } finally {
      client.release();
    }
    return primaryKeys.size;
  }

  /** The connection a call should use: a transaction's, or the pool. */
  function target(token) {
    if (!token) return { client: pool, release: () => {} };
    const tx = transactions.get(token);
    if (!tx) throw new Error('This transaction is no longer open.');
    clearTimeout(tx.timer);
    tx.timer = setTimeout(() => void rollback(token), TRANSACTION_TIMEOUT_MS);
    return { client: tx.client, release: () => {} };
  }

  async function get(sql, params = [], token = null) {
    try {
      const { client } = target(token);
      const c = compile(sql, params, primaryKeys);
      const res = await client.query(c.text, c.values);
      return { success: true, data: res.rows };
    } catch (err) {
      return { success: false, error: message(err) };
    }
  }

  async function run(sql, params = [], token = null) {
    try {
      const { client } = target(token);
      const c = compile(sql, params, primaryKeys);
      const res = await client.query(c.text, c.values);
      if (c.resync) await client.query(c.resync);
      return { success: true, lastId: extractLastId(res, c.idColumn) };
    } catch (err) {
      return { success: false, error: message(err) };
    }
  }

  /**
   * An ordered list of statements, all or nothing.
   *
   * Inside an open transaction this becomes a SAVEPOINT rather than a nested
   * BEGIN — PostgreSQL rejects the latter, exactly as SQLite did — so a batch
   * can fail and unwind without discarding the transaction around it.
   */
  async function batch(ops, token = null) {
    let list;
    try {
      list = validateBatch(ops);
    } catch (err) {
      return { success: false, error: message(err) };
    }

    const nested = Boolean(token);
    const savepoint = `batch_sp_${++tokenSeq}`;
    let client;
    let release = () => {};

    try {
      if (nested) {
        ({ client } = target(token));
        await client.query(`SAVEPOINT ${savepoint}`);
      } else {
        client = await pool.connect();
        release = () => client.release();
        await client.query('BEGIN');
      }
    } catch (err) {
      release();
      return { success: false, error: message(err) };
    }

    const results = [];
    const ids = [];

    try {
      for (let i = 0; i < list.length; i++) {
        const op = list[i];
        const params = resolveParams(op.params, ids, i);
        const c = compile(op.sql, params, primaryKeys);
        const res = await client.query(c.text, c.values);
        if (c.resync) await client.query(c.resync);
        const lastId = extractLastId(res, c.idColumn);
        ids.push(lastId);
        results.push({ lastId });
      }

      if (nested) await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      else await client.query('COMMIT');

      return {
        success: true,
        results,
        lastId: results.length ? results[results.length - 1].lastId : null,
      };
    } catch (err) {
      const failedIndex = results.length;
      try {
        if (nested) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          await client.query('ROLLBACK');
        }
      } catch (rollbackErr) {
        console.error('Rolling back a failed batch failed:', message(rollbackErr));
      }
      return {
        success: false,
        error: `${message(err)} (statement ${failedIndex + 1} of ${list.length})`,
        failedIndex,
        failedSql: list[failedIndex]?.sql ?? '',
      };
    } finally {
      release();
    }
  }

  // ── transactions spanning several calls ──────────────────
  // Only 2 call sites use these; the other 54 multi-statement writes use
  // batch(), which is self-contained. Prefer batch() for new work.

  async function begin() {
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      const token = `tx_${++tokenSeq}_${Date.now()}`;
      const tx = {
        client,
        timer: setTimeout(() => void rollback(token), TRANSACTION_TIMEOUT_MS),
      };
      transactions.set(token, tx);
      return { success: true, token };
    } catch (err) {
      return { success: false, error: message(err) };
    }
  }

  async function finish(token, verb) {
    const tx = transactions.get(token);
    if (!tx) return { success: false, error: 'No database transaction is open.' };
    transactions.delete(token);
    clearTimeout(tx.timer);
    try {
      await tx.client.query(verb);
      return { success: true };
    } catch (err) {
      return { success: false, error: message(err) };
    } finally {
      tx.client.release();
    }
  }

  const commit = (token) => finish(token, 'COMMIT');
  const rollback = (token) => finish(token, 'ROLLBACK');

  return {
    init,
    get,
    run,
    batch,
    begin,
    commit,
    rollback,
    get openTransactions() { return transactions.size; },
    get primaryKeyCount() { return primaryKeys.size; },
  };
}
