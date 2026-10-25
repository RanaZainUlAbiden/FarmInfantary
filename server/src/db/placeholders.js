/**
 * `?` -> `$1 .. $n`.
 *
 * The app writes SQLite-style positional placeholders in 341 call sites and
 * passes values in a params array. PostgreSQL numbers them. This rewrite
 * happens ONCE here, at the boundary, which is why no component changes.
 *
 * Only code regions are touched (see scan.js): a `?` inside a string literal
 * is the user's text, and renumbering it corrupts data.
 *
 * Ordering is positional, left to right, exactly as SQLite binds them — so the
 * params array carries over untouched. That matters more than it looks: the
 * desktop code has queries whose `?` appears textually BEFORE the one it reads
 * as "the outer" parameter, inside a correlated subquery, and the params array
 * is built in that textual order. One of the verify scripts exists purely
 * because getting that order wrong returns wrong money without failing.
 */

import { mapCode } from './scan.js';

/**
 * @param {string} sql
 * @returns {{ text: string, count: number }}
 */
export function toNumberedPlaceholders(sql) {
  let count = 0;
  const text = mapCode(sql, (code) => code.replace(/\?/g, () => `$${++count}`));
  return { text, count };
}

/**
 * Rewrites and checks the params array length in one step, because a mismatch
 * between placeholders and params is the kind of thing that throws a confusing
 * driver error ("bind message supplies 3 parameters, but prepared statement
 * requires 4") a long way from its cause.
 *
 * @param {string} sql
 * @param {unknown[]} params
 */
export function prepare(sql, params = []) {
  const { text, count } = toNumberedPlaceholders(sql);
  if (count !== params.length) {
    throw new Error(
      `SQL expects ${count} parameter${count === 1 ? '' : 's'} but ${params.length} ` +
      `${params.length === 1 ? 'was' : 'were'} supplied.\n  ${sql.trim().slice(0, 200)}`
    );
  }
  return { text, values: params };
}
