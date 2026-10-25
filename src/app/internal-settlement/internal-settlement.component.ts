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
import { bankSourceError, paymentSourceLabel, bankOptionLabel } from '../shared/utils/bank-source.util';
import { alignHeadFootWithColumnStyles } from '../shared/utils/pdf-table.util';

import { printPdfBase64 } from '../shared/utils/browser-print.util';
function firstOfMonth(): string {
  const d = new Date();
  return toLocalDateString(new Date(d.getFullYear(), d.getMonth(), 1));
}

/**
 * INTERNAL SETTLEMENT — the owner's farm paying distribution what it owes.
 *
 * Distribution sent feed to a flock and billed it (an own-farm bill,
 * `payment_type = 'internal'`); the flock carried the cost and the debt; the
 * flock sold its chickens and the money landed in one of the owner's accounts;
 * this screen clears the debt. Distribution records the receipt and the farm's
 * balance goes to zero.
 *
 * NOT A SECOND SETTLEMENT. The bills, the `customer_ledger` credits and the
 * balance recompute are `customerSettlementOps()` — the same FIFO allocation
 * the Customer Ledger screen and the Receive Voucher screen run.
 * `saveInternalSettlement()` composes this screen's own row and the bank
 * movement around it. This screen owns only its own SQL, as every screen here
 * does.
 *
 * WHY IT IS NOT THE RECEIVE VOUCHER SCREEN. Both ends of this money are the
 * owner's, so BOTH ends get an account picker — and they can name the SAME
 * account. When they do, nothing moved: the debt clears and not one
 * `bank_ledger` row is written. A receive voucher has one end and always
 * deposits. Own-farm customers are excluded there and are the ONLY customers
 * offered here, which is the other half of the same split.
 *
 * THE INVARIANT. Bank balances in total move by
 *   (TO is a bank ? +amount : 0) - (FROM is a bank ? +amount : 0)
 * so Bank -> Bank (same account or different) and Cash -> Cash leave the total
 * IDENTICAL, while Bank -> Cash and Cash -> Bank move it by exactly the amount
 * — the cash that really left or entered the banked world. If the total moves
 * by anything else, money has been invented or destroyed.
 *
 * HOUSE ACCOUNTS ONLY, both sides: `getHouseBankAccounts()`, never
 * `getBankAccounts()` unscoped. A customer's account holds the customer's
 * money, and settling through one would record the movement as that customer's.
 *
 * NO EDIT PATH, as with the vouchers. A settlement is a compound event — bills,
 * ledger, two bank legs — so it is corrected by deleting it (which reverses
 * every side in one batch) and entering it again.
 */
@Component({
  selector: 'app-internal-settlement',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe],
  templateUrl: './internal-settlement.component.html',
  styleUrl: './internal-settlement.component.scss'
})
export class InternalSettlementComponent implements OnInit {
  currentFarm: any = null;

  /** Own-farm customers only — see the class note. */
  customers: any[] = [];
  houseBanks: any[] = [];

  /**
   * How one house account reads in the dropdown: bank name plus the account's
   * title. Shared with every other bank picker — see bank-source.util.ts.
   */
  bankOptionLabel(bank: any): string {
    return bankOptionLabel(bank);
  }
  settlements: any[] = [];

  isLoading = true;
  isSaving = false;
  errorMessage = '';
  formError = '';

  fromDate = firstOfMonth();
  toDate = toLocalDateString();

  showForm = false;
  form: any = this.emptyForm();

  /** The chosen farm's unpaid bills, for the "owes" figure and the preview. */
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

  /**
   * `fromChoice` / `toChoice` are one control per side, holding '' (nothing
   * picked yet), 'cash', or the account's id as a string.
   *
   * THREE states, not two, which is why these are strings rather than a
   * `bank_id` that is null for cash: with more than one house account the
   * client asked for no default, so "not yet chosen" has to be
   * distinguishable from "deliberately cash" — otherwise an untouched form
   * would silently save as a cash settlement.
   */
  private emptyForm() {
    return {
      customer_id: null as number | null,
      amount: null as number | null,
      date: toLocalDateString(),
      fromChoice: '',
      toChoice: '',
      reference: '',
      notes: ''
    };
  }

  // ── LOAD ──────────────────────────────────────────────────

  async loadAll() {
    this.isLoading = true;
    this.errorMessage = '';
    try {
      // Own-farm customers ONLY. They stand for the owner's own farm_units and
      // are the only parties that can owe an internal bill; every other
      // customer-picking query in the app filters them out and this one is the
      // one place that filters everything else out instead.
      const custRes = await this.db.get(
        `SELECT c.customer_id, c.customer_name, c.unit_id,
           (SELECT COALESCE(SUM(MAX(COALESCE(b.total_amount, 0) - COALESCE(b.amount_paid, 0), 0)), 0)
            FROM bills b WHERE b.customer_id = c.customer_id) AS outstanding_balance
         FROM customers c
         WHERE c.farm_id = ? AND COALESCE(c.customer_type, 'external') = 'own_farm'
         ORDER BY c.customer_name ASC`,
        [this.currentFarm.farm_id]
      );
      if (!custRes.success) throw new Error(custRes.error);
      this.customers = custRes.data || [];

      const bankRes = await this.db.getHouseBankAccounts(this.currentFarm.farm_id);
      this.houseBanks = bankRes.success ? (bankRes.data || []) : [];

      await this.loadSettlements();
    } catch (error: any) {
      this.errorMessage = 'Failed to load: ' + (error?.message || error);
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  async loadSettlements() {
    const res = await this.db.get(
      `SELECT ins.settlement_id, ins.settlement_number, ins.date, ins.amount,
              ins.from_account, ins.from_bank_id, ins.to_account, ins.to_bank_id,
              ins.reference, ins.notes, ins.customer_id,
              c.customer_name, c.unit_id,
              fb.bank_name AS from_bank_name, tb.bank_name AS to_bank_name
       FROM internal_settlements ins
       LEFT JOIN customers c ON ins.customer_id = c.customer_id
       LEFT JOIN bank_accounts fb ON ins.from_bank_id = fb.bank_id
       LEFT JOIN bank_accounts tb ON ins.to_bank_id = tb.bank_id
       WHERE ins.farm_id = ? AND ins.date BETWEEN ? AND ?
       ORDER BY ins.date DESC, ins.settlement_id DESC`,
      [this.currentFarm.farm_id, this.fromDate, this.toDate]
    );
    this.settlements = res.success ? (res.data || []) : [];
    if (!res.success) {
      this.errorMessage = 'Failed to load settlements: ' +
        friendlySqlError(res.error, 'unknown error.');
    }
    this.cdr.detectChanges();
  }

  async onRangeChange() {
    await this.loadSettlements();
  }

  // ── FORM ──────────────────────────────────────────────────

  /**
   * THE AUTO-SELECT RULE, confirmed with the client:
   *
   *   one house account   both sides preselect it — with a single account
   *                       there is nothing to choose, and making him pick the
   *                       same thing twice is friction, not safety
   *   no house accounts   neither dropdown is rendered; the settlement is
   *                       cash-only with no account, which is the truth
   *   several accounts    both start empty and the save is refused until both
   *                       are picked, so a wrong account can never be a default
   */
  openForm() {
    this.form = this.emptyForm();
    if (this.houseBanks.length === 1) {
      const only = String(this.houseBanks[0].bank_id);
      this.form.fromChoice = only;
      this.form.toChoice = only;
    } else if (this.houseBanks.length === 0) {
      this.form.fromChoice = 'cash';
      this.form.toChoice = 'cash';
    }
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

  /** One side's choice as the pair the service and the row actually store. */
  private sideFields(choice: string): { account: string; bank_id: number | null } {
    if (choice === 'cash') return { account: 'cash', bank_id: null };
    const id = Number(choice) || 0;
    return id > 0 ? { account: 'bank', bank_id: id } : { account: 'cash', bank_id: null };
  }

  /**
   * Did the money cross an account boundary? False when both sides name the
   * same bank account AND when both are cash. This is what the form, the save
   * and the printed receipt all branch on, derived in one place so they cannot
   * disagree.
   */
  get sameAccount(): boolean {
    return this.form.fromChoice !== '' && this.form.fromChoice === this.form.toChoice;
  }

  bankLabelFor(choice: string): string {
    const side = this.sideFields(choice);
    return paymentSourceLabel(
      { payment_source: side.account, bank_id: side.bank_id }, this.houseBanks);
  }

  /**
   * Which bills this amount would clear, oldest first — the same walk
   * `customerSettlementOps()` does, shown before saving. Display only; the save
   * re-derives it from a fresh read and is the authority.
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
      this.formError = 'Choose which of your farms is settling.';
      return;
    }
    const amount = Number(this.form.amount) || 0;
    if (!(amount > 0)) {
      this.formError = 'Enter an amount greater than zero.';
      return;
    }
    if (!this.form.date) {
      this.formError = 'Choose the date the money moved.';
      return;
    }
    // With more than one house account neither side has a default, so an
    // unpicked side is refused rather than quietly treated as cash.
    if (this.houseBanks.length > 0 && (!this.form.fromChoice || !this.form.toChoice)) {
      this.formError = 'Choose both the account the money came from and the account it went into.';
      return;
    }

    const from = this.sideFields(this.form.fromChoice);
    const to = this.sideFields(this.form.toChoice);

    // The same account-exists check every other money screen makes, applied to
    // each side in turn: a stale id is refused rather than posted into nothing.
    const fromErr = bankSourceError(
      { payment_source: from.account, bank_id: from.bank_id }, this.houseBanks, 'From account');
    if (fromErr) { this.formError = fromErr; return; }
    const toErr = bankSourceError(
      { payment_source: to.account, bank_id: to.bank_id }, this.houseBanks, 'To account');
    if (toErr) { this.formError = toErr; return; }

    this.isSaving = true;
    try {
      const number = await this.nextSettlementNumber();
      const farmName = this.selectedCustomer?.customer_name || 'Own Farm';
      const reference = (this.form.reference || '').trim() || null;
      const notes = (this.form.notes || '').trim() || null;

      // This screen's own row. It becomes OPERATION 0 of the batch, so the
      // ledger credits and both bank legs can name it with { $lastId: 0 }.
      const insert: DbBatchOp = {
        sql: `INSERT INTO internal_settlements
                (farm_id, customer_id, settlement_number, date, amount,
                 from_account, from_bank_id, to_account, to_bank_id, reference, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [this.currentFarm.farm_id, Number(this.form.customer_id), number,
                 this.form.date, amount, from.account, from.bank_id,
                 to.account, to.bank_id, reference, notes]
      };

      const result = await this.db.saveInternalSettlement(insert, {
        customer_id: Number(this.form.customer_id),
        amount,
        date: this.form.date,
        description: reference
          ? `Internal Settlement ${number} — ${reference}`
          : `Internal Settlement ${number}`,
        bank_description_out: `Internal Settlement ${number} — paid by ${farmName}`,
        bank_description_in: `Internal Settlement ${number} — received from ${farmName}`,
        from_account: from.account,
        from_bank_id: from.bank_id,
        to_account: to.account,
        to_bank_id: to.bank_id
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

  /** IS-001 upward, per account — the same shape as the voucher numbers. */
  private async nextSettlementNumber(): Promise<string> {
    const r = await this.db.get(
      `SELECT COALESCE(MAX(CAST(SUBSTR(settlement_number, 4) AS INTEGER)), 0) + 1 AS next_number
       FROM internal_settlements WHERE farm_id = ? AND settlement_number LIKE 'IS-%'`,
      [this.currentFarm.farm_id]
    );
    const n = (r.success && r.data && r.data[0]) ? r.data[0].next_number : 1;
    return 'IS-' + String(n).padStart(3, '0');
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
   * Deleting a settlement reverses every side together: the money goes back
   * onto the bills it cleared, its ledger lines go, and both bank legs go. A
   * same-account settlement had no legs, so there is nothing there to reverse.
   * The result is checked because `runBatch()` reports a refusal in `.success`
   * rather than throwing.
   */
  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    const id = this.deletingId;
    this.showDeleteDialog = false;
    this.deletingId = null;

    try {
      const result = await this.db.deleteInternalSettlement(id);
      if (!result?.success) {
        this.errorMessage = 'Failed to delete settlement: ' +
          friendlySqlError(result?.error, 'the database refused the change.') + ' Nothing was changed.';
        this.cdr.detectChanges();
        return;
      }
      this.errorMessage = '';
      await this.loadAll();
    } catch (error: any) {
      this.errorMessage = 'Failed to delete settlement: ' + (error?.message || error);
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }

  // ── TOTALS / LABELS ───────────────────────────────────────

  get total(): number {
    return this.settlements.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  }

  /** Where the money came from, as a table cell or a statement line. */
  fromLabel(s: any): string {
    return paymentSourceLabel(
      { payment_source: s.from_account, bank_id: s.from_bank_id, bank_name: s.from_bank_name },
      this.houseBanks);
  }

  toLabel(s: any): string {
    return paymentSourceLabel(
      { payment_source: s.to_account, bank_id: s.to_bank_id, bank_name: s.to_bank_name },
      this.houseBanks);
  }

  /** The same test the service applies: did the money cross an account? */
  settledInPlace(s: any): boolean {
    const from = (s.from_account === 'bank') ? Number(s.from_bank_id) || 0 : 0;
    const to = (s.to_account === 'bank') ? Number(s.to_bank_id) || 0 : 0;
    return from === to;
  }

  // ── PRINT ─────────────────────────────────────────────────

  /**
   * The receipt, as a document — logo, watermark and footer, the same hand-rolled
   * shape the Report screens print rather than the plainer shared
   * `printPdfReport()` helper, because the client asked for one "like the
   * others".
   *
   * The table is what the settlement actually did — the bills it cleared — read
   * back from the ledger rows it wrote, so a printed receipt shows the real
   * allocation rather than a re-guess of it. The same reason the vouchers print
   * from their ledger rows.
   */
  async printSettlement(s: any) {
    const linesRes = await this.db.get(
      `SELECT cl.credit, cl.reference_id, b.bill_number, b.bill_date,
              b.total_amount, b.amount_paid
       FROM customer_ledger cl
       LEFT JOIN bills b ON cl.reference_id = b.bill_id
       WHERE cl.internal_settlement_id = ?
       ORDER BY cl.ledger_id ASC`,
      [s.settlement_id]
    );
    const lines = linesRes.success ? (linesRes.data || []) : [];

    // Which flock or batch the debt belongs to. The own-farm customer is keyed
    // on the FARM UNIT, not the flock — flocks close and are deleted, the farm
    // that owes the money does not — so the flock is reached through the unit.
    let unit: any = null;
    if (s.unit_id != null) {
      const unitRes = await this.db.get(
        `SELECT fu.unit_name, fu.module_type,
                (SELECT GROUP_CONCAT(f.flock_name, ', ') FROM flocks f
                  WHERE f.unit_id = fu.unit_id AND COALESCE(f.status, 'active') = 'active') AS flocks,
                (SELECT GROUP_CONCAT(bt.batch_name, ', ') FROM batches bt
                  WHERE bt.unit_id = fu.unit_id AND COALESCE(bt.status, 'active') = 'active') AS batches
         FROM farm_units fu WHERE fu.unit_id = ?`,
        [s.unit_id]
      );
      unit = (unitRes.success && unitRes.data && unitRes.data[0]) || null;
    }

    const doc = new jsPDF('p', 'mm', 'a4');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const B: [number, number, number] = [0, 0, 0];
    const G: [number, number, number] = [120, 120, 120];
    const margin = 14;
    const today = new Date().toLocaleDateString('en-PK');
    const footer = 'Software By: www.devinfantary.com  |  Contact: 0302 6938217';
    const rs = (n: any) => 'Rs. ' + Math.round(Number(n) || 0).toLocaleString();

    // ── Background watermark ────────────────────────────────
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

    // ── Logo + letterhead ───────────────────────────────────
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
    doc.text(`INTERNAL SETTLEMENT RECEIPT — ${s.settlement_number || ''}`, pw / 2, y, { align: 'center' });
    y += 7;

    doc.setDrawColor(...B);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pw - margin, y);
    y += 9;

    // ── Details ─────────────────────────────────────────────
    //
    // THE ONE BRANCH ON THE PAGE. Different accounts show where the money came
    // from and where it went; the same account (or cash both sides) shows the
    // one account and says plainly that nothing moved between accounts — which
    // is why no bank entry exists for it.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('DETAILS', margin, y);
    y += 6;

    const detail: [string, string][] = [
      ['Settled By', s.customer_name || 'Own Farm'],
      ['Farm', unit?.unit_name || '—'],
      [(unit?.module_type === 'layer') ? 'Batch' : 'Flock',
        (unit?.flocks || unit?.batches || '—')],
      ['Date', String(s.date || '—')],
      ['Settled Amount', rs(s.amount)]
    ];

    if (this.settledInPlace(s)) {
      detail.push(['Account', this.fromLabel(s)]);
      detail.push(['Transfer', 'None (settled in place — no money moved between accounts)']);
    } else {
      detail.push(['From account', this.fromLabel(s)]);
      detail.push(['To account', this.toLabel(s)]);
    }

    detail.push(['Reference', s.reference || '—']);
    detail.push(['Notes', s.notes || '—']);

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

    // ── The bills it cleared ────────────────────────────────
    const body = lines.length > 0
      ? lines.map((l: any) => [
          l.bill_number || '—',
          l.bill_date || '—',
          rs(l.total_amount),
          rs(l.credit),
          rs(Math.max((Number(l.total_amount) || 0) - (Number(l.amount_paid) || 0), 0))
        ])
      : [['No bills recorded against this settlement', '', '', '', '']];

    autoTable(doc, {
      startY: y,
      head: [['Bill #', 'Bill Date', 'Bill Total', 'Settled', 'Still Owed']],
      body,
      foot: [['Total', '', '', rs(s.amount), '']],
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

    let noteY = (doc as any).lastAutoTable.finalY + 8;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(...G);
    const note = doc.splitTextToSize(
      this.settledInPlace(s)
        ? 'Both ends of this settlement are the same account, so no money moved between accounts and ' +
          'no bank entry was recorded. The farm\'s debt to the distribution business is cleared.'
        : 'This settlement moved money between two of the owner\'s own accounts: a withdrawal from the ' +
          'paying account and a deposit into the receiving one. The total across all accounts is ' +
          'unchanged — only the farm\'s debt to the distribution business has cleared.',
      pw - margin * 2 - 12
    );
    doc.text(note, margin + 6, noteY);

    // ── Footer ──────────────────────────────────────────────
    const totalPages = (doc.internal as any).getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(7.5);
      doc.setTextColor(...G);
      doc.text(footer, pw / 2, ph - 9, { align: 'center' });
      doc.text('Page ' + i + ' of ' + totalPages, pw / 2, ph - 4, { align: 'center' });
    }

    await this.printPdf(doc, `${s.settlement_number || 'Internal_Settlement'}.pdf`);
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
