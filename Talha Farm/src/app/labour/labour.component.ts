import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { BankPickerComponent } from '../shared/components/bank-picker/bank-picker.component';
import { bankSourceError, bankSourceFields, bankNameOf } from '../shared/utils/bank-source.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { FlockService } from '../shared/services/flock.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';

import { toLocalDateString } from '../shared/utils/date.util';
import { groupByKey, byNewestFirst, GroupSummary } from '../shared/utils/group.util';
@Component({
  selector: 'app-labour',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent, BankPickerComponent],
  templateUrl: './labour.component.html',
  styleUrl: './labour.component.scss'
})
export class LabourComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
  roster: any[] = [];
  payments: any[] = [];
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;
  errorMessage = '';
  // The farm's OWN accounts. Never getBankAccounts() unscoped — that also
  // returns customers' accounts, and paying a wage out of a customer's account
  // would record it as that customer's withdrawal.
  houseBanks: any[] = [];

  showQuickAdd = false;
  quickAddForm = { labour_name: '', phone: '', role: '' };
  quickAddTargetRow: any = null; // which pending row triggered the quick-add

  currentPage = 1;
  pageSize = 20;

  /** The worker card the user clicked into, or null for the grid. */
  selectedWorker: GroupSummary<number> | null = null;

  private subs = new Subscription();

  get hasPendingRows(): boolean { return this.pendingRows.length > 0; }

  /** One card per worker who has a payment on this flock/batch, newest total first. */
  get workerGroups(): GroupSummary<number>[] {
    return groupByKey(
      this.payments,
      p => p.labour_id,
      p => p.labour_name,
      p => p.amount
    ).sort((a, b) => b.total - a.total);
  }

  /** The selected worker's payments, newest first — reads `payments`, never recomputed elsewhere. */
  get selectedWorkerPayments(): any[] {
    if (!this.selectedWorker) return [];
    return this.payments
      .filter(p => p.labour_id === this.selectedWorker!.key)
      .slice()
      .sort((a, b) => byNewestFirst(a.date, b.date, a.payment_id, b.payment_id));
  }

  get selectedWorkerTotal(): number {
    return this.selectedWorkerPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
  }

  get paginatedWorkerPayments() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.selectedWorkerPayments.slice(start, start + this.pageSize);
  }

  openWorker(worker: GroupSummary<number>) {
    this.selectedWorker = worker;
    this.editingId = null;
    this.currentPage = 1;
  }

  closeWorker() {
    this.selectedWorker = null;
    this.currentPage = 1;
  }

  /** Adds a pending row already tied to the worker whose detail view is open. */
  addPendingRowForWorker(labourId: number) {
    if (this.isSaving) return;
    this.editingId = null;
    const row = this.makeNewRow();
    row.labour_id = labourId;
    this.pendingRows.push(row);
  }

  get targetId(): number | null {
    return this.currentFlock?.flock_id || this.currentFlock?.batch_id || null;
  }
  get moduleType(): string {
    return this.currentFlock?.batch_id ? 'layer' : 'broiler';
  }

  get totalPaid(): number {
    return this.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === 'a') {
      const activeTag = (event.target as HTMLElement)?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
      event.preventDefault();
      this.addPendingRow();
    }
    if (event.ctrlKey && event.key === 's') {
      event.preventDefault();
      if (this.hasPendingRows) this.saveAllRows();
    }
  }

  constructor(
    private db: DatabaseService,
    private flockService: FlockService,
    private authService: AuthService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    const resolved = this.route.snapshot.data['data'];
    if (resolved) {
      this.currentFlock = resolved.flock;
      this.roster = resolved.roster || [];
      this.payments = resolved.payments || [];
      // The resolver supplies the roster and the payments, so loadPayments()
      // never runs on arrival — the bank accounts still have to be fetched, or
      // the account dropdown is empty until a flock switch.
      this.loadBanks().then(() => this.cdr.detectChanges());
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock) {
          this.currentFlock = flock;
          this.pendingRows = [];
          this.editingId = null;
          this.selectedWorker = null;
          this.loadRoster();
          this.loadPayments();
        }
      })
    );
  }

  ngOnDestroy() { this.subs.unsubscribe(); }

  bankNameOf(bankId: number | null): string { return bankNameOf(this.houseBanks, bankId); }

  /**
   * How a bank-paid wage is labelled on the bank statement. The account's
   * ledger is read on its own, away from this screen, so the line has to name
   * the worker without it.
   */
  private withdrawalLabel(row: any): string {
    const who = this.getLabourName(row?.labour_id) || 'labour';
    const head = `Labour payment - ${who}`;
    const tail = String(row?.description ?? '').trim();
    return tail ? `${head}: ${tail}` : head;
  }

  /**
   * Re-read on every payment load: the account list is farm-wide rather than
   * per flock or batch, so an account added on the Bank screen has to appear
   * here without a reload.
   */
  async loadBanks() {
    const farmId = this.currentFlock?.farm_id || this.authService.getCurrentFarm()?.farm_id;
    if (!farmId) { this.houseBanks = []; return; }
    const res = await this.db.getHouseBankAccounts(farmId);
    this.houseBanks = res.success ? (res.data || []) : [];
  }

  async loadRoster() {
    // Roster is farm-wide. Deriving farm_id from the existing roster's own
    // first row silently no-ops when the roster is still empty (e.g. right
    // after inserting this farm's very first labour via quick-add) — the
    // insert succeeds but this reload finds no row to read a farm_id from,
    // so the newly added worker never appears until something else (a full
    // navigation, re-running the resolver) reloads the roster instead.
    const farmIdSource = this.currentFlock?.farm_id || this.authService.getCurrentFarm()?.farm_id;
    if (!farmIdSource) return;
    const result = await this.db.get(`SELECT * FROM labour WHERE farm_id = ? AND status = 'active' ORDER BY labour_name ASC`, [farmIdSource]);
    if (result.success) {
      this.roster = result.data;
      this.cdr.detectChanges();
    }
  }

  async loadPayments() {
    await this.loadBanks();
    if (!this.targetId) { this.payments = []; this.cdr.detectChanges(); return; }
    // LEFT JOIN, not JOIN: deleting a worker off the roster keeps their
    // payments — the money really left the farm — so an INNER JOIN silently
    // dropped real cost here while overview.service.ts and
    // farm-report.service.ts, which never join `labour`, kept counting it.
    // Module fragments are literals, matching farm-report.service.ts.
    const moduleWhere = this.moduleType === 'layer'
      ? `lp.module_type = 'layer'`
      : `COALESCE(lp.module_type,'broiler') = 'broiler'`;
    const result = await this.db.get(
      `SELECT lp.*, COALESCE(l.labour_name, 'Deleted Worker') AS labour_name
       FROM labour_payments lp
       LEFT JOIN labour l ON lp.labour_id = l.labour_id
       WHERE lp.flock_id = ? AND ${moduleWhere}
       ORDER BY lp.date ASC`,
      [this.targetId]
    );
    if (result.success) {
      this.payments = result.data;
      this.currentPage = 1;
      this.cdr.detectChanges();
    }
  }

  getLabourName(labourId: number): string {
    return this.roster.find(l => l.labour_id === labourId)?.labour_name || '—';
  }

  // ── Quick add labour (from within a pending row) ────────────
  openQuickAdd(row: any) {
    this.quickAddTargetRow = row;
    this.quickAddForm = { labour_name: '', phone: '', role: '' };
    this.showQuickAdd = true;
  }
  cancelQuickAdd() { this.showQuickAdd = false; this.quickAddTargetRow = null; }

  async saveQuickAdd() {
    if (!this.quickAddForm.labour_name.trim()) return;
    const farmId = this.currentFlock?.farm_id || this.roster[0]?.farm_id;
    if (!farmId) return;
    const result = await this.db.run(
      `INSERT INTO labour (farm_id, labour_name, phone, role) VALUES (?,?,?,?)`,
      [farmId, this.quickAddForm.labour_name.trim(), this.quickAddForm.phone || '', this.quickAddForm.role || '']
    );
    if (result.success) {
      await this.loadRoster();
      const newLabourId = (result as any).lastId;
      if (this.quickAddTargetRow) {
        this.quickAddTargetRow.labour_id = newLabourId;
      }
    }
    this.showQuickAdd = false;
    this.quickAddTargetRow = null;
    this.cdr.detectChanges();
  }

  // ── Pending rows ─────────────────────────────────────────────
  makeNewRow(): any {
    return {
      labour_id: this.roster.length > 0 ? this.roster[0].labour_id : null,
      date: toLocalDateString(),
      description: '',
      amount: null,
      payment_type: 'cash',
      bank_id: null
    };
  }

  addPendingRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.pendingRows.push(this.makeNewRow());
  }
  addRowAfter(index: number) { this.pendingRows.splice(index + 1, 0, this.makeNewRow()); }
  removePendingRow(index: number) { this.pendingRows.splice(index, 1); }
  cancelAllRows() { this.pendingRows = []; }

  async saveAllRows() {
    if (!this.pendingRows.length || this.isSavingAll || !this.targetId) return;
    this.errorMessage = '';

    for (let i = 0; i < this.pendingRows.length; i++) {
      const row = this.pendingRows[i];
      if (!row.labour_id || !row.date || !row.amount) {
        this.errorMessage = `Row ${i + 1}: select labour, date and amount.`;
        this.cdr.detectChanges();
        return;
      }
      if (Number(row.amount) <= 0) {
        this.errorMessage = `Row ${i + 1}: amount must be greater than 0.`;
        this.cdr.detectChanges();
        return;
      }
    }

    for (let i = 0; i < this.pendingRows.length; i++) {
      const err = bankSourceError(this.pendingRows[i], this.houseBanks, `Row ${i + 1}`);
      if (err) { this.errorMessage = err; this.cdr.detectChanges(); return; }
    }

    this.isSavingAll = true;
    try {
      // One batch rather than a `run()` per row: every run() writes the whole
      // database file back to disk, and a failure part way through used to
      // leave some payments saved and the rest silently dropped. A bank-paid
      // row's withdrawal is interleaved directly after its own insert and keyed
      // to it with `{ $lastId: -1 }`, so the payment and the money leaving the
      // account are one movement; balances are rebuilt once at the end, per
      // account.

      // NO ACCOUNT MAY BE TAKEN BELOW ZERO, and the whole set of rows is
      // weighed at once: several wages paid out of one account are affordable
      // individually and not together, and they land in one batch. Refused
      // here, so the batch never runs.
      const balanceGuard = await this.db.checkBankSourceInserts(
        'labour_payments',
        this.pendingRows.map(r => ({ ...bankSourceFields(r), amount: Number(r.amount) || 0 }))
      );
      if (!balanceGuard.success) {
        this.errorMessage = balanceGuard.error || 'Not enough balance in that account.';
        return;
      }

      const ops: DbBatchOp[] = [];
      for (const row of this.pendingRows) {
        const bank = bankSourceFields(row);
        ops.push({
          sql: `INSERT INTO labour_payments (labour_id, flock_id, date, description, amount, payment_type, payment_source, bank_id, module_type) VALUES (?,?,?,?,?,?,?,?,?)`,
          params: [row.labour_id, this.targetId, row.date, row.description || '', row.amount, row.payment_type || 'cash', bank.payment_source, bank.bank_id, this.moduleType]
        });
        ops.push(...this.db.bankSourceInsertOps('labour_payments', {
          ...bank,
          date: row.date,
          description: this.withdrawalLabel(row),
          amount: Number(row.amount) || 0
        }));
      }
      ops.push(...this.db.bankRebuildOps(this.pendingRows.map(r => bankSourceFields(r).bank_id)));

      const result = await this.db.runBatch(ops);
      if (!result?.success) {
        this.errorMessage =
          'Could not save these payments: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was written.';
        return;
      }
      this.pendingRows = [];
      await this.loadPayments();
    } finally {
      this.isSavingAll = false;
      this.cdr.detectChanges();
    }
  }

  // ── Edit / delete ─────────────────────────────────────────────
  startEdit(p: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = p.payment_id;
    this.editForm = {
      labour_id: p.labour_id,
      date: p.date,
      description: p.description,
      amount: p.amount,
      payment_type: p.payment_type || 'cash',
      bank_id: p.bank_id ?? null
    };
  }
  cancelEdit() { this.editingId = null; this.editForm = {}; }

  async saveEdit(id: number) {
    if (this.isSaving) return;
    if (!this.editForm.labour_id || !this.editForm.date || !this.editForm.amount) {
      this.errorMessage = 'Select labour, date and amount.';
      this.cdr.detectChanges();
      return;
    }
    const bankErr = bankSourceError(this.editForm, this.houseBanks);
    if (bankErr) { this.errorMessage = bankErr; this.cdr.detectChanges(); return; }

    this.isSaving = true;
    try {
      // The withdrawal is reversed and re-posted rather than patched, which is
      // one shape for all five transitions - changed amount (the net movement
      // is the difference), changed date, cash to bank, bank to cash, and
      // bank A to bank B - with both accounts rebuilt at the end.
      const bank = bankSourceFields(this.editForm);
      const update: DbBatchOp = {
        sql: `UPDATE labour_payments SET labour_id=?, date=?, description=?, amount=?, payment_type=?, payment_source=?, bank_id=? WHERE payment_id=?`,
        params: [this.editForm.labour_id, this.editForm.date, this.editForm.description || '', this.editForm.amount, this.editForm.payment_type || 'cash', bank.payment_source, bank.bank_id, id]
      };
      const result = await this.db.saveBankSourceEdit('labour_payments', id, update, {
        ...bank,
        date: this.editForm.date,
        description: this.withdrawalLabel(this.editForm),
        amount: Number(this.editForm.amount) || 0
      });
      if (!result?.success) {
        this.errorMessage =
          'Could not save this payment: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was changed.';
        return;
      }
      this.editingId = null;
      this.editForm = {};
      await this.loadPayments();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDelete(id: number) { this.deletingId = id; this.showDeleteDialog = true; }
  onDeleteCancelled() { this.showDeleteDialog = false; this.deletingId = null; }

  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    this.isSaving = true;
    this.showDeleteDialog = false;
    try {
      // If it was paid by bank, the withdrawal goes with it and the account is
      // rebuilt in the same batch. The money never left.
      const result = await this.db.deleteBankSourced('labour_payments', this.deletingId, [
        { sql: `DELETE FROM labour_payments WHERE payment_id=?`, params: [this.deletingId] }
      ]);
      if (!result?.success) {
        this.errorMessage =
          'Could not delete this payment: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was changed.';
        return;
      }
      await this.loadPayments();
    } finally {
      this.deletingId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }
}