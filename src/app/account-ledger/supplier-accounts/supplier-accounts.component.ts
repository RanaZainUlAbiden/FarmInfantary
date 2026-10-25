import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { DatabaseService } from '../../shared/services/database.service';
import { AuthService } from '../../shared/services/auth.service';
import { toLocalDateString } from '../../shared/utils/date.util';
import { friendlySqlError } from '../../shared/utils/sql-error.util';
import { paymentSourceLabel } from '../../shared/utils/bank-source.util';
import { alignHeadFootWithColumnStyles, getTableRightEdge } from '../../shared/utils/pdf-table.util';
import { BackLinkComponent } from '../../shared/components/back-link/back-link.component';
import { printPdfBase64 } from '../../shared/utils/browser-print.util';
import {
  isSupplierPayment, supplierRowLabel, supplierTotals, SupplierTotals
} from '../../shared/utils/supplier-ledger.util';

/**
 * SUPPLIER ACCOUNTS — the entity-based view of what the farm owes its
 * suppliers, and the mirror of the Customer Accounts screen beside it.
 *
 * A SIBLING OF SUPPLIER LEDGER, NEVER A REPLACEMENT. The two are a bank
 * account screen and a bank statement: Supplier Ledger is the row-by-row
 * statement with a running balance, and the place a manual cash payment is
 * entered or a line deleted; this screen is the party — one card per supplier
 * with their standing figures, and a drilldown that gathers everything about
 * that one supplier in one place (statement, purchases, payments, and which
 * account each payment came out of). Both coexist deliberately.
 *
 * NOTHING HERE DERIVES A FIGURE OF ITS OWN. The payable is
 * `SUM(credit - debit)` over `supplier_ledger`, stored nowhere — there is no
 * `suppliers.outstanding_balance` and there must never be one. The cards read
 * `getAllSuppliersWithBalance()`; the drilldown's summary comes from
 * `supplierTotals()` over the very rows the statement table lists. Those are
 * the same two doors the Supplier Ledger screen uses, so the two screens
 * cannot print different numbers for one supplier. The account breakdown is
 * `getSupplierPaymentsByAccount()`, unchanged.
 *
 * NO PAYMENT FORM. "Record Payment" hands off to Distribution > Payment
 * Voucher with `?supplierId=`, which is the one supplier-payment door that
 * writes the `supplier_ledger` debit AND the matching bank withdrawal in one
 * batch. A second payment flow here would either repeat that or — worse —
 * offer Bank with nothing to post the withdrawal to.
 */
@Component({
  selector: 'app-supplier-accounts',
  standalone: true,
  imports: [CommonModule, FormsModule, BackLinkComponent],
  templateUrl: './supplier-accounts.component.html',
  styleUrl: './supplier-accounts.component.scss'
})
export class SupplierAccountsComponent implements OnInit {
  currentFarm: any = null;

  /** One card per supplier, straight off `getAllSuppliersWithBalance()`. */
  suppliers: any[] = [];
  filteredSuppliers: any[] = [];
  searchTerm = '';

  selectedSupplier: any = null;
  /** The statement — the same rows, in the same order, as Supplier Ledger. */
  ledgerEntries: any[] = [];
  /** Every `purchase_orders` row raised against this supplier. */
  purchases: any[] = [];
  /** What was paid to them, split by the account it came out of. */
  paymentsByAccount: any[] = [];

  isLoading = true;
  errorMessage = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();

    this.route.params.subscribe(params => {
      const supplierId = params['id'];
      if (supplierId) {
        this.loadSupplierDetail(Number(supplierId));
      } else {
        this.loadSuppliers();
      }
    });
  }

  // ── LOAD ──────────────────────────────────────────────────

  /**
   * The cards.
   *
   * Two reads, because `getAllSuppliersWithBalance()` carries the money and
   * nothing else — the last transaction date is the one card figure it does
   * not return, and it is read here rather than bolted onto that query, which
   * four other screens share.
   */
  async loadSuppliers() {
    this.isLoading = true;
    this.errorMessage = '';
    this.selectedSupplier = null;

    try {
      const result = await this.db.getAllSuppliersWithBalance(this.currentFarm.farm_id);
      if (!result.success) throw new Error(friendlySqlError(result.error, 'unknown error.'));
      this.suppliers = result.data || [];

      const lastSeen = await this.db.get(
        `SELECT l.supplier_id, MAX(l.transaction_date) AS last_transaction_date,
                COUNT(*) AS transaction_count
         FROM supplier_ledger l
         INNER JOIN suppliers s ON s.supplier_id = l.supplier_id
         WHERE s.farm_id = ?
         GROUP BY l.supplier_id`,
        [this.currentFarm.farm_id]
      );
      const byId = new Map<number, any>();
      for (const row of (lastSeen.success ? lastSeen.data || [] : [])) {
        byId.set(Number(row.supplier_id), row);
      }
      for (const supplier of this.suppliers) {
        const seen = byId.get(Number(supplier.supplier_id));
        supplier.last_transaction_date = seen?.last_transaction_date || null;
        supplier.transaction_count = Number(seen?.transaction_count) || 0;
      }

      this.applyFilter();
    } catch (error: any) {
      this.errorMessage = 'Failed to load supplier accounts: ' + (error?.message || error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadSupplierDetail(supplierId: number) {
    this.isLoading = true;
    this.errorMessage = '';
    this.selectedSupplier = null;
    this.ledgerEntries = [];
    this.purchases = [];
    this.paymentsByAccount = [];

    try {
      // Scoped on farm_id as well as the id: the id is the thing a stale route
      // carries, and supplier ids are database-wide rather than per account.
      const supplierRes = await this.db.get(
        `SELECT * FROM suppliers WHERE supplier_id = ? AND farm_id = ?`,
        [supplierId, this.currentFarm.farm_id]
      );
      const supplier = supplierRes.success ? (supplierRes.data || [])[0] : null;
      if (!supplier) {
        this.errorMessage = 'Supplier not found';
        return;
      }
      this.selectedSupplier = supplier;

      const ledgerRes = await this.db.getSupplierLedgerWithBalance(
        supplierId, this.currentFarm.farm_id);
      this.ledgerEntries = ledgerRes.success ? (ledgerRes.data || []) : [];

      // The order side, for the Purchases list. `bank_name` is read live off
      // `bank_accounts` rather than stored on the order, so renaming an
      // account propagates — the same shape the Distribution report uses.
      const purchaseRes = await this.db.get(
        `SELECT po.purchase_id, po.date, po.quantity, po.cost_price, po.total_amount,
                po.payment_type, po.payment_source, po.bank_id, po.notes,
                p.product_name, b.bank_name
         FROM purchase_orders po
         LEFT JOIN products p ON p.product_id = po.product_id
         LEFT JOIN bank_accounts b ON b.bank_id = po.bank_id
         WHERE po.farm_id = ? AND po.supplier_id = ?
         ORDER BY po.date DESC, po.purchase_id DESC`,
        [this.currentFarm.farm_id, supplierId]
      );
      this.purchases = purchaseRes.success ? (purchaseRes.data || []) : [];

      const accountsRes = await this.db.getSupplierPaymentsByAccount(
        this.currentFarm.farm_id, supplierId);
      this.paymentsByAccount = accountsRes.success ? (accountsRes.data || []) : [];
    } catch (error: any) {
      this.errorMessage = 'Failed to load supplier: ' + (error?.message || error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── SEARCH ────────────────────────────────────────────────

  applyFilter() {
    const term = this.searchTerm.trim().toLowerCase();
    this.filteredSuppliers = !term
      ? [...this.suppliers]
      : this.suppliers.filter(s =>
          (s.supplier_name || '').toLowerCase().includes(term) ||
          (s.phone || '').includes(term) ||
          (s.products_supplied || '').toLowerCase().includes(term));
    this.cdr.detectChanges();
  }

  clearSearch() {
    this.searchTerm = '';
    this.applyFilter();
  }

  // ── LIST FIGURES ─────────────────────────────────────────
  //
  // Sums of the card figures shown, never a second query.

  getTotalPurchased(): number {
    return this.filteredSuppliers.reduce((sum, s) => sum + (Number(s.total_purchased) || 0), 0);
  }

  getTotalPaid(): number {
    return this.filteredSuppliers.reduce((sum, s) => sum + (Number(s.total_paid) || 0), 0);
  }

  getTotalPayable(): number {
    return this.filteredSuppliers.reduce((sum, s) => sum + (Number(s.outstanding_balance) || 0), 0);
  }

  // ── DRILLDOWN FIGURES ────────────────────────────────────

  /**
   * Purchased / paid / payable for the supplier on screen, off the rows on
   * screen — `supplierTotals()` owns the bucket predicates, shared with the
   * SQL behind the cards. The drilldown and the card are two code paths onto
   * one set of numbers, so neither restates them.
   */
  get totals(): SupplierTotals {
    return supplierTotals(this.ledgerEntries);
  }

  /** The money-out rows, newest first — the Payments list. */
  get paymentHistory(): any[] {
    return this.ledgerEntries.filter(e => isSupplierPayment(e)).slice().reverse();
  }

  /** What the statement closes at: the payable, summed off the rows. */
  getSupplierBalance(): number {
    return this.totals.outstanding;
  }

  /** What the Purchases list adds up to. */
  getPurchaseOrderTotal(): number {
    return this.purchases.reduce((sum, p) => sum + (Number(p.total_amount) || 0), 0);
  }

  /** What the Payments list adds up to — equal to the summary's Paid. */
  getPaymentsTotal(): number {
    return this.paymentHistory.reduce((sum, e) => sum + (Number(e.debit) || 0), 0);
  }

  /** 'Purchase (paid)', 'Return', 'Payment voucher'… */
  rowLabel(entry: any): string {
    return supplierRowLabel(entry);
  }

  /** 'Cash' or 'Bank · <account>' — never a cash/credit test. */
  accountLabel(row: any): string {
    return paymentSourceLabel(row);
  }

  /** A row that moved no money has no account to name. */
  hasAccount(entry: any): boolean {
    return isSupplierPayment(entry);
  }

  /** Was this order settled when it was raised? */
  isPaidOrder(purchase: any): boolean {
    return (purchase?.payment_type || '').toLowerCase() !== 'credit';
  }

  // ── NAVIGATION ───────────────────────────────────────────

  selectSupplier(supplier: any) {
    this.router.navigate(['/app/supplier-accounts', supplier.supplier_id]);
  }

  goBack() {
    this.router.navigate(['/app/supplier-accounts']);
  }

  /**
   * Record Payment — the hand-off, not a second payment flow.
   *
   * Payment Voucher is the only supplier-payment door that attributes a bank
   * account, because it writes the `supplier_ledger` debit and the
   * `bank_ledger` withdrawal in one batch. The nonce is the same trick the
   * sidebar's Add shortcuts use: Angular ignores a navigation to the URL it is
   * already on, so a repeat click would otherwise not reopen the form.
   */
  recordPayment() {
    if (!this.selectedSupplier) return;
    this.router.navigate(['/app/payment-voucher'], {
      queryParams: { supplierId: this.selectedSupplier.supplier_id, t: Date.now() }
    });
  }

  /** Across to the row-by-row statement screen, on the same supplier. */
  viewStatement() {
    if (!this.selectedSupplier) return;
    this.router.navigate(['/app/supplier-ledger', this.selectedSupplier.supplier_id]);
  }

  // ── PRINT ────────────────────────────────────────────────

  async printReport() {
    if (!this.selectedSupplier) return;

    const doc = new jsPDF('p', 'mm', 'a4');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const B: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [120, 120, 120];
    const farmName = this.currentFarm?.farm_name || 'Farm';
    const today = toLocalDateString();
    const margin = 14;
    const pageWidth = pw - (margin * 2);
    const t = this.totals;

    let y = 20;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...B);
    doc.text(farmName.toUpperCase(), pw / 2, y, { align: 'center' });
    y += 8;

    doc.setFontSize(14);
    doc.text('SUPPLIER ACCOUNT', pw / 2, y, { align: 'center' });
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...G);
    doc.text(`Report Date: ${today}`, margin, y);
    doc.text(`Farm ID: ${this.currentFarm?.farm_id || ''}`, pw - margin, y, { align: 'right' });
    y += 10;

    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...B);
    doc.text(this.selectedSupplier.supplier_name || 'Supplier', margin, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Phone: ${this.selectedSupplier.phone || 'N/A'}`, margin, y);
    doc.text(`Products: ${this.selectedSupplier.products_supplied || 'N/A'}`, margin + 70, y);
    y += 5;
    doc.text(`Total Purchased: Rs. ${Math.round(t.purchased).toLocaleString()}`, margin, y);
    doc.text(`Total Paid: Rs. ${Math.round(t.paid).toLocaleString()}`, margin + 70, y);
    y += 5;
    if (t.returned > 0) {
      doc.text(`Returned to Supplier: Rs. ${Math.round(t.returned).toLocaleString()}`, margin, y);
      y += 5;
    }
    if (t.otherCharges > 0) {
      doc.text(`Other Charges: Rs. ${Math.round(t.otherCharges).toLocaleString()}`, margin, y);
      y += 5;
    }
    doc.setFont('helvetica', 'bold');
    doc.text(`Outstanding Payable: Rs. ${Math.round(t.outstanding).toLocaleString()}`, margin, y);
    doc.setFont('helvetica', 'normal');
    y += 10;

    // ── PURCHASES ───────────────────────────────────────────
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Product', 'Qty', 'Rate', 'Amount', 'Payment']],
      body: this.purchases.length > 0
        ? this.purchases.map((p: any) => [
            p.date || '',
            p.product_name || '—',
            String(Number(p.quantity) || 0),
            'Rs. ' + Math.round(Number(p.cost_price) || 0).toLocaleString(),
            'Rs. ' + Math.round(Number(p.total_amount) || 0).toLocaleString(),
            this.isPaidOrder(p) ? this.accountLabel(p) : 'Credit'
          ])
        : [['No purchases recorded', '', '', '', '', '']],
      theme: 'striped',
      headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [21, 101, 192], textColor: [255, 255, 255], halign: 'center' },
      bodyStyles: { fontSize: 8, textColor: [0, 0, 0], halign: 'center' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      margin: { left: margin, right: margin },
      // 24+48+18+28+30+34 = 182 = pageWidth, so nothing is squeezed out.
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 48 },
        2: { cellWidth: 18, halign: 'right' },
        3: { cellWidth: 28, halign: 'right' },
        4: { cellWidth: 30, halign: 'right' },
        5: { cellWidth: 34 }
      },
      tableWidth: pageWidth,
      styles: { overflow: 'linebreak', cellPadding: 3 },
      didParseCell: alignHeadFootWithColumnStyles
    });
    y = (doc as any).lastAutoTable.finalY + 8;

    // ── PAYMENTS ────────────────────────────────────────────
    const history = this.paymentHistory;
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Description', 'Type', 'Account', 'Amount']],
      body: history.length > 0
        ? history.map((e: any) => [
            e.transaction_date || '',
            e.description || '—',
            this.rowLabel(e),
            this.accountLabel(e),
            'Rs. ' + Math.round(Number(e.debit) || 0).toLocaleString()
          ])
        : [['No payments recorded', '', '', '', '']],
      theme: 'striped',
      headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [46, 125, 50], textColor: [255, 255, 255], halign: 'center' },
      bodyStyles: { fontSize: 8, textColor: [0, 0, 0], halign: 'center' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      margin: { left: margin, right: margin },
      // 24+56+28+44+30 = 182 = pageWidth.
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 56 },
        2: { cellWidth: 28 },
        3: { cellWidth: 44 },
        4: { cellWidth: 30, halign: 'right' }
      },
      tableWidth: pageWidth,
      styles: { overflow: 'linebreak', cellPadding: 3 },
      didParseCell: alignHeadFootWithColumnStyles,
      didDrawPage: () => {
        const pageNumber = (doc as any).getNumberOfPages();
        doc.setFontSize(7);
        doc.setTextColor(...G);
        doc.text(`Page ${pageNumber}`, pw / 2, ph - 8, { align: 'center' });
        doc.setTextColor(...B);
      }
    });
    y = (doc as any).lastAutoTable.finalY + 8;
    const tableRight = getTableRightEdge(doc);

    // ── WHICH ACCOUNT THE PAYMENTS CAME FROM ────────────────
    if (this.paymentsByAccount.length > 0 && y < ph - 30) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...B);
      doc.text('PAYMENTS BY ACCOUNT', margin, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      for (const acc of this.paymentsByAccount) {
        if (y > ph - 20) break;
        doc.setTextColor(...G);
        doc.text(`${this.accountLabel(acc)} (${acc.payment_count})`, margin + 6, y);
        doc.setTextColor(...B);
        doc.text(`Rs. ${Math.round(Number(acc.total_paid) || 0).toLocaleString()}`,
          tableRight, y, { align: 'right' });
        y += 5;
      }
    }

    doc.setFontSize(7);
    doc.setTextColor(...G);
    doc.text('Generated by: www.devinfantary.com  |  Contact: 0302 6938217',
      pw / 2, ph - 4, { align: 'center' });

    await this.printPdf(doc,
      `Supplier_Account_${this.selectedSupplier.supplier_name}_${today}.pdf`);
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
}
