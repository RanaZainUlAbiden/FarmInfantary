/**
 * Browser-side paging for a long table.
 *
 * Only what is DRAWN is limited. The list it is given is still the full result,
 * so totals, running balances and PDF exports computed from that list stay
 * correct. One pager per table: `*ngFor="let x of pager.view(items)"`, then
 * `<app-pagination [currentPage]="pager.currentPage" [totalItems]="pager.total"
 * [pageSize]="pager.size" (pageChange)="pager.page = $event">` after the table.
 */
export class ListPager {
  page = 1;
  /** Set by the last `view()`, so the pagination bar needs no second pass over the list. */
  total = 0;
  currentPage = 1;

  constructor(readonly size = 50) {}

  view<T>(items: readonly T[] | null | undefined): T[] {
    const list = items ?? [];
    this.total = list.length;
    // A shrinking list (a filter, a deleted row) never leaves you on an empty page.
    this.currentPage = Math.min(Math.max(1, this.page), Math.max(1, Math.ceil(list.length / this.size)));
    const start = (this.currentPage - 1) * this.size;
    return list.slice(start, start + this.size);
  }
}
