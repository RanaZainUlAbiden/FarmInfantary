/** One card's worth of grouped rows: a key, a display label, the running total and count. */
export interface GroupSummary<K> {
  key: K;
  label: string;
  total: number;
  count: number;
}

/**
 * Groups `rows` by `keyFn`, summing `amountFn` per group. Used to derive the
 * card-grid summaries (Labour by worker, Distribution Expenses by category)
 * from the same rows already loaded for the flat list — no extra query, no
 * change to what gets written.
 */
export function groupByKey<T, K>(
  rows: T[],
  keyFn: (row: T) => K,
  labelFn: (row: T) => string,
  amountFn: (row: T) => number
): GroupSummary<K>[] {
  const map = new Map<K, GroupSummary<K>>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = map.get(key);
    if (existing) {
      existing.total += amountFn(row) || 0;
      existing.count++;
    } else {
      map.set(key, { key, label: labelFn(row), total: amountFn(row) || 0, count: 1 });
    }
  }
  return Array.from(map.values());
}

/** Newest-first comparator for rows carrying a `date`/`transaction_date` string and an id tiebreaker. */
export function byNewestFirst(dateA: string | null | undefined, dateB: string | null | undefined, idA: number, idB: number): number {
  const cmp = (dateB || '').localeCompare(dateA || '');
  return cmp !== 0 ? cmp : idB - idA;
}
