import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DatabaseService } from '../../shared/services/database.service';
import { AuthService } from '../../shared/services/auth.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { alignHeadFootWithColumnStyles, getTableRightEdge } from '../../shared/utils/pdf-table.util';
import { DeleteCodeDialogComponent } from '../../shared/components/delete-code-dialog/delete-code-dialog.component';

import { toLocalDateString } from '../../shared/utils/date.util';
import { friendlySqlError } from '../../shared/utils/sql-error.util';
import { paymentSourceLabel } from '../../shared/utils/bank-source.util';
import { BackLinkComponent } from '../../shared/components/back-link/back-link.component';
import {
  isSupplierPayment, supplierRowLabel, supplierTotals, SupplierTotals
} from '../../shared/utils/supplier-ledger.util';
import { filterByDateRange, dateRangeLabel } from '../../shared/utils/date-range.util';
import { printPdfBase64 } from '../../shared/utils/browser-print.util';
@Component({
  selector: 'app-supplier-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, BackLinkComponent],
  templateUrl: './supplier-ledger.component.html',
  styleUrl: './supplier-ledger.component.scss'
})
export class SupplierLedgerComponent implements OnInit {
  currentFarm: any = null;
  suppliers: any[] = [];
  filteredSuppliers: any[] = [];
  selectedSupplier: any = null;
  ledgerEntries: any[] = [];
  /** Which account each payment to this supplier came from. */
  paymentsByAccount: any[] = [];
  isLoading = true;
  errorMessage = '';
  searchTerm: string = '';
  
  // Payment form
  showPaymentForm = false;
  paymentAmount: number = 0;
  paymentDate: string = '';
  /** Becomes the row's `description` — what the line IS. */
  paymentNote: string = '';
  /** Becomes the row's `notes` — the client's own free text about it. */
  paymentNotes: string = '';
  isSubmitting = false;
  
  showDeleteDialog = false;
  showDeleteCodeDialog: boolean = false;
  deletingEntryId: number | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.paymentDate = toLocalDateString();
    
    this.route.params.subscribe(params => {
      const supplierId = params['id'];
      if (supplierId) {
        this.loadSupplierDetail(supplierId);
      } else {
        this.loadSuppliers();
      }
    });
  }

  // ── LOAD METHODS ──────────────────────────────────────────

  async loadSuppliers() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      const result = await this.db.getAllSuppliersWithBalance(this.currentFarm.farm_id);
      if (result.success) {
        this.suppliers = result.data || [];
        this.filteredSuppliers = [...this.suppliers];
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to load suppliers: ' + error.message;
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
    this.paymentsByAccount = [];

    try {
      const supplierResult = await this.db.get(
        'SELECT * FROM suppliers WHERE supplier_id = ? AND farm_id = ?',
        [supplierId, this.currentFarm.farm_id]
      );

      if (supplierResult.success && supplierResult.data && supplierResult.data.length > 0) {
        this.selectedSupplier = supplierResult.data[0];

        const ledgerResult = await this.db.getSupplierLedgerWithBalance(supplierId, this.currentFarm.farm_id);
        if (ledgerResult.success) {
          this.ledgerEntries = ledgerResult.data || [];
        }

        const accountsResult = await this.db.getSupplierPaymentsByAccount(
          this.currentFarm.farm_id, supplierId);
        if (accountsResult.success) {
          this.paymentsByAccount = accountsResult.data || [];
        }
      } else {
        this.errorMessage = 'Supplier not found';
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to load supplier details: ' + error.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── SEARCH METHODS ────────────────────────────────────────

  filterSuppliers() {
    if (!this.searchTerm.trim()) {
      this.filteredSuppliers = [...this.suppliers];
      return;
    }
    
    const term = this.searchTerm.toLowerCase().trim();
    this.filteredSuppliers = this.suppliers.filter(s => 
      s.supplier_name.toLowerCase().includes(term) ||
      (s.phone && s.phone.includes(term))
    );
    this.cdr.detectChanges();
  }

  clearSearch() {
    this.searchTerm = '';
    this.filteredSuppliers = [...this.suppliers];
    this.cdr.detectChanges();
  }

  // ── NAVIGATION METHODS ────────────────────────────────────

  selectSupplier(supplier: any) {
    this.router.navigateByUrl(`/app/supplier-ledger/${supplier.supplier_id}`).then(
      (success) => {
        if (!success) {
          console.error('Navigation failed');
          this.router.navigate(['/app/supplier-ledger', supplier.supplier_id]);
        }
      }
    );
  }

  goBack() {
    this.selectedSupplier = null;
    this.ledgerEntries = [];
    this.searchTerm = '';
    this.router.navigate(['/app/supplier-ledger']).then(() => {
      this.loadSuppliers();
    });
  }

  // ── CALCULATION METHODS ──────────────────────────────────

  getTotalPayable(): number {
    return this.filteredSuppliers.reduce((sum, s) => sum + (s.outstanding_balance || 0), 0);
  }

  /** Across the list: what was bought from every supplier shown. */
  getTotalPurchased(): number {
    return this.filteredSuppliers.reduce((sum, s) => sum + (Number(s.total_purchased) || 0), 0);
  }

  /** Across the list: what has actually been paid to them. */
  getTotalPaid(): number {
    return this.filteredSuppliers.reduce((sum, s) => sum + (Number(s.total_paid) || 0), 0);
  }

  /**
   * The four figures for the supplier on screen, off the rows on screen.
   *
   * `supplierTotals()` owns the bucket predicates, shared with the SQL in
   * `getAllSuppliersWithBalance()` — the list row and this detail view are two
   * code paths onto the same numbers, so neither restates them.
   */
  get totals(): SupplierTotals {
    return supplierTotals(this.ledgerEntries);
  }

  // `getTotalDebit()` and `getTotalCredit()` used to live here, as raw
  // SUM(debit) and SUM(credit) over the statement, and were shown as "Total
  // Debit (Payments)" and "Total Credit (Purchases)". Both labels were wrong:
  // SUM(debit) counts a purchase RETURN as a payment, so the screen claimed
  // the farm had paid money it had not. They are gone rather than left unused
  // — `totals` above is the replacement, and nothing should reach for the raw
  // sums again. See `supplier-ledger.util.ts`.

  getSupplierBalance(): number {
    return this.ledgerEntries.reduce((sum, e) => sum + (Number(e.credit) || 0) - (Number(e.debit) || 0), 0);
  }

  // ── THE DATE RANGE ───────────────────────────────────────
  //
  // Narrows the LISTED ROWS and nothing else. Every figure in the summary
  // block above the table — and the payable in particular — goes on being read
  // over `ledgerEntries`, the full history, because a payable is what is owed
  // NOW and because that block is an identity that filtering four of its five
  // terms would break. See `date-range.util.ts`.
  dateFrom: string = '';
  dateTo: string = '';

  /** The rows the statement, the payment history and the PDF all show. */
  get visibleEntries(): any[] {
    return filterByDateRange(this.ledgerEntries, 'transaction_date', this.dateFrom, this.dateTo);
  }

  /** '2026-10-01 to 2026-10-31', or '' when nothing is filtered. */
  get rangeLabel(): string {
    return dateRangeLabel(this.dateFrom, this.dateTo);
  }

  get isDateFiltered(): boolean {
    return !!(this.dateFrom || this.dateTo);
  }

  clearDateRange() {
    this.dateFrom = '';
    this.dateTo = '';
    this.cdr.detectChanges();
  }

  /** The money-out rows, newest first — the payment history. */
  get paymentHistory(): any[] {
    return this.visibleEntries
      .filter(e => isSupplierPayment(e))
      .slice()
      .reverse();
  }

  /** 'Purchase (paid)', 'Return', 'Payment voucher'… */
  rowLabel(entry: any): string {
    return supplierRowLabel(entry);
  }

  /**
   * Which account a row's money moved through: 'Cash', or 'Bank · <account>'.
   *
   * Always `paymentSourceLabel()`, never a `cash ? : 'Credit'` test — the row's
   * `payment_source` is resolved by the query from the voucher or the purchase
   * order that recorded the movement, and a row with none is honestly Cash.
   */
  accountLabel(entry: any): string {
    return paymentSourceLabel(entry);
  }

  /** A row that moved no money has no account to name. */
  hasAccount(entry: any): boolean {
    return isSupplierPayment(entry);
  }

  // ── PAYMENT METHODS ──────────────────────────────────────
  //
  // THIS PAYMENT IS CASH-ONLY, AND DELIBERATELY SO. There is no Cash/Bank
  // selector here and must not be one: `supplier_ledger` carries no
  // `payment_source`/`bank_id`, so it is not a `BANK_SOURCES` table and this
  // write cannot post the matching `bank_ledger` entry. Offering "Bank" here
  // would record a bank payment that never reaches the bank account — exactly
  // the defect Change 1 exists to prevent, and the reason every other money
  // screen refuses to save Bank without an account.
  //
  // A supplier payment that came out of a named account goes through
  // DISTRIBUTION > PAYMENT VOUCHER, which writes this same single
  // `supplier_ledger` debit (`supplierLedgerEntryOp`, shared) AND the
  // withdrawal, in one batch. Its rows show up in this ledger with the account
  // named, so nothing is hidden from this screen — it just is not entered here.
  // The form says so too, so a user looking for the bank option is told where
  // it is rather than left guessing.

  openPaymentForm() {
    this.showPaymentForm = true;
    this.paymentAmount = this.getSupplierBalance();
    this.paymentDate = toLocalDateString();
    this.paymentNote = '';
    this.paymentNotes = '';
  }

  closePaymentForm() {
    this.showPaymentForm = false;
    this.paymentAmount = 0;
    this.paymentNote = '';
    this.paymentNotes = '';
  }

  async submitPayment() {
    if (!this.paymentAmount || this.paymentAmount <= 0) {
      this.errorMessage = 'Please enter a valid payment amount';
      return;
    }
    
    if (this.paymentAmount > this.getSupplierBalance()) {
      this.errorMessage = 'Payment amount cannot exceed total payable';
      return;
    }

    this.isSubmitting = true;
    this.errorMessage = '';

    try {
      // `addSupplierLedgerEntry` reports a failure in `.success` rather than
      // throwing, so without this check a refused write closed the form and
      // reloaded the screen as if the payment had been recorded.
      const res = await this.db.addSupplierLedgerEntry({
        supplier_id: this.selectedSupplier.supplier_id,
        transaction_date: this.paymentDate,
        description: this.paymentNote || 'Payment made',
        debit: this.paymentAmount,
        reference_type: 'payment',
        notes: (this.paymentNotes || '').trim() || null
      });
      if (!res?.success) {
        this.errorMessage = 'Failed to record payment: ' +
          (res?.error || 'the database refused the change.') + ' Nothing was recorded.';
        return;
      }

      this.closePaymentForm();
      await this.loadSupplierDetail(this.selectedSupplier.supplier_id);
      
    } catch (error: any) {
      this.errorMessage = 'Failed to record payment: ' + error.message;
    } finally {
      this.isSubmitting = false;
      this.cdr.detectChanges();
    }
  }

  // ── DELETE METHODS ──────────────────────────────────────

  confirmDeleteEntry(entryId: number) {
    this.deletingEntryId = entryId;
    this.showDeleteCodeDialog = true;
  }

  onDeleteCodeVerified() {
    this.showDeleteCodeDialog = false;
    this.showDeleteDialog = true;
  }

  onDeleteCodeCancelled() {
    this.showDeleteCodeDialog = false;
    this.deletingEntryId = null;
  }

  /**
   * A supplier's payable IS this ledger — `SUM(credit - debit)` over these very
   * rows, with no `bills.amount_paid` behind it the way the customer side has —
   * so removing the row already reverses the payment. What the service adds is
   * the refusal of a purchase row and a result that is actually checked:
   * `run()` reports a refusal in `.success`, so the old catch never saw one and
   * a refused delete closed the dialog looking like it had worked.
   */
  async onDeleteConfirmed() {
    if (!this.deletingEntryId) return;

    try {
      const result = await this.db.deleteSupplierLedgerEntry(this.deletingEntryId);
      this.showDeleteDialog = false;
      this.deletingEntryId = null;

      if (!result?.success) {
        this.errorMessage =
          'Failed to delete entry: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was changed.';
        this.cdr.detectChanges();
        return;
      }

      this.errorMessage = '';
      await this.loadSupplierDetail(this.selectedSupplier.supplier_id);
    } catch (error: any) {
      this.errorMessage = 'Failed to delete entry: ' + error.message;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingEntryId = null;
  }

  // ── PROFESSIONAL PDF REPORT ──────────────────────────────

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
    
    let y = 20;
    
    // ── HEADER ──────────────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...B);
    doc.text(farmName.toUpperCase(), pw / 2, y, { align: 'center' });
    y += 8;
    
    doc.setFontSize(14);
    doc.setTextColor(...B);
    doc.text('SUPPLIER LEDGER REPORT', pw / 2, y, { align: 'center' });
    y += 8;
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...G);
    doc.text(`Report Date: ${today}`, margin, y);
    doc.text(`Farm ID: ${this.currentFarm?.farm_id || ''}`, pw - margin, y, { align: 'right' });
    y += 10;
    
    // ── DIVIDER ─────────────────────────────────────────────
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
    
    // ── SUPPLIER INFO ──────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...B);
    doc.text('Supplier Details', margin, y);
    y += 6;
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...B);
    doc.text(`Supplier: ${this.selectedSupplier.supplier_name}`, margin, y);
    doc.text(`Phone: ${this.selectedSupplier.phone || 'N/A'}`, margin + 70, y);
    y += 5;
    doc.text(`Products Supplied: ${this.selectedSupplier.products_supplied || 'N/A'}`, margin, y);
    y += 5;
    // Which rows the statement below actually covers. Printed only when the
    // client filtered, so an unfiltered statement reads exactly as it did.
    if (this.isDateFiltered) {
      doc.text(`Transactions shown: ${this.rangeLabel}`, margin, y);
      y += 5;
    }
    const t = this.totals;
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
    // 🔥 FIX: "Current Balance" → "Total Payable"
    doc.text(`Total Payable: Rs. ${this.getSupplierBalance().toLocaleString()}`, margin, y);
    y += 10;
    
    // ── DIVIDER ─────────────────────────────────────────────
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
    
    // ── TABLE ──────────────────────────────────────────────
    // The account rides on every row, which is the whole point of the change:
    // a printed statement has to say which bank each payment came out of.
    // AMOUNTS CARRY NO 'Rs. ' PREFIX HERE, and the note under the table says so
    // once instead. It is what buys every row ONE LINE: 'Rs. 1,250,000' is
    // 17.5mm at 8pt against '1,250,000' at 12.4mm, and across the three amount
    // columns that 15mm is the difference between a Description column wide
    // enough for 'Payment Voucher PV-0001' and one that wraps it. The summary
    // block below still prints Rs. on every figure.
    const money = (n: number) => Math.round(Number(n) || 0).toLocaleString();
    // The rows the screen is showing, so a printed statement is the period the
    // client filtered to. The summary block below is lifetime and says so.
    const tableData = this.visibleEntries.map((entry: any) => [
      entry.transaction_date || '',
      entry.description || '—',
      entry.notes || '—',
      this.rowLabel(entry),
      this.hasAccount(entry) ? this.accountLabel(entry) : '—',
      entry.debit > 0 ? money(entry.debit) : '—',
      entry.credit > 0 ? money(entry.credit) : '—',
      money(entry.balance)
    ]);

    autoTable(doc, {
      startY: y,
      head: [['Date', 'Description', 'Notes', 'Type', 'Account', 'Debit', 'Credit', 'Balance']],
      body: tableData.length > 0 ? tableData : [['No transactions found', '', '', '', '', '', '', '']],
      theme: 'striped',
      headStyles: { 
        fontStyle: 'bold', 
        fontSize: 8, 
        fillColor: [21, 101, 192], 
        textColor: [255, 255, 255],
        halign: 'center'
      },
      bodyStyles: { 
        fontSize: 8, 
        textColor: [0, 0, 0],
        halign: 'center'
      },
      alternateRowStyles: {
        fillColor: [245, 245, 245]
      },
      margin: { left: margin, right: margin },
      // ONE LINE PER ROW, and the widths are derived rather than guessed.
      //
      // Every payment printed on TWO lines, which is what the client saw and
      // asked about: 'Payment Voucher PV-0001' is 33.5mm at helvetica 8pt, and
      // Description offered 36mm less 4mm of padding each side = 28mm, so
      // jspdf-autotable's `overflow: 'linebreak'` wrapped it. A purchase row
      // ('Purchase Order #12', 25.2mm) fitted, which is exactly why he noticed
      // it on payments and not on purchases.
      //
      // 4mm of padding at 8pt was the root cause: eight columns spent 64mm of
      // the 182mm available on whitespace. At 1.2mm it costs 19.2mm, and the
      // widths below give every column its own worst case:
      //
      //   Date 14.3  Description 33.5  Notes 19.9  Type 21.8
      //   Account 21.1  Debit/Credit/Balance 14.0 each
      //
      // 17+38+26+26+24+17+17+17 = 182 = pageWidth, each with >= 0.5mm to
      // spare over the longest string it can hold. Notes and Account are the
      // two whose content has no fixed length, so they are the ones that will
      // wrap first if the client writes a long note or names an account at
      // length — which is the right place for the slack to run out.
      columnStyles: {
        0: { cellWidth: 17 },
        1: { cellWidth: 38 },
        2: { cellWidth: 26 },
        3: { cellWidth: 26 },
        4: { cellWidth: 24 },
        5: { cellWidth: 17, halign: 'right' },
        6: { cellWidth: 17, halign: 'right' },
        7: { cellWidth: 17, halign: 'right' }
      },
      tableWidth: pageWidth,
      styles: {
        overflow: 'linebreak',
        cellPadding: 1.2
      },
      // jspdf-autotable only applies columnStyles to the body section — the head
      // cell otherwise keeps headStyles' halign, so a right-aligned amount column's
      // header sits centered while its values sit right.
      didParseCell: alignHeadFootWithColumnStyles,
      didDrawPage: (data: any) => {
        const pageNumber = (doc as any).getNumberOfPages();
        const totalPages = (doc as any).getNumberOfPages();
        doc.setFontSize(7);
        doc.setTextColor(...G);
        doc.text(`Page ${pageNumber} of ${totalPages}`, pw / 2, ph - 8, { align: 'center' });
      }
    });
    
    // Said once, because the amount columns no longer repeat it on every row.
    const unitNoteY = (doc as any).lastAutoTable.finalY + 4;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(...G);
    doc.text('All amounts in Rs.', margin, unitNoteY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...B);

    const finalY = (doc as any).lastAutoTable.finalY + 10;
    const supplierTableRight = getTableRightEdge(doc);

    // ── SUMMARY ─────────────────────────────────────────────
    if (finalY < ph - 40) {
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, finalY, pw - margin, finalY);
      y = finalY + 8;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...B);
      // Named as lifetime whenever the rows above are not, so the two cannot
      // be read as describing the same period. The payable in particular is
      // what is owed NOW — see `date-range.util.ts`.
      doc.text(this.isDateFiltered ? 'SUMMARY (all transactions)' : 'SUMMARY', margin, y);
      y += 6;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`Total Purchased: Rs. ${Math.round(t.purchased).toLocaleString()}`, supplierTableRight, y, { align: 'right' });
      y += 5;
      if (t.otherCharges > 0) {
        doc.text(`Other Charges: Rs. ${Math.round(t.otherCharges).toLocaleString()}`, supplierTableRight, y, { align: 'right' });
        y += 5;
      }
      doc.text(`Total Paid: Rs. ${Math.round(t.paid).toLocaleString()}`, supplierTableRight, y, { align: 'right' });
      y += 5;
      if (t.returned > 0) {
        // Named separately from the payments above it, because it is stock sent
        // back rather than money — see `supplier-ledger.util.ts`.
        doc.text(`Less: Returned to Supplier: Rs. ${Math.round(t.returned).toLocaleString()}`, supplierTableRight, y, { align: 'right' });
        y += 5;
      }
      // 🔥 FIX: "Current Balance" → "Total Payable"
      doc.text(`Total Payable: Rs. ${this.getSupplierBalance().toLocaleString()}`, supplierTableRight, y, { align: 'right' });
      y += 10;

      // ── WHICH ACCOUNT THE PAYMENTS CAME FROM ───────────────
      if (this.paymentsByAccount.length > 0 && y < ph - 30) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('PAYMENTS BY ACCOUNT', margin, y);
        y += 6;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        for (const acc of this.paymentsByAccount) {
          if (y > ph - 20) break;
          doc.setTextColor(...G);
          doc.text(`${this.accountLabel(acc)} (${acc.payment_count})`, margin + 6, y);
          doc.setTextColor(...B);
          doc.text(
            `Rs. ${Math.round(Number(acc.total_paid) || 0).toLocaleString()}`,
            supplierTableRight, y, { align: 'right' }
          );
          y += 5;
        }
        doc.setTextColor(...B);
      }
    }
    
    // ── FOOTER ──────────────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(...G);
    const footer = 'Generated by: www.devinfantary.com  |  Contact: 0302 6938217';
    doc.text(footer, pw / 2, ph - 4, { align: 'center' });
    
    await this.printPdf(doc, `Supplier_Ledger_${this.selectedSupplier.supplier_name}_${today}.pdf`);
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
