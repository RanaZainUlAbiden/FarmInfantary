/** Current purchase settlement, derived from the supplier statement.
 * payment_type remains the original payment-at-entry flag used by cash/bank
 * writers. Never change it merely because a later voucher settled an order.
 * Unassigned supplier payments cover oldest claims first (date, then ledger ID).
 * Returns reduce the original claim before allocation, freeing any overpayment
 * for later purchases. No financial row is written by this presentation helper.
 */
export interface PurchaseSettlement {
  settlement_paid: number;
  settlement_credit: number;
  settlement_returned: number;
  settlement_due: number;
  settlement_status: 'Paid' | 'Part paid' | 'Unpaid' | 'Returned' | 'Settled';
}
const cents = (value: unknown): number => Math.max(0, Math.round((Number(value) || 0) * 100));
interface Claim { due: number; paid: number; credit: number; }

export function settledPurchases<T extends { purchase_id: number; supplier_id?: number; total_amount: number; payment_type?: string; date?: string }>(
  purchases: T[], ledger: any[]
): (T & PurchaseSettlement)[] {
  const results = new Map<number, PurchaseSettlement>();
  const suppliers = new Set(purchases.map(p => Number(p.supplier_id) || 0));
  for (const supplier of suppliers) {
    const orders = purchases.filter(p => (Number(p.supplier_id) || 0) === supplier);
    const byId = new Map(orders.map(p => [Number(p.purchase_id), p]));
    const rows = ledger.filter(l => Number(l.supplier_id) === supplier).slice().sort((a,b) =>
      String(a.transaction_date || '').localeCompare(String(b.transaction_date || '')) || Number(a.ledger_id) - Number(b.ledger_id));
    const returned = new Map<number, number>();
    for (const row of rows) if (row.reference_type === 'return' && byId.has(Number(row.reference_id))) {
      const id = Number(row.reference_id);
      returned.set(id, (returned.get(id) || 0) + Math.max(0, cents(row.debit) - cents(row.credit)));
    }
    const claims: Claim[] = [], orderClaims = new Map<number, Claim>();
    const credits: { amount: number; kind: 'paid' | 'credit' }[] = [];
    const apply = (claim: Claim, amount: number, kind: 'paid' | 'credit'): number => {
      const used = Math.min(claim.due, amount); claim.due -= used; claim[kind] += used; return amount - used;
    };
    const distribute = () => {
      for (const claim of claims) while (claim.due > 0 && credits.length) {
        const lot = credits[0]; lot.amount = apply(claim, lot.amount, lot.kind); if (!lot.amount) credits.shift();
      }
    };
    const addOrder = (id: number): Claim => {
      let claim = orderClaims.get(id);
      if (!claim) {
        const order = byId.get(id)!;
        claim = { due: Math.max(0, cents(order.total_amount) - (returned.get(id) || 0)), paid: 0, credit: 0 };
        orderClaims.set(id, claim); claims.push(claim);
      }
      return claim;
    };
    for (const row of rows) {
      const id = Number(row.reference_id), debit = cents(row.debit), credit = cents(row.credit);
      if (row.reference_type === 'return') {
        if (!byId.has(id) && debit > credit) credits.push({ amount: debit - credit, kind: 'credit' });
        distribute(); continue;
      }
      if (row.reference_type === 'purchase' && byId.has(id)) {
        const claim = addOrder(id);
        // A paid-at-entry order pays its own claim before any older debt.
        const excess = apply(claim, debit, 'paid');
        if (excess) credits.push({ amount: excess, kind: 'paid' });
      } else {
        if (credit) claims.push({ due: credit, paid: 0, credit: 0 });
        if (debit) credits.push({ amount: debit, kind: 'paid' });
      }
      distribute();
    }
    // Legacy orders without a mirror remain visible. An upfront cash flag is
    // historical payment evidence, never a new supplier payment or bank write.
    for (const order of orders.slice().sort((a,b) => String(a.date || '').localeCompare(String(b.date || '')) || a.purchase_id-b.purchase_id)) {
      const id = Number(order.purchase_id), missing = !orderClaims.has(id), claim = addOrder(id);
      if (missing && order.payment_type === 'cash') apply(claim, claim.due, 'paid');
      distribute();
      const ret = Math.min(cents(order.total_amount), returned.get(id) || 0);
      const status = claim.due ? (claim.paid || claim.credit ? 'Part paid' : 'Unpaid') :
        ret === cents(order.total_amount) && ret > 0 ? 'Returned' : claim.credit ? 'Settled' : 'Paid';
      results.set(id, { settlement_paid: claim.paid/100, settlement_credit: claim.credit/100,
        settlement_returned: ret/100, settlement_due: claim.due/100, settlement_status: status });
    }
  }
  return purchases.map(p => ({ ...p, ...results.get(Number(p.purchase_id))! }));
}
