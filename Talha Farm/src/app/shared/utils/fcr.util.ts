// FCR (Feed Conversion Ratio) for the broiler daily health rows in `flock_health`.
//
// The client's own formula is:
//   FCR = [(remaining birds / 1000) x chick weight in grams] / bags of feed used
//
// `avg_weight` is entered in GRAMS, so the `/ 1000` is the gram-to-kilogram
// conversion: it turns the flock into kilograms of live weight, and the result
// reads as kilograms of live weight produced per bag of feed. Do not "simplify"
// that `/ 1000` away — the field is grams, whatever a stale label may say.
//
// The numerator is CUMULATIVE — `avg_weight` is the weight a bird has built up
// over its whole life to that day — so the denominator has to be cumulative too:
// every bag fed from day 1 up to and including that row's day. Feed is entered
// DAILY, so dividing a life-to-date weight by a single day's bags inflates the
// result wildly. That was the bug — and its signature is that the FIRST reading
// of a flock looked right while every later one did not, because on day 1 that
// day's feed IS the cumulative feed.
//
// `flock_health.week_number` is misnamed (see CLAUDE.md): it holds a 1-based DAY
// index. It is the ordering key here — never a row's position in the array,
// since days can be entered out of order and skipped days leave gaps.

//
// The day-index and cumulative-feed arithmetic itself lives in `health-day.util.ts`,
// shared with the layer health screen, which needs the same cumulative window for a
// different numerator. This file is now just the broiler formula on top of it.

import { num, dayIndexOf, cumulativeThroughDay, DayRow } from './health-day.util';

export interface FcrRow extends DayRow {
  week_number?: number | string | null;
  total_birds?: number | string | null;
  mortality?: number | string | null;
  feed_used?: number | string | null;
  avg_weight?: number | string | null;
  fcr?: number | string | null;
  /** 1 when the user typed the FCR by hand; that value is kept, never recomputed. */
  fcr_manual?: number | boolean | null;
}

/** The row's 1-based day index, or null when it has not been filled in yet. */
export function fcrDayIndex(row: FcrRow | null | undefined): number | null {
  return dayIndexOf(row);
}

/** Bags of feed used from day 1 through `day`, inclusive. Summed by day index. */
export function cumulativeFeedThroughDay(rows: FcrRow[], day: number | null): number {
  return cumulativeThroughDay(rows, day, 'feed_used');
}

/**
 * The auto-calculated FCR for one row. `allRows` must be every row of the flock
 * (saved and unsaved), because the denominator is drawn from all of them.
 */
export function computeAutoFcr(row: FcrRow, allRows: FcrRow[]): number {
  const remaining = num(row?.total_birds) - num(row?.mortality);
  const avgWeight = num(row?.avg_weight);                                  // grams
  const feed = cumulativeFeedThroughDay(allRows, fcrDayIndex(row));        // bags
  if (remaining <= 0 || avgWeight <= 0 || feed <= 0) return 0;
  return parseFloat((((remaining / 1000) * avgWeight) / feed).toFixed(3));
}

export function isManualFcr(row: FcrRow | null | undefined): boolean {
  return !!row?.fcr_manual;
}

/**
 * The FCR to display for a saved row. Hand-entered values are shown as entered;
 * every other row is derived on the fly, so editing an earlier day's feed moves
 * every later day's FCR, and so rows saved with the old single-day denominator
 * display correctly without their stored `fcr` being rewritten.
 */
export function displayFcr(row: FcrRow, allRows: FcrRow[]): number {
  return isManualFcr(row) ? num(row.fcr) : computeAutoFcr(row, allRows);
}

/**
 * THE flock's cumulative FCR — the single figure both the Flock Health screen's
 * "Latest FCR" card and the broiler Report's "FCR" card print. One
 * implementation, two readers: a second one would disagree the moment either
 * screen's rows or rounding drifted, which is exactly what CLAUDE.md warns
 * about for any figure shown in two places.
 *
 * It is already cumulative without summing anything here: `avg_weight` is the
 * weight a bird has built up over its whole life to that day and the
 * denominator is every bag fed from day 1 through it, so the HIGHEST qualifying
 * day's FCR *is* the flock's life-to-date ratio.
 *
 * Which row qualifies: the highest DAY INDEX that actually has both a weight
 * and some cumulative feed to derive one from — not the last element of the
 * array, since rows can be entered out of order and a later day can still be
 * missing its figures. Reads `displayFcr`, so a hand-entered FCR is respected
 * here too.
 *
 * `denominatorRows` is the pool the cumulative feed is drawn from, which is NOT
 * always the candidate list: the Flock Health screen passes its saved records as
 * the candidates and saved-plus-editing-plus-pending as the pool, so the card
 * moves as the user types. A screen with only saved rows passes one list and
 * gets the same arithmetic.
 *
 * Null — never 0 — when no row qualifies: a flock with no feed or no weight has
 * no ratio, and 0 would read as a real and very bad one.
 */
export function latestFlockFcr(
  rows: FcrRow[],
  denominatorRows: FcrRow[] = rows
): number | null {
  let bestDay = -Infinity;
  let bestValue: number | null = null;
  for (const row of rows) {
    const day = fcrDayIndex(row);
    if (day === null) continue;
    const hasWeight = Number(row.avg_weight) > 0;
    const hasFeed = cumulativeFeedThroughDay(rows, day) > 0;
    if (hasWeight && hasFeed && day > bestDay) {
      bestDay = day;
      bestValue = displayFcr(row, denominatorRows);
    }
  }
  return bestValue;
}
