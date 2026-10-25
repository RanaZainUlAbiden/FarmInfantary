/**
 * A From/To filter over rows that carry a stored date, for the Customer and
 * Supplier Ledger statements.
 *
 * WHAT IT FILTERS, AND WHAT IT MUST NOT. It narrows the LIST OF ROWS and
 * nothing else. Every summary figure on those screens — Total Purchased, Total
 * Paid, Returned, and above all the payable or the outstanding balance — goes
 * on being read over the full history, because:
 *
 *   - A payable is what is owed NOW, not a flow across a window. The
 *     Distribution report's two outstanding cards sit outside its date filter
 *     for exactly this reason, and a supplier's payable is
 *     `SUM(credit - debit)` over the WHOLE ledger with nothing else behind it,
 *     so a filtered sum would simply be a different quantity wearing the same
 *     label.
 *   - The Supplier Ledger's summary block is an identity:
 *     Purchased + Other Charges - Paid - Returned = Total Payable. Filtering
 *     the four terms but not the payable would break it on screen; filtering
 *     all five would print a "payable" the client cannot reconcile against
 *     what the supplier actually says he is owed.
 *
 * The `balance` column on each row is likewise untouched: it is computed in
 * SQL as the running total over every earlier row, so a row keeps showing the
 * true balance as at its own date even when the rows before it are hidden.
 * That is what makes a printed period statement correct rather than merely
 * plausible.
 *
 * Dates are compared as `YYYY-MM-DD` STRINGS, never as `Date` objects. Every
 * date in this database is stored in that form by `toLocalDateString()`, and
 * lexicographic order on it is chronological order — so this needs no parsing,
 * no timezone and no DST reasoning, which is the whole class of bug
 * `toLocalDateString()` exists to avoid. A value that carries a time
 * (`2026-10-24T18:30:00`) still compares correctly on its leading 10
 * characters, which is why the day is sliced off rather than the string used
 * whole: `'2026-10-24T18:30' <= '2026-10-24'` is false, and a row dated on the
 * To day would otherwise drop out of its own range.
 */

/** The `YYYY-MM-DD` day of a stored date, however it was stored. */
export function dayOf(value: any): string {
  if (!value) return '';
  return String(value).split('T')[0].split(' ')[0];
}

/**
 * Is this row's date within [from, to]? Both bounds are INCLUSIVE, and either
 * may be empty, which drops that side of the comparison — so an empty pair
 * admits everything and the unfiltered screen behaves exactly as before.
 *
 * A row with no date at all is kept: it cannot be shown to be outside the
 * range, and hiding it would make a statement silently incomplete.
 */
export function inDateRange(value: any, from?: string | null, to?: string | null): boolean {
  const day = dayOf(value);
  if (!day) return true;
  if (from && day < dayOf(from)) return false;
  if (to && day > dayOf(to)) return false;
  return true;
}

/** The rows of `rows` whose `key` date falls in [from, to], in their original order. */
export function filterByDateRange<T>(
  rows: T[],
  key: keyof T & string,
  from?: string | null,
  to?: string | null
): T[] {
  if (!from && !to) return rows;
  return rows.filter(row => inDateRange((row as any)[key], from, to));
}

/**
 * How the active range reads on screen and in a printed heading, or '' when
 * nothing is filtered. Dates are shown as stored — `YYYY-MM-DD`, the form the
 * inputs themselves use — so the label cannot disagree with the controls.
 */
export function dateRangeLabel(from?: string | null, to?: string | null): string {
  const f = dayOf(from);
  const t = dayOf(to);
  if (f && t) return `${f} to ${t}`;
  if (f) return `from ${f}`;
  if (t) return `up to ${t}`;
  return '';
}
