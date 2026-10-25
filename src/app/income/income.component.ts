import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { BankPickerComponent } from '../shared/components/bank-picker/bank-picker.component';
import { bankSourceError, bankSourceFields, bankNameOf } from '../shared/utils/bank-source.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { FlockService } from '../shared/services/flock.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';

import { toLocalDateString } from '../shared/utils/date.util';
@Component({
  selector: 'app-income',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent, BankPickerComponent],
  templateUrl: './income.component.html',
  styleUrl: './income.component.scss'
})
export class IncomeComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
  incomeList: any[] = [];
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;

  showValidationDialog = false;
  validationMessage = '';

  // The farm's OWN accounts - never a customer's.
  houseBanks: any[] = [];

  private subs = new Subscription();

  // ── Computed ─────────────────────────────────────────────────
  get hasPendingRows(): boolean {
    return this.pendingRows.length > 0;
  }

  // Layer batches are surfaced as a flock carrying a batch_id.
  get moduleType(): string {
    return this.currentFlock?.batch_id ? 'layer' : 'broiler';
  }

  currentPage = 1;
  pageSize = 20;

  get paginatedIncome() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.incomeList.slice(start, start + this.pageSize);
  }

  get totalIncome(): number {
    return this.incomeList.reduce((sum, i) => sum + (i.amount || 0), 0);
  }

  get saleIncome(): number {
    return this.incomeList
      .filter(i => i.source === 'sale' || i.source === 'egg_sale' || i.source === 'hen_sale')
      .reduce((sum, i) => sum + (i.amount || 0), 0);
  }

  get manualIncome(): number {
    return this.incomeList
      .filter(i => i.source === 'manual')
      .reduce((sum, i) => sum + (i.amount || 0), 0);
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

  /**
   * Draft cache key. `flocks.flock_id` and `batches.batch_id` are separate
   * sequences that collide from #1, so a key built on the id alone let a draft
   * started on broiler flock N be restored on layer batch N — and saved into
   * the wrong module. The module goes in the key, and the id is still checked
   * against the restored payload.
   */
  private stateKey(): string {
    return `IncomeComponent_${this.moduleType}`;
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
   * MIRROR ROWS ARE NOT BANKABLE, and this is the guard that keeps one sale
   * from being banked twice.
   *
   * `income` holds two kinds of row. A `source = 'manual'` row is money the
   * user entered here and is the only kind this screen writes. The
   * sale / egg_sale / hen_sale rows are daily totals rebuilt from `sales`,
   * `egg_sales` and `hen_sales` by those screens, which each carry their own
   * Cash/Bank selector and post their own deposit. Offering the selector on a
   * mirror would deposit the same money a second time, and the mirror is
   * rebuilt from scratch on every change anyway, so the choice could not
   * survive. The screen already refuses to edit them; this is the same rule
   * stated once for the template.
   */
  isBankable(income: any): boolean {
    return (income?.source || 'manual') === 'manual';
  }

  /** How a banked income row is labelled on the bank statement. */
  private depositLabel(row: any): string {
    const tail = String(row?.description ?? '').trim();
    return tail ? `Income: ${tail}` : 'Income';
  }

  /**
   * Re-read on every load: the account list is farm-wide rather than per flock,
   * so an account added on the Bank screen has to appear here without a reload.
   */
  async loadBanks() {
    const farmId = this.currentFlock?.farm_id || this.authService.getCurrentFarm()?.farm_id;
    if (!farmId) { this.houseBanks = []; return; }
    const res = await this.db.getHouseBankAccounts(farmId);
    this.houseBanks = res.success ? (res.data || []) : [];
  }

  ngOnInit() {
    const resolved = this.route.snapshot.data['data'];
    if (resolved) {
      this.currentFlock = resolved.flock;
      this.incomeList = resolved.income || [];

      const cached = this.pendingState.getState(this.stateKey());
      if (cached && cached.flockId === this.currentFlock?.flock_id) {
        this.pendingRows = cached.pendingRows || [];
      }
      // The resolver supplies the income rows, so loadIncome() never runs on
      // arrival - the accounts still have to be fetched.
      this.loadBanks().then(() => this.cdr.detectChanges());
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock) {
          // Computed before the reassignment: this clears the draft belonging
          // to the flock/batch being switched away from, not the new one.
          const previousKey = this.stateKey();
          this.currentFlock = flock;
          this.pendingRows = [];
          this.editingId = null;
          this.isSaving = false;
          this.pendingState.clearState(previousKey);
          this.loadIncome();
        }
      })
    );
  }

  ngOnDestroy() {
    this.pendingState.saveState(this.stateKey(), {
      flockId: this.currentFlock?.flock_id,
      pendingRows: this.pendingRows
    });
    this.subs.unsubscribe();
  }

  async loadIncome() {
    if (!this.currentFlock) return;
    const result = await this.db.get(
      `SELECT * FROM income
       WHERE flock_id = ? AND module_type = ?
       ORDER BY date DESC, income_id ASC`,
      [this.currentFlock.flock_id, this.moduleType]
    );
    if (result.success) {
      this.incomeList = result.data;
    }
    await this.loadBanks();
    this.cdr.detectChanges();
  }

  // ── Pending Rows (Multi-row add) ─────────────────────────────
  makeNewRow(): any {
    return {
      date: toLocalDateString(),
      description: '',
      amount: null,
      // This screen never had a payment selector, so Cash/Bank is its own
      // field rather than derived from a `payment_type` it does not have.
      payment_source: 'cash',
      bank_id: null
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
        if (!row.date || !row.amount || Number(row.amount) < 0) invalidRows.push(row);
        else validRows.push(row);
      }

      // Banked with no account chosen is refused rather than saved as cash.
      // Checked before anything is written, so the save stays all-or-nothing.
      for (let i = 0; i < validRows.length; i++) {
        const err = bankSourceError(validRows[i], this.houseBanks, `Row ${i + 1}`);
        if (err) {
          this.validationMessage = err;
          this.showValidationDialog = true;
          return;
        }
      }

      if (validRows.length > 0) {
        // One batch rather than a `run()` per row: every run() writes the whole
        // database file back to disk, and a failure part way through used to
        // leave some rows saved and the rest silently dropped. A banked row's
        // deposit is interleaved directly after its own insert and keyed to it
        // with `{ $lastId: -1 }`, so the income and the money arriving in the
        // account are one movement; balances are rebuilt once at the end, per
        // account.

        // NO ACCOUNT MAY BE TAKEN BELOW ZERO. Income is money IN, so this can
        // only ever refuse if the table's declared direction in BANK_SOURCES
        // changes — called on the same terms as every other insert path rather
        // than skipped on that reasoning, which is the point of the sign being
        // declared in one place.
        const balanceGuard = await this.db.checkBankSourceInserts(
          'income',
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
            sql: `INSERT INTO income (flock_id, date, description, amount, source, payment_source, bank_id, module_type)
                  VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
            params: [
              this.currentFlock.flock_id,
              row.date,
              row.description,
              row.amount,
              bank.payment_source,
              bank.bank_id,
              this.moduleType
            ]
          });
          ops.push(...this.db.bankSourceInsertOps('income', {
            ...bank,
            date: row.date,
            description: this.depositLabel(row),
            amount: Number(row.amount) || 0
          }));
        }
        ops.push(...this.db.bankRebuildOps(validRows.map(r => bankSourceFields(r).bank_id)));

        const result = await this.db.runBatch(ops);
        if (!result?.success) {
          // All-or-nothing, so the rows are still unsaved drafts - leave
          // pendingRows alone and let the user retry.
          this.validationMessage =
            'Could not save this income: ' +
            friendlySqlError(result?.error, 'the database refused the change.') +
            ' Nothing was written.';
          this.showValidationDialog = true;
          return;
        }

        this.pendingRows = invalidRows;
        await this.loadIncome();
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

  // ── Edit ───────────────────────────────────────────────────
  startEdit(income: any) {
    if (this.isSaving) return;
    if (income.source === 'sale' || income.source === 'egg_sale' || income.source === 'hen_sale') return; // auto rows are read-only
    this.pendingRows = [];
    this.editingId = income.income_id;
    this.editForm = {
      date: income.date,
      description: income.description,
      amount: income.amount,
      payment_source: income.payment_source === 'bank' ? 'bank' : 'cash',
      bank_id: income.bank_id ?? null
    };
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
  }

  async saveEdit(incomeId: number) {
    if (this.isSaving) return;
    if (!this.editForm.amount || Number(this.editForm.amount) < 0) {
      this.validationMessage = 'Amount is required and cannot be negative.';
      this.showValidationDialog = true;
      return;
    }

    const bankErr = bankSourceError(this.editForm, this.houseBanks);
    if (bankErr) {
      this.validationMessage = bankErr;
      this.showValidationDialog = true;
      return;
    }

    this.isSaving = true;
    this.editingId = null;

    try {
      // The deposit is reversed and re-posted rather than patched, which is one
      // shape for all five transitions - changed amount (the net movement is
      // the difference), changed date, cash to bank, bank to cash, and
      // bank A to bank B - with both accounts rebuilt at the end.
      const bank = bankSourceFields(this.editForm);
      const update: DbBatchOp = {
        sql: `UPDATE income SET date = ?, description = ?, amount = ?,
                     payment_source = ?, bank_id = ?
         WHERE income_id = ?`,
        params: [
          this.editForm.date,
          this.editForm.description,
          this.editForm.amount,
          bank.payment_source,
          bank.bank_id,
          incomeId
        ]
      };
      const result = await this.db.saveBankSourceEdit('income', incomeId, update, {
        ...bank,
        date: this.editForm.date,
        description: this.depositLabel(this.editForm),
        amount: Number(this.editForm.amount) || 0
      });
      if (!result?.success) {
        this.validationMessage =
          'Could not save this income: ' +
          friendlySqlError(result?.error, 'the database refused the change.') +
          ' Nothing was changed.';
        this.showValidationDialog = true;
        this.editingId = incomeId;
        return;
      }
      this.editForm = {};
      await this.loadIncome();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ─────────────────────────────────────────────────
  confirmDelete(incomeId: number) {
    if (this.isSaving) return;
    this.deletingId = incomeId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteDialog = false;

    try {
      if (this.deletingId) {
        // If it was banked, the deposit goes with it and the account is
        // rebuilt in the same batch. The money never arrived.
        const result = await this.db.deleteBankSourced('income', this.deletingId, [
          { sql: `DELETE FROM income WHERE income_id = ?`, params: [this.deletingId] }
        ]);
        if (!result?.success) {
          this.validationMessage =
            'Could not delete this income: ' +
            friendlySqlError(result?.error, 'the database refused the change.') +
            ' Nothing was changed.';
          this.showValidationDialog = true;
          return;
        }
        await this.loadIncome();
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