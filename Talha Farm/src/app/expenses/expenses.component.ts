import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { FlockService } from '../shared/services/flock.service';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { BankPickerComponent } from '../shared/components/bank-picker/bank-picker.component';
import { AuthService } from '../shared/services/auth.service';
import { bankSourceError, bankSourceFields, bankNameOf } from '../shared/utils/bank-source.util';

import { toLocalDateString } from '../shared/utils/date.util';
@Component({
  selector: 'app-expenses',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent, BankPickerComponent],
  templateUrl: './expenses.component.html',
  styleUrl: './expenses.component.scss'
})
export class ExpensesComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
  expenses: any[] = [];
  // What an expense with no category of its own is shown and saved as. This is
  // the successor to the fixed "Other" ledger the screen used to file every row
  // under: a plain value in the row's own `category` column, with no ledger
  // behind it. Free text — there is no category table for farm expenses.
  readonly defaultCategory = 'Other';
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;

  showValidationDialog = false;
  validationMessage = '';

  // The farm's OWN accounts. Never getBankAccounts() unscoped — that also
  // returns customers' accounts, and paying for feed out of a customer's
  // account would record it as that customer's withdrawal.
  houseBanks: any[] = [];

  currentPage = 1;
  pageSize = 20;

  selectedDateFilter: string = '';
  filteredByDate: boolean = false;

  // This screen lists rows from `expenses` and nothing else, and it writes
  // nothing else either. Expenses and ledgers are two independent books: an
  // expense is a row here with a category and touches no ledger; a ledger entry
  // lives on the Ledger screen and touches no expense. Nothing links them — no
  // mirror row, no ledger_id, no ledger_entry_id. The Report still subtracts
  // both, as two separately labelled lines.
  get filteredExpenses() {
    if (!this.filteredByDate || !this.selectedDateFilter) return this.expenses;
    return this.expenses.filter(e => String(e.date).split('T')[0] === this.selectedDateFilter);
  }

  get paginatedExpenses() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredExpenses.slice(start, start + this.pageSize);
  }

  applyDateFilter() { if (this.selectedDateFilter) { this.filteredByDate = true; this.currentPage = 1; } }
  clearDateFilter() { this.selectedDateFilter = ''; this.filteredByDate = false; this.currentPage = 1; }

  private subs = new Subscription();

  get totalExpenses(): number {
    return this.expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  get hasPendingRows(): boolean {
    return this.pendingRows.length > 0;
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
    if (event.key === 'Escape' && this.viewingImage) {
      this.closeImage();
    }
  }

  constructor(
    private db: DatabaseService,
    private flockService: FlockService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    private pendingState: PendingStateService,
    private authService: AuthService
  ) {}

  bankNameOf(bankId: number | null): string { return bankNameOf(this.houseBanks, bankId); }

  /**
   * How a bank-paid expense is labelled on the bank statement. The account's
   * ledger is read on its own, away from this screen, so the line has to say
   * what the money was for without it.
   */
  private withdrawalLabel(row: any): string {
    const head = `Expense — ${this.categoryOf(row)}`;
    const tail = String(row?.description ?? '').trim();
    return tail ? `${head}: ${tail}` : head;
  }

  ngOnInit() {
    const resolved = this.route.snapshot.data['data'];
    if (resolved) {
      this.currentFlock = resolved.flock;
      this.expenses = resolved.expenses || [];

      const cached = this.pendingState.getState('ExpensesComponent');
      if (cached && cached.flockId === this.currentFlock?.flock_id) {
        this.pendingRows = cached.pendingRows || [];
      }
      // The resolver supplies the expenses, so loadData() never runs on
      // arrival — the accounts still have to be fetched.
      this.loadBanks().then(() => this.cdr.detectChanges());
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock) {
          this.currentFlock = flock;
          this.pendingRows = [];
          this.editingId = null;
          this.isSaving = false;
          this.pendingState.clearState('ExpensesComponent');
          this.loadData();
        }
      })
    );
  }

  ngOnDestroy() {
    this.pendingState.saveState('ExpensesComponent', {
      flockId: this.currentFlock?.flock_id,
      pendingRows: this.pendingRows
    });
    this.subs.unsubscribe();
  }

  async loadData() {
    if (!this.currentFlock) return;

    const expensesResult = await this.db.get(
      // Shared table — layer files a batch_id in flock_id and the ids collide,
      // so the module guard is what keeps layer expenses off this screen.
      // Must stay identical to expenses.resolver.ts.
      `SELECT e.* FROM expenses e
       WHERE e.flock_id = ? AND COALESCE(e.module_type,'broiler') = 'broiler'
       ORDER BY e.date DESC`,
      [this.currentFlock.flock_id]
    );

    if (expensesResult.success) this.expenses = expensesResult.data;

    await this.loadBanks();
    this.cdr.detectChanges();
  }

  /** Trim whatever the user typed; an empty category falls back to "Other". */
  private categoryOf(row: any): string {
    return String(row?.category ?? '').trim() || this.defaultCategory;
  }

  /**
   * Loaded on arrival as well as on every flock switch, because the resolver
   * does not fetch them and the account list is farm-wide rather than per
   * flock — a new account added on the Bank screen has to show up here without
   * a reload.
   */
  async loadBanks() {
    const farmId = this.currentFlock?.farm_id || this.authService.getCurrentFarm()?.farm_id;
    if (!farmId) { this.houseBanks = []; return; }
    const res = await this.db.getHouseBankAccounts(farmId);
    this.houseBanks = res.success ? (res.data || []) : [];
  }

  // ── Pending Rows (Multi-row add) ─────────────────────────────
  makeNewRow(): any {
    return {
      date: toLocalDateString(),
      category: this.defaultCategory,
      description: '',
      amount: null,
      payment_type: 'cash',
      bank_id: null,
      bill_available: 'No',
      receipt_image: null
    };
  }

  addPendingRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.pendingRows.push(this.makeNewRow());
  }

  addRowAfter(index: number) {
    this.pendingRows.splice(index + 1, 0, this.makeNewRow());
  }

  removePendingRow(index: number) {
    this.pendingRows.splice(index, 1);
  }

  async saveAllRows() {
    if (this.pendingRows.length === 0) return;
    if (this.isSavingAll) return;
    this.isSavingAll = true;

    try {
      const invalidRows: any[] = [];
      const validRows: any[] = [];

      for (const row of this.pendingRows) {
        if (!row.date || !row.amount) invalidRows.push(row);
        else validRows.push(row);
      }

      // A row paid by bank with no account chosen is refused outright rather
      // than saved as cash — including a legacy row being re-entered. Checked
      // before anything is written, so the whole save stays all-or-nothing.
      for (let i = 0; i < validRows.length; i++) {
        const err = bankSourceError(validRows[i], this.houseBanks, `Row ${i + 1}`);
        if (err) {
          this.validationMessage = err;
          this.showValidationDialog = true;
          return;
        }
      }

      if (validRows.length > 0) {
        // One row, one statement — an expense is a row in `expenses` and nothing
        // more. No ledger is resolved, created or written to. Still one batch for
        // the lot so the whole save is atomic and the DB file is written once
        // rather than once per row.
        //
        // A bank-paid row's withdrawal is interleaved directly after its own
        // insert and keyed to it with `{ $lastId: -1 }`, so the expense and the
        // money leaving the account are one movement. Balances are rebuilt once
        // at the end, per account: several rows paid out of the same account
        // would otherwise each cache a figure the next statement invalidates.

        // NO ACCOUNT MAY BE TAKEN BELOW ZERO, and the whole set of rows is
        // weighed at once rather than one at a time: three expenses each
        // affordable on their own are not affordable together, and they land
        // in one batch. Refused here, so the batch never runs.
        const balanceGuard = await this.db.checkBankSourceInserts(
          'expenses',
          validRows.map(r => ({ ...bankSourceFields(r), amount: Number(r.amount) || 0 }))
        );
        if (!balanceGuard.success) {
          this.validationMessage = balanceGuard.error || 'Not enough balance in that account.';
          this.showValidationDialog = true;
          return;
        }

        const ops: DbBatchOp[] = [];
        for (const row of validRows) {
          const bank = bankSourceFields(row);
          ops.push({
            sql: `INSERT INTO expenses (flock_id, date, category, description, amount, payment_type, payment_source, bank_id, bill_available, receipt_image, module_type)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'broiler')`,
            params: [
              this.currentFlock.flock_id,
              row.date,
              this.categoryOf(row),
              row.description,
              row.amount,
              row.payment_type || 'cash',
              bank.payment_source,
              bank.bank_id,
              row.bill_available,
              row.receipt_image || null
            ]
          });
          ops.push(...this.db.bankSourceInsertOps('expenses', {
            ...bank,
            date: row.date,
            description: this.withdrawalLabel(row),
            amount: Number(row.amount) || 0
          }));
        }
        ops.push(...this.db.bankRebuildOps(validRows.map(r => bankSourceFields(r).bank_id)));

        const result = await this.db.runBatch(ops);
        if (!result.success) {
          // The batch is all-or-nothing, so the rows are still unsaved drafts —
          // leave pendingRows exactly as they are and let the user retry.
          this.validationMessage = 'Could not save these expenses. Nothing was written — please try again.';
          this.showValidationDialog = true;
          return;
        }

        this.pendingRows = invalidRows;
        await this.loadData();
      } else {
        this.pendingRows = invalidRows;
      }

      if (invalidRows.length > 0) {
        this.validationMessage = 'Some rows are missing required fields (Date or Amount) and were not saved.';
        this.showValidationDialog = true;
      }
    } finally {
      this.isSavingAll = false;
      this.cdr.detectChanges();
    }
  }

  cancelAllRows() {
    this.pendingRows = [];
  }


  onFileSelected(event: any, target: any) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxWidth = 800;
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        target.receipt_image = canvas.toDataURL('image/jpeg', 0.7);
        this.cdr.detectChanges();
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  viewingImage: string | null = null;

  openImage(base64: string) {
    this.viewingImage = base64;
  }

  closeImage() {
    this.viewingImage = null;
  }
  // ── Edit ───────────────────────────────────────────────────
  startEdit(expense: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = expense.expense_id;
    this.editForm = {
      date: expense.date,
      // A legacy row saved before the category column was used shows "Other",
      // which is what it was filed under anyway.
      category: expense.category || this.defaultCategory,
      description: expense.description,
      amount: expense.amount,
      payment_type: expense.payment_type || 'cash',
      // A legacy row says payment_type = 'bank' with no account, because none
      // was ever recorded. The dropdown opens unset and the save is refused
      // until one is chosen — see bankSourceError().
      bank_id: expense.bank_id ?? null,
      bill_available: expense.bill_available,
      receipt_image: expense.receipt_image || null
    };
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
  }

  async saveEdit(expenseId: number) {
    if (this.isSaving) return;

    this.isSaving = true;
    this.editingId = null;

    try {
      // A row labelled Bank with no account is refused, same as on the save.
      const bankErr = bankSourceError(this.editForm, this.houseBanks);
      if (bankErr) {
        this.validationMessage = bankErr;
        this.showValidationDialog = true;
        this.editingId = expenseId;   // nothing was written — reopen the row
        return;
      }

      // One statement for the row: there is no mirror to keep in step and no
      // ledger to re-file into. `ledger_id` / `ledger_entry_id` are left exactly
      // as the row already holds them — the columns are no longer read by
      // anything, and blanking them here would rewrite half the table's history
      // depending on which rows happened to be edited.
      //
      // The bank side goes through saveBankSourceEdit(), which reverses
      // whatever withdrawal the row had and re-posts it from the edited values,
      // rebuilding the old and the new account. That one shape covers a changed
      // amount (the net movement is the difference), a changed date, cash->bank,
      // bank->cash and bank A->bank B.
      const bank = bankSourceFields(this.editForm);
      const update: DbBatchOp = {
        sql: `UPDATE expenses SET date = ?, category = ?, description = ?, amount = ?,
               payment_type = ?, payment_source = ?, bank_id = ?, bill_available = ?, receipt_image = ?
         WHERE expense_id = ?`,
        params: [
          this.editForm.date, this.categoryOf(this.editForm), this.editForm.description,
          this.editForm.amount, this.editForm.payment_type || 'cash',
          bank.payment_source, bank.bank_id,
          this.editForm.bill_available, this.editForm.receipt_image || null, expenseId
        ]
      };

      const result = await this.db.saveBankSourceEdit('expenses', expenseId, update, {
        ...bank,
        date: this.editForm.date,
        description: this.withdrawalLabel(this.editForm),
        amount: Number(this.editForm.amount) || 0
      });
      if (!result.success) {
        this.validationMessage =
          'Could not save this expense. Nothing was changed — ' +
          friendlySqlError(result.error, 'please try again.');
        this.showValidationDialog = true;
        // The batch is all-or-nothing, so reopen the row with what the user
        // typed rather than closing it and dropping their edit.
        this.editingId = expenseId;
        return;
      }

      this.editForm = {};
      await this.loadData();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ─────────────────────────────────────────────────
  confirmDelete(expenseId: number) {
    if (this.isSaving) return;
    this.deletingId = expenseId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteDialog = false;

    try {
      if (this.deletingId) {
        // The expense row and nothing else. A legacy row may still carry a
        // `ledger_entry_id`, but the entry it named is gone (the one-time
        // migration removed every mirror) and no ledger row is this screen's to
        // delete any more — deleting one here would take a genuine entry off the
        // Ledger screen, which is now a separate book.
        //
        // One ledger row IS this screen's to remove: the withdrawal mirroring
        // this expense, if it was paid by bank. The money never left, so the
        // account must not go on saying it did — and the reversal, the delete
        // and the balance rebuild are one batch.
        const result = await this.db.deleteBankSourced('expenses', this.deletingId, [
          { sql: `DELETE FROM expenses WHERE expense_id = ?`, params: [this.deletingId] }
        ]);
        if (!result.success) {
          this.validationMessage =
            'Could not delete this expense. Nothing was changed — ' +
            friendlySqlError(result.error, 'please try again.');
          this.showValidationDialog = true;
          return;
        }
        await this.loadData();
      }
    } finally {
      this.deletingId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
    this.deletingId = null;
  }
}