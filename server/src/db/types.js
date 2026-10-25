/**
 * Makes node-postgres hand back JavaScript NUMBERS for integer columns.
 *
 * THE PROBLEM
 * -----------
 * SQLite `INTEGER` is 64-bit, so the generated schema maps it to `bigint`.
 * node-postgres returns `bigint` (and `numeric`) as STRINGS, because they can
 * hold values JavaScript's Number cannot represent exactly.
 *
 * That is 214 of the schema's 555 columns — every id, every integer quantity
 * (`total_birds`, `mortality`, `total_eggs`, `initial_birds`, `quantity`), and
 * every flag (`done`, `is_active`, `fcr_manual`).
 *
 * Without this, the app breaks in two ways that do not raise an error:
 *
 *   row.total_birds + row.mortality   ->  "4242"   (concatenation)
 *   row.flock_id === currentFlock.flock_id  ->  false  ("3" !== 3)
 *
 * The second is the nastier one. Every screen scopes its data by comparing an
 * id from the database against an id held in localStorage, and a strict
 * comparison between a string and a number is silently false — so a screen
 * shows nothing, or worse, a filter that should exclude a row does not.
 *
 * This is the same class of defect as D4 (money as `numeric`), but across more
 * than twice as many columns.
 *
 * THE FIX, AND ITS LIMIT
 * ----------------------
 * Parse int8 as a Number. These are row ids and farm counts: the largest value
 * any of them will ever hold is many orders of magnitude below
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991).
 *
 * But "will never happen" is not "cannot happen", and silently rounding an id
 * would be exactly the kind of invisible corruption this file exists to
 * prevent. So a value beyond the safe range THROWS rather than returning an
 * approximation. If that ever fires, the answer is a deliberate decision about
 * big ids, not a quieter parser.
 */

const INT8 = 20;      // bigint
const NUMERIC = 1700; // see D4 — the schema has none, this is a tripwire

let registered = false;

/**
 * @param {{ types: { setTypeParser: Function, getTypeParser?: Function } }} pg
 */
export function registerTypeParsers(pg) {
  if (registered) return;

  pg.types.setTypeParser(INT8, (value) => {
    if (value === null) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `A bigint value (${value}) is outside JavaScript's safe integer range. ` +
        `Returning it as a Number would silently change it. See server/src/db/types.js.`
      );
    }
    return n;
  });

  // The schema should contain no `numeric` columns at all (D4). If one ever
  // appears, this makes it behave like every other number rather than becoming
  // a string that concatenates — but verify_money_types_pg.mjs still fails the
  // build, because the right fix is the column type, not the parser.
  pg.types.setTypeParser(NUMERIC, (value) => (value === null ? null : Number(value)));

  registered = true;
}

/** Test seam: lets a test re-register against a fresh stub. */
export function resetTypeParsersForTests() {
  registered = false;
}
