import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService } from '../shared/services/database.service';
import { FlockService } from '../shared/services/flock.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';

import { toLocalDateString } from '../shared/utils/date.util';
@Component({
  selector: 'app-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent],
  templateUrl: './ledger.component.html',
  styleUrl: './ledger.component.scss'
})
export class LedgerComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
  ledgers: any[] = [];
  selectedLedger: any = null;
  entries: any[] = [];
  pendingRows: any[] = [];
  private subs = new Subscription();

  showLedgerForm = false;
  showDeleteLedgerDialog = false;
  showDeleteEntryDialog = false;
  deletingLedgerId: number | null = null;
  deletingEntryId: number | null = null;
  editingEntryId: number | null = null;
  editEntryForm: any = {};
  isSaving = false;
  isSavingAll = false;

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

  // There is deliberately no "is this entry an expense?" test any more. Expenses
  // and ledgers are independent books: the Expenses screen writes no ledger row,
  // and the one-time migration in database.js deleted the mirrors it used to
  // write. Every row on this screen is the ledger's own and is freely editable.
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
    private flockService: FlockService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    private pendingState: PendingStateService
  ) {}

  ngOnInit() {
    const resolved = this.route.snapshot.data['data'];
    if (resolved) {
      this.currentFlock = resolved.flock;
      this.ledgers = resolved.ledgers || [];

      const cached = this.pendingState.getState('LedgerComponent');
      if (cached && cached.flockId === this.currentFlock?.flock_id) {
        this.pendingRows = cached.pendingRows || [];
        if (cached.selectedLedgerId) {
          this.selectedLedger = this.ledgers.find((l: any) => l.ledger_id === cached.selectedLedgerId) || null;
          if (this.selectedLedger) {
            this.loadEntries();
          }
        }
      }
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock && flock.flock_id !== this.currentFlock?.flock_id) {
          this.currentFlock = flock;
          this.selectedLedger = null;
          this.entries = [];
          this.pendingRows = [];
          this.editingEntryId = null;
          this.isSaving = false;
          this.pendingState.clearState('LedgerComponent');
          this.loadLedgers();
        }
      })
    );
  }

  ngOnDestroy() {
    this.pendingState.saveState('LedgerComponent', {
      flockId: this.currentFlock?.flock_id,
      pendingRows: this.pendingRows,
      selectedLedgerId: this.selectedLedger?.ledger_id
    });
    this.subs.unsubscribe();
  }

  // ── Loaders ──────────────────────────────────────────────────
  async loadLedgers() {
    const result = await this.db.get(
      `SELECT l.*,
        COALESCE(SUM(le.amount), 0) as total
       FROM ledgers l
       LEFT JOIN ledger_entries le ON l.ledger_id = le.ledger_id
       WHERE l.flock_id = ?
       GROUP BY l.ledger_id
       ORDER BY l.created_at ASC`,
      [this.currentFlock.flock_id]
    );
    if (result.success) {
      this.ledgers = result.data;
      this.cdr.detectChanges();
    }
  }

  async loadEntries() {
    const result = await this.db.get(
      `SELECT * FROM ledger_entries
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

    this.isSaving = true;
    this.showLedgerForm = false;

    try {
      await this.db.run(
        `INSERT INTO ledgers (flock_id, ledger_name) VALUES (?, ?)`,
        [this.currentFlock.flock_id, this.ledgerForm.ledger_name.trim()]
      );
      await this.loadLedgers();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDeleteLedger(ledgerId: number) {
    if (this.isSaving) return;
    this.deletingLedgerId = ledgerId;
    this.showDeleteLedgerDialog = true;
      this.cdr.detectChanges();  // ✅ ADD THIS LINE

  }

  async onDeleteLedgerConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteLedgerDialog = false;

    try {
      if (this.deletingLedgerId) {
        // The ledger and its entries, and nothing else. No expense is filed under
        // a ledger any more, so there are no links to unpick — the `expenses`
        // table is not this screen's to write to.
        await this.db.runBatch([
          { sql: `DELETE FROM ledger_entries WHERE ledger_id = ?`, params: [this.deletingLedgerId] },
          { sql: `DELETE FROM ledgers WHERE ledger_id = ?`, params: [this.deletingLedgerId] }
        ]);


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
      type: 'debit',
      source: 'manual'  // Manual entries ka source 'manual' hoga
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
    this.isSavingAll = true;

    try {
      const invalidRows: any[] = [];
      let insertedCount = 0;

      for (const row of this.pendingRows) {
        if (!row.date || !row.amount) {
          invalidRows.push(row);
          continue;
        }

        // Manual entries - source = 'manual', NO link to expenses
        await this.db.run(
          `INSERT INTO ledger_entries
            (ledger_id, flock_id, date, description, amount, type, source)
           VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
          [
            this.selectedLedger.ledger_id,
            this.currentFlock.flock_id,
            row.date,
            row.description,
            row.amount,
            row.type
          ]
        );
        insertedCount++;
      }

      this.pendingRows = invalidRows;
      
      if (insertedCount > 0) {
        await this.loadEntries();
        await this.loadLedgers();
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

    try {
      await this.db.run(
        `UPDATE ledger_entries
         SET date = ?, description = ?, amount = ?, type = ?
         WHERE entry_id = ?`,
        [
          this.editEntryForm.date,
          this.editEntryForm.description,
          this.editEntryForm.amount,
          this.editEntryForm.type,
          entryId
        ]
      );
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
    this.showDeleteEntryDialog = true;
  }

  async onDeleteEntryConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteEntryDialog = false;

    try {
      if (this.deletingEntryId) {
        await this.db.run(
          `DELETE FROM ledger_entries WHERE entry_id = ?`,
          [this.deletingEntryId]
        );
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