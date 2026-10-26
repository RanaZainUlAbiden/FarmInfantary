/**
 * Session-owned execution for the guarded SQL route. Not a SQL guard itself:
 * construction requires a trusted authorize callback. buildServer supplies the
 * actual AST compiler after restricted-role/RLS attestation in session mode.
 * Never accept an actor or authorize callback from an HTTP body.
 */
import { randomBytes } from 'node:crypto';
import { createDb } from './execute.js';
import { validateBatch } from './batch.js';
import { readPrepared } from './prepared.js';

const failure = error => ({ success: false, error });
const unavailable = () => failure('Database operation failed.');
const closedTransaction = () => failure('This transaction is unavailable.');
const positiveId = value => {
  const text = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text)) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return BigInt(text) <= 9223372036854775807n ? text : null;
};
function identity(actor) {
  if (!actor || !['farm_admin', 'staff'].includes(actor.role) ||
      typeof actor.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(actor.sessionKey)) return null;
  const userId = positiveId(actor.userId), farmId = positiveId(actor.farmId), authVersion = positiveId(actor.authVersion);
  if (!userId || !farmId || !authVersion) return null;
  return Object.freeze({ userId, farmId, authVersion, role: actor.role, sessionKey: actor.sessionKey });
}
const matches = (a, b) => a.sessionKey === b.sessionKey && a.userId === b.userId &&
  a.farmId === b.farmId && a.authVersion === b.authVersion && a.role === b.role;
const sanitize = result => result?.success ? result : {
  ...unavailable(), ...(Number.isSafeInteger(result?.failedIndex) ? { failedIndex: result.failedIndex } : {}),
};

export function createSessionDb(pool, {
  authorize, idleTimeoutMs = 30_000, lifetimeMs = 60_000,
  statementTimeoutMs = 10_000, maxConnections = 8, maxTransactionsPerUser = 4,
  maxQueuedOperations = 16, maxBatchSize = 500,
} = {}) {
  if (typeof authorize !== 'function') throw new Error('A trusted SQL authorizer is required.');
  for (const value of [idleTimeoutMs, lifetimeMs, statementTimeoutMs, maxConnections,
    maxTransactionsPerUser, maxQueuedOperations, maxBatchSize]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid session database limit.');
  }
  const db = createDb(pool, { transactionTimeoutMs: 0 });
  const records = new Set(), tokens = new Map(), sessions = new Map();
  let shuttingDown = false;

  function forget(record) {
    record.state = 'closed';
    clearTimeout(record.idleTimer); clearTimeout(record.lifeTimer);
    records.delete(record); tokens.delete(record.token);
    if (sessions.get(record.actor.sessionKey) === record) sessions.delete(record.actor.sessionKey);
  }
  function queue(record, work) {
    const next = record.tail.then(work);
    record.tail = next.catch(() => {});
    return next.catch(unavailable);
  }
  function expire(record) {
    record.cancelled = true;
    if (['closing', 'closed'].includes(record.state)) return record.tail;
    record.state = 'closing';
    clearTimeout(record.idleTimer); clearTimeout(record.lifeTimer);
    return queue(record, async () => {
      try { if (record.internalToken) await db.rollback(record.internalToken); }
      finally { forget(record); }
    });
  }
  function touch(record) {
    clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => void expire(record), idleTimeoutMs);
    record.idleTimer.unref();
  }
  function reserve(actor, explicit) {
    if (shuttingDown || records.size >= maxConnections) return null;
    if (explicit && (sessions.has(actor.sessionKey) || [...records].filter(r =>
      r.explicit && r.actor.userId === actor.userId).length >= maxTransactionsPerUser)) return null;
    const record = { actor, explicit, state: 'opening', tail: Promise.resolve(), pending: 0,
      token: randomBytes(32).toString('base64url'), internalToken: null };
    records.add(record);
    if (explicit) sessions.set(actor.sessionKey, record);
    record.lifeTimer = setTimeout(() => void expire(record), lifetimeMs);
    record.lifeTimer.unref();
    return record;
  }
  async function open(record) {
    const result = await db.begin();
    if (!result.success) { forget(record); return false; }
    record.internalToken = result.token;
    // Trusted, parameterized, transaction-local context on the SAME connection
    // as every business statement. Neither pool reuse nor COMMIT preserves it.
    const context = await db.get(`SELECT set_config('app.farm_id', ?, true),
      set_config('app.user_id', ?, true), set_config('statement_timeout', ?, true),
      set_config('lock_timeout', ?, true), set_config('idle_in_transaction_session_timeout', ?, true)`,
    [record.actor.farmId, record.actor.userId, String(statementTimeoutMs),
      String(statementTimeoutMs), String(Math.max(idleTimeoutMs, statementTimeoutMs) + 1000)], result.token);
    if (!context.success || record.state !== 'opening') {
      await db.rollback(result.token); forget(record); return false;
    }
    record.state = 'open'; touch(record);
    if (record.explicit) tokens.set(record.token, record);
    return true;
  }
  async function begin(actor) {
    const record = reserve(actor, true);
    if (!record) return failure('Transaction capacity is unavailable.');
    return queue(record, async () => await open(record)
      ? { success: true, token: record.token } : unavailable());
  }
  function owned(actor, token) {
    const record = typeof token === 'string' ? tokens.get(token) : null;
    if (!record || record.state !== 'open') return null;
    if (!matches(record.actor, actor)) {
      // A changed server identity invalidates that device's old transaction.
      // A different device cannot terminate a transaction by guessing its token.
      if (record.actor.sessionKey === actor.sessionKey) void expire(record);
      return null;
    }
    return record;
  }
  async function finish(actor, token, commit) {
    const record = owned(actor, token);
    if (!record) return closedTransaction();
    // Close admissions synchronously, before any pending operation finishes.
    record.state = 'closing';
    clearTimeout(record.idleTimer);
    return queue(record, async () => {
      try {
        const result = await db[commit && !record.cancelled ? 'commit' : 'rollback'](record.internalToken);
        return commit && record.cancelled ? closedTransaction() : sanitize(result);
      }
      finally { forget(record); }
    });
  }
  async function execute(actor, method, input, params, token) {
    let payload;
    try {
      payload = method === 'batch' ? validateBatch(structuredClone(input))
        : { sql: input, params: structuredClone(params) };
      if (method === 'batch' && payload.length > maxBatchSize) return failure('Batch is too large.');
      const statements = method === 'batch' ? payload : [payload];
      for (const statement of statements) {
        if (typeof statement.sql !== 'string' || !statement.sql.trim() || !Array.isArray(statement.params)) {
          return failure('Invalid database operation.');
        }
        // All batch statements are authorized before the first mutation.
        const approved = await authorize({ actor, method, sql: statement.sql, params: structuredClone(statement.params) });
        if (approved !== true && !(readPrepared(approved?.query) && Array.isArray(approved.params))) {
          return failure('Database access is not allowed.');
        }
        if (approved !== true) { statement.sql = approved.query; statement.params = approved.params; }
      }
    } catch { return failure('Database access is not allowed.'); }
    const explicit = token !== null && token !== undefined;
    const record = explicit ? owned(actor, token) : reserve(actor, false);
    if (!record) return explicit ? closedTransaction() : failure('Database capacity is unavailable.');
    if (record.pending >= maxQueuedOperations) return failure('Too many pending transaction operations.');
    record.pending++;
    return queue(record, async () => {
      try {
        if (!explicit && !await open(record)) return unavailable();
        // Work admitted before commit is allowed to drain; expiry/revocation
        // instead prevents queued work, then rolls back after the active query.
        if (record.cancelled) return closedTransaction();
        const result = method === 'batch' ? await db.batch(payload, record.internalToken)
          : await db[method](payload.sql, payload.params, record.internalToken);
        if (explicit && record.cancelled) return closedTransaction();
        if (!explicit) {
          if (!result.success || record.state !== 'open') { await db.rollback(record.internalToken); return sanitize(result.success ? null : result); }
          const committed = await db.commit(record.internalToken);
          return committed.success ? sanitize(result) : unavailable();
        }
        // A failed batch already restored its savepoint. A failed ordinary
        // statement poisons PostgreSQL's transaction: roll it back immediately.
        if (!result.success && method !== 'batch') void expire(record);
        return sanitize(result);
      } catch {
        if (explicit) void expire(record);
        else if (record.internalToken) await db.rollback(record.internalToken);
        return unavailable();
      } finally {
        record.pending--;
        if (!explicit) forget(record);
        else if (record.state === 'open') touch(record);
      }
    });
  }
  async function revoke(predicate) {
    const found = [...records].filter(predicate);
    for (const record of found) record.cancelled = true;
    await Promise.all(found.map(expire));
  }
  function forActor(value) {
    const actor = identity(value);
    const denied = () => Promise.resolve(failure('A valid farm session is required.'));
    if (!actor) return Object.fromEntries(['get', 'run', 'batch', 'begin', 'commit', 'rollback'].map(key => [key, denied]));
    return Object.freeze({
      get: (sql, params = [], token = null) => execute(actor, 'get', sql, params, token),
      run: (sql, params = [], token = null) => execute(actor, 'run', sql, params, token),
      batch: (ops, token = null) => execute(actor, 'batch', ops, null, token),
      begin: () => begin(actor), commit: token => finish(actor, token, true), rollback: token => finish(actor, token, false),
    });
  }
  return {
    init: db.init, forActor,
    revokeSession: key => revoke(record => record.actor.sessionKey === key),
    revokeUser: id => revoke(record => record.actor.userId === String(id)),
    async close() { shuttingDown = true; await revoke(() => true); },
    get openTransactions() { return sessions.size; },
    get activeConnections() { return records.size; },
  };
}
