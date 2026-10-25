import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FlockService } from '../shared/services/flock.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { friendlySqlError } from '../shared/utils/sql-error.util';

import { toLocalDateString } from '../shared/utils/date.util';

/**
 * The layer module's Ledger screen — the broiler Ledger screen's twin, keyed on
 * `batch_id` instead of `flock_id` and writing `layer_ledgers` /
 * `layer_ledger_entries` instead of `ledgers` / `ledger_entries`.
 *
 * Parallel tables, not `module_type` on the broiler pair: those two have no
 * module column and every query filters `flock_id` alone, so a batch filed there
 * would surface inside the broiler flock whose id collides. Same reasoning, same
 * shape as `layer_health` beside `flock_health`. Because the keys live in
 * different tables there is no guard to get right here — a batch_id and a
 * flock_id never share a column.
 *
 * Manual entries only. Nothing auto-files into a ledger: the layer Expenses
 * screen writes `expenses` and nothing else, exactly as the broiler one does, so
 * the two books partition every cost between them with no mirror rows and
 * nothing to exclude. That is why there is no `source` column to filter on.
 */
@Component({
  selector: 'app-layer-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, DateOnlyPipe, PaginationComponent],
  templateUrl: './layer-ledger.component.html',
  styleUrl: './layer-ledger.component.scss'
})
export class LayerLedgerComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  /** The active batch, held by FlockService and told apart by `batch_id`. */
  currentBatch: any = null;
  ledgers: any[] = [];
  selectedLedger: any = null;
  entries: any[] = [];
  pendingRows: any[] = [];
  private subs = new Subscription();

  showLedgerForm = false;
  showDeleteLedgerDialog = false;
  showDeleteEntryDialog = false;
  // Destructive actions go through the per-farm delete PIN first.
  showDeleteLedgerCodeDialog = false;
  showDeleteEntryCodeDialog = false;
  deletingLedgerId: number | null = null;
  deletingEntryId: number | null = null;
  editingEntryId: number | null = null;
  editEntryForm: any = {};
  isSaving = false;
  isSavingAll = false;
  errorMessage = '';

  showValidationDialog = false;
  validationMessage = '';

  ledgerForm = { ledger_name: '' };

  currentPage = 1;
  pageSize = 20;

  searchTerm: string = '';

  get filteredLedgers(): any[] {
    const term = this.searchTerm.toLowerCase().trim();
    if (!term) return this.ledgers;
    return this.ledgers.filter(l => l.ledger_name?.toLowerCase().includes(term));
  }

  selectedDateFilter: string = '';
  filteredByDate: boolean = false;

  get filteredEntries() {
    if (!this.filteredByDate || !this.selectedDateFilter) return this.entries;
    return this.entries.filter(e => String(e.date).split('T')[0] === this.selectedDateFilter);
  }

  get paginatedEntries() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredEntries.slice(start, start + this.pageSize);
  }

  applyDateFilter() { if (this.selectedDateFilter) { this.filteredByDate = true; this.currentPage = 1; } }
  clearDateFilter() { this.selectedDateFilter = ''; this.filteredByDate = false; this.currentPage = 1; }

  // ── Computed ─────────────────────────────────────────────────
  get hasPendingRows(): boolean {
    return this.pendingRows.length > 0;
  }

  get totalCredit(): number {
    return this.entries
      .filter(e => e.type === 'credit')
      .reduce((s, e) => s + (e.amount || 0), 0);
  }

  get totalDebit(): number {
    return this.entries
      .filter(e => e.type === 'debit')
      .reduce((s, e) => s + (e.amount || 0), 0);
  }

  get totalAmount(): number {
    return this.entries.reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    if (!this.selectedLedger) return;

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
    private authService: AuthService,
    private flockService: FlockService,
    private cdr: ChangeDetectorRef,
    private pendingState: PendingStateService
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    // No resolver, deliberately: this screen loads through loadLedgers() on init
    // exactly as it does on a batch switch, so the two paths onto it cannot drift
    // into reporting different totals. Same shape as report.component.ts.
    const active = this.flockService.getCurrentFlock();
    this.currentBatch = active?.batch_id ? active : null;

    if (this.currentBatch) {
      await this.loadLedgers();

      const cached = this.pendingState.getState('LayerLedgerComponent');
      if (cached && cached.batchId === this.currentBatch.batch_id) {
        this.pendingRows = cached.pendingRows || [];
        if (cached.selectedLedgerId) {
          this.selectedLedger = this.ledgers.find((l: any) => l.ledger_id === cached.selectedLedgerId) || null;
          if (this.selectedLedger) {
            await this.loadEntries();
          }
        }
      }
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        // A broiler flock selection reaching this screen means the account is on
        // the broiler tab; there is no batch to show, so clear rather than key a
        // layer query on a flock_id.
        const batch = flock?.batch_id ? flock : null;
        if (batch?.batch_id === this.currentBatch?.batch_id) return;

        this.currentBatch = batch;
        this.selectedLedger = null;
        this.entries = [];
        this.pendingRows = [];
        this.editingEntryId = null;
        this.isSaving = false;
        this.errorMessage = '';
        this.pendingState.clearState('LayerLedgerComponent');
        if (batch) this.loadLedgers();
        else { this.ledgers = []; this.cdr.detectChanges(); }
      })
    );
  }

  ngOnDestroy() {
    this.pendingState.saveState('LayerLedgerComponent', {
      batchId: this.currentBatch?.batch_id,
      pendingRows: this.pendingRows,
      selectedLedgerId: this.selectedLedger?.ledger_id
    });
    this.subs.unsubscribe();
  }

  // ── Loaders ──────────────────────────────────────────────────
  async loadLedgers() {
    if (!this.currentBatch?.batch_id) { this.ledgers = []; return; }
    const result = await this.db.get(
      `SELECT l.*,
        COALESCE(SUM(le.amount), 0) as total
       FROM layer_ledgers l
       LEFT JOIN layer_ledger_entries le ON l.ledger_id = le.ledger_id
       WHERE l.batch_id = ?
       GROUP BY l.ledger_id
       ORDER BY l.created_at ASC`,
      [this.currentBatch.batch_id]
    );
    if (result.success) {
      this.ledgers = result.data;
      this.cdr.detectChanges();
    }
  }

  async loadEntries() {
    if (!this.selectedLedger) { this.entries = []; return; }
    const result = await this.db.get(
      `SELECT * FROM layer_ledger_entries
       WHERE ledger_id = ?
       ORDER BY date DESC`,
      [this.selectedLedger.ledger_id]
    );
    if (result.success) {
      this.entries = result.data;
      this.cdr.detectChanges();
    }
  }

  // ── Ledger CRUD ──────────────────────────────────────────────
  openLedgerForm() {
    if (this.isSaving) return;
    this.ledgerForm = { ledger_name: '' };
    this.showLedgerForm = true;
  }

  async saveLedger() {
    if (this.isSaving) return;
    if (!this.ledgerForm.ledger_name.trim()) return;
    if (!this.currentBatch?.batch_id) return;

    this.isSaving = true;
    this.showLedgerForm = false;
    this.errorMessage = '';

    try {
      const result = await this.db.run(
        `INSERT INTO layer_ledgers (batch_id, farm_id, ledger_name) VALUES (?, ?, ?)`,
        [this.currentBatch.batch_id, this.currentFarm.farm_id, this.ledgerForm.ledger_name.trim()]
      );
      if (!result.success) {
        this.errorMessage = 'Could not create the ledger: ' +
          friendlySqlError(result.error, 'the database refused the change.');
        return;
      }
      await this.loadLedgers();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDeleteLedger(ledgerId: number) {
    if (this.isSaving) return;
    this.deletingLedgerId = ledgerId;
    this.showDeleteLedgerCodeDialog = true;
    this.cdr.detectChanges();
  }

  onDeleteLedgerCodeVerified() {
    this.showDeleteLedgerCodeDialog = false;
    this.showDeleteLedgerDialog = true;
    this.cdr.detectChanges();
  }

  onDeleteLedgerCodeCancelled() {
    this.showDeleteLedgerCodeDialog = false;
    this.deletingLedgerId = null;
  }

  async onDeleteLedgerConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteLedgerDialog = false;
    this.errorMessage = '';

    try {
      if (this.deletingLedgerId) {
        // The ledger and its entries, in one batch so a failure part-way cannot
        // leave the entries behind with no ledger to reach them from. Nothing
        // else is touched: no expense is filed under a ledger, here or in
        // broiler, so there are no links to unpick.
        const result = await this.db.runBatch([
          { sql: `DELETE FROM layer_ledger_entries WHERE ledger_id = ?`, params: [this.deletingLedgerId] },
          { sql: `DELETE FROM layer_ledgers WHERE ledger_id = ?`, params: [this.deletingLedgerId] }
        ]);

        if (!result?.success) {
          this.errorMessage = 'Could not delete the ledger: ' +
            friendlySqlError(result?.error, 'the database refused the change.') +
            ' Nothing was deleted.';
          return;
        }

        if (this.selectedLedger?.ledger_id === this.deletingLedgerId) {
          this.selectedLedger = null;
          this.entries = [];
        }
        await this.loadLedgers();
      }
    } finally {
      this.deletingLedgerId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteLedgerCancelled() {
    this.showDeleteLedgerDialog = false;
    this.deletingLedgerId = null;
  }

  // ── Select ledger ────────────────────────────────────────────
  async selectLedger(ledger: any) {
    if (this.isSaving) return;
    this.selectedLedger = ledger;
    this.pendingRows = [];
    this.editingEntryId = null;
    this.currentPage = 1;
    await this.loadEntries();
  }

  backToLedgers() {
    if (this.isSaving) return;
    this.selectedLedger = null;
    this.entries = [];
    this.pendingRows = [];
    this.editingEntryId = null;
  }

  // ── Pending Rows (Multi-row add) ─────────────────────────────
  makeNewRow(): any {
    return {
      date: toLocalDateString(),
      description: '',
      amount: null,
      type: 'debit'
    };
  }

  addPendingRow() {
    if (this.isSaving) return;
    this.editingEntryId = null;
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
    if (!this.selectedLedger || !this.currentBatch?.batch_id) return;
    this.isSavingAll = true;
    this.errorMessage = '';

    try {
      const invalidRows = this.pendingRows.filter(row => !row.date || !row.amount);
      const validRows = this.pendingRows.filter(row => row.date && row.amount);

      if (validRows.length > 0) {
        // One runBatch, not a run() per row: every runQuery writes the whole
        // database back to disk, so a row-at-a-time loop costs one file write
        // each and can leave half the rows saved if one fails.
        const result = await this.db.runBatch(validRows.map(row => ({
          sql: `INSERT INTO layer_ledger_entries
                  (ledger_id, batch_id, date, description, amount, type)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            this.selectedLedger.ledger_id,
            this.currentBatch.batch_id,
            row.date,
            row.description || null,
            row.amount,
            row.type
          ]
        })));

        if (!result?.success) {
          this.errorMessage = 'Could not save: ' +
            friendlySqlError(result?.error, 'the database refused the change.') +
            ' Nothing was saved.';
          return;
        }

        this.pendingRows = invalidRows;
        await this.loadEntries();
        await this.loadLedgers();
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

  // ── Entry CRUD ───────────────────────────────────────────────
  startEditEntry(entry: any) {
    if (this.isSaving) return;

    this.pendingRows = [];
    this.editingEntryId = entry.entry_id;
    this.editEntryForm = {
      date: entry.date,
      description: entry.description,
      amount: entry.amount,
      type: entry.type || 'debit'
    };
  }

  cancelEditEntry() {
    if (this.isSaving) return;
    this.editingEntryId = null;
    this.editEntryForm = {};
  }

  async saveEditEntry(entryId: number) {
    if (this.isSaving) return;

    this.isSaving = true;
    this.editingEntryId = null;
    this.errorMessage = '';

    try {
      const result = await this.db.run(
        `UPDATE layer_ledger_entries
         SET date = ?, description = ?, amount = ?, type = ?
         WHERE entry_id = ?`,
        [
          this.editEntryForm.date,
          this.editEntryForm.description || null,
          this.editEntryForm.amount,
          this.editEntryForm.type,
          entryId
        ]
      );
      if (!result.success) {
        this.errorMessage = 'Could not save the change: ' +
          friendlySqlError(result.error, 'the database refused the change.');
        return;
      }
      this.editEntryForm = {};
      await this.loadEntries();
      await this.loadLedgers();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDeleteEntry(entryId: number) {
    if (this.isSaving) return;
    this.deletingEntryId = entryId;
    this.showDeleteEntryCodeDialog = true;
  }

  onDeleteEntryCodeVerified() {
    this.showDeleteEntryCodeDialog = false;
    this.showDeleteEntryDialog = true;
    this.cdr.detectChanges();
  }

  onDeleteEntryCodeCancelled() {
    this.showDeleteEntryCodeDialog = false;
    this.deletingEntryId = null;
  }

  async onDeleteEntryConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteEntryDialog = false;
    this.errorMessage = '';

    try {
      if (this.deletingEntryId) {
        const result = await this.db.run(
          `DELETE FROM layer_ledger_entries WHERE entry_id = ?`,
          [this.deletingEntryId]
        );
        if (!result.success) {
          this.errorMessage = 'Could not delete the entry: ' +
            friendlySqlError(result.error, 'the database refused the change.');
          return;
        }
        await this.loadEntries();
        await this.loadLedgers();
      }
    } finally {
      this.deletingEntryId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteEntryCancelled() {
    this.showDeleteEntryDialog = false;
    this.deletingEntryId = null;
  }
}
