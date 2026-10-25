// Day-index and cumulative-window helpers shared by the two daily health screens:
// broiler `flock_health` and layer `layer_health`.
//
// Both tables are a list of rows carrying a 1-based DAY index and that day's feed.
// The column names differ only for historical reasons — broiler holds the day in
// the misnamed `week_number` (see CLAUDE.md), layer in `day_number` — so everything
// here reads whichever is present and neither screen needs its own copy of the
// arithmetic.
//
// Two rules are encoded here rather than left to each caller, because getting either
// wrong has already produced a live bug:
//
//   * The next day index comes from MAX(day) over every row, never from the number
//     of rows. Deleting a row does not renumber the ones after it, so a count
//     collides with a day index that is still in use.
//   * Any metric divided by feed uses feed CUMULATIVE from day 1 through that row's
//     day. Feed is entered daily while the things measured against it (body weight,
//     eggs laid) accumulate over the bird's life, so a single day's figure inflates
//     the result wildly — and looks correct on day 1, where the two coincide.

export interface DayRow {
  /** Broiler's day index, misnamed. */
  week_number?: number | string | null;
  /** Layer's day index. */
  day_number?: number | string | null;
  feed_used?: number | string | null;
  [key: string]: any;
}

export function num(value: any): number {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** The row's 1-based day index, or null when it has not been filled in yet. */
export function dayIndexOf(row: DayRow | null | undefined): number | null {
  const raw = row?.week_number ?? row?.day_number;
  const n = typeof raw === 'number' ? raw : parseFloat(raw as any);
  return Number.isFinite(n) ? n : null;
}

/**
 * Highest day index across every list given — saved rows, unsaved rows, whatever
 * else is in play. 0 when nothing has a day yet, so `maxDayIndex(...) + 1` is the
 * next day to use. Never derive that from a row count.
 */
export function maxDayIndex(...rowLists: (DayRow[] | null | undefined)[]): number {
  let max = 0;
  for (const rows of rowLists) {
    if (!rows) continue;
    for (const row of rows) {
      const day = dayIndexOf(row);
      if (day !== null && day > max) max = day;
    }
  }
  return max;
}

/** Sum of `field` over every row from day 1 through `day`, inclusive. */
export function cumulativeThroughDay(
  rows: DayRow[],
  day: number | null,
  field: string = 'feed_used'
): number {
  if (day === null) return 0;
  let total = 0;
  for (const row of rows) {
    const rowDay = dayIndexOf(row);
    if (rowDay !== null && rowDay <= day) total += num(row[field]);
  }
  return total;
}

/**
 * A reusable lookup for the same cumulative sum, built once in O(n log n) and then
 * answered in O(log n) per query.
 *
 * `cumulativeThroughDay` re-scans every row on each call, which is fine for a broiler
 * flock's ~42 rows but not for a layer batch's 500+: the table asks for a cumulative
 * figure per visible row, on every change-detection pass. Same numbers, without the
 * quadratic scan.
 */
export function cumulativeLookup(
  rows: DayRow[],
  field: string = 'feed_used'
): (day: number | null) => number {
  const byDay = new Map<number, number>();
  for (const row of rows) {
    const day = dayIndexOf(row);
    if (day === null) continue;
    byDay.set(day, (byDay.get(day) || 0) + num(row[field]));
  }

  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  const totals: number[] = [];
  let running = 0;
  for (const day of days) {
    running += byDay.get(day) as number;
    totals.push(running);
  }

  return (day: number | null): number => {
    if (day === null || days.length === 0 || day < days[0]) return 0;
    // Rightmost day <= the one asked for.
    let lo = 0;
    let hi = days.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (days[mid] <= day) lo = mid;
      else hi = mid - 1;
    }
    return totals[lo];
  };
}
