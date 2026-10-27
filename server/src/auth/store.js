import { createHmac, randomBytes } from 'node:crypto';

export function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(name) ? name.toLowerCase() : null;
}
const actorFrom = r => ({ userId: r.user_id, username: r.username, role: r.role,
  farmId: r.farm_id, authVersion: r.auth_version,
  ...(r.token_hash ? { sessionKey: r.token_hash } : {}),
  farm: r.farm_id == null ? null : { farm_id: r.farm_id, farm_name: r.farm_name, business_type: r.business_type },
});
export function createAuthStore(pool, config, {
  clock = () => Date.now(), onRevokeSession = async () => {}, onRevokeUser = async () => {},
} = {}) {
  const now = () => Math.floor(clock() / 1000);
  const digest = (purpose, value) => createHmac('sha256', config.secret).update(purpose + '\0' + value).digest('hex');
  let nextCleanup = 0;
  async function cleanup(at) {
    if (at < nextCleanup) return;
    nextCleanup = at + 60;
    await pool.query('DELETE FROM auth_sessions WHERE expires_at <= $1 OR last_seen_at <= $2', [at, at-config.idleSeconds]);
    await pool.query('DELETE FROM auth_login_limits WHERE window_started_at <= $1', [at-config.loginWindowSeconds]);
  }
  async function throttle(ip, username, purpose = 'login', limits = null) {
    const at = now();
    await cleanup(at);
    const windowSeconds=limits?.windowSeconds??config.loginWindowSeconds;
    for (const [scope, key, limit] of [['ip',ip,limits?.ipAttempts??config.ipAttempts],['username',username,limits?.userAttempts??config.usernameAttempts]]) {
      const r = await pool.query(`INSERT INTO auth_login_limits(bucket,window_started_at,attempts) VALUES($1,$2,1)
        ON CONFLICT(bucket) DO UPDATE SET
          attempts = CASE WHEN auth_login_limits.window_started_at <= $3 THEN 1 ELSE auth_login_limits.attempts+1 END,
          window_started_at = CASE WHEN auth_login_limits.window_started_at <= $3 THEN $2 ELSE auth_login_limits.window_started_at END
        RETURNING attempts`, [digest(purpose+':'+scope,key),at,at-windowSeconds]);
      if (r.rows[0].attempts > limit) return false;
    }
    return true;
  }
  async function findUser(username) {
    const r = await pool.query(`SELECT u.*, f.status AS farm_status
      FROM users u LEFT JOIN LATERAL auth_farm_metadata(u.farm_id) f ON true WHERE lower(u.username)=$1`, [username]);
    return r.rows[0] ?? null;
  }
  async function issue(user, previousToken = null) {
    const client = await pool.connect();
    let issued;
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT u.*, f.farm_name, f.business_type, f.status AS farm_status
        FROM users u LEFT JOIN LATERAL auth_farm_metadata(u.farm_id) f ON true
        WHERE u.user_id=$1 AND u.auth_version=$2 AND u.password_hash=$3 AND u.status='active'
          AND (u.role='super_admin' OR f.status='active') FOR UPDATE OF u`, [user.user_id,user.auth_version,user.password_hash]);
      if (!r.rows[0]) { await client.query('ROLLBACK'); return null; }
      const token = randomBytes(32).toString('base64url');
      const at = now();
      if (previousToken) await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest('session',previousToken)]);
      await client.query(`INSERT INTO auth_sessions(token_hash,user_id,auth_version,created_at,last_seen_at,expires_at)
        VALUES($1,$2,$3,$4,$4,$5)`, [digest('session',token),user.user_id,user.auth_version,at,at+config.lifetimeSeconds]);
      await client.query('COMMIT');
      issued = { token, actor: actorFrom(r.rows[0]) };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    if (previousToken) await onRevokeSession(digest('session', previousToken));
    return issued;
  }
  async function resolveToken(token) {
    if (!token) return null;
    const at = now();
    const r = await pool.query(`UPDATE auth_sessions s SET last_seen_at=GREATEST(s.last_seen_at,$2)
      FROM users u LEFT JOIN LATERAL auth_farm_metadata(u.farm_id) f ON true
      WHERE s.token_hash=$1 AND s.user_id=u.user_id AND s.auth_version=u.auth_version
        AND s.expires_at>$2 AND s.last_seen_at>$3 AND u.status='active'
        AND (u.role='super_admin' OR f.status='active')
      RETURNING u.user_id,u.username,u.role,u.farm_id,u.auth_version,f.farm_name,f.business_type,s.token_hash`,
    [digest('session',token),at,at-config.idleSeconds]);
    return r.rows[0] ? actorFrom(r.rows[0]) : null;
  }
  async function revoke(token) {
    if (token) {
      const key = digest('session', token);
      await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [key]);
      await onRevokeSession(key);
    }
  }
  async function changePassword(user, oldHash, newHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(`UPDATE users SET password_hash=$1,auth_version=auth_version+1
        WHERE user_id=$2 AND password_hash=$3 AND auth_version=$4 AND status='active' RETURNING user_id`,
      [newHash,user.userId,oldHash,user.authVersion]);
      if (!changed.rows.length) { await client.query('ROLLBACK'); return false; }
      await client.query('DELETE FROM auth_sessions WHERE user_id=$1',[user.userId]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await onRevokeUser(user.userId);
    return true;
  }
  return { throttle, findUser, issue, resolveToken, revoke, changePassword };
}
