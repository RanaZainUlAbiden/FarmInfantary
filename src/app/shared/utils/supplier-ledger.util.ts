/**
 * How a `supplier_ledger` row is classified, in one place.
 *
 * The supplier payable is `SUM(credit - debit)` over this table and nothing
 * else — derived on every read, never stored. These helpers do NOT compute a
 * second opinion on it: they split those same rows into the four buckets that
 * reconcile back to it exactly, so a screen can show "purchased / paid /
 * returned / still owed" without inventing arithmetic of its own.
 *
 *     purchased + otherCharges - paid - returned === SUM(credit - debit)
 *
 * The bucket predicates exist twice on purpose — here, and as SQL in
 * `getAllSuppliersWithBalance()` / `getSupplierPaymentsByAccount()`. Two code
 * paths reach the same figures (the per-supplier list row comes from SQL, the
 * detail view's totals come from the rows already on screen), and this codebase
 * has been bitten by a screen and its resolver running different queries. So
 * the predicates live in ONE function on this side, and
 * `scripts/verify/verify_supplier_tracking.js` asserts the two sides agree on
 * real rows rather than trusting that they look the same.
 *
 * Why the row kinds are what they are, read off the writers rather than
 * assumed:
 *
 *   'purchase'  `addToSupplierLedger()` (purchase-orders.component.ts) mirrors
 *               every order as a credit. A CASH order is one single row
 *               carrying both the credit and an equal debit — so the same row
 *               is both a charge and a payment, and is counted in both.
 *   'return'    `purchase-returns.component.ts` posts a debit with
 *               `reference_type = 'return'`. It reduces the payable, but it is
 *               stock handed back, NOT money paid. Counting it as paid
 *               overstates what the farm paid out by every rupee returned.
 *   'payment'   a Payment Voucher (`voucher_id` set, account on the voucher) or
 *               a manual payment from the Supplier Ledger screen (no account —
 *               Cash). Both are money that left.
 *   'charge'    anything else carrying a credit. Nothing writes one today.
 */

/** A `supplier_ledger` row, as every read of it comes back. */
export interface SupplierLedgerRow {
  debit?: number | null;
  credit?: number | null;
  reference_type?: string | null;
  voucher_id?: number | null;
  payment_source?: string | null;
  bank_id?: number | null;
  bank_name?: string | null;
}

export type SupplierRowKind = 'purchase' | 'return' | 'payment' | 'charge';

const num = (v: any): number => Number(v) || 0;

/**
 * What kind of row this is, off `reference_type` alone.
 *
 * A cash purchase order is 'purchase' even though it also paid: the row is the
 * order, and `paidOf()` below is what notices its debit. Splitting it into two
 * kinds would make it two events on screen when the user raised one.
 */
export function supplierRowKind(row: SupplierLedgerRow | null | undefined): SupplierRowKind {
  const ref = (row?.reference_type || '').toLowerCase();
  if (ref === 'purchase') return 'purchase';
  if (ref === 'return') return 'return';
  if (ref === 'payment') return 'payment';
  return num(row?.credit) > 0 ? 'charge' : 'payment';
}

/** What this row charged: a purchase mirror's credit. */
export function purchasedOf(row: SupplierLedgerRow | null | undefined): number {
  return supplierRowKind(row) === 'purchase' ? num(row?.credit) : 0;
}

/** A credit that is not a purchase mirror. Zero today — see the file comment. */
export function otherChargeOf(row: SupplierLedgerRow | null | undefined): number {
  return supplierRowKind(row) === 'purchase' ? 0 : num(row?.credit);
}

/**
 * Money that actually left the farm on this row.
 *
 * Every debit except a return's — including the debit a cash purchase order
 * carries on its own row, which is the payment that settled it at source.
 */
export function paidOf(row: SupplierLedgerRow | null | undefined): number {
  return supplierRowKind(row) === 'return' ? 0 : num(row?.debit);
}

/** Stock sent back: a debit that reduced the payable without paying anything. */
export function returnedOf(row: SupplierLedgerRow | null | undefined): number {
  return supplierRowKind(row) === 'return' ? num(row?.debit) : 0;
}

/** Does this row record money leaving? Then it belongs in a payment history. */
export function isSupplierPayment(row: SupplierLedgerRow | null | undefined): boolean {
  return paidOf(row) > 0;
}

/** The four buckets plus the payable, summed over a supplier's whole ledger. */
export interface SupplierTotals {
  purchased: number;
  otherCharges: number;
  paid: number;
  returned: number;
  /** `SUM(credit - debit)`, the canonical payable — summed, never reconstructed. */
  outstanding: number;
}

/**
 * Totals over the rows given.
 *
 * `outstanding` is summed straight off `credit - debit` rather than derived
 * from the other four, so the identity the verify script asserts is a real
 * check of the buckets against the payable and not a tautology.
 */
export function supplierTotals(rows: SupplierLedgerRow[] | null | undefined): SupplierTotals {
  const totals: SupplierTotals = {
    purchased: 0, otherCharges: 0, paid: 0, returned: 0, outstanding: 0
  };
  for (const row of (rows || [])) {
    totals.purchased += purchasedOf(row);
    totals.otherCharges += otherChargeOf(row);
    totals.paid += paidOf(row);
    totals.returned += returnedOf(row);
    totals.outstanding += num(row.credit) - num(row.debit);
  }
  return totals;
}

/**
 * How a row reads in a "Type" column.
 *
 * A voucher is named as one because that is where it must be deleted — the
 * Supplier Ledger screen refuses the row (it is one side of a three-part event)
 * and the user needs to be told where to go.
 */
export function supplierRowLabel(row: SupplierLedgerRow | null | undefined): string {
  switch (supplierRowKind(row)) {
    case 'purchase':
      return num(row?.debit) > 0 ? 'Purchase (paid)' : 'Purchase';
    case 'return':
      return 'Return';
    case 'charge':
      return 'Charge';
    default:
      return row?.voucher_id ? 'Payment voucher' : 'Payment';
  }
}
