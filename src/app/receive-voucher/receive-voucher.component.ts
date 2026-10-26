import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
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
 * RECEIVE VOUCHER — money in from a customer, in one form.
 *
 * A SHORTCUT, not new functionality. Recording a receipt meant navigating into
 * the customer, finding their ledger and entering a payment there; this
 * collapses it into picking a customer, an amount and the account the money
 * landed in. The settlement is not reimplemented here — `saveReceiveVoucher()`
 * runs `customerSettlementOps()`, the same FIFO allocation across bills that
 * `customer-ledger.component.ts` runs, and folds the bank deposit into the same
 * batch. This screen owns only its own voucher row's SQL, as every screen in
 * this app owns its own.
 *
 * HOUSE ACCOUNTS ONLY. `getHouseBankAccounts()`, never `getBankAccounts()`
 * unscoped: a customer's own account holds the customer's money, and banking a
 * receipt into it would record the money as that customer withdrawing it. The
 * customer-deposit axis that `sales-orders.component.ts` drives
 * (`reference_type = 'payment'` with a null `reference_id`, on a customer's
 * account) is a different mechanism and nothing here touches it.
 *
 * OWN-FARM CUSTOMERS ARE EXCLUDED. They stand for the owner's own farm_units,
 * are created and named by the app, and are settled on the Customer Ledger
 * screen, which includes them deliberately. Every other customer-picking query
 * filters them out and so does this one.
 *
 * NO EDIT PATH, on purpose. A voucher is a compound event — bills, ledger,
 * bank — and re-allocating a settlement in place would need a second reversal
 * path to exist. Correct one by deleting it, which reverses all three sides
 * together, and entering it again.
 */
@Component({
  selector: 'app-receive-voucher',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe],
  templateUrl: './receive-voucher.component.html',
  styleUrl: './receive-voucher.component.scss'
})
export class ReceiveVoucherComponent implements OnInit {
  currentFarm: any = null;

  customers: any[] = [];
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

  /** The chosen customer's unpaid bills, for the "owes" figure and the preview. */
  selectedBills: any[] = [];

  showDeleteDialog = false;
  showDeleteCodeDialog = false;
  deletingId: number | null = null;

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.loadAll();
  }

  private emptyForm() {
    return {
      customer_id: null as number | null,
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
      // Own-farm customers filtered out — see the class note.
      const custRes = await this.db.get(
        `SELECT c.customer_id, c.customer_name, c.phone,
           (SELECT COALESCE(SUM(MAX(COALESCE(b.total_amount, 0) - COALESCE(b.amount_paid, 0), 0)), 0)
            FROM bills b WHERE b.customer_id = c.customer_id) AS outstanding_balance
         FROM customers c
         WHERE c.farm_id = ? AND COALESCE(c.customer_type, 'external') <> 'own_farm'
         ORDER BY c.customer_name ASC`,
        [this.currentFarm.farm_id]
      );
      if (!custRes.success) throw new Error(custRes.error);
      this.customers = custRes.data || [];

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
      `SELECT rv.voucher_id, rv.voucher_number, rv.date, rv.amount, rv.payment_source,
              rv.bank_id, rv.reference, rv.notes, rv.customer_id,
              c.customer_name, ba.bank_name
       FROM receive_vouchers rv
       LEFT JOIN customers c ON rv.customer_id = c.customer_id
       LEFT JOIN bank_accounts ba ON rv.bank_id = ba.bank_id
       WHERE rv.farm_id = ? AND rv.date BETWEEN ? AND ?
       ORDER BY rv.date DESC, rv.voucher_id DESC`,
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
    this.selectedBills = [];
    this.formError = '';
    this.showForm = true;
  }

  closeForm() {
    this.showForm = false;
    this.form = this.emptyForm();
    this.selectedBills = [];
    this.formError = '';
  }

  /** Cash/Bank is one control; `payment_source` is what the mechanism reads. */
  onSourceChange() {
    if (this.form.payment_source !== 'bank') this.form.bank_id = null;
  }

  async onCustomerChange() {
    this.selectedBills = [];
    this.formError = '';
    const id = Number(this.form.customer_id) || 0;
    if (!id) return;
    // The same read the settlement itself uses, so what is previewed here is
    // what will actually be allocated.
    const res = await this.db.getUnpaidBills(id);
    this.selectedBills = res.success ? (res.data || []) : [];
    if (this.form.amount === null) this.form.amount = this.selectedOutstanding || null;
    this.cdr.detectChanges();
  }

  get selectedCustomer(): any {
    const id = Number(this.form.customer_id) || 0;
    return this.customers.find(c => Number(c.customer_id) === id) || null;
  }

  get selectedOutstanding(): number {
    return this.selectedBills.reduce(
      (sum, b) => sum + Math.max((Number(b.total_amount) || 0) - (Number(b.amount_paid) || 0), 0), 0);
  }

  /**
   * Which bills this amount would settle, oldest first — the same walk
   * `customerSettlementOps()` does, shown before saving so the owner can see
   * where the money is going. Display only; the save re-derives it from a
   * fresh read and is the authority.
   */
  get preview(): { bill_number: string; bill_date: string; outstanding: number; applied: number }[] {
    let remaining = Number(this.form.amount) || 0;
    const out: any[] = [];
    for (const b of this.selectedBills) {
      if (remaining <= 0) break;
      const outstanding = (Number(b.total_amount) || 0) - (Number(b.amount_paid) || 0);
      if (outstanding <= 0) continue;
      const applied = Math.min(remaining, outstanding);
      out.push({ bill_number: b.bill_number, bill_date: b.bill_date, outstanding, applied });
      remaining -= applied;
    }
    return out;
  }

  get previewUnapplied(): number {
    const applied = this.preview.reduce((s, p) => s + p.applied, 0);
    return Math.max((Number(this.form.amount) || 0) - applied, 0);
  }

  async save() {
    this.formError = '';

    if (!Number(this.form.customer_id)) {
      this.formError = 'Choose which customer the money came from.';
      return;
    }
    const amount = Number(this.form.amount) || 0;
    if (!(amount > 0)) {
      this.formError = 'Enter an amount greater than zero.';
      return;
    }
    if (!this.form.date) {
      this.formError = 'Choose the date the money was received.';
      return;
    }
    // Bank with no account is refused rather than quietly saved as cash — the
    // whole point of the mechanism is that a bank receipt reaches a bank.
    const bankErr = bankSourceError(this.form, this.houseBanks);
    if (bankErr) {
      this.formError = bankErr;
      return;
    }

    this.isSaving = true;
    try {
      const voucherNumber = await this.nextVoucherNumber();
      const bank = bankSourceFields(this.form);
      const customerName = this.selectedCustomer?.customer_name || 'Customer';
      const reference = (this.form.reference || '').trim() || null;
      const notes = (this.form.notes || '').trim() || null;

      // This screen's own row. It becomes operation 0 of the batch, so the
      // ledger credits and the bank entry can both name it with { $lastId: 0 }.
      const insert: DbBatchOp = {
        sql: `INSERT INTO receive_vouchers
                (farm_id, customer_id, voucher_number, date, amount, payment_source, bank_id, reference, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [this.currentFarm.farm_id, Number(this.form.customer_id), voucherNumber,
                 this.form.date, amount, bank.payment_source, bank.bank_id, reference, notes]
      };

      const result = await this.db.saveReceiveVoucher(insert, {
        customer_id: Number(this.form.customer_id),
        amount,
        date: this.form.date,
        description: reference
          ? `Receive Voucher ${voucherNumber} — ${reference}`
          : `Receive Voucher ${voucherNumber}`,
        bank_description: `Receive Voucher ${voucherNumber} — ${customerName}`,
        payment_source: bank.payment_source,
        bank_id: bank.bank_id
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

  /** RV-001 upward, per account — the same shape as the bill numbers. */
  private async nextVoucherNumber(): Promise<string> {
    const r = await this.db.get(
      `SELECT COALESCE(MAX(CAST(SUBSTR(voucher_number, 4) AS INTEGER)), 0) + 1 AS next_number
       FROM receive_vouchers WHERE farm_id = ? AND voucher_number LIKE 'RV-%'`,
      [this.currentFarm.farm_id]
    );
    const n = (r.success && r.data && r.data[0]) ? r.data[0].next_number : 1;
    return 'RV-' + String(n).padStart(3, '0');
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

  /**
   * Deleting a voucher reverses all three sides together: the money goes back
   * onto the bills it settled, its ledger lines go, and its bank deposit goes.
   * The result is checked because `runBatch()` reports a refusal in `.success`
   * rather than throwing.
   */
  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    const id = this.deletingId;
    this.showDeleteDialog = false;
    this.deletingId = null;

    try {
      const result = await this.db.deleteReceiveVoucher(id);
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
   * The voucher itself, as a document — logo, watermark and footer, the same
   * hand-rolled shape `internal-settlement.component.ts` prints rather than the
   * plainer shared `printPdfReport()` helper, because the client asked for a
   * receipt "like the others".
   *
   * The logo deliberately does NOT go into that shared helper: it also prints
   * the Assets, Personal Expenses, Egg Sales and Hen Sales lists, which are not
   * distribution documents, so putting it there would restyle all four.
   *
   * The table is what the receipt actually did — the bills it was applied to —
   * read back from the ledger rows the voucher wrote, so a printed voucher
   * shows the real allocation rather than a re-guess of it.
   */
  async printVoucher(v: any) {
    const res = await this.db.get(
      `SELECT cl.credit, cl.reference_id, b.bill_number, b.bill_date,
              b.total_amount, b.amount_paid
       FROM customer_ledger cl
       LEFT JOIN bills b ON cl.reference_id = b.bill_id
       WHERE cl.voucher_id = ?
       ORDER BY cl.ledger_id ASC`,
      [v.voucher_id]
    );
    const lines = res.success ? (res.data || []) : [];

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

    // ── Logo + letterhead ───────────────────────
    //
    // The ONLY heading on the page. The login account's farm_name is not
    // printed above it: a voucher is a document of the distribution business,
    // which is what the letterhead already names.
    try {
      const id = await this.loadImageAsBase64('/logo.png?v=20261026');
      const ip = doc.getImageProperties(id);
      const lh = 30;
      const lw = (ip.width * lh) / ip.height;
      const tx = margin + lw + 10;
      doc.addImage(id, 'PNG', margin, y, lw, lh);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
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
      doc.setFontSize(16);
      doc.setTextColor(...B);
      doc.text('FarmInfantary', pw / 2, y, { align: 'center' });
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
    doc.text(`RECEIVE VOUCHER — ${v.voucher_number || ''}`, pw / 2, y, { align: 'center' });
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
      ['Received From', v.customer_name || '—'],
      ['Date', String(v.date || '—')],
      ['Amount', rs(v.amount)],
      ['Received Into', this.sourceLabel(v)],
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

    // ── The bills it was applied to ─────────────────
    const body = lines.length > 0
      ? lines.map((l: any) => [
          l.bill_number || '—',
          l.bill_date || '—',
          rs(l.total_amount),
          rs(l.credit),
          rs(Math.max((Number(l.total_amount) || 0) - (Number(l.amount_paid) || 0), 0))
        ])
      : [['No bills recorded against this voucher', '', '', '', '']];

    autoTable(doc, {
      startY: y,
      head: [['Bill #', 'Bill Date', 'Bill Total', 'Applied', 'Still Owed']],
      body,
      foot: [['Total', '', '', rs(v.amount), '']],
      theme: 'striped',
      headStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [26, 92, 56], textColor: [255, 255, 255] },
      footStyles: { fontStyle: 'bold', fontSize: 8, fillColor: [240, 240, 240], textColor: B },
      bodyStyles: { fontSize: 8, textColor: B },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      margin: { left: margin, right: margin },
      columnStyles: {
        0: { cellWidth: 32 },
        1: { cellWidth: 30 },
        2: { cellWidth: 34, halign: 'right' },
        3: { cellWidth: 34, halign: 'right' },
        4: { cellWidth: 32, halign: 'right' }
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

    await this.printPdf(doc, `${v.voucher_number || 'Receive_Voucher'}.pdf`);
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
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Logo load failed'));
      img.src = url;
    });
  }
}
