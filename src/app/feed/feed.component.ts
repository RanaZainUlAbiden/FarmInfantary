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
  selector: 'app-Feed',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent],
  templateUrl: './feed.component.html',
  styleUrl: './feed.component.scss'
})
export class FeedComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
  traders: any[] = [];
  selectedTrader: any = null;
  entries: any[] = [];
  pendingRows: any[] = [];
  private subs = new Subscription();

  showTraderForm = false;
  showDeleteTraderDialog = false;
  showDeleteEntryDialog = false;
  deletingTraderId: number | null = null;
  deletingEntryId: number | null = null;
  editingEntryId: number | null = null;
  editEntryForm: any = {};
  isSaving = false;
  isSavingAll = false;

  showValidationDialog = false;
  validationMessage = '';

  traderForm = { trader_name: '' };

  currentPage = 1;
  pageSize = 20;

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
get moduleType(): string {
    return this.currentFlock?.batch_id ? 'layer' : 'broiler';
  }

  get targetId(): number | null {
    return this.currentFlock?.flock_id || this.currentFlock?.batch_id || null;
  }

  get traderTotal(): number {
    return this.entries.reduce((sum, e) => sum + (e.total_amount || 0), 0);
  }

  getEditTotal(): number {
    return (this.editEntryForm.quantity || 0) * (this.editEntryForm.price_per_unit || 0);
  }

  getRowTotal(row: any): number {
    return (row.quantity || 0) * (row.price_per_unit || 0);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    if (!this.selectedTrader) return;
    
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
    return `FeedComponent_${this.moduleType}`;
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
      this.traders = resolved.traders || [];

      const cached = this.pendingState.getState(this.stateKey());
      if (cached && cached.flockId === this.targetId) {
        this.pendingRows = cached.pendingRows || [];
        if (cached.selectedTraderId) {
          this.selectedTrader = this.traders.find((t: any) => t.trader_id === cached.selectedTraderId) || null;
          if (this.selectedTrader) {
            this.loadEntries();
          }
        }
      }
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock) {
          // Computed before the reassignment: this clears the draft belonging
          // to the flock/batch being switched away from, not the new one.
          const previousKey = this.stateKey();
          this.currentFlock = flock;
          this.selectedTrader = null;
          this.entries = [];
          this.pendingRows = [];
          this.editingEntryId = null;
          this.isSaving = false;
          this.pendingState.clearState(previousKey);
          this.loadTraders();
        }
      })
    );
  }

 ngOnDestroy() {
    this.pendingState.saveState(this.stateKey(), {
      flockId: this.targetId,
      pendingRows: this.pendingRows,
      selectedTraderId: this.selectedTrader?.trader_id
    });
    this.subs.unsubscribe();
  }

  // ── Loaders ──────────────────────────────────────────────────
  async loadTraders() {
    const result = await this.db.get(
      `SELECT t.*,
        COALESCE(SUM(e.total_amount), 0) as total
       FROM Feed_traders t
       LEFT JOIN Feed_entries e ON t.trader_id = e.trader_id
       WHERE t.flock_id = ? AND t.module_type = ?
       GROUP BY t.trader_id
       ORDER BY t.trader_name ASC`,
      [this.targetId, this.moduleType]
    );
    if (result.success) {
      this.traders = result.data;
      this.cdr.detectChanges();
    }
  }

  async loadEntries() {
    const result = await this.db.get(
      `SELECT * FROM Feed_entries
       WHERE trader_id = ?
       ORDER BY date ASC`,
      [this.selectedTrader.trader_id]
    );
    if (result.success) {
      this.entries = result.data;
      this.cdr.detectChanges();
    }
  }

  // ── Trader CRUD ──────────────────────────────────────────────
  openTraderForm() {
    if (this.isSaving) return;
    this.traderForm = { trader_name: '' };
    this.showTraderForm = true;
  }

  async saveTrader() {
    if (this.isSaving) return;
    if (!this.traderForm.trader_name.trim()) return;

    this.isSaving = true;
    this.showTraderForm = false;

    try {
      await this.db.run(
        `INSERT INTO Feed_traders (flock_id, trader_name, module_type) VALUES (?, ?, ?)`,
        [this.targetId, this.traderForm.trader_name.trim(), this.moduleType]
      );
      await this.loadTraders();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  confirmDeleteTrader(traderId: number) {
    if (this.isSaving) return;
    this.deletingTraderId = traderId;
    this.showDeleteTraderDialog = true;
      this.cdr.detectChanges();  // ✅ ADD THIS LINE

  }

  async onDeleteTraderConfirmed() {
    if (this.isSaving) return;

    this.isSaving = true;
    this.showDeleteTraderDialog = false;

    try {
      if (this.deletingTraderId) {
        await this.db.run(
          `DELETE FROM Feed_entries WHERE trader_id = ?`,
          [this.deletingTraderId]
        );
        await this.db.run(
          `DELETE FROM Feed_traders WHERE trader_id = ?`,
          [this.deletingTraderId]
        );
        if (this.selectedTrader?.trader_id === this.deletingTraderId) {
          this.selectedTrader = null;
          this.entries = [];
        }
        await this.loadTraders();
      }
    } finally {
      this.deletingTraderId = null;
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteTraderCancelled() {
    this.showDeleteTraderDialog = false;
    this.deletingTraderId = null;
  }

  // ── Select / Back ─────────────────────────────────────────────
  async selectTrader(trader: any) {
    if (this.isSaving) return;
    this.selectedTrader = trader;
    this.pendingRows = [];
    this.editingEntryId = null;
    await this.loadEntries();
  }

  backToTraders() {
    if (this.isSaving) return;
    this.selectedTrader = null;
    this.entries = [];
    this.pendingRows = [];
    this.editingEntryId = null;
  }

  // ── Pending Rows (Multi-row add) ─────────────────────────────
  makeNewRow(): any {
    return {
      date: toLocalDateString(),
      Feed_name: '',
      quantity: null,
      price_per_unit: null
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
        if (!row.date || !row.Feed_name || !row.quantity || !row.price_per_unit) {
          invalidRows.push(row);
          continue;
        }

        const total = this.getRowTotal(row);

        await this.db.run(
          `INSERT INTO Feed_entries
            (trader_id, flock_id, date, Feed_name,
             quantity, price_per_unit, total_amount, module_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.selectedTrader.trader_id,
            this.targetId,
            row.date,
            row.Feed_name,
            row.quantity,
            row.price_per_unit,
            total,
            this.moduleType
          ]
        );
        insertedCount++;
      }

      this.pendingRows = invalidRows;
      
      if (insertedCount > 0) {
        await this.loadEntries();
        await this.loadTraders();
      }

      if (invalidRows.length > 0) {
        this.validationMessage = 'Some rows are missing required fields and were not saved.';
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
      Feed_name: entry.Feed_name,
      quantity: entry.quantity,
      price_per_unit: entry.price_per_unit
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

    const total = this.getEditTotal();

    try {
      await this.db.run(
        `UPDATE Feed_entries SET
          date = ?, Feed_name = ?,
          quantity = ?, price_per_unit = ?, total_amount = ?
         WHERE entry_id = ?`,
        [
          this.editEntryForm.date,
          this.editEntryForm.Feed_name,
          this.editEntryForm.quantity,
          this.editEntryForm.price_per_unit,
          total,
          entryId
        ]
      );
      this.editEntryForm = {};
      await this.loadEntries();
      await this.loadTraders();
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
          `DELETE FROM Feed_entries WHERE entry_id = ?`,
          [this.deletingEntryId]
        );
        await this.loadEntries();
        await this.loadTraders();
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
