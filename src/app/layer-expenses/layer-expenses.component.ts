import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { BankPickerComponent } from '../shared/components/bank-picker/bank-picker.component';
import { bankSourceError, bankSourceFields, bankNameOf } from '../shared/utils/bank-source.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { Subscription } from 'rxjs';

import { toLocalDateString } from '../shared/utils/date.util';

@Component({
  selector: 'app-layer-expenses',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe, PaginationComponent, BankPickerComponent],
  templateUrl: './layer-expenses.component.html',
  styleUrl: './layer-expenses.component.scss'
})
export class LayerExpensesComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  batches: any[] = [];
  expenses: any[] = [];
  // What an expense with no category of its own is shown and saved as — the
  // same free-text fallback the broiler Expenses screen uses
  // (`expenses.component.ts`), on the same `expenses.category` column. There is
  // no category table for farm expenses.
  readonly defaultCategory = 'Other';
  // All layer farms for this account — drives the unit_id filter below.
  units: any[] = [];
  // The farm currently selected in the sidebar.
  currentUnit: any = null;
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  showDeleteCodeDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;
  errorMessage = '';

  currentPage = 1;
  pageSize = 30;

  selectedBatchFilter: string = 'all';
  // The farm's OWN accounts. Never getBankAccounts() unscoped - that also
  // returns customers' accounts, and paying for diesel out of a customer's
  // account would record it as that customer's withdrawal.
  houseBanks: any[] = [];
  private subs = new Subscription();

  get filteredExpenses() {
    if (this.selectedBatchFilter === 'all') return this.expenses;
    return this.expenses.filter(e => String(e.batch_id) === String(this.selectedBatchFilter));
  }

  get paginatedExpenses() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredExpenses.slice(start, start + this.pageSize);
  }

  get totalExpenses(): number {
    return this.filteredExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }

  get hasPendingRows(): boolean { return this.pendingRows.length > 0; }

  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === 'a') {
      if ((event.target as HTMLElement)?.tagName === 'INPUT' || (event.target as HTMLElement)?.tagName === 'TEXTAREA') return;
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
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
    private pendingState: PendingStateService,
    private flockService: FlockService,
    private farmUnitService: FarmUnitService, private dataChange: DataChangeService
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    // Load units first — the currentUnit$ subscription below fires
    // synchronously (BehaviorSubject) and its filtering depends on
    // this.units already being populated.
    await this.loadUnits();
    await this.loadData();

    const cached = this.pendingState.getState('LayerExpensesComponent');
    if (cached && cached.farmId === this.currentFarm?.farm_id) {
      this.pendingRows = cached.pendingRows || [];
    }

    this.applyActiveBatch(this.flockService.getCurrentFlock());
    this.subs.add(
      this.flockService.currentFlock$.subscribe(flock => this.applyActiveBatch(flock))
    );

    this.subs.add(
      this.farmUnitService.currentUnit$.subscribe(unit => {
        this.currentUnit = unit;
        this.loadData();
      })
    );

    this.subs.add(
      this.dataChange.onChange('units').subscribe(async () => {
        await this.loadUnits();
        this.loadData();
      })
    );
  }

  async loadUnits() {
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id, 'layer');
    this.units = result.success ? result.data : [];
  }

  /**
   * Re-read on every loadData(), not once: the account list is farm-wide rather
   * than per batch, so an account added on the Bank screen has to appear here
   * without a reload.
   */
  async loadBanks() {
    const farmId = this.currentFarm?.farm_id;
    if (!farmId) { this.houseBanks = []; return; }
    const res = await this.db.getHouseBankAccounts(farmId);
    this.houseBanks = res.success ? (res.data || []) : [];
  }

  bankNameOf(bankId: number | null): string { return bankNameOf(this.houseBanks, bankId); }

  /**
   * How a bank-paid expense is labelled on the bank statement. The account's
   * ledger is read on its own, away from this screen, so the line has to say
   * what the money was for without it.
   */
  private withdrawalLabel(row: any): string {
    const head = `Layer expense - ${this.categoryOf(row)}`;
    const tail = String(row?.description ?? '').trim();
    return tail ? `${head}: ${tail}` : head;
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
    this.pendingState.saveState('LayerExpensesComponent', { farmId: this.currentFarm?.farm_id, pendingRows: this.pendingRows });
  }

  private applyActiveBatch(flock: any) {
    if (!flock?.batch_id) return;
    const batchId = String(flock.batch_id);
    if (this.selectedBatchFilter === batchId) return;
    this.selectedBatchFilter = batchId;
    this.currentPage = 1;
    this.cdr.detectChanges();
  }

  async loadData() {
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty list.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;

    const batchSql = unitId
      ? `SELECT * FROM batches WHERE farm_id = ? AND status = 'active' AND unit_id = ? ORDER BY batch_id DESC`
      : `SELECT * FROM batches WHERE farm_id = ? AND status = 'active' ORDER BY batch_id DESC`;
    const batchParams = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const batchResult = await this.db.get(batchSql, batchParams);
    this.batches = batchResult.success ? batchResult.data : [];

    // Shared table: expenses.flock_id holds the batch_id when module_type = 'layer'.
    const expSql = unitId
      ? `SELECT e.*, e.flock_id AS batch_id, b.batch_name FROM expenses e JOIN batches b ON e.flock_id = b.batch_id WHERE b.farm_id = ? AND b.unit_id = ? AND e.module_type = 'layer' ORDER BY e.date DESC, e.expense_id DESC`
      : `SELECT e.*, e.flock_id AS batch_id, b.batch_name FROM expenses e JOIN batches b ON e.flock_id = b.batch_id WHERE b.farm_id = ? AND e.module_type = 'layer' ORDER BY e.date DESC, e.expense_id DESC`;
    const expParams = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const expResult = await this.db.get(expSql, expParams);
    this.expenses = expResult.success ? expResult.data : [];
    await this.loadBanks();
    this.cdr.detectChanges();
  }

  getBatchName(batchId: number): string {
    return this.batches.find(b => b.batch_id === batchId)?.batch_name || '—';
  }

  /** Trim whatever the user typed; an empty category falls back to "Other". */
  private categoryOf(row: any): string {
    return String(row?.category ?? '').trim() || this.defaultCategory;
  }

  makeNewRow(): any {
    return {
      batch_id: this.selectedBatchFilter !== 'all' ? Number(this.selectedBatchFilter) : (this.batches.length > 0 ? this.batches[0].batch_id : null),
      date: toLocalDateString(),
      category: this.defaultCategory,
      description: '',
      amount: null,
      notes: '',
      // This screen never had a payment selector, so Cash/Bank is its own
      // field rather than being derived from a `payment_type` the way the
      // broiler Expenses screen does it.
      payment_source: 'cash',
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

  // Returns an error message if the row is invalid, otherwise null.
  validateExpenseRow(row: any): string | null {
    if (!row.batch_id || !row.date || row.amount === null || row.amount === undefined || row.amount === '') {
      return 'Select a batch, date and enter an amount.';
    }
    if (Number(row.amount) <= 0) {
      return 'Amount must be greater than 0.';
    }
    // Paid by bank with no account chosen is refused rather than saved as cash:
    // an expense that says it left a bank account has to name which one, or
    // nothing reverses it and no balance moves.
    return bankSourceError(row, this.houseBanks);
  }

  async saveAllRows() {
    if (this.pendingRows.length === 0 || this.isSavingAll) return;
    this.errorMessage = '';
    for (const row of this.pendingRows) {
      const error = this.validateExpenseRow(row);
      if (error) { this.errorMessage = error; this.cdr.detectChanges(); return; }
    }
    this.isSavingAll = true;
    try {
      // A bank-paid row's withdrawal is interleaved directly after its own
      // insert and keyed to it with `{ $lastId: -1 }`, so the expense and the
      // money leaving the account are one movement. Balances are rebuilt once
      // at the end, per account: several rows paid out of the same account
      // would otherwise each cache a figure the next statement invalidates.

      // NO ACCOUNT MAY BE TAKEN BELOW ZERO, and the whole set of rows is
      // weighed at once: several rows paid out of one account are affordable
      // individually and not together, and they land in one batch. Refused
      // here, so the batch never runs.
      const balanceGuard = await this.db.checkBankSourceInserts(
        'expenses',
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
          sql: `INSERT INTO expenses (flock_id, date, category, description, amount, notes, payment_source, bank_id, module_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'layer')`,
          params: [row.batch_id, row.date, this.categoryOf(row), row.description || null, row.amount, row.notes || null, bank.payment_source, bank.bank_id]
        });
        ops.push(...this.db.bankSourceInsertOps('expenses', {
          ...bank,
          date: row.date,
          description: this.withdrawalLabel(row),
          amount: Number(row.amount) || 0
        }));
      }
      ops.push(...this.db.bankRebuildOps(this.pendingRows.map(r => bankSourceFields(r).bank_id)));

      // runBatch reports a failed write in `.success` rather than throwing, so
      // an unchecked result closed the form on rows that never landed - and now
      // on a bank withdrawal that never landed either.
      const result = await this.db.runBatch(ops);
      if (!result?.success) {
        this.errorMessage =
          'Could not save these expenses: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was written.';
        return;
      }
      this.pendingRows = [];
      await this.loadData();
    } finally {
      this.isSavingAll = false;
      this.cdr.detectChanges();
    }
  }

  cancelAllRows() { this.pendingRows = []; }

  startEdit(e: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = e.expense_id;
    // A legacy row saved before the category column was used shows "Other",
    // so editing one does not silently clear it.
    this.editForm = { batch_id: e.batch_id, date: e.date, category: e.category || this.defaultCategory, description: e.description, amount: e.amount, notes: e.notes,
      payment_source: e.payment_source === 'bank' ? 'bank' : 'cash', bank_id: e.bank_id ?? null };
  }

  cancelEdit() { if (!this.isSaving) { this.editingId = null; this.editForm = {}; } }

  async saveEdit(id: number) {
    if (this.isSaving) return;
    const error = this.validateExpenseRow(this.editForm);
    if (error) { this.errorMessage = error; this.cdr.detectChanges(); return; }
    this.isSaving = true;
    this.editingId = null;
    this.errorMessage = '';
    try {
      // The withdrawal is reversed and re-posted rather than patched, which is
      // one shape for all five transitions - changed amount (the net movement
      // is the difference), changed date, cash->bank, bank->cash and
      // bank A->bank B - with both accounts rebuilt at the end.
      const bank = bankSourceFields(this.editForm);
      const update: DbBatchOp = {
        sql: `UPDATE expenses SET flock_id = ?, date = ?, category = ?, description = ?, amount = ?, notes = ?, payment_source = ?, bank_id = ?, module_type = 'layer' WHERE expense_id = ?`,
        params: [this.editForm.batch_id, this.editForm.date, this.categoryOf(this.editForm), this.editForm.description || null, this.editForm.amount, this.editForm.notes || null, bank.payment_source, bank.bank_id, id]
      };
      const result = await this.db.saveBankSourceEdit('expenses', id, update, {
        ...bank,
        date: this.editForm.date,
        description: this.withdrawalLabel(this.editForm),
        amount: Number(this.editForm.amount) || 0
      });
      if (!result?.success) {
        this.errorMessage =
          'Could not save this expense: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was changed.';
        this.editingId = id;
        return;
      }
      this.editForm = {};
      await this.loadData();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDelete(id: number) { if (!this.isSaving) { this.deletingId = id; this.showDeleteCodeDialog = true; } }
  onDeleteCodeVerified() { this.showDeleteCodeDialog = false; this.showDeleteDialog = true; }
  onDeleteCodeCancelled() { this.showDeleteCodeDialog = false; this.deletingId = null; }

  async onDeleteConfirmed() {
    if (this.isSaving || !this.deletingId) return;
    this.isSaving = true;
    this.showDeleteDialog = false;
    try {
      // If it was paid by bank, the withdrawal goes with it and the account is
      // rebuilt in the same batch. The money never left.
      const result = await this.db.deleteBankSourced('expenses', this.deletingId, [
        { sql: 'DELETE FROM expenses WHERE expense_id = ?', params: [this.deletingId] }
      ]);
      if (!result?.success) {
        this.errorMessage =
          'Could not delete this expense: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was changed.';
        return;
      }
      await this.loadData();
    } finally {
      this.deletingId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() { this.showDeleteDialog = false; this.deletingId = null; }
}
