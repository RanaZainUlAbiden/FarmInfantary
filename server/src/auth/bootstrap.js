import { hashPassword } from './password.js';
import { normalizeUsername } from './store.js';

/** One-time, direct database bootstrap. No public HTTP endpoint or defaults. */
export async function bootstrapSuperAdmin(pool, username, password) {
  const name = normalizeUsername(username);
  if (!name) throw new Error('Set a username of 3–64 letters, digits, dots, underscores or hyphens.');
  const hash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':super-admin-bootstrap'))");
    if ((await client.query("SELECT 1 FROM users WHERE role='super_admin' LIMIT 1")).rowCount) {
      throw new Error('A super admin already exists. Bootstrap will not replace credentials or add another.');
    }
    const result = await client.query("INSERT INTO users(username,password_hash,role) VALUES($1,$2,'super_admin') RETURNING user_id",[name,hash]);
    await client.query('COMMIT'); return result.rows[0].user_id;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
