/**
 * `lastId` — the id of the row an INSERT just created.
 *
 * 341 call sites take an inserted id from the `run()` result. On the desktop
 * this came from `last_insert_rowid()` with a `MAX(pk)` fallback driven by a
 * hand-maintained `PRIMARY_KEY_MAP`, and a table missing from that map returned
 * `lastId: null` — which does not throw. It gets written into a foreign key
 * column and the row is quietly orphaned.
 *
 * PostgreSQL has no `last_insert_rowid()`, so `RETURNING <pk>` is the only
 * mechanism. That makes the map load-bearing rather than a fallback.
 *
 * SO WE DO NOT MAINTAIN A MAP.
 *
 * The primary keys are read from the catalogue at startup. A hand-written map
 * can drift from the schema; a catalogue read cannot. This removes the landmine
 * structurally instead of guarding it with a test — though
 * scripts/verify/verify_primary_keys.js still checks the desktop map, because
 * the frozen reference app continues to rely on it.
 */

import { codeMask } from './scan.js';

/**
 * Single-column primary keys, by table.
 *
 * Composite keys (`app_settings`) and non-integer keys (`activation.machine_id`)
 * are deliberately absent: there is no generated id to hand back for either.
 *
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<{rows: any[]}> }} client
 * @returns {Promise<Map<string, string>>}
 */
export async function loadPrimaryKeys(client) {
  const { rows } = await client.query(`
    SELECT c.relname       AS table_name,
           a.attname       AS column_name,
           format_type(a.atttypid, NULL) AS column_type,
           count(*) OVER (PARTITION BY c.relname) AS key_columns
      FROM pg_index i
      JOIN pg_class c     ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE i.indisprimary
       AND n.nspname = 'public'
       AND c.relkind = 'r'`);

  const map = new Map();
  for (const r of rows) {
    if (Number(r.key_columns) !== 1) continue;            // composite
    if (!/^(bigint|integer|smallint)$/.test(r.column_type)) continue; // text key
    map.set(r.table_name, r.column_name);
  }
  return map;
}

/**
 * The table an INSERT targets, or null when the statement is not an INSERT.
 * Matches against the real SQL but only where the scanner says it is code, so
 * the word INSERT inside a string literal is not mistaken for a statement.
 *
 * @param {string} sql
 * @returns {string | null}
 */
export function insertTarget(sql) {
  const mask = codeMask(sql);
  const re = /\bINSERT\s+INTO\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
  let m;
  while ((m = re.exec(sql))) {
    if (!mask[m.index]) continue;
    return (m[1] ?? m[2]).toLowerCase();
  }
  return null;
}

/** True when the statement already ends with its own RETURNING clause. */
export function hasReturning(sql) {
  const mask = codeMask(sql);
  const re = /\bRETURNING\b/gi;
  let m;
  while ((m = re.exec(sql))) if (mask[m.index]) return true;
  return false;
}

/**
 * Appends `RETURNING <pk>` to an INSERT so the driver hands back the new id.
 *
 * Returns the statement unchanged when it is not an INSERT, already has a
 * RETURNING clause, or targets a table with no single-column integer key —
 * those last are `app_settings` (composite) and `activation` (text key), and
 * neither has an id to return.
 *
 * @param {string} sql
 * @param {Map<string, string>} primaryKeys
 * @returns {{ text: string, idColumn: string | null, table: string | null }}
 */
export function withReturning(sql, primaryKeys) {
  const table = insertTarget(sql);
  if (!table) return { text: sql, idColumn: null, table: null };
  if (hasReturning(sql)) return { text: sql, idColumn: null, table };

  const pk = primaryKeys.get(table);
  if (!pk) return { text: sql, idColumn: null, table };

  const text = sql.replace(/;?\s*$/, '') + ` RETURNING "${pk}"`;
  return { text, idColumn: pk, table };
}

/**
 * Pulls the id out of a driver result.
 *
 * Null when nothing came back, which is correct and not an error: an
 * `INSERT .. ON CONFLICT DO NOTHING` that conflicted inserted no row, so there
 * is no id to report.
 */
export function extractLastId(result, idColumn) {
  if (!idColumn) return null;
  const row = result?.rows?.[0];
  if (!row) return null;
  const v = row[idColumn];
  return v === undefined ? null : v;
}

/**
 * Does this INSERT supply the table's own primary key?
 *
 * SQLite and PostgreSQL disagree about what that means for the next generated
 * id, and the difference is silent until it bites:
 *
 *   SQLite      INSERT (id, v) VALUES (900,..) advances AUTOINCREMENT, so the
 *               next generated id is 901.
 *   PostgreSQL  an identity column's sequence knows nothing about an explicit
 *               insert, so the next generated id is still 2 — and will keep
 *               colliding until the sequence catches up.
 *
 * The app never does this today (checked: zero INSERTs name their own primary
 * key), but test fixtures do, and one added later would desync a sequence and
 * produce duplicate-key errors a long way from the cause.
 *
 * Callers use this to resync the sequence afterwards, which reproduces the
 * SQLite behaviour exactly. The cost is one extra statement, and only on the
 * inserts that actually supply an id.
 */
export function insertsExplicitPk(sql, table, pk) {
  if (!table || !pk) return false;
  const mask = codeMask(sql);
  const re = /\bINSERT\s+INTO\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(sql))) {
    if (!mask[m.index]) continue;
    return m[1]
      .split(',')
      .map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase())
      .includes(pk.toLowerCase());
  }
  return false;
}

/** SQL that pushes a table's identity sequence past its current maximum id. */
export function resyncSequenceSql(table, pk) {
  return `SELECT setval(
            pg_get_serial_sequence('${table}', '${pk}'),
            GREATEST((SELECT COALESCE(MAX("${pk}"), 0) FROM "${table}"), 1),
            true)`;
}
