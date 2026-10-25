/**
 * `bills` holds TWO kinds of row now, and almost every reader wants only one.
 *
 * A DISTRIBUTION bill (`source` NULL or 'distribution') is what Sales Orders
 * writes: a sale out of distribution's stock, with `bill_items`, stock
 * deductions and a place in the Distribution report's revenue.
 *
 * A LAYER-SALE bill (`source` = 'egg_sale' or 'hen_sale') is a RECEIVABLE and
 * nothing else. An unpaid egg or hen sale needs the customer to carry the debt
 * until they settle, and in this app a customer's balance IS
 * `Σ MAX(bills.total_amount − bills.amount_paid, 0)` — `customers.
 * outstanding_balance`, the Customer Ledger screen, the Receive Voucher
 * screen and `customerSettlementOps()` all derive from that one expression. So
 * the receivable has to be a bill; a bare `customer_ledger` debit would show
 * on the statement, move no balance, and be unsettleable, because the
 * settlement allocates across unpaid BILLS.
 *
 * What a layer-sale bill is NOT is distribution revenue. The sale already
 * books its own revenue in the layer module through the daily `income` mirror
 * (`source` = 'egg_sale' / 'hen_sale'), so a reader that counted the bill too
 * would report the same money twice. It also has no `bill_items`, no stock
 * movement and nothing to return, so it must stay out of Sales Orders and
 * Sales Returns, where editing it would rewrite it as a distribution bill.
 *
 * THE SPLIT, and which side each reader is on:
 *
 *   DISTRIBUTION ONLY — use `distributionBillsOnly()`:
 *     sales-orders (its list, and therefore its edit and delete paths)
 *     sales-returns (the bill picker)
 *     distribution-report (revenue, outstanding, every bill figure)
 *     overview.service (all four bill queries)
 *
 *   BOTH KINDS, deliberately — the debt is the debt whoever raised it:
 *     customer-ledger (the statement, and where it is settled)
 *     receive-voucher / internal-settlement (the outstanding they offer)
 *     database.service: rebuildCustomerBalanceOp, getUnpaidBills,
 *       customerSettlementOps, customerUnwindOps, getAllCustomersWithBalance
 *     cash-position.service (`bills.amount_paid` is money received whoever
 *       raised the bill — an egg sale collected on credit is cash in hand
 *       exactly as a distribution bill is)
 *
 * `farm-report.service.ts` needs no filter: it already demands
 * `payment_type = 'internal'` AND `customer_type = 'own_farm'`, and a
 * layer-sale bill is neither.
 *
 * Written once here rather than spelled out in each of the seven places,
 * because a filter that has to appear in seven queries is exactly the kind
 * that gets forgotten in the eighth — and a forgotten one double-counts
 * revenue with nothing on screen to say why.
 * `scripts/verify/verify_layer_sales_customers.js` checks every `FROM bills`
 * reader in `src/` against the two lists above.
 */

/** Rows Sales Orders wrote: the only kind that is distribution's own sale. */
export const DISTRIBUTION_BILL_SOURCE = 'distribution';

/** What a layer-sale receivable carries in `bills.source`, by screen. */
export const LAYER_BILL_SOURCES = ['egg_sale', 'hen_sale'] as const;
export type LayerBillSource = typeof LAYER_BILL_SOURCES[number];

/**
 * The WHERE fragment that keeps layer-sale receivables out of a distribution
 * query. `alias` is the table alias in the caller's statement ('' for none).
 *
 * COALESCE, not `= 'distribution'`: every bill written before this column
 * existed has it NULL, and those are all distribution bills. A strict
 * comparison would drop every historical bill from every report.
 */
export function distributionBillsOnly(alias: string = ''): string {
  const col = alias ? `${alias}.source` : 'source';
  return `COALESCE(${col}, '${DISTRIBUTION_BILL_SOURCE}') = '${DISTRIBUTION_BILL_SOURCE}'`;
}

/** Is this bill row a layer-sale receivable rather than a distribution sale? */
export function isLayerSaleBill(bill: { source?: string | null } | null | undefined): boolean {
  return !!bill && (LAYER_BILL_SOURCES as readonly string[]).includes(String(bill.source));
}
