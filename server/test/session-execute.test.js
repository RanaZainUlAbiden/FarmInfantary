import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/execute.js';
import { createSessionDb } from '../src/db/session-execute.js';

test('failed BEGIN destroys the connection lease instead of leaking pool capacity', async () => {
  const broken = new Error('connection broke during BEGIN'); let released;
  const db = createDb({ connect: async () => ({ query: async () => { throw broken; }, release: error => { released = error; } }) });
  assert.equal((await db.begin()).success, false);
  assert.equal(released, broken); assert.equal(db.openTransactions, 0);
});

test('session execution rejects absent authorization before touching the pool', () => {
  const pool = { connect() { throw new Error('must not be called'); } };
  assert.throws(() => createSessionDb(pool), /authorizer/);
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => createSessionDb(pool, { authorize: () => true, maxConnections: value }), /limit/);
  }
});

test('authorization errors and malformed input return contractual failures without database access', async () => {
  const db = createSessionDb({ connect() { throw new Error('must not be called'); } }, {
    authorize: () => { throw new Error('sensitive guard details'); },
  });
  const actor = db.forActor({ farmId: 1, userId: 1, authVersion: 1, role: 'farm_admin', sessionKey: 'a'.repeat(64) });
  for (const result of [await actor.get('SELECT 1'), await actor.get('SELECT 1', {}), await actor.batch(null),
    await actor.batch([{ sql: 'SELECT 1', params: {} }])]) {
    assert.equal(result.success, false); assert.ok(['Database access is not allowed.', 'Invalid database operation.'].includes(result.error));
  }
  assert.equal(db.activeConnections, 0); await db.close();
});
