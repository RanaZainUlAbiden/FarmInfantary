import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { bankSourceError, bankSourceFields, paymentSourceLabel, bankOptionLabel } from '../shared/utils/bank-source.util';
import { alignHeadFootWithColumnStyles } from '../shared/utils/pdf-table.util';

import { printPdfBase64 } from '../shared/utils/browser-print.util';
function firstOfMonth(): string {
  const d = new Date();
  return toLocalDateString(new Date(d.getFullYear(), d.getMonth(), 1));
}

/**
 * PAYMENT VOUCHER — money out to a supplier, in one form.
 *
 * The mirror of the Receive Voucher screen, and a shortcut in the same way:
 * recording a payment meant navigating into the supplier and entering it on
 * their ledger. The settlement is not reimplemented — `savePaymentVoucher()`
 * writes the same single `supplier_ledger` debit the Supplier Ledger screen
 * writes, and folds the bank withdrawal into the same batch.
 *
 * THE PAYABLE IS DERIVED, never stored: `SUM(credit - debit)` over
 * `supplier_ledger`, with nothing behind it. So a debit row IS the reduction,
 * which is why this side needs none of the bill allocation the receive side
 * does — and why deleting a voucher only has to remove the row. There is no
 * `outstanding_balance` column on `suppliers` and none is wanted.
 *
 * HOUSE ACCOUNTS ONLY — `getHouseBankAccounts()`. Paying a supplier out of a
 * customer's account would record it as that customer's withdrawal.
 *
 * NO EDIT PATH, on purpose — see the Receive Voucher screen's note. Correct a
 * voucher by deleting it, which reverses both sides together, and re-entering.
 */
@Component({
  selector: 'app-payment-voucher',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe],
  templateUrl: './payment-voucher.component.html',
  styleUrl: './payment-voucher.component.scss'
})
export class PaymentVoucherComponent implements OnInit {
  currentFarm: any = null;

  suppliers: any[] = [];
  houseBanks: any[] = [];

  /**
   * How one house account reads in the dropdown: bank name plus the account's
   * title. Shared with every other bank picker — see bank-source.util.ts.
   */
  bankOptionLabel(bank: any): string {
    return bankOptionLabel(bank);
  }
  vouchers: any[] = [];

  isLoading = true;
  isSaving = false;
  errorMessage = '';
  formError = '';

  fromDate = firstOfMonth();
  toDate = toLocalDateString();

  showForm = false;
  form: any = this.emptyForm();

  /** The ngOnInit load, so the `?supplierId=` hand-off can await it. */
  private loaded: Promise<void> = Promise.resolve();

  showDeleteDialog = false;
  showDeleteCodeDialog = false;
  deletingId: number | null = null;

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loaded = this.loadAll();

    // `?supplierId=` — the hand-off from Supplier Accounts' "Record Payment".
    // That screen deliberately has no payment form of its own: this is the one
    // supplier-payment door that writes the `supplier_ledger` debit AND the
    // matching bank withdrawal in one batch. Honoured after `loadAll()` so the
    // supplier list is there to prefill the payable from; the `t` nonce the
    // caller stamps on is what makes a repeat click re-emit here.
    this.route.queryParams.subscribe(params => {
      const supplierId = Number(params['supplierId']) || 0;
      if (supplierId) this.openFormForSupplier(supplierId);
    });
  }

  /**
   * Open the form on one supplier, as if it had been picked in the dropdown.
   *
   * Goes through `openForm()` and `onSupplierChange()` rather than assigning
   * the form fields itself, so the prefilled payable is the same figure a
   * hand-picked supplier gets. Waits for the list, because an id that is not
   * this farm's must leave the dropdown unset rather than name a supplier the
   * save would then refuse.
   */
  private async openFormForSupplier(supplierId: number) {
    // The ngOnInit load, awaited — NOT a second `loadAll()`, which would read
    // everything twice and race the first one's assignments.
    await this.loaded;
    if (!this.suppliers.some(s => Number(s.supplier_id) === supplierId)) return;

    this.openForm();
    this.form.supplier_id = supplierId;
    this.onSupplierChange();
    this.cdr.detectChanges();
  }

  private emptyForm() {
    return {
      supplier_id: null as number | null,
      amount: null as number | null,
      date: toLocalDateString(),
      payment_source: 'cash',
      bank_id: null as number | null,
      reference: '',
      notes: ''
    };
  }

  // ── LOAD ──────────────────────────────────────────────────

  async loadAll() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      // The payable comes off the ledger, the only place it exists.
      const supRes = await this.db.getAllSuppliersWithBalance(this.currentFarm.farm_id);
      if (!supRes.success) throw new Error(supRes.error);
      this.suppliers = supRes.data || [];

      const bankRes = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
      this.houseBanks = bankRes.success ? (bankRes.data || []) : [];

      await this.loadVouchers();
    } catch (error: any) {
      this.errorMessage = 'Failed to load: ' + (error?.message || error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadVouchers() {
    const res = await this.db.get(
      `SELECT pv.voucher_id, pv.voucher_number, pv.date, pv.amount, pv.payment_source,
              pv.bank_id, pv.reference, pv.notes, pv.supplier_id,
              s.supplier_name, ba.bank_name
       FROM payment_vouchers pv
       LEFT JOIN suppliers s ON pv.supplier_id = s.supplier_id
       LEFT JOIN bank_accounts ba ON pv.bank_id = ba.bank_id
       WHERE pv.farm_id = ? AND pv.date BETWEEN ? AND ?
       ORDER BY pv.date DESC, pv.voucher_id DESC`,
      [this.currentFarm.farm_id, this.fromDate, this.toDate]
    );
    this.vouchers = res.success ? (res.data || []) : [];
    if (!res.success) this.errorMessage = 'Failed to load vouchers: ' + friendlySqlError(res.error, 'unknown error.');
    this.cdr.detectChanges();
  }

  async onRangeChange() {
    await this.loadVouchers();
  }

  // ── FORM ──────────────────────────────────────────────────

  openForm() {
    this.form = this.emptyForm();
    this.formError = '';
    this.showForm = true;
  }

  closeForm() {
    this.showForm = false;
    this.form = this.emptyForm();
    this.formError = '';
  }

  onSourceChange() {
    if (this.form.payment_source !== 'bank') this.form.bank_id = null;
  }

  onSupplierChange() {
    this.formError = '';
    if (this.form.amount === null) this.form.amount = this.selectedPayable || null;
  }

  get selectedSupplier(): any {
    const id = Number(this.form.supplier_id) || 0;
    return this.suppliers.find(s => Number(s.supplier_id) === id) || null;
  }

  get selectedPayable(): number {
    return Number(this.selectedSupplier?.outstanding_balance) || 0;
  }

  /** What this payment leaves owing. Display only; the save re-reads. */
  get payableAfter(): number {
    return this.selectedPayable - (Number(this.form.amount) || 0);
  }

  async save() {
    this.formError = '';

    if (!Number(this.form.supplier_id)) {
      this.formError = 'Choose which supplier the money went to.';
      return;
    }
    const amount = Number(this.form.amount) || 0;
    if (!(amount > 0)) {
      this.formError = 'Enter an amount greater than zero.';
      return;
    }
    if (!this.form.date) {
      this.formError = 'Choose the date the money was paid.';
      return;
    }
    const bankErr = bankSourceError(this.form, this.houseBanks);
    if (bankErr) {
      this.formError = bankErr;
      return;
    }

    this.isSaving = true;
    try {
      const voucherNumber = await this.nextVoucherNumber();
      const bank = bankSourceFields(this.form);
      const supplierName = this.selectedSupplier?.supplier_name || 'Supplier';
      const reference = (this.form.reference || '').trim() || null;
      const notes = (this.form.notes || '').trim() || null;

      // This screen's own row, and operation 0 of the batch so the ledger
      // debit and the bank entry can both name it with { $lastId: 0 }.
      const insert: DbBatchOp = {
        sql: `INSERT INTO payment_vouchers
                (farm_id, supplier_id, voucher_number, date, amount, payment_source, bank_id, reference, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [this.currentFarm.farm_id, Number(this.form.supplier_id), voucherNumber,
                 this.form.date, amount, bank.payment_source, bank.bank_id, reference, notes]
      };

      const result = await this.db.savePaymentVoucher(insert, {
        supplier_id: Number(this.form.supplier_id),
        amount,
        date: this.form.date,
        description: reference
          ? `Payment Voucher ${voucherNumber} — ${reference}`
          : `Payment Voucher ${voucherNumber}`,
        bank_description: `Payment Voucher ${voucherNumber} — ${supplierName}`,
        payment_source: bank.payment_source,
        bank_id: bank.bank_id,
        notes
      });

      if (!result.success) {
        this.formError = friendlySqlError(result.error, 'the database refused the change.') +
          ' Nothing was recorded.';
        return;
      }

      this.closeForm();
      await this.loadAll();
    } catch (error: any) {
      this.formError = 'Failed to save: ' + (error?.message || error);
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  /** PV-001 upward, per account. */
  private async nextVoucherNumber(): Promise<string> {
    const r = await this.db.get(
      `SELECT COALESCE(MAX(CAST(SUBSTR(voucher_number, 4) AS INTEGER)), 0) + 1 AS next_number
       FROM payment_vouchers WHERE farm_id = ? AND voucher_number LIKE 'PV-%'`,
      [this.currentFarm.farm_id]
    );
    const n = (r.success && r.data && r.data[0]) ? r.data[0].next_number : 1;
    return 'PV-' + String(n).padStart(3, '0');
  }

  // ── DELETE ────────────────────────────────────────────────

  confirmDelete(id: number) {
    this.deletingId = id;
    this.showDeleteCodeDialog = true;
  }

  onDeleteCodeVerified() {
    this.showDeleteCodeDialog = false;
    this.showDeleteDialog = true;
  }

  onDeleteCodeCancelled() {
    this.showDeleteCodeDialog = false;
    this.deletingId = null;
  }

  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    const id = this.deletingId;
    this.showDeleteDialog = false;
    this.deletingId = null;

    try {
      const result = await this.db.deletePaymentVoucher(id);
      if (!result?.success) {
        this.errorMessage = 'Failed to delete voucher: ' +
          friendlySqlError(result?.error, 'the database refused the change.') + ' Nothing was changed.';
        this.cdr.detectChanges();
        return;
      }
      this.errorMessage = '';
      await this.loadAll();
    } catch (error: any) {
      this.errorMessage = 'Failed to delete voucher: ' + (error?.message || error);
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }

  // ── TOTALS ────────────────────────────────────────────────

  get total(): number {
    return this.vouchers.reduce((sum, v) => sum + (Number(v.amount) || 0), 0);
  }

  sourceLabel(v: any): string {
    return paymentSourceLabel(v, this.houseBanks);
  }

  // ── PRINT ─────────────────────────────────────────────────

  /**
   * The voucher as a document — logo, watermark and footer, the same
   * hand-rolled shape `internal-settlement.component.ts` prints rather than the
   * plainer shared `printPdfReport()` helper, because the client asked for a
   * receipt "like the others".
   *
   * The logo deliberately does NOT go into that shared helper: it also prints
   * the Assets, Personal Expenses, Egg Sales and Hen Sales lists, which are not
   * distribution documents, so putting it there would restyle all four.
   *
   * The table is what the payment did to the payable, read back off the
   * ledger: the running total at the voucher's own row is the payable it left
   * behind, so what is printed is the real effect rather than a figure
   * recomputed from the form.
   */
  async printVoucher(v: any) {
    const res = await this.db.get(
      `SELECT sl.ledger_id, sl.debit,
              (SELECT COALESCE(SUM(COALESCE(x.credit, 0) - COALESCE(x.debit, 0)), 0)
               FROM supplier_ledger x
               WHERE x.supplier_id = sl.supplier_id AND x.ledger_id <= sl.ledger_id) AS payable_after
       FROM supplier_ledger sl
       WHERE sl.voucher_id = ?
       ORDER BY sl.ledger_id ASC`,
      [v.voucher_id]
    );
    const line = (res.success && res.data && res.data[0]) || null;
    const paid = Number(line?.debit) || Number(v.amount) || 0;
    const after = line ? Number(line.payable_after) || 0 : 0;

    const doc = new jsPDF('p', 'mm', 'a4');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const B: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [120, 120, 120];
    const margin = 14;
    const today = new Date().toLocaleDateString('en-PK');
    const footer = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
    const rs = (n: any) => 'Rs. ' + Math.round(Number(n) || 0).toLocaleString();

    // ── Background watermark ──────────────────────
    let bgImgData: string | null = null;
    let bgW = 0; let bgH = 0;
    try {
      bgImgData = await this.loadImageAsBase64('reportimage.png');
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

    // ── Logo + letterhead ───────────────────────
    //
    // The ONLY heading on the page. The login account's farm_name is not
    // printed above it: a voucher is a document of the distribution business,
    // which is what the letterhead already names.
    try {
      const id = await this.loadImageAsBase64('Report-Distribution.jpeg');
      const ip = doc.getImageProperties(id);
      const lh = 30;
      const lw = (ip.width * lh) / ip.height;
      const tx = margin + lw + 10;
      doc.addImage(id, 'JPEG', margin, y, lw, lh);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...B);
      doc.text('TALHA POULTRY FEEDS AND CHICKS', tx, y + 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...G);
      doc.text('Shop # 33 Jinnah Market Akal Wala Road, Toba Tek Singh', tx, y + 14);
      doc.text('Proprietor: Muhammad Tariq 0321-7546630', tx, y + 19);
      doc.text('Managing Director: Ghulam Abbas 0322-7778826', tx, y + 24);
      doc.setFontSize(10);
      doc.text('Generated: ' + today, tx, y + 30);
      y += lh + 10;
    } catch {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...B);
      doc.text('TALHA POULTRY FEEDS AND CHICKS', pw / 2, y, { align: 'center' });
      y += 7;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(...G);
      doc.text('Generated: ' + today, pw / 2, y, { align: 'center' });
      y += 10;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...B);
    doc.text(`PAYMENT VOUCHER — ${v.voucher_number || ''}`, pw / 2, y, { align: 'center' });
    y += 7;

    doc.setDrawColor(...B);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pw - margin, y);
    y += 9;

    // ── Details ───────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('DETAILS', margin, y);
    y += 6;

    const detail: [string, string][] = [
      ['Paid To', v.supplier_name || '—'],
      ['Date', String(v.date || '—')],
      ['Amount', rs(v.amount)],
      ['Paid From', this.sourceLabel(v)],
      ['Reference', v.reference || '—'],
      ['Notes', v.notes || '—']
    ];

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    for (const [label, value] of detail) {
      doc.setTextColor(...G);
      doc.text(label + ':', margin + 6, y);
      doc.setTextColor(...B);
      doc.text(doc.splitTextToSize(String(value), pw - margin * 2 - 60), margin + 55, y);
      y += 6;
    }
    y += 4;

    // ── What it did to the payable ──────────────────
    autoTable(doc, {
      startY: y,
      head: [['Supplier', 'Payable Before', 'Paid', 'Payable After']],
      body: [[
        v.supplier_name || '—',
        rs(after + paid),
        rs(paid),
        rs(after)
      ]],
      theme: 'striped',
      headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
      bodyStyles: { fontSize: 8, textColor: B },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      margin: { left: margin, right: margin },
      columnStyles: {
        0: { cellWidth: 56 },
        1: { cellWidth: 36, halign: 'right' },
        2: { cellWidth: 36, halign: 'right' },
        3: { cellWidth: 36, halign: 'right' }
      },
      didParseCell: alignHeadFootWithColumnStyles,
      didDrawPage: () => drawBackground()
    });

    // ── Footer ─────────────────────────────────
    const totalPages = (doc.internal as any).getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(7.5);
      doc.setTextColor(...G);
      doc.text(footer, pw / 2, ph - 9, { align: 'center' });
      doc.text('Page ' + i + ' of ' + totalPages, pw / 2, ph - 4, { align: 'center' });
    }

    await this.printPdf(doc, `${v.voucher_number || 'Payment_Voucher'}.pdf`);
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

  private loadImageAsBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')!.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/jpeg'));
      };
      img.onerror = () => reject(new Error('Logo load failed'));
      img.src = url;
    });
  }
}
