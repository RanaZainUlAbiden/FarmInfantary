import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { distributionBillsOnly } from '../shared/utils/bill-source.util';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles, getTableRightEdge } from '../shared/utils/pdf-table.util';
import { paymentSourceLabel } from '../shared/utils/bank-source.util';
import { CashPositionService, CashPosition } from '../shared/services/cash-position.service';

import { printPdfBase64 } from '../shared/utils/browser-print.util';
/**
 * What one bill's goods actually cost, split so the report can be honest about
 * how much of the number is measured and how much is estimated.
 */
interface BillCost {
  /** Purchase cost of the goods that left stock on this bill. */
  cogs: number;
  /** Units inside `cogs` priced from a fallback rate, not from their own batch. */
  estimatedUnits: number;
  /** The portion of `cogs` those units contributed. */
  estimatedCost: number;
  /** Units with no cost source anywhere — they contribute 0 and are warned about. */
  unpricedUnits: number;
}

@Component({
  selector: 'app-distribution-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './distribution-report.component.html',
  styleUrl: './distribution-report.component.scss'
})
export class DistributionReportComponent implements OnInit {
  currentFarm: any = null;
  products: any[] = [];
  purchases: any[] = [];
  sales: any[] = [];
  salesReturns: any[] = [];
  purchaseReturns: any[] = [];
  expenses: any[] = [];
  customers: any[] = [];

  /**
   * Cash in hand and total bank balance, as at today. Loaded alongside
   * everything else and read through the two getters below; null until the
   * first load resolves, which is why both getters default to 0.
   */
  cashPosition: CashPosition | null = null;

  /** Per-supplier purchased / paid / returned / payable, all off supplier_ledger. */
  supplierBalances: any[] = [];
  /** What was paid to suppliers, split by the account it came out of. */
  supplierPaymentAccounts: any[] = [];
  isGenerating = false;
  isLoading = true;
  errorMessage = '';

  /**
   * Distribution's own carried-forward opening balance — the same idea as
   * `farm_units.opening_balance`, but distribution is one business per
   * account, not a farm_units row, so it lives in `app_settings` under the
   * key `distribution_opening_balance` instead. Entered by hand here, never
   * app-calculated. See `openingBalanceLabel` and `totalWithOpeningBalance`.
   */
  distributionOpeningBalance = 0;
  isEditingOpeningBalance = false;
  openingBalanceInput: number | null = 0;
  isSavingOpeningBalance = false;

  readonly openingBalanceLabel =
    'A fixed starting figure carried forward from your previous system, not something this app ' +
    'calculated. It has no date of its own, so it is included here regardless of the date filter ' +
    'above, and is kept separate from the profit/loss this app calculated for the period.';

  /** `totalProfitLoss + distributionOpeningBalance` — the only place the two are combined. */
  get totalWithOpeningBalance(): number {
    return this.totalProfitLoss + this.distributionOpeningBalance;
  }

  /** bill_id -> cost of goods sold on that bill. Built by `loadCostOfGoods()`. */
  private billCosts = new Map<number, BillCost>();
  /** Data-quality notes about the COGS figure, surfaced in the UI and the PDF. */
  cogsWarnings: string[] = [];

  // Features
  sections = {
    inventory: true,
    purchases: true,
    purchaseReturns: true,
    sales: true,
    returns: true,
    expenses: true,
    supplierPayables: true,
    summary: true
  };

  dateFrom: string = '';
  dateTo: string = '';

  // ── CALCULATIONS ──────────────────────────────────────────

  /**
   * Inventory Value — what the stock still on hand cost to buy.
   *
   * Valued from `product_batches.purchase_price` (the price actually paid for
   * that batch), not from `products.cost_price`, so it is measured on the same
   * basis as COGS: every unit is worth what it cost, whether it has sold yet or
   * not. Units sitting in a batch with no recorded price fall back to the same
   * rate `costOfGoodsSold` uses — see `loadCostOfGoods()`.
   *
   * This is the counterweight to `totalPurchases`. Purchases that have not sold
   * yet are not a loss; they are here, as stock the owner still holds.
   */
  get totalInventoryValue(): number {
    return this.products.reduce((sum: number, p: any) => sum + (Number(p.inventory_value) || 0), 0);
  }

  get filteredPurchases(): any[] {
    if (!this.dateFrom && !this.dateTo) return this.purchases;
    return this.purchases.filter((p: any) => {
      const date = p.date ? new Date(p.date).setHours(0, 0, 0, 0) : null;
      if (!date) return false;
      const from = this.dateFrom ? new Date(this.dateFrom).setHours(0, 0, 0, 0) : null;
      const to = this.dateTo ? new Date(this.dateTo).setHours(0, 0, 0, 0) : null;
      if (from && to) return date >= from && date <= to;
      if (from) return date >= from;
      if (to) return date <= to;
      return true;
    });
  }

  get filteredSales(): any[] {
    if (!this.dateFrom && !this.dateTo) return this.sales;
    return this.sales.filter((s: any) => {
      const date = s.bill_date ? new Date(s.bill_date).setHours(0, 0, 0, 0) : null;
      if (!date) return false;
      const from = this.dateFrom ? new Date(this.dateFrom).setHours(0, 0, 0, 0) : null;
      const to = this.dateTo ? new Date(this.dateTo).setHours(0, 0, 0, 0) : null;
      if (from && to) return date >= from && date <= to;
      if (from) return date >= from;
      if (to) return date <= to;
      return true;
    });
  }

  get filteredReturns(): any[] {
    if (!this.dateFrom && !this.dateTo) return this.salesReturns;
    return this.salesReturns.filter((r: any) => {
      const date = r.return_date ? new Date(r.return_date).setHours(0, 0, 0, 0) : null;
      if (!date) return false;
      const from = this.dateFrom ? new Date(this.dateFrom).setHours(0, 0, 0, 0) : null;
      const to = this.dateTo ? new Date(this.dateTo).setHours(0, 0, 0, 0) : null;
      if (from && to) return date >= from && date <= to;
      if (from) return date >= from;
      if (to) return date <= to;
      return true;
    });
  }

  get filteredPurchaseReturns(): any[] {
    if (!this.dateFrom && !this.dateTo) return this.purchaseReturns;
    return this.purchaseReturns.filter((r: any) => {
      const date = r.return_date ? new Date(r.return_date).setHours(0, 0, 0, 0) : null;
      if (!date) return false;
      const from = this.dateFrom ? new Date(this.dateFrom).setHours(0, 0, 0, 0) : null;
      const to = this.dateTo ? new Date(this.dateTo).setHours(0, 0, 0, 0) : null;
      if (from && to) return date >= from && date <= to;
      if (from) return date >= from;
      if (to) return date <= to;
      return true;
    });
  }

  get totalPurchaseReturns(): number {
    return this.filteredPurchaseReturns.reduce((sum: number, r: any) => sum + (Number(r.return_amount) || 0), 0);
  }

  get totalPurchaseReturnsCount(): number {
    return this.filteredPurchaseReturns.length;
  }

  get filteredExpenses(): any[] {
    if (!this.dateFrom && !this.dateTo) return this.expenses;
    return this.expenses.filter((e: any) => {
      const date = e.transaction_date ? new Date(e.transaction_date).setHours(0, 0, 0, 0) : null;
      if (!date) return false;
      const from = this.dateFrom ? new Date(this.dateFrom).setHours(0, 0, 0, 0) : null;
      const to = this.dateTo ? new Date(this.dateTo).setHours(0, 0, 0, 0) : null;
      if (from && to) return date >= from && date <= to;
      if (from) return date >= from;
      if (to) return date <= to;
      return true;
    });
  }

  get totalPurchases(): number {
    return this.filteredPurchases.reduce((sum: number, p: any) => sum + (p.total_amount || 0), 0);
  }

  /**
   * Every bill that counts as revenue for this business — which is ALL of them,
   * own-farm bills included.
   *
   * Distribution is its own business and the owner's farms are its customers.
   * When it supplies feed to one of them that is a real sale: distribution earns
   * the revenue and the farm owes the money. Own-farm bills used to be dropped
   * here while their COGS was still charged (see `totalCOGS`), so every transfer
   * pushed this report further into loss — the shop appearing to give its stock
   * away.
   *
   * That elimination belongs at ACCOUNT level, not here, and it still happens
   * there: `overview.service.ts` drops the own-farm bill's revenue AND the
   * matching cost row booked in the broiler/layer module, so the two cancel and
   * the owner cannot manufacture profit by selling to himself. This screen is
   * the distribution business's own P&L, where the farm is simply a customer.
   *
   * The collected-basis rule applies to own-farm bills exactly as it does to
   * everyone else: an unsettled one contributes nothing to `totalPaidSales` and
   * shows up in `totalUnpaidSales`.
   */
  get revenueBills(): any[] {
    return this.filteredSales;
  }

  get internalSales(): any[] {
    return this.filteredSales.filter((s: any) => (s.payment_type || 'cash') === 'internal');
  }

  /** Own-farm sales billed in the period — disclosure, and part of revenue. */
  get internalTransferValue(): number {
    return this.internalSales.reduce((sum: number, s: any) => sum + (Number(s.total_amount) || 0), 0);
  }

  get internalTransferCount(): number {
    return this.internalSales.length;
  }

  /** The part of own-farm sales the farms have actually settled. */
  get internalSettled(): number {
    return this.internalSales.reduce((sum: number, s: any) => sum + this.getBillPaidAmount(s), 0);
  }

  /** Still owed by the owner's own farms — the debt they carry until settled. */
  get internalOutstanding(): number {
    return Math.max(this.internalTransferValue - this.internalSettled, 0);
  }

  /** Billed to customers in the period, paid or not (accrual). */
  get totalSales(): number {
    return this.revenueBills.reduce((sum: number, s: any) => sum + (s.total_amount || 0), 0);
  }

  /** The part of `totalSales` actually collected — this is what profit uses. */
  get totalPaidSales(): number {
    return this.revenueBills.reduce((sum: number, s: any) => sum + this.getBillPaidAmount(s), 0);
  }

  get totalReturns(): number {
    return this.filteredReturns.reduce((sum: number, r: any) => sum + (Number(r.return_amount) || 0), 0);
  }

  get totalExpenses(): number {
    return this.filteredExpenses.reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
  }

  /**
   * COST OF GOODS SOLD — the purchase cost of the stock that actually left on
   * the bills in range, taken from `batch_transactions` -> `product_batches`.
   *
   * This is deliberately NOT total purchases. Buying stock converts cash into
   * an asset; it becomes a cost only when that stock is sold. Charging every
   * purchase against the period made a shop that had bought Rs 7.24m of stock
   * and sold Rs 12.5k of it look like it had lost Rs 7.24m, when almost all of
   * that money was still on the shelves.
   *
   * Summed over `filteredSales` rather than queried with its own date filter,
   * so cost is always drawn from the same date-filtered set of bills.
   *
   * Own-farm bills are costed here like any other, and they now earn revenue
   * like any other too (see `revenueBills`), so cost and revenue are drawn from
   * the same set of bills and there is no longer an asymmetry to explain.
   * `qDistributionCogs()` in overview.service.ts computes the same figure the
   * same way.
   */
  get totalCOGS(): number {
    return this.filteredSales.reduce(
      (sum: number, s: any) => sum + (this.billCosts.get(s.bill_id)?.cogs || 0), 0
    );
  }

  /** Portion of `totalCOGS` priced from a fallback rate rather than its own batch. */
  get estimatedCOGS(): number {
    return this.filteredSales.reduce(
      (sum: number, s: any) => sum + (this.billCosts.get(s.bill_id)?.estimatedCost || 0), 0
    );
  }

  get estimatedCOGSUnits(): number {
    return this.filteredSales.reduce(
      (sum: number, s: any) => sum + (this.billCosts.get(s.bill_id)?.estimatedUnits || 0), 0
    );
  }

  /** Units sold that have no cost source at all — they sit in COGS at zero. */
  get unpricedCOGSUnits(): number {
    return this.filteredSales.reduce(
      (sum: number, s: any) => sum + (this.billCosts.get(s.bill_id)?.unpricedUnits || 0), 0
    );
  }

  get billsWithEstimatedCost(): number {
    return this.filteredSales.filter((s: any) => {
      const c = this.billCosts.get(s.bill_id);
      return !!c && (c.estimatedUnits > 0 || c.unpricedUnits > 0);
    }).length;
  }

  /** Revenue less the cost of what was sold, before running expenses. */
  get grossProfit(): number {
    return this.totalPaidSales - this.totalCOGS;
  }

  /**
   * Stock bought in this period that has not been sold on. Not a loss — it is
   * inventory the owner still holds, and it is the difference between the
   * frightening "Total Purchases" number and the real cost of trading.
   */
  get purchasesNotYetSold(): number {
    return this.totalPurchases - this.totalPurchaseReturns - this.totalCOGS;
  }

  get totalProfitLoss(): number {
    // Profit = collected sales revenue − cost of goods sold − expenses.
    //
    // Revenue stays COLLECTED basis: only `bills.amount_paid` counts, so an
    // unpaid bill contributes nothing positive while the cost of the goods it
    // moved is already charged, pulling profit down until the money is actually
    // collected. The billed (accrual) figure and the uncollected balance are
    // both displayed above it, but neither feeds this number — an unpaid bill is
    // not profit. overview.service.ts applies the same rule to the same bills.
    //
    // Own-farm sales count as revenue here, on the same collected basis — see
    // `revenueBills`. The account-level elimination that stops the owner
    // profiting from selling to himself lives in overview.service.ts, not here.
    //
    // Purchase returns are NOT added back here. Stock returned to a supplier was
    // never sold, so it never entered COGS; `purchase-returns.component.ts` has
    // already removed it from inventory. Crediting it against profit as the old
    // formula did booked a gain that never happened.
    return this.totalPaidSales - this.totalCOGS - this.totalExpenses;
  }

  /**
   * 🔥 FIX: Unpaid Sales = Total Sales - Total Paid Sales
   * This is the correct accounting formula
   */
  get totalUnpaidSales(): number {
    return this.revenueBills.reduce((sum: number, s: any) => {
      const total = Number(s.total_amount) || 0;
      return sum + Math.max(total - this.getBillPaidAmount(s), 0);
    }, 0);
  }

  /**
   * The same uncollected figure read from the other side — the customers' own
   * outstanding balances. Own-farm customers are included deliberately: a farm
   * that has not settled owes this business money exactly as an outside customer
   * does, which is why `totalUnpaidSales` counts it too. The two agree except
   * that this one is not date-filtered.
   */
  get totalOutstandingBalance(): number {
    return this.customers.reduce((sum: number, c: any) => sum + (c.outstanding_balance || 0), 0);
  }

  /**
   * TOP CARD: what OUTSIDE customers still owe this account.
   *
   * The same per-customer `outstanding_balance` every other screen reads —
   * `getAllCustomersWithBalance()`'s
   * `SUM(MAX(bills.total_amount - bills.amount_paid, 0))`, which is the one
   * definition of a customer's debt in this app (Customer Ledger, Sales
   * Orders, the cached `customers.outstanding_balance`). There is deliberately
   * no second query computing "customer outstanding" another way: two sources
   * that disagree is worse than no card.
   *
   * The only difference from `totalOutstandingBalance` above is the filter.
   * That figure is the mirror of `totalUnpaidSales` and so INCLUDES own-farm
   * bills; this card is labelled "customers" in the outside sense, and the
   * owner's own farms are not that — hence
   * `COALESCE(customer_type,'external') <> 'own_farm'`, expressed here over
   * rows already read.
   *
   * Not date-filtered, exactly like the supplier payables below it: a balance
   * is what is owed as at today, not a flow over a period.
   */
  get totalCustomerOutstanding(): number {
    return this.customers
      .filter((c: any) => (c.customer_type || 'external') !== 'own_farm')
      .reduce((sum: number, c: any) => sum + (Number(c.outstanding_balance) || 0), 0);
  }

  /**
   * TOP CARD: what this account still owes its suppliers.
   *
   * Straight through to `totalSupplierPayable` — `SUM(credit - debit)` over
   * `supplier_ledger` per supplier, summed — so the card and the Supplier
   * Payables section further down cannot print different numbers.
   */
  get totalSupplierOutstanding(): number {
    return this.totalSupplierPayable;
  }

  /**
   * TOP CARD: cash the account is holding, derived from every recorded cash
   * transaction. See `CashPositionService` — the one definition, shared with
   * the Overview dashboard and the Farm Report so the three cannot print
   * different figures. Account-wide and as at today, exactly like the two
   * outstanding cards beside it.
   */
  get cashInHand(): number {
    return this.cashPosition?.cashInHand || 0;
  }

  /** TOP CARD: every HOUSE bank account's balance, summed. Same source. */
  get totalBankBalance(): number {
    return this.cashPosition?.totalBankBalance || 0;
  }

  get totalProducts(): number {
    return this.products.length;
  }

  get totalPurchasesCount(): number {
    return this.filteredPurchases.length;
  }

  // ── SUPPLIER PAYABLES ──────────────────────────────────────
  //
  // Every figure here is a plain sum of the columns `getAllSuppliersWithBalance()`
  // derived from `supplier_ledger`. Nothing is recomputed from a different
  // source, so this section cannot disagree with the Supplier Ledger screen.
  //
  // Not date-filtered, unlike everything above: a payable is what is owed as at
  // today. Slicing a date range out of a ledger would print a balance that is
  // not the balance, and `totalSupplierPayable` is the figure the client checks
  // against what the supplier says he is owed.

  /** Suppliers who have any history at all — a never-traded row is noise. */
  get activeSuppliers(): any[] {
    return this.supplierBalances.filter((s: any) =>
      (Number(s.total_purchased) || 0) !== 0 ||
      (Number(s.total_paid) || 0) !== 0 ||
      (Number(s.outstanding_balance) || 0) !== 0
    );
  }

  get totalSupplierPurchased(): number {
    return this.activeSuppliers.reduce((sum, s) => sum + (Number(s.total_purchased) || 0), 0);
  }

  get totalSupplierOtherCharges(): number {
    return this.activeSuppliers.reduce((sum, s) => sum + (Number(s.other_charges) || 0), 0);
  }

  get totalSupplierPaid(): number {
    return this.activeSuppliers.reduce((sum, s) => sum + (Number(s.total_paid) || 0), 0);
  }

  get totalSupplierReturned(): number {
    return this.activeSuppliers.reduce((sum, s) => sum + (Number(s.total_returned) || 0), 0);
  }

  /** What the business still owes its suppliers: SUM(credit - debit), summed. */
  get totalSupplierPayable(): number {
    return this.activeSuppliers.reduce((sum, s) => sum + (Number(s.outstanding_balance) || 0), 0);
  }

  /** A supplier in credit — he owes the farm, usually after a return. */
  get totalSupplierAdvance(): number {
    return this.activeSuppliers.reduce(
      (sum, s) => sum + Math.min(Number(s.outstanding_balance) || 0, 0), 0);
  }

  /**
   * 'Cash' or 'Bank · <account>', for a purchase order row or an account
   * roll-up row. Always `paymentSourceLabel()` — never a cash/credit test,
   * which is what `payment_type` would give and which says nothing about which
   * account the money moved through.
   */
  accountLabel(row: any): string {
    return paymentSourceLabel(row);
  }

  /**
   * Does this order record money leaving a named place?
   *
   * An UNPAID (credit) order moved nothing yet, so it names no account even
   * though its `payment_source` column holds the default 'cash'. Reading
   * `payment_type` here rather than `payment_source` is deliberate: on this one
   * table `payment_type` is the settlement status ("Paid" vs "Credit"), which
   * is precisely the question being asked.
   */
  orderWasPaid(order: any): boolean {
    return (order?.payment_type || '').toLowerCase() === 'cash';
  }

  /** Every revenue bill, so it agrees with `totalSales` beside it. */
  get totalSalesCount(): number {
    return this.revenueBills.length;
  }

  get totalReturnsCount(): number {
    return this.filteredReturns.length;
  }

  get totalExpensesCount(): number {
    return this.filteredExpenses.length;
  }

  /**
   * Get product stock from batches
   */
  getProductStock(productId: number): number {
    const product = this.products.find(p => p.product_id === productId);
    return product?.calculated_stock || 0;
  }

  /**
   * Get product inventory value — batch purchase price, matching COGS.
   */
  getProductValue(product: any): number {
    return Number(product?.inventory_value) || 0;
  }

  /** The rate `loadCostOfGoods()` settled on for a product, for display. */
  getProductUnitCost(product: any): number {
    return Number(product?.effective_unit_cost) || 0;
  }

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cashPositionService: CashPositionService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadPreferences();
    this.loadData();
  }

  /**
   * BUG FIX: merge the saved preferences OVER the defaults instead of
   * replacing them.
   *
   * This used to assign the parsed JSON straight onto `sections`, so any
   * section added after a user had last saved their preferences arrived
   * `undefined` — falsy — and that section was hidden from both the screen and
   * the PDF, with its checkbox unticked, on every machine that had ever
   * touched this screen. The section was effectively invisible to exactly the
   * users who use the report most, and there was nothing on screen to say why.
   * Spreading over the defaults means a new key keeps its default (shown) and
   * only the keys the user actually chose are restored.
   */
  loadPreferences() {
    const saved = localStorage.getItem('distReportPrefs');
    if (saved) {
      try {
        this.sections = { ...this.sections, ...JSON.parse(saved) };
      } catch (e) {
        console.error('Error parsing preferences', e);
      }
    }
  }

  savePreferences() {
    localStorage.setItem('distReportPrefs', JSON.stringify(this.sections));
  }

  applyDateFilter() {
    this.cdr.detectChanges();
  }

  clearDateFilter() {
    this.dateFrom = '';
    this.dateTo = '';
    this.cdr.detectChanges();
  }

  // ── LOAD DATA ─────────────────────────────────────────────

  async loadData() {
    this.isLoading = true;
    this.errorMessage = '';

    try {
      // Load products
      const pr = await this.db.get('SELECT * FROM products WHERE farm_id=?', [this.currentFarm.farm_id]);
      this.products = pr.success ? pr.data : [];

      // 🔥 Calculate stock for each product from batches
      for (const product of this.products) {
        const totalStock = await this.db.getTotalStock(product.product_id);
        product.calculated_stock = totalStock;

        // Also get batch count for display
        const batchesResult = await this.db.getBatchesByProduct(product.product_id, this.currentFarm.farm_id);
        const batches = batchesResult.success && batchesResult.data ? batchesResult.data : [];
        product.batch_count = batches.length;

        // Check for expiring batches
        const hasExpiring = await this.db.hasExpiringBatches(product.product_id);
        product.has_expiring = hasExpiring;
      }

      // Load purchases
      //
      // `bank_name` rides along so the Account column can name the account a
      // paid order was paid from. Read live off `bank_accounts` rather than
      // stored on the order, so renaming an account propagates — the same shape
      // as `getAssetPayments()`.
      const pu = await this.db.get(
        `SELECT po.*, p.product_name, s.supplier_name, b.bank_name
         FROM purchase_orders po
         LEFT JOIN products p ON po.product_id = p.product_id
         LEFT JOIN suppliers s ON po.supplier_id = s.supplier_id
         LEFT JOIN bank_accounts b ON b.bank_id = po.bank_id
         WHERE po.farm_id = ?
         ORDER BY po.date DESC`,
        [this.currentFarm.farm_id]
      );
      this.purchases = pu.success ? pu.data : [];

      // ── SUPPLIER PAYABLES ────────────────────────────────────
      //
      // "Supplier ki payment ka kitna dena hai kitna lena hai on reports."
      // Both figures are DERIVED from `supplier_ledger` on this read — the
      // payable is `SUM(credit - debit)` over it and is stored nowhere, so this
      // section cannot disagree with the Supplier Ledger screen or go stale.
      //
      // Deliberately NOT part of the date filter or the P&L summary below: a
      // payable is a balance as at today, not a flow over a period, and
      // dropping half a supplier's ledger out of it would print a payable the
      // supplier does not agree with.
      const suppliersResult = await this.db.getAllSuppliersWithBalance(this.currentFarm.farm_id);
      this.supplierBalances = suppliersResult.success ? (suppliersResult.data || []) : [];

      const supplierAccountsResult =
        await this.db.getSupplierPaymentsByAccount(this.currentFarm.farm_id);
      this.supplierPaymentAccounts =
        supplierAccountsResult.success ? (supplierAccountsResult.data || []) : [];

      // Load sales bills
      // Distribution's own bills only. A layer sale's receivable is a bill
      // too — that is how the customer carries the debt — but it is not a
      // distribution sale, and its revenue is already booked in the layer
      // module's `income` mirror. Counting it here would report it twice.
      const sa = await this.db.get(
        `SELECT * FROM bills WHERE farm_id = ? AND ${distributionBillsOnly()}
         ORDER BY bill_date DESC, bill_id DESC`,
        [this.currentFarm.farm_id]
      );
      this.sales = sa.success ? sa.data : [];

      const returnsResult = await this.db.get(
        `SELECT sr.*, b.bill_number, b.customer_name
         FROM sales_returns sr
         JOIN bills b ON b.bill_id = sr.bill_id
         WHERE sr.farm_id = ?
         ORDER BY sr.return_date DESC, sr.return_id DESC`,
        [this.currentFarm.farm_id]
      );
      this.salesReturns = returnsResult.success ? returnsResult.data : [];

      const purchaseReturnsResult = await this.db.get(
        `SELECT pr.*, p.product_name, s.supplier_name
         FROM purchase_returns pr
         JOIN purchase_orders po ON po.purchase_id = pr.purchase_id
         LEFT JOIN products p ON p.product_id = po.product_id
         LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
         WHERE pr.farm_id = ?
         ORDER BY pr.return_date DESC, pr.return_id DESC`,
        [this.currentFarm.farm_id]
      );
      this.purchaseReturns = purchaseReturnsResult.success ? purchaseReturnsResult.data : [];

      // Own-farm customers are INCLUDED, matching `totalUnpaidSales`, which now
      // counts unsettled own-farm bills — see `totalOutstandingBalance`.
      const customersResult = await this.db.getAllCustomersWithBalance(this.currentFarm.farm_id);
      this.customers = customersResult.success ? customersResult.data : [];

      // Cash in hand + total bank balance. Not date-filtered — both are
      // balances as at today, like the outstanding cards they sit with.
      this.cashPosition = await this.cashPositionService.getCashPosition(this.currentFarm.farm_id);

      // Load expenses
      const ex = await this.db.get(
        `SELECT * FROM expense_ledger WHERE farm_id = ? ORDER BY transaction_date DESC`,
        [this.currentFarm.farm_id]
      );
      this.expenses = ex.success ? ex.data : [];

      // Opening balance — a hand-entered figure, not part of any table's own
      // rows. A missing row (nothing saved yet) or a NULL value both fall
      // back to 0.
      const obRes = await this.db.get(
        `SELECT value FROM app_settings WHERE farm_id = ? AND key = 'distribution_opening_balance'`,
        [this.currentFarm.farm_id]
      );
      const obRow = obRes.success && obRes.data && obRes.data[0] ? obRes.data[0] : null;
      this.distributionOpeningBalance = Number(obRow?.value) || 0;

      // Cost of goods sold + inventory valuation. Runs last: it needs both the
      // product list and the bill list already in place.
      await this.loadCostOfGoods();

      // Determine bill paid status
      for (const bill of this.sales) {
        bill.is_paid = this.getBillPaidAmount(bill) >= (Number(bill.total_amount) || 0);
      }

      console.log('📊 Distribution Report Data:');
      console.log(`Total Products: ${this.totalProducts}`);
      console.log(`Total Purchases: Rs. ${this.totalPurchases.toLocaleString()}`);
      console.log(`Total Sales: Rs. ${this.totalSales.toLocaleString()}`);
      console.log(`Total Paid Sales: Rs. ${this.totalPaidSales.toLocaleString()}`);
      console.log(`Total Unpaid Sales: Rs. ${this.totalUnpaidSales.toLocaleString()}`);
      console.log(`Total Returns: Rs. ${this.totalReturns.toLocaleString()}`);
      console.log(`Total Expenses: Rs. ${this.totalExpenses.toLocaleString()}`);
      console.log(`Inventory Value: Rs. ${this.totalInventoryValue.toLocaleString()}`);
      console.log(`Cost of Goods Sold: Rs. ${this.totalCOGS.toLocaleString()}`);
      console.log(`Profit / Loss: Rs. ${this.totalProfitLoss.toLocaleString()}`);
      if (this.cogsWarnings.length) console.warn('COGS data quality:', this.cogsWarnings);

    } catch (error: any) {
      this.errorMessage = 'Failed to load data: ' + error.message;
      console.error('Load error:', error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── COST OF GOODS SOLD ────────────────────────────────────

  /**
   * Builds `billCosts` — the purchase cost of the goods each bill moved — and
   * values the stock still on hand, both on the same rates so the two numbers
   * reconcile against purchases.
   *
   * Where the cost comes from
   * -------------------------
   * `sales-orders.component.ts` walks the product's batches oldest-expiry-first
   * and writes one `batch_transactions` row per batch it draws from, stamped
   * `type = 'sale'` and `reference_id = bills.bill_id`. The rate for those units
   * is `product_batches.purchase_price` on the batch the row points at. This
   * only reads those rows; it never writes and never touches the FIFO logic.
   *
   * Stock coming back is `type = 'return'` and has to be netted off, or an
   * edited bill counts its goods twice — a bill edit restores stock (a `return`)
   * and then re-deducts it (a fresh `sale`). Two different writers produce
   * `return` rows and they overload `reference_id` differently:
   *
   *   restoreBillStock()      (bill edited)     reference_id = bills.bill_id
   *   restoreReturnedStock()  (customer return) reference_id = sales_returns.return_id
   *
   * Both id spaces start at 1, so matching on the id alone would misfile a bill
   * edit as somebody else's customer return. The join below also requires the
   * note to start with that return's `return_number`, which `restoreReturnedStock`
   * always writes and `restoreBillStock` ("Restored from deleted/edited sale")
   * never does. Anything failing both tests is treated as a bill reference.
   *
   * The `' - '` in that LIKE pattern is load-bearing, not cosmetic. Matching on
   * `return_number || '%'` made RET-100 match the notes of RET-1000, RET-1001,
   * … as well as its own, so from the 100th return onwards a single return row
   * could join several transactions and net the same goods off more than once.
   * `restoreReturnedStock()` writes the note as `${return_number} - Bill ...`,
   * so requiring the separator pins the match to the whole number. Keep the two
   * in step: change the note format and this pattern changes with it.
   *
   * `type = 'purchase'` and `type = 'adjustment'` are excluded on purpose:
   * adjustments are stock leaving for a purchase edit, a purchase return or a
   * batch deletion. That stock was never sold, so it is not a cost of sales.
   *
   * Sales returns need nothing further. `sales-returns.component.ts` rewrites
   * `bills.total_amount` and `amount_paid` in place as well as posting the
   * `return` rows, so revenue and cost both net out already; subtracting
   * `totalReturns` again here would double-count it.
   *
   * Uncosted units
   * --------------
   * Not every sale is fully costed, in three different ways:
   *
   *   1. Bills predating the batch module have no `batch_transactions` at all.
   *   2. Some batches carry `purchase_price = 0` — `restoreBillStock`'s
   *      last-resort branch creates them, and the batch screen allows a blank
   *      price. A FIFO sale drawing on one of those would cost nothing.
   *   3. `deductFromBatches` stops when the batches run dry, so a bill sold
   *      short of stock logs fewer units than it billed.
   *
   * Letting any of those stand at zero would overstate profit, which is the very
   * failure this rewrite exists to fix. So every unit on `bill_items` not backed
   * by a priced batch draw is re-priced at a fallback rate — first
   * `products.cost_price`, then the weighted-average rate across that product's
   * `purchase_orders`, then its most recent priced batch. The chain is needed
   * because `products.cost_price` is only ever written by hand on the inventory
   * screen (purchase orders do not maintain it), so alone it is often stale or 0.
   *
   * Units that come up empty on all three are counted at zero — there is no
   * honest number available — but they are tallied into `unpricedUnits` and
   * reported as a warning on screen and in the PDF, so an overstated profit is
   * visible rather than silent.
   */
  private async loadCostOfGoods() {
    this.billCosts.clear();
    this.cogsWarnings = [];

    const farmId = this.currentFarm?.farm_id;
    if (!farmId) return;

    const num = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // ── 1. Fallback unit cost per product ───────────────────────────────
    // products.cost_price -> weighted-average purchase rate -> latest priced batch.
    const costRes = await this.db.get(
      `SELECT p.product_id,
              COALESCE(
                NULLIF(p.cost_price, 0),
                NULLIF((SELECT CASE WHEN COALESCE(SUM(po.quantity), 0) > 0
                                    THEN SUM(po.total_amount) / SUM(po.quantity)
                                    ELSE 0 END
                        FROM purchase_orders po
                        WHERE po.product_id = p.product_id AND po.farm_id = p.farm_id), 0),
                NULLIF((SELECT pb.purchase_price
                        FROM product_batches pb
                        WHERE pb.product_id = p.product_id AND pb.farm_id = p.farm_id
                          AND COALESCE(pb.purchase_price, 0) > 0
                        ORDER BY pb.batch_id DESC LIMIT 1), 0),
                0) AS unit_cost
       FROM products p
       WHERE p.farm_id = ?`,
      [farmId]
    );
    if (!costRes.success) {
      this.cogsWarnings.push('Could not read product cost rates: ' + friendlySqlError(costRes.error, 'unknown error'));
    }
    const unitCost = new Map<number, number>();
    for (const row of (costRes.success && costRes.data) ? costRes.data : []) {
      unitCost.set(Number(row.product_id), num(row.unit_cost));
    }
    for (const product of this.products) {
      product.effective_unit_cost = unitCost.get(Number(product.product_id)) || 0;
    }

    // ── 2. Inventory value, on the same rates ───────────────────────────
    // Same stock filter getTotalStock() uses, so value and quantity agree.
    const invRes = await this.db.get(
      `SELECT pb.product_id,
              COALESCE(SUM(CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                                THEN pb.quantity * pb.purchase_price ELSE 0 END), 0) AS priced_value,
              COALESCE(SUM(CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                                THEN 0 ELSE pb.quantity END), 0) AS unpriced_qty
       FROM product_batches pb
       WHERE pb.farm_id = ? AND pb.quantity > 0 AND pb.expiry_date >= date('now')
       GROUP BY pb.product_id`,
      [farmId]
    );
    if (!invRes.success) {
      this.cogsWarnings.push('Could not value the stock on hand: ' + friendlySqlError(invRes.error, 'unknown error'));
    }
    const inventory = new Map<number, { priced: number; unpricedQty: number }>();
    for (const row of (invRes.success && invRes.data) ? invRes.data : []) {
      inventory.set(Number(row.product_id), {
        priced: num(row.priced_value),
        unpricedQty: num(row.unpriced_qty)
      });
    }
    for (const product of this.products) {
      const inv = inventory.get(Number(product.product_id));
      const rate = product.effective_unit_cost || 0;
      product.inventory_value = inv ? inv.priced + inv.unpricedQty * rate : 0;
    }

    // ── 3. Net units drawn per bill and product, and what they cost ─────
    const loggedRes = await this.db.get(
      `SELECT bill_id, product_id,
              SUM(net_qty)      AS net_qty,
              SUM(priced_cost)  AS priced_cost,
              SUM(unpriced_qty) AS unpriced_qty
       FROM (
         SELECT bt.reference_id AS bill_id,
                bt.product_id   AS product_id,
                bt.quantity     AS net_qty,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN bt.quantity * pb.purchase_price ELSE 0 END AS priced_cost,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN 0 ELSE bt.quantity END AS unpriced_qty
         FROM batch_transactions bt
         JOIN product_batches pb ON pb.batch_id = bt.batch_id
         WHERE pb.farm_id = ? AND bt.type = 'sale' AND bt.reference_id IS NOT NULL

         UNION ALL

         SELECT COALESCE(sr.bill_id, bt.reference_id) AS bill_id,
                bt.product_id   AS product_id,
                -bt.quantity    AS net_qty,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN -(bt.quantity * pb.purchase_price) ELSE 0 END AS priced_cost,
                CASE WHEN COALESCE(pb.purchase_price, 0) > 0
                     THEN 0 ELSE -bt.quantity END AS unpriced_qty
         FROM batch_transactions bt
         JOIN product_batches pb ON pb.batch_id = bt.batch_id
         LEFT JOIN sales_returns sr
                ON sr.return_id = bt.reference_id
               AND sr.farm_id = ?
               AND bt.notes LIKE sr.return_number || ' - %'
         WHERE pb.farm_id = ? AND bt.type = 'return' AND bt.reference_id IS NOT NULL
       )
       GROUP BY bill_id, product_id`,
      [farmId, farmId, farmId]
    );
    if (!loggedRes.success) {
      this.cogsWarnings.push('Could not read the batch movement behind the sales: ' + friendlySqlError(loggedRes.error, 'unknown error'));
    }

    // key: `${bill_id}:${product_id}`
    const logged = new Map<string, { netQty: number; pricedCost: number; unpricedQty: number }>();
    for (const row of (loggedRes.success && loggedRes.data) ? loggedRes.data : []) {
      const billId = Number(row.bill_id);
      if (!billId) continue;
      logged.set(billId + ':' + (row.product_id ?? 'null'), {
        netQty: num(row.net_qty),
        pricedCost: num(row.priced_cost),
        unpricedQty: num(row.unpriced_qty)
      });
    }

    // ── 4. What each bill actually billed ───────────────────────────────
    // bill_items is the source of truth for units sold; sales returns reduce it
    // in place, exactly as they reduce the netted batch movement above.
    const itemsRes = await this.db.get(
      `SELECT bi.bill_id, bi.product_id, COALESCE(SUM(bi.quantity), 0) AS qty
       FROM bill_items bi
       JOIN bills b ON b.bill_id = bi.bill_id
       WHERE b.farm_id = ?
       GROUP BY bi.bill_id, bi.product_id`,
      [farmId]
    );
    if (!itemsRes.success) {
      this.cogsWarnings.push('Could not read the sold quantities: ' + friendlySqlError(itemsRes.error, 'unknown error'));
    }

    // ── 5. Assemble, re-pricing anything the batches did not cost ───────
    const seenKeys = new Set<string>();

    const bump = (billId: number, patch: Partial<BillCost>) => {
      const cur = this.billCosts.get(billId)
        || { cogs: 0, estimatedUnits: 0, estimatedCost: 0, unpricedUnits: 0 };
      cur.cogs += patch.cogs || 0;
      cur.estimatedUnits += patch.estimatedUnits || 0;
      cur.estimatedCost += patch.estimatedCost || 0;
      cur.unpricedUnits += patch.unpricedUnits || 0;
      this.billCosts.set(billId, cur);
    };

    for (const row of (itemsRes.success && itemsRes.data) ? itemsRes.data : []) {
      const billId = Number(row.bill_id);
      if (!billId) continue;
      const productId = row.product_id ?? null;
      const key = billId + ':' + (productId ?? 'null');
      seenKeys.add(key);

      const soldQty = num(row.qty);
      const draw = logged.get(key);
      const netQty = draw ? draw.netQty : 0;

      // Units the batches priced, and units they did not: the ones drawn from a
      // zero-price batch, plus any the FIFO walk never logged at all.
      const zeroPriced = Math.max(draw ? draw.unpricedQty : 0, 0);
      const neverLogged = Math.max(soldQty - netQty, 0);
      const estimateQty = zeroPriced + neverLogged;
      const pricedCost = draw ? draw.pricedCost : 0;

      const rate = productId === null ? 0 : (unitCost.get(Number(productId)) || 0);

      if (estimateQty > 0 && rate <= 0) {
        // No batch price, no product price, no purchase history. Counting these
        // at zero is the only option left, so make the gap visible instead.
        bump(billId, { cogs: pricedCost, unpricedUnits: estimateQty });
        continue;
      }

      bump(billId, {
        cogs: pricedCost + estimateQty * rate,
        estimatedUnits: estimateQty,
        estimatedCost: estimateQty * rate
      });
    }

    // Batch movement pointing at a bill that no longer carries a matching item
    // line still cost the business money — keep it rather than lose it silently.
    for (const [key, draw] of logged) {
      if (seenKeys.has(key)) continue;
      if (draw.pricedCost === 0) continue;
      bump(Number(key.split(':')[0]), { cogs: draw.pricedCost });
    }

    // ── 6. Data-quality warnings ────────────────────────────────────────
    const estUnits = this.estimatedCOGSUnits;
    const unpriced = this.unpricedCOGSUnits;

    if (estUnits > 0) {
      this.cogsWarnings.push(
        `${estUnits.toLocaleString()} unit(s) sold across ${this.billsWithEstimatedCost} bill(s) had no priced ` +
        `stock batch behind them (older bills, or batches saved without a purchase price). They are costed at ` +
        `the product's current purchase rate, so Rs. ${Math.round(this.estimatedCOGS).toLocaleString()} of the ` +
        `cost of goods sold is an estimate rather than a recorded batch price.`
      );
    }
    if (unpriced > 0) {
      this.cogsWarnings.push(
        `${unpriced.toLocaleString()} unit(s) sold have no purchase price recorded anywhere — not on their batch, ` +
        `not on the product, and not on any purchase order. They are counted at zero cost, so profit is ` +
        `overstated by whatever they actually cost. Set a cost price for these products on the Inventory ` +
        `screen to correct the figure.`
      );
    }
  }

  isInternalBill(bill: any): boolean {
    return (bill?.payment_type || 'cash') === 'internal';
  }

  isBillPaid(bill: any): boolean {
    if (bill.is_paid !== undefined) {
      return bill.is_paid;
    }
    return this.getBillPaidAmount(bill) >= (Number(bill.total_amount) || 0);
  }

  getBillPaidAmount(bill: any): number {
    const total = Number(bill?.total_amount) || 0;
    const paid = Number(bill?.amount_paid) || 0;
    return Math.min(Math.max(paid, 0), total);
  }

  // ── OPENING BALANCE ───────────────────────────────────────

  startEditOpeningBalance() {
    this.openingBalanceInput = this.distributionOpeningBalance;
    this.isEditingOpeningBalance = true;
  }

  cancelEditOpeningBalance() {
    this.isEditingOpeningBalance = false;
  }

  async saveOpeningBalance() {
    const farmId = this.currentFarm?.farm_id;
    if (!farmId) return;

    this.isSavingOpeningBalance = true;
    const value = Number(this.openingBalanceInput) || 0;
    const res = await this.db.run(
      `INSERT INTO app_settings (farm_id, key, value) VALUES (?, 'distribution_opening_balance', ?)
       ON CONFLICT(farm_id, key) DO UPDATE SET value = excluded.value`,
      [farmId, String(value)]
    );

    if (res.success) {
      this.distributionOpeningBalance = value;
      this.isEditingOpeningBalance = false;
    } else {
      this.errorMessage = 'Failed to save opening balance: ' + friendlySqlError(res.error, 'unknown error');
    }
    this.isSavingOpeningBalance = false;
    this.cdr.detectChanges();
  }

  // ── PDF GENERATION ────────────────────────────────────────

  async generatePDF() {
    this.isGenerating = true;
    try {
      const doc = new jsPDF('p', 'mm', 'a4');
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const farmName = this.currentFarm?.farm_name || 'Poultry Farm';
      const today = new Date().toLocaleDateString('en-PK');
      const footer = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
      const margin = 14;

      const formatDate = (d: any) => {
        if (!d) return '—';
        const p = String(d).split('T')[0].split(' ')[0].split('-');
        return (p.length === 3 && p[0].length === 4) ? `${p[2]}-${p[1]}-${p[0]}` : String(d);
      };

      const B: [number, number, number] = [0, 0, 0];
      const G: [number, number, number] = [120, 120, 120];

      // ── Background watermark ────────────────────────────────
      let bgImgData: string | null = null;
      let bgW = 0; let bgH = 0;
      try {
        bgImgData = await this.loadImageAsBase64('/logo.png?v=20261026');
        const bgProps = doc.getImageProperties(bgImgData);
        bgW = 140;
        bgH = (bgProps.height * bgW) / bgProps.width;
      } catch { }

      const drawBackground = () => {
        if (bgImgData) {
          doc.saveGraphicsState();
          doc.setGState(new (doc as any).GState({ opacity: 0.08 }));
          doc.addImage(bgImgData, 'PNG', (pw - bgW) / 2, (ph - bgH) / 2, bgW, bgH);
          doc.restoreGraphicsState();
        }
      };

      drawBackground();

      let y = 20;

      // ── COVER PAGE ─────────────────────────────────────────

      try {
        const id = await this.loadImageAsBase64('/logo.png?v=20261026');
        const ip = doc.getImageProperties(id);
        const lh = 35;
        const lw = (ip.width * lh) / ip.height;
        const tx = margin + lw + 10;
        doc.addImage(id, 'PNG', margin, y, lw, lh);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(...B);
        doc.text('FarmInfantary', tx, y + 8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...G);
        doc.text('', tx, y + 14);
        doc.text('', tx, y + 19);
        doc.text('', tx, y + 24);
        doc.setFontSize(10);
        doc.text('Generated: ' + today, tx, y + 30);
        y += lh + 10;
      } catch {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(...B);
        doc.text('FarmInfantary', pw / 2, y, { align: 'center' });
        y += 7;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...G);
        doc.text('', pw / 2, y, { align: 'center' });
        y += 5;
        doc.text('', pw / 2, y, { align: 'center' });
        y += 4.5;
        doc.text('', pw / 2, y, { align: 'center' });
        y += 6;
        doc.setFontSize(10);
        doc.text('Generated: ' + today, pw / 2, y, { align: 'center' });
        y += 10;
      }

      doc.setDrawColor(...B);
      doc.setLineWidth(0.5);
      doc.line(margin, y, pw - margin, y);
      y += 10;

      // ── BALANCE CARDS ──────────────────────────────────────
      //
      // Part of the LETTERHEAD, not a section: these four balances are what the
      // client checks first, so they print above the section list and before
      // any section starts, whichever sections are selected. They read the
      // same four getters the on-screen cards do, so the PDF cannot disagree
      // with the screen.
      //
      // Two across and two down, in the SAME order as the on-screen grid —
      // what is owed on the first row, where the money actually is on the
      // second.
      {
        const cardW = (pw - margin * 2 - 6) / 2;
        const cardH = 18;
        const cards: [string, string][] = [
          ['Total Customer Outstanding', 'Rs. ' + Math.round(this.totalCustomerOutstanding).toLocaleString()],
          ['Total Supplier Outstanding', 'Rs. ' + Math.round(this.totalSupplierOutstanding).toLocaleString()],
          ['Cash in Hand', 'Rs. ' + Math.round(this.cashInHand).toLocaleString()],
          ['Total Bank Balance', 'Rs. ' + Math.round(this.totalBankBalance).toLocaleString()]
        ];
        cards.forEach(([label, value], i) => {
          const x = margin + (i % 2) * (cardW + 6);
          const cy = y + Math.floor(i / 2) * (cardH + 4);
          doc.setDrawColor(200, 200, 200);
          doc.setLineWidth(0.3);
          doc.roundedRect(x, cy, cardW, cardH, 2, 2);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(...G);
          doc.text(label, x + 4, cy + 7);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(13);
          doc.setTextColor(...B);
          doc.text(value, x + 4, cy + 14.5);
        });
        y += Math.ceil(cards.length / 2) * (cardH + 4);

        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(...G);
        const note = 'Balances as at today, not limited to the selected date range. ' +
          'Customer outstanding excludes your own farms. Cash in Hand is derived from ' +
          'recorded cash transactions; Total Bank Balance covers your own accounts only.';
        const noteLines = doc.splitTextToSize(note, pw - margin * 2);
        doc.text(noteLines, margin, y);
        y += noteLines.length * 3.4 + 6;
      }

      // ── SECTION BREAKS ─────────────────────────────────────
      //
      // The block above is a LETTERHEAD, not a section: it is drawn on page 1
      // whatever is selected. Every section below used to open with an
      // UNCONDITIONAL `doc.addPage()`, which is right while the summary is on
      // — the summary fills page 1 — and wrong when it is off, because page 1
      // was then left holding nothing but the branding and the watermark while
      // the one selected section started on page 2. Selecting a single section
      // produced a two-page PDF whose first page was blank but for the logo.
      // Present since v1.0.0.
      //
      // So the FIRST section continues on page 1 when the cover is all that is
      // on it. Nothing else changes: with the summary on, the break happens
      // exactly where it always did, and the header design, the logo and the
      // watermark are untouched on every page.
      let coverPageFree = !this.sections.summary;

      /**
       * Opens a section and returns the `y` its content starts at.
       *
       * On page 1 the title is drawn in the SAME bold-14 style and with the
       * same rule under it that `addPageHeader()` draws, at the running `y`
       * rather than the fixed top-of-page position — the farm name and the
       * date are already on the cover immediately above, so repeating them
       * would be the only visible difference. The 13mm it leaves below the
       * title is the gap the fixed header leaves too (title at 22, content at
       * 35), so a first-page section and a later one are laid out alike.
       */
      const startSection = (title: string): number => {
        if (coverPageFree) {
          coverPageFree = false;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(14);
          doc.setTextColor(...B);
          doc.text(title, margin, y);
          doc.setDrawColor(...B);
          doc.setLineWidth(0.5);
          doc.line(margin, y + 3, pw - margin, y + 3);
          return y + 13;
        }
        doc.addPage();
        drawBackground();
        this.addPageHeader(doc, farmName, today, title);
        return 35;
      };

      // ── SUMMARY SECTION ────────────────────────────────────

      if (this.sections.summary) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.setTextColor(...B);
        doc.text('SUMMARY', margin, y);
        y += 8;

        const rs = (n: number) => 'Rs. ' + Math.round(n).toLocaleString();

        const summaryData: [string, string][] = [
          ['Total Products', String(this.totalProducts)],
          ['Total Purchase Orders', String(this.totalPurchasesCount)],
          ['Total Sales Bills', String(this.totalSalesCount)],
          ['Total Returns', rs(this.totalReturns)],
          ['Total Expenses Count', String(this.totalExpensesCount)],

          // ── Where the money went ──
          ['Total Purchases (all stock bought)', rs(this.totalPurchases)],
          ['Less: Purchase Returns (sent back to supplier)', rs(this.totalPurchaseReturns)],
          ['Less: Cost of Goods Sold (stock that actually sold)', rs(this.totalCOGS)],
          ['= Stock bought but not yet sold', rs(this.purchasesNotYetSold)],
          ['Current Inventory Value (all unsold stock, at cost)', rs(this.totalInventoryValue)],

          // ── Trading result ──
          ['Sales Billed to Customers', rs(this.totalSales)],
          ['Less: Billed but Not Yet Collected', rs(this.totalUnpaidSales)],
          ['= Revenue Counted (money collected)', rs(this.totalPaidSales)],
          ['Cost of Goods Sold', rs(this.totalCOGS)],
          ['Gross Profit (Revenue Counted - Cost of Goods Sold)', rs(this.grossProfit)],
          ['Total Expenses', rs(this.totalExpenses)],
          [
            this.totalProfitLoss >= 0
              ? 'Net Profit (this period, app-calculated)'
              : 'Net Loss (this period, app-calculated)',
            rs(Math.abs(this.totalProfitLoss))
          ],
          ...(this.internalTransferCount > 0
            ? ([
                [
                  `Of which Own-Farm Sales (${this.internalTransferCount})`,
                  rs(this.internalTransferValue)
                ],
                [
                  'Of which Still Owed by Your Own Farms',
                  rs(this.internalOutstanding)
                ]
              ] as [string, string][])
            : []),

          // Carried forward from the client's previous system, not app-calculated —
          // shown separately, then combined into a final total below it.
          ['Opening Balance (carried forward, not app-calculated)', rs(this.distributionOpeningBalance)],
          [
            this.totalWithOpeningBalance >= 0
              ? 'Total (Opening Balance + Net Profit)'
              : 'Total (Opening Balance + Net Loss)',
            rs(Math.abs(this.totalWithOpeningBalance))
          ]
        ];

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        for (const [label, value] of summaryData) {
          doc.setTextColor(...G);
          doc.text(label + ':', margin + 6, y);
          doc.setTextColor(...B);
          doc.text(value, margin + 105, y);
          y += 6;
        }

        // Buying stock is not a loss — it converts cash into an asset. Spell that
        // out on the page, because "Total Purchases" is the number that alarms.
        y += 2;
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(...G);
        const basisNote = doc.splitTextToSize(
          'Profit charges only the purchase cost of the stock that actually sold (cost of goods sold), ' +
          'traced through the stock batches each sale drew from. Stock still on the shelves is an asset ' +
          'you own, not money lost, so it is shown as Inventory Value instead of being charged against ' +
          'profit. Sales are shown as billed, then reduced by whatever has not yet been collected: an ' +
          'unpaid bill is never counted as profit until the money arrives. Transfers to your own flocks ' +
          'or batches are not sales and are excluded from revenue, though the cost of that stock is ' +
          'still charged. Purchase returns are not credited to profit — that stock never sold, so its ' +
          'cost never entered the profit calculation.',
          pw - margin * 2 - 12
        );
        doc.text(basisNote, margin + 6, y);
        y += basisNote.length * 3.6 + 3;

        const openingNote = doc.splitTextToSize(this.openingBalanceLabel, pw - margin * 2 - 12);
        doc.text(openingNote, margin + 6, y);
        y += openingNote.length * 3.6 + 3;

        if (this.cogsWarnings.length > 0) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(198, 40, 40);
          doc.text('Data quality notes on the cost figure:', margin + 6, y);
          y += 4.5;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(...G);
          for (const w of this.cogsWarnings) {
            const lines = doc.splitTextToSize('- ' + w, pw - margin * 2 - 12);
            doc.text(lines, margin + 6, y);
            y += lines.length * 3.6 + 2;
          }
        }
      }

      // ── INVENTORY TABLE ────────────────────────────────────

      if (this.sections.inventory && this.products.length > 0) {
        const sectionY = startSection('INVENTORY DETAIL (Current Stock from Batches)');

        // Sort products by stock value (highest first)
        const sortedProducts = [...this.products].sort(
          (a, b) => this.getProductValue(b) - this.getProductValue(a)
        );

        const inventoryBody = sortedProducts.map(p => [
          p.product_name,
          p.category || '—',
          String(p.unit || '—'),
          String(p.calculated_stock || 0),
          String(p.batch_count || 0),
          'Rs. ' + Math.round(this.getProductUnitCost(p)).toLocaleString(),
          'Rs. ' + (p.selling_price || 0).toLocaleString(),
          'Rs. ' + Math.round(this.getProductValue(p)).toLocaleString()
        ]);

        autoTable(doc, {
          startY: sectionY,
          head: [['Product', 'Category', 'Unit', 'Stock', 'Batches', 'Cost', 'Sell', 'Value']],
          body: inventoryBody.length > 0 ? inventoryBody : [['No products found', '', '', '', '', '', '', '']],
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 7, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          bodyStyles: { fontSize: 7, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 26 },
            1: { cellWidth: 18 },
            2: { cellWidth: 13 },
            3: { cellWidth: 16, halign: 'right' },
            4: { cellWidth: 16, halign: 'right' },
            5: { cellWidth: 24, halign: 'right' },
            6: { cellWidth: 24, halign: 'right' },
            7: { cellWidth: 30, halign: 'right' }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        const finalY = (doc as any).lastAutoTable.finalY + 6;
        const inventoryTableRight = getTableRightEdge(doc);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...B);
        doc.text(`Total Inventory Value: Rs. ${this.totalInventoryValue.toLocaleString()}`, inventoryTableRight, finalY, { align: 'right' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(...G);
        doc.text(
          '* Each batch is valued at the price actually paid for it (product_batches.purchase_price); ' +
          'batches saved without a price fall back to the product cost rate shown in the Cost column.',
          margin, finalY + 5
        );
      }

      // ── PURCHASES ──────────────────────────────────────────

      if (this.sections.purchases && this.filteredPurchases.length > 0) {
        const sectionY = startSection('PURCHASE ORDERS');

        // The Account column is the point: a printed purchase list has to say
        // which bank a paid order was paid out of. An unpaid order moved no
        // money and names none.
        const purchaseBody = this.filteredPurchases.map(p => [
          formatDate(p.date),
          p.product_name || '—',
          p.supplier_name || '—',
          String(p.quantity || 0),
          'Rs. ' + (p.cost_price || 0).toLocaleString(),
          'Rs. ' + (p.total_amount || 0).toLocaleString(),
          p.payment_type || '—',
          this.orderWasPaid(p) ? this.accountLabel(p) : '—'
        ]);

        autoTable(doc, {
          startY: sectionY,
          head: [['Date', 'Product', 'Supplier', 'Qty', 'Cost', 'Total', 'Payment', 'Account']],
          body: purchaseBody.length > 0 ? purchaseBody : [['No purchases found', '', '', '', '', '', '', '']],
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          bodyStyles: { fontSize: 8, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 22 },
            1: { cellWidth: 26 },
            2: { cellWidth: 24 },
            3: { cellWidth: 13, halign: 'right' },
            4: { cellWidth: 22, halign: 'right' },
            5: { cellWidth: 26, halign: 'right' },
            6: { cellWidth: 18 },
            7: { cellWidth: 31 }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        const finalY = (doc as any).lastAutoTable.finalY + 6;
        const purchasesTableRight = getTableRightEdge(doc);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...B);
        doc.text(`Total Purchases: Rs. ${this.totalPurchases.toLocaleString()}`, purchasesTableRight, finalY, { align: 'right' });
      }

      // ── SALES ──────────────────────────────────────────────

      if (this.sections.sales && this.filteredSales.length > 0) {
        const sectionY = startSection('SALES BILLS');

        const salesBody = this.filteredSales.map(s => {
          const isPaid = this.isBillPaid(s);
          return [
            formatDate(s.bill_date),
            s.bill_number || '—',
            s.customer_name || 'Walk-in',
            'Rs. ' + (s.total_amount || 0).toLocaleString(),
            'Rs. ' + this.getBillPaidAmount(s).toLocaleString(),
            isPaid ? 'Paid' : 'Unpaid'
          ];
        });

        autoTable(doc, {
          startY: sectionY,
          head: [['Date', 'Bill #', 'Customer', 'Total', 'Paid', 'Status']],
          body: salesBody.length > 0 ? salesBody : [['No sales found', '', '', '', '', '']],
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          bodyStyles: { fontSize: 8, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 24 },
            1: { cellWidth: 26 },
            2: { cellWidth: 28 },
            3: { cellWidth: 28, halign: 'right' },
            4: { cellWidth: 28, halign: 'right' },
            5: { cellWidth: 20, halign: 'center' }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        const finalY = (doc as any).lastAutoTable.finalY + 6;
        const salesTableRight = getTableRightEdge(doc);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...B);
        doc.text(`Total Sales: Rs. ${this.totalSales.toLocaleString()}`, salesTableRight, finalY, { align: 'right' });
        doc.text(`Total Paid: Rs. ${this.totalPaidSales.toLocaleString()}`, salesTableRight, finalY + 6, { align: 'right' });
        doc.text(`Total Unpaid: Rs. ${this.totalUnpaidSales.toLocaleString()}`, salesTableRight, finalY + 12, { align: 'right' });
      }

      if (this.sections.returns && this.filteredReturns.length > 0) {
        const sectionY = startSection('SALES RETURNS');

        const returnsBody = this.filteredReturns.map(r => [
          formatDate(r.return_date),
          r.return_number || '—',
          r.bill_number || '—',
          r.customer_name || 'Walk-in',
          'Rs. ' + (r.return_amount || 0).toLocaleString(),
          'Rs. ' + (r.refund_amount || 0).toLocaleString(),
          r.refund_method || 'cash'
        ]);

        autoTable(doc, {
          startY: sectionY,
          head: [['Date', 'Return #', 'Bill #', 'Customer', 'Amount', 'Refund', 'Method']],
          body: returnsBody,
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          bodyStyles: { fontSize: 8, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 22 },
            1: { cellWidth: 24 },
            2: { cellWidth: 22 },
            3: { cellWidth: 26 },
            4: { cellWidth: 26, halign: 'right' },
            5: { cellWidth: 26, halign: 'right' },
            6: { cellWidth: 18 }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        const returnFinalY = (doc as any).lastAutoTable.finalY + 6;
        const returnsTableRight = getTableRightEdge(doc);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...B);
        doc.text(`Total Returns: Rs. ${this.totalReturns.toLocaleString()}`, returnsTableRight, returnFinalY, { align: 'right' });
      }

      // ── PURCHASE RETURNS ───────────────────────────────────

      if (this.sections.purchaseReturns && this.filteredPurchaseReturns.length > 0) {
        const sectionY = startSection('PURCHASE RETURNS');

        const purchaseReturnsBody = this.filteredPurchaseReturns.map(r => [
          formatDate(r.return_date),
          r.return_number || '—',
          r.product_name || '—',
          r.supplier_name || '—',
          String(r.quantity || 0),
          'Rs. ' + (r.return_amount || 0).toLocaleString(),
          r.refund_method || 'cash',
          r.reason || '—'
        ]);

        autoTable(doc, {
          startY: sectionY,
          head: [['Date', 'Return #', 'Product', 'Supplier', 'Qty', 'Amount', 'Method', 'Reason']],
          body: purchaseReturnsBody,
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          bodyStyles: { fontSize: 8, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 18 },
            1: { cellWidth: 18 },
            2: { cellWidth: 24 },
            3: { cellWidth: 24 },
            4: { cellWidth: 14, halign: 'right' },
            5: { cellWidth: 26, halign: 'right' },
            6: { cellWidth: 18 },
            7: { cellWidth: 24 }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        const purchaseReturnFinalY = (doc as any).lastAutoTable.finalY + 6;
        const purchaseReturnsTableRight = getTableRightEdge(doc);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...B);
        doc.text(`Total Purchase Returns: Rs. ${this.totalPurchaseReturns.toLocaleString()}`, purchaseReturnsTableRight, purchaseReturnFinalY, { align: 'right' });
      }

      // ── EXPENSES ───────────────────────────────────────────

      if (this.sections.expenses && this.filteredExpenses.length > 0) {
        const sectionY = startSection('DISTRIBUTION EXPENSES');

        const expensesBody = this.filteredExpenses.map(e => [
          formatDate(e.transaction_date),
          e.category || '—',
          e.description || '—',
          e.payment_type || 'cash',
          'Rs. ' + (e.amount || 0).toLocaleString()
        ]);

        autoTable(doc, {
          startY: sectionY,
          head: [['Date', 'Category', 'Description', 'Payment Type', 'Amount']],
          body: expensesBody.length > 0 ? expensesBody : [['No expenses found', '', '', '', '']],
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          bodyStyles: { fontSize: 8, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 22 },
            1: { cellWidth: 30 },
            2: { cellWidth: 60 },
            3: { cellWidth: 22 },
            4: { cellWidth: 28, halign: 'right' }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        const finalY = (doc as any).lastAutoTable.finalY + 6;
        const expensesTableRight = getTableRightEdge(doc);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...B);
        doc.text(`Total Expenses: Rs. ${this.totalExpenses.toLocaleString()}`, expensesTableRight, finalY, { align: 'right' });
      }

      // ── SUPPLIER PAYABLES ──────────────────────────────────
      //
      // "Supplier ki payment ka kitna dena hai kitna lena hai on reports",
      // plus which account each payment came from. Every figure is derived
      // from `supplier_ledger` at load time — the payable is
      // `SUM(credit - debit)` over it and is stored nowhere — so this page
      // cannot disagree with the Supplier Ledger screen.
      //
      // NOT date-filtered, and deliberately printed apart from the SUMMARY
      // page: a payable is a balance as at today, not a flow for the period,
      // and it is not an expense. Putting it in the profit list would invite
      // someone to subtract it from a profit that already counts the stock it
      // paid for.

      if (this.sections.supplierPayables && this.activeSuppliers.length > 0) {
        const sectionY = startSection('SUPPLIER PAYABLES');

        const supplierBody = this.activeSuppliers.map(sup => [
          sup.supplier_name || '—',
          sup.phone || '—',
          'Rs. ' + Math.round(Number(sup.total_purchased) || 0).toLocaleString(),
          'Rs. ' + Math.round(Number(sup.total_paid) || 0).toLocaleString(),
          (Number(sup.total_returned) || 0) > 0
            ? 'Rs. ' + Math.round(Number(sup.total_returned)).toLocaleString()
            : '—',
          'Rs. ' + Math.round(Number(sup.outstanding_balance) || 0).toLocaleString()
        ]);

        autoTable(doc, {
          startY: sectionY,
          head: [['Supplier', 'Phone', 'Purchased', 'Paid', 'Returned', 'Still Owed']],
          body: supplierBody,
          foot: [[
            'Total', '',
            'Rs. ' + Math.round(this.totalSupplierPurchased).toLocaleString(),
            'Rs. ' + Math.round(this.totalSupplierPaid).toLocaleString(),
            this.totalSupplierReturned > 0
              ? 'Rs. ' + Math.round(this.totalSupplierReturned).toLocaleString()
              : '—',
            'Rs. ' + Math.round(this.totalSupplierPayable).toLocaleString()
          ]],
          theme: 'striped',
          headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
          footStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [240, 240, 240], textColor: B },
          bodyStyles: { fontSize: 8, textColor: B },
          margin: { left: margin, right: margin },
          columnStyles: {
            0: { cellWidth: 40 },
            1: { cellWidth: 26 },
            2: { cellWidth: 29, halign: 'right' },
            3: { cellWidth: 29, halign: 'right' },
            4: { cellWidth: 26, halign: 'right' },
            5: { cellWidth: 32, halign: 'right' }
          },
          didParseCell: alignHeadFootWithColumnStyles
        });

        let supY = (doc as any).lastAutoTable.finalY + 8;

        if (this.totalSupplierReturned > 0) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(...G);
          doc.text(
            '* Returned is stock sent back to the supplier. It reduces what is owed, but it is not ' +
            'money paid, so it is shown apart from Paid.',
            margin, supY
          );
          supY += 8;
        }

        // Which account the money came out of.
        if (this.supplierPaymentAccounts.length > 0) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(...B);
          doc.text('PAYMENTS BY ACCOUNT', margin, supY);
          supY += 4;

          autoTable(doc, {
            startY: supY,
            head: [['Account', 'Payments', 'Amount Paid']],
            body: this.supplierPaymentAccounts.map(acc => [
              this.accountLabel(acc),
              String(acc.payment_count || 0),
              'Rs. ' + Math.round(Number(acc.total_paid) || 0).toLocaleString()
            ]),
            foot: [[
              'Total Paid to Suppliers', '',
              'Rs. ' + Math.round(this.totalSupplierPaid).toLocaleString()
            ]],
            theme: 'striped',
            headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
            footStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [240, 240, 240], textColor: B },
            bodyStyles: { fontSize: 8, textColor: B },
            margin: { left: margin, right: margin },
            columnStyles: {
              0: { cellWidth: 92 },
              1: { cellWidth: 30, halign: 'right' },
              2: { cellWidth: 60, halign: 'right' }
            },
            didParseCell: alignHeadFootWithColumnStyles
          });

          supY = (doc as any).lastAutoTable.finalY + 6;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(...G);
          doc.text(
            // Wrapped, not drawn as one line: at 7pt this runs 198mm wide and
            // would finish ~2mm past the 210mm page edge, clipping its last
            // word. The sibling notes above split the same way.
            doc.splitTextToSize(
              '* Cash means no bank account was recorded against the payment. Bank-attributed supplier ' +
              'payments are entered through Payment Voucher, which records the withdrawal with them.',
              pw - margin * 2
            ),
            margin, supY
          );
        }
      }

      // ── FOOTER ─────────────────────────────────────────────

      const totalPages = (doc.internal as any).getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7.5);
        doc.setTextColor(...G);
        doc.text(footer, pw / 2, ph - 9, { align: 'center' });
        doc.text('Page ' + i + ' of ' + totalPages, pw / 2, ph - 4, { align: 'center' });
      }

      await this.printPdf(doc, farmName + '-Distribution-Report.pdf');

    } catch (error) {
      console.error('PDF Generation Error:', error);
    } finally {
      this.isGenerating = false;
      this.cdr.detectChanges();
    }
  }

  private async printPdf(doc: jsPDF, filename: string) {
    try {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1];
      const result = await printPdfBase64(base64);
      if (!result || !result.success) {
        console.error('Print failed, falling back to save:', result?.error);
        doc.save(filename);
      }
    } catch (e) {
      console.error('Print error, falling back to save:', e);
      doc.save(filename);
    }
  }

  // ── HELPER: Add Page Header ──────────────────────────────

  private addPageHeader(doc: jsPDF, farmName: string, date: string, title: string) {
    const pw = doc.internal.pageSize.getWidth();
    const B: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [120, 120, 120];

    doc.setFontSize(8);
    doc.setTextColor(...G);
    doc.text('FarmInfantary', 14, 9);
    doc.text(date, pw - 14, 9, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...B);
    doc.text(title, 14, 22);

    doc.setDrawColor(...B);
    doc.setLineWidth(0.5);
    doc.line(14, 25, pw - 14, 25);
  }

  // ── HELPER: Load Image ────────────────────────────────────

  private loadImageAsBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')!.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Logo load failed'));
      img.src = url;
    });
  }
}
