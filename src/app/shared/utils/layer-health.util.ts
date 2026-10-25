// Feed efficiency for LAYER batches.
//
// Broiler FCR — kilograms of live weight grown per bag of feed — is meaningless
// here. A layer's body weight is essentially flat after point of lay, so dividing it
// by an ever-growing pile of feed produces a number that falls every single day and
// says nothing about how the batch is performing. Layers are measured on how much
// feed it takes to produce eggs.
//
// The metric below is therefore NOT an FCR and is never labelled as one. It is
// "Feed / Dozen": kilograms of feed per dozen eggs, the standard layer figure,
// typically 1.5–2.0 kg/dozen for a healthy batch (lower is better).
//
//   cumFeedBags(D) = sum of feed_used over layer_health rows with day_number <= D
//   cumEggs(D)     = sum of total_eggs over egg_collection rows dated on or before
//                    the calendar day D falls on
//
//   FeedPerDozen(D) = (cumFeedBags(D) x BAG_WEIGHT_KG) / (cumEggs(D) / 12)
//
// Both sides are cumulative over the SAME window, for the same reason broiler FCR
// is: feed is entered daily, eggs are collected daily, and a ratio of one day's feed
// to one day's eggs swings wildly on nothing more than when a feed bag was opened.
//
// Returns null — rendered as a dash, never as a number — whenever either side of the
// window is empty. A batch before point of lay has feed and no eggs; showing "0" or
// a huge figure there would read as a real measurement of a batch that simply is not
// laying yet.

import { toLocalDateString, daysBetween, addDays } from './date.util';

/**
 * Feed is entered in BAGS everywhere in this app, and nothing in the schema records
 * what a bag weighs. Bags per dozen would read ~0.03 and be useless to the client, so
 * it is converted here to the kg/dozen figure the industry quotes. 50 kg is the
 * standard local feed bag — this constant is the single place to change if it isn't.
 */
export const BAG_WEIGHT_KG = 50;

export const EGGS_PER_DOZEN = 12;

/**
 * Kilograms of feed per dozen eggs over a cumulative window, or null when the window
 * has no feed or no eggs in it and any number would be a fiction.
 */
export function feedPerDozenEggs(
  cumulativeFeedBags: number,
  cumulativeEggs: number
): number | null {
  if (!(cumulativeFeedBags > 0) || !(cumulativeEggs > 0)) return null;
  const kg = cumulativeFeedBags * BAG_WEIGHT_KG;
  const dozens = cumulativeEggs / EGGS_PER_DOZEN;
  return parseFloat((kg / dozens).toFixed(3));
}

/**
 * The 1-based day index a calendar date falls on for a batch — day 1 is the batch's
 * start date. Floored at 1, so an entry backdated before the batch started still
 * lands on a real day rather than a zero or negative index that would sort ahead of
 * everything and break the cumulative window.
 */
export function dayNumberFor(batchStartDate: string, date: string): number {
  const diff = daysBetween(batchStartDate, date);
  if (diff === null) return 1;
  return Math.max(1, diff + 1);
}

/** The calendar date a 1-based day index falls on. Falls back to today if unparseable. */
export function dateForDayNumber(batchStartDate: string, day: number): string {
  return addDays(batchStartDate, Math.max(0, day - 1)) ?? toLocalDateString();
}
