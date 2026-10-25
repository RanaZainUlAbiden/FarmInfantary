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
import { BackLinkComponent } from '../../shared/components/back-link/back-link.component';
import { filterByDateRange, dateRangeLabel } from '../../shared/utils/date-range.util';

import { printPdfBase64 } from '../../shared/utils/browser-print.util';
@Component({
  selector: 'app-customer-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, BackLinkComponent],
  templateUrl: './customer-ledger.component.html',
  styleUrl: './customer-ledger.component.scss'
})
export class CustomerLedgerComponent implements OnInit {
  currentFarm: any = null;
  customers: any[] = [];
  filteredCustomers: any[] = [];
  selectedCustomer: any = null;
  ledgerEntries: any[] = [];
  customerBills: any[] = [];
  isLoading = true;
  errorMessage = '';
  searchTerm: string = '';
  
  // Payment form
  showPaymentForm = false;
  paymentAmount: number = 0;
  paymentDate: string = '';
  paymentNote: string = '';
  isSubmitting = false;
  
  // Bill selection for payment
  selectedBillId: number | null = null;
  showBillSelection: boolean = false;
  unpaidBills: any[] = [];
  
  // Delete dialog
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
      const customerId = params['id'];
      if (customerId) {
        this.loadCustomerDetail(customerId);
      } else {
        this.loadCustomers();
      }
    });
  }

  // ── LOAD METHODS ──────────────────────────────────────────

  /**
   * Own-farm customers are INCLUDED here, deliberately — this is the screen the
   * owner's own farms settle on. Distribution bills a farm like any other
   * customer, so the farm carries a real debt, and this is where it is visible
   * and where a payment against it is recorded. Every other customer-picking
   * screen (Sales Orders, Customer Management, Bank Ledger) filters them out.
   */
  async loadCustomers() {
    this.isLoading = true;
    this.errorMessage = '';

    try {
      const result = await this.db.getAllCustomersWithBalance(this.currentFarm.farm_id);
      if (result.success) {
        this.customers = result.data || [];
        this.customers.sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0));
        this.filteredCustomers = [...this.customers];
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to load customers: ' + error.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadCustomerDetail(customerId: number) {
    this.isLoading = true;
    this.errorMessage = '';
    this.selectedCustomer = null;
    this.ledgerEntries = [];
    this.customerBills = [];
    this.unpaidBills = [];
    
    try {
      // 🔥 selectedCustomer.outstanding_balance comes from this query, and is
      // now bills-derived (see DatabaseService.updateCustomerOutstandingBalance).
      // This is what getCustomerBalance() reads from, so it always matches
      // what Sales Orders / Reports show for this customer.
      const customerResult = await this.db.get(
        `SELECT c.*,
          (SELECT COALESCE(SUM(MAX(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) FROM bills WHERE customer_id = c.customer_id) as outstanding_balance
         FROM customers c
         WHERE c.customer_id = ? AND c.farm_id = ?`,
        [customerId, this.currentFarm.farm_id]
      );
      
      if (customerResult.success && customerResult.data && customerResult.data.length > 0) {
        this.selectedCustomer = customerResult.data[0];
        
        const ledgerResult = await this.db.getCustomerLedgerWithBalance(customerId);
        if (ledgerResult.success) {
          this.ledgerEntries = ledgerResult.data || [];
        }
        
        // The customer's unpaid bills, oldest first — the allocation order
        // submitPayment() hands to customerSettlementOps(). The query moved to
        // the service unchanged so the Receive Voucher screen reads it through
        // the same method and the two cannot disagree about which bill is
        // oldest.
        const billsResult = await this.db.getUnpaidBills(customerId);
        if (billsResult.success) {
          this.customerBills = billsResult.data || [];
          this.unpaidBills = this.customerBills.filter(b => (b.amount_paid || 0) < (b.total_amount || 0));
        }
      } else {
        this.errorMessage = 'Customer not found';
      }
    } catch (error: any) {
      this.errorMessage = 'Failed to load customer details: ' + error.message;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  // ── SEARCH METHODS ────────────────────────────────────────

  filterCustomers() {
    if (!this.searchTerm.trim()) {
      this.filteredCustomers = [...this.customers];
      return;
    }
    
    const term = this.searchTerm.toLowerCase().trim();
    this.filteredCustomers = this.customers.filter(c => 
      c.customer_name.toLowerCase().includes(term) ||
      (c.phone && c.phone.includes(term))
    );
    this.cdr.detectChanges();
  }

  clearSearch() {
    this.searchTerm = '';
    this.filteredCustomers = [...this.customers];
    this.cdr.detectChanges();
  }

  // ── NAVIGATION METHODS ────────────────────────────────────

  selectCustomer(customer: any) {
    this.router.navigateByUrl(`/app/customer-ledger/${customer.customer_id}`).then(
      (success) => {
        if (!success) {
          console.error('Navigation failed');
          this.router.navigate(['/app/customer-ledger', customer.customer_id]);
        }
      }
    );
  }

  goBack() {
    this.selectedCustomer = null;
    this.ledgerEntries = [];
    this.customerBills = [];
    this.unpaidBills = [];
    this.searchTerm = '';
    this.router.navigate(['/app/customer-ledger']).then(() => {
      this.loadCustomers();
    });
  }

  // ── CALCULATION METHODS ──────────────────────────────────

  getTotalOutstanding(): number {
    return this.filteredCustomers.reduce((sum, c) => sum + (c.outstanding_balance || 0), 0);
  }

  getTotalDebit(): number {
    return this.ledgerEntries.reduce((sum, e) => sum + (e.debit || 0), 0);
  }

  getTotalCredit(): number {
    return this.ledgerEntries.reduce((sum, e) => sum + (e.credit || 0), 0);
  }

  // 🔥 FIX: read the balance straight off the customer record (bills-derived),
  // instead of trusting the last ledger row's running `balance` field.
  // This is the single change that keeps this screen in sync with
  // Sales Orders and the Distribution Report.
  getCustomerBalance(): number {
    return this.selectedCustomer?.outstanding_balance || 0;
  }

  // ── THE DATE RANGE ───────────────────────────────────────
  //
  // Narrows the LISTED ROWS and nothing else. The outstanding balance above is
  // read off `bills` (`customers.outstanding_balance`), never off these rows,
  // so it is already what is owed NOW and the filter cannot move it — which is
  // exactly the behaviour wanted. See `date-range.util.ts`.
  dateFrom: string = '';
  dateTo: string = '';

  /** The rows the statement and the PDF both show. */
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

  // ── PAYMENT METHODS ──────────────────────────────────────

  openPaymentForm() {
    this.showPaymentForm = true;
    this.paymentAmount = this.getCustomerBalance();
    this.paymentDate = toLocalDateString();
    this.paymentNote = '';
    this.selectedBillId = null;
    
    this.showBillSelection = this.unpaidBills.length > 0;
    if (this.unpaidBills.length === 1) {
      this.selectedBillId = this.unpaidBills[0].bill_id;
    }
  }

  closePaymentForm() {
    this.showPaymentForm = false;
    this.paymentAmount = 0;
    this.paymentNote = '';
    this.selectedBillId = null;
    this.showBillSelection = false;
  }

  async submitPayment() {
    if (!this.paymentAmount || this.paymentAmount <= 0) {
      this.errorMessage = 'Please enter a valid payment amount';
      return;
    }
    
    if (this.paymentAmount > this.getCustomerBalance()) {
      this.errorMessage = 'Payment amount cannot exceed outstanding balance';
      return;
    }

    this.isSubmitting = true;
    this.errorMessage = '';

    try {
      // The allocation, the bill UPDATEs, the customer_ledger entries and the
      // outstanding-balance recompute are all `customerSettlementOps()` now —
      // the same statements in the same order this method used to build inline,
      // moved into the service to sit beside `customerUnwindOps()`, which
      // already un-made them. The Receive Voucher screen is a second door onto
      // this same event and settles through that one function, so the two
      // cannot drift about what a customer owes.
      //
      // Still one runBatch: the bill UPDATEs, the ledger entries and the
      // recompute describe the same money three times over. Run as separate
      // writes, a failure part-way left the ledger crediting a payment the
      // bills had not taken, and the balance recomputed off that half-applied
      // state — and run() reports failure in `.success` rather than throwing,
      // so nothing caught it either.
      const customerId = this.selectedCustomer.customer_id;
      const description = this.paymentNote || 'Payment received';

      const settlement = this.db.customerSettlementOps({
        customer_id: customerId,
        amount: this.paymentAmount,
        date: this.paymentDate,
        description,
        bills: this.unpaidBills,
        bill_id: this.selectedBillId
      });

      const result = await this.db.runBatch(settlement.ops);
      if (!result?.success) {
        this.errorMessage =
          'Failed to record payment: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was recorded.';
        return;
      }

      this.closePaymentForm();
      await this.loadCustomerDetail(this.selectedCustomer.customer_id);
      
    } catch (error: any) {
      this.errorMessage = 'Failed to record payment: ' + error.message;
      console.error('Payment error:', error);
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
   * Deleting a payment REVERSES it. The balance on this screen is derived from
   * `bills`, and a payment's real effect is the `amount_paid` submitPayment()
   * wrote there, so a delete that removed only the ledger row left the money
   * applied and the balance unchanged — the payment vanished from the statement
   * while still being counted. `deleteCustomerLedgerEntry()` puts it back on the
   * bills it was applied to, deletes the row and rebuilds the balance in one
   * batch; see it for how the bills are chosen and why a bill row is refused.
   *
   * The result is checked because `run()`/`runBatch()` report a refusal in
   * `.success` rather than throwing — the old catch could never see one, so a
   * refused delete closed the dialog and looked like it had worked.
   */
  async onDeleteConfirmed() {
    if (!this.deletingEntryId) return;

    try {
      const result = await this.db.deleteCustomerLedgerEntry(this.deletingEntryId);
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
      await this.loadCustomerDetail(this.selectedCustomer.customer_id);
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
    if (!this.selectedCustomer) return;
    
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
    doc.text('CUSTOMER LEDGER REPORT', pw / 2, y, { align: 'center' });
    y += 8;
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...G);
    doc.text(`Report Date: ${today}`, margin, y);
    doc.text(`Farm ID: ${this.currentFarm?.farm_id || ''}`, pw - margin, y, { align: 'right' });
    y += 5;
    // Which rows the statement below covers. Printed only when the client
    // filtered, so an unfiltered report reads exactly as it did.
    if (this.isDateFiltered) {
      doc.text(`Transactions shown: ${this.rangeLabel}`, margin, y);
      y += 5;
    }
    y += 5;
    
    // ── DIVIDER ─────────────────────────────────────────────
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
    
    // ── CUSTOMER INFO ──────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...B);
    doc.text('Customer Details', margin, y);
    y += 6;
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...B);
    doc.text(`Customer: ${this.selectedCustomer.customer_name}`, margin, y);
    doc.text(`Phone: ${this.selectedCustomer.phone || 'N/A'}`, margin + 70, y);
    y += 5;
    doc.text(`Address: ${this.selectedCustomer.address || 'N/A'}`, margin, y);
    y += 5;
    doc.text(`Current Balance: Rs. ${this.getCustomerBalance().toLocaleString()}`, margin, y);
    y += 10;
    
    // ── DIVIDER ─────────────────────────────────────────────
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pw - margin, y);
    y += 8;
    
    // ── TABLE ──────────────────────────────────────────────
    // The rows the screen is showing, so a printed statement is the period the
    // client filtered to.
    const tableData = this.visibleEntries.map((entry: any) => [
      entry.transaction_date || '',
      entry.description || '—',
      entry.debit > 0 ? 'Rs. ' + entry.debit.toLocaleString() : '—',
      entry.credit > 0 ? 'Rs. ' + entry.credit.toLocaleString() : '—',
      'Rs. ' + (entry.balance || 0).toLocaleString()
    ]);
    
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Description', 'Debit', 'Credit', 'Balance']],
      body: tableData.length > 0 ? tableData : [['No transactions found', '', '', '', '']],
      theme: 'striped',
      headStyles: { 
        fontStyle: 'bold', 
        fontSize: 8, 
        fillColor: [26, 92, 56], 
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
      columnStyles: {
        0: { cellWidth: 25 },
        1: { cellWidth: 60 },
        2: { cellWidth: 35, halign: 'right' },
        3: { cellWidth: 35, halign: 'right' },
        4: { cellWidth: 40, halign: 'right' }
      },
      tableWidth: pageWidth,
      styles: {
        overflow: 'linebreak',
        cellPadding: 4
      },
      // jspdf-autotable only applies columnStyles to the body section — the head
      // cell otherwise keeps headStyles' halign, so a right-aligned amount column's
      // header sits centered while its values sit right.
      didParseCell: alignHeadFootWithColumnStyles,
      didDrawPage: (data: any) => {
        const pageInfo = (doc.internal as any).getCurrentPageInfo?.() || { pageNumber: doc.getNumberOfPages() };
        const pageNumber = pageInfo.pageNumber;
        const totalPages = doc.getNumberOfPages();
        doc.setFontSize(7);
        doc.setTextColor(...G);
        doc.text(`Page ${pageNumber} of ${totalPages}`, pw / 2, ph - 8, { align: 'center' });
      }
    });
    
    const finalY = (doc as any).lastAutoTable.finalY + 8;
    const customerTableRight = getTableRightEdge(doc);

    // ── SUMMARY ─────────────────────────────────────────────
    if (finalY < ph - 40) {
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, finalY, pw - margin, finalY);
      y = finalY + 8;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...B);
      doc.text('SUMMARY', margin, y);
      y += 6;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`Total Debit (Sales): Rs. ${this.getTotalDebit().toLocaleString()}`, customerTableRight, y, { align: 'right' });
      y += 5;
      doc.text(`Total Credit (Payments): Rs. ${this.getTotalCredit().toLocaleString()}`, customerTableRight, y, { align: 'right' });
      y += 5;
      doc.text(`Current Balance: Rs. ${this.getCustomerBalance().toLocaleString()}`, customerTableRight, y, { align: 'right' });
      y += 10;
    }
    
    // ── FOOTER ──────────────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(...G);
    const footer = 'Generated by: www.devinfantary.com  |  Contact: 0302 6938217';
    doc.text(footer, pw / 2, ph - 4, { align: 'center' });
    
    await this.printPdf(doc, `Customer_Ledger_${this.selectedCustomer.customer_name}_${today}.pdf`);
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
