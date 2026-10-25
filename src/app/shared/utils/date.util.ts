// Local-date formatting for date inputs and DB storage. `toISOString()`
// converts to UTC, which for PKT (UTC+5) shifts any local time before 05:00
// onto the previous day — always build the date string from local
// getFullYear/getMonth/getDate instead.
export function toLocalDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The `YYYY-MM-DD` head of a stored date, or null if there isn't one. Dates in this
 * database are mostly date-only strings, but a few paths have written a full
 * timestamp; both need to compare and subtract the same way.
 */
function dateParts(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return [y, m, d];
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`. Null if either is unparseable.
 *
 * Anchored on Date.UTC rather than local Date objects deliberately: the arithmetic
 * is then exact whole days and cannot be knocked off by one by a DST boundary
 * falling between the two dates. It is date arithmetic, not clock arithmetic — no
 * value here is ever converted back through toISOString().
 */
export function daysBetween(from: string, to: string): number | null {
  const a = dateParts(from);
  const b = dateParts(to);
  if (!a || !b) return null;
  const MS_PER_DAY = 86400000;
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / MS_PER_DAY);
}

/** `date` shifted by `days`, as a `YYYY-MM-DD` string. Null if `date` is unparseable. */
export function addDays(date: string, days: number): string | null {
  const parts = dateParts(date);
  if (!parts) return null;
  const shifted = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
