/**
 * The database endpoints — a 1:1 mirror of the desktop `electronAPI` surface.
 *
 *   dbGet                -> POST /api/db/get
 *   dbRun                -> POST /api/db/run
 *   dbRunBatch           -> POST /api/db/batch
 *   dbBeginTransaction   -> POST /api/db/tx/begin
 *   dbCommitTransaction  -> POST /api/db/tx/commit
 *   dbRollbackTransaction-> POST /api/db/tx/rollback
 *
 * Keeping the shapes identical is what lets `DatabaseService` keep its method
 * signatures, which is what lets 341 call sites go unmodified.
 *
 * HTTP STATUS IS ALWAYS 200 FOR A QUERY THAT REACHED THE DATABASE.
 *
 * That looks wrong and is deliberate. On the desktop a failing statement came
 * back as `{ success: false, error }` — never a thrown exception — and every
 * call site checks `.success`. If a SQL error became a 500, Angular's
 * HttpClient would reject the promise, and error handling across the whole app
 * would silently change shape: screens showing nothing instead of a message,
 * and `catch` blocks that nobody ever wrote.
 *
 * Genuinely malformed REQUESTS (not statements) still get 4xx, because those
 * are a client bug rather than a database answer.
 */

/** Body shape guard. Returns an error string, or null when the body is fine. */
function badBody(body) {
  if (!body || typeof body !== 'object') return 'Expected a JSON object body.';
  return null;
}

export function registerDbRoutes(app, { db, session, sessionDb, guarded = false }) {
  /** Every handler resolves who it is acting as from the SERVER, never the body. */
  const actor = (req) => session.resolve(req);
  const executor = async req => {
    const identity = await actor(req);
    if(guarded&&!sessionDb) {
      const denied=async()=>({success:false,error:'Business database access is unavailable.'});
      return Object.fromEntries(['get','run','batch','begin','commit','rollback'].map(key=>[key,denied]));
    }
    return sessionDb ? sessionDb.forActor(identity) : db;
  };

  app.post('/api/db/get', async (req, reply) => {
    const bad = badBody(req.body);
    if (bad) return reply.code(400).send({ success: false, error: bad });

    const { sql, params, token } = req.body;
    if (typeof sql !== 'string' || sql.trim() === '') {
      return reply.code(400).send({ success: false, error: 'sql must be a non-empty string.' });
    }
    return (await executor(req)).get(sql, params ?? [], token ?? null);
  });

  app.post('/api/db/run', async (req, reply) => {
    const bad = badBody(req.body);
    if (bad) return reply.code(400).send({ success: false, error: bad });

    const { sql, params, token } = req.body;
    if (typeof sql !== 'string' || sql.trim() === '') {
      return reply.code(400).send({ success: false, error: 'sql must be a non-empty string.' });
    }
    return (await executor(req)).run(sql, params ?? [], token ?? null);
  });

  app.post('/api/db/batch', async (req, reply) => {
    const bad = badBody(req.body);
    if (bad) return reply.code(400).send({ success: false, error: bad });

    const { ops, token } = req.body;
    // A malformed batch comes back as success:false rather than 400 — the
    // desktop validated it the same way, inside runBatch.
    return (await executor(req)).batch(ops, token ?? null);
  });

  app.post('/api/db/tx/begin', async (req) => {
    return (await executor(req)).begin();
  });

  app.post('/api/db/tx/commit', async (req, reply) => {
    const bad = badBody(req.body);
    if (bad) return reply.code(400).send({ success: false, error: bad });
    return (await executor(req)).commit(req.body.token);
  });

  app.post('/api/db/tx/rollback', async (req, reply) => {
    const bad = badBody(req.body);
    if (bad) return reply.code(400).send({ success: false, error: bad });
    return (await executor(req)).rollback(req.body.token);
  });
}
