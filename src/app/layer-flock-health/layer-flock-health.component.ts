import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { PendingStateService } from '../shared/services/pending-state.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { Subscription } from 'rxjs';

import { toLocalDateString } from '../shared/utils/date.util';
import { maxDayIndex, cumulativeLookup, DayRow } from '../shared/utils/health-day.util';
import { dayNumberFor, dateForDayNumber, feedPerDozenEggs } from '../shared/utils/layer-health.util';

/**
 * Layer Flock Health — the layer counterpart to the broiler Flock Health screen,
 * replacing the old Mortality-only screen. Same day-wise shape: total birds,
 * mortality, remaining, feed used, average weight, plus summary cards.
 *
 * Three things differ from broiler, all of them deliberate:
 *
 *  - It stores a real `date` per row and derives the day index from it, rather than
 *    the other way round. Layer entries arrive dated (the migrated mortality records
 *    certainly do), and `batches.start_date` makes the day index a pure function of
 *    the date, so there is one source of truth instead of two that can drift.
 *
 *  - It shows Feed / Dozen instead of FCR. See `layer-health.util.ts` for why broiler
 *    FCR is meaningless for a laying bird and what replaces it.
 *
 *  - It is built for volume. A layer batch runs 70+ weeks, so 500+ rows per batch is
 *    normal against broiler's ~42. Every query is scoped to ONE batch, the summary
 *    cards come from SQL aggregates rather than from reducing the loaded array, the
 *    table is paginated newest-first, and the cumulative feed/egg windows are
 *    prebuilt lookups instead of a rescan per row per change-detection pass.
 */
@Component({
  selector: 'app-layer-flock-health',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, PaginationComponent, DateOnlyPipe],
  templateUrl: './layer-flock-health.component.html',
  styleUrl: './layer-flock-health.component.scss'
})
export class LayerFlockHealthComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  units: any[] = [];
  currentUnit: any = null;
  batches: any[] = [];
  currentBatchId: number | null = null;

  healthRecords: any[] = [];
  pendingRows: any[] = [];

  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;

  showValidationDialog = false;
  validationMessage = '';

  // Newest first. 500+ rows a batch is normal here, so the table never renders the
  // whole set — only the page the user is looking at.
  currentPage = 1;
  pageSize = 25;

  // ── Summary, straight from SQL ───────────────────────────────
  // Aggregates over the whole batch, not over `healthRecords`. Reducing the loaded
  // array inside a getter would re-run over every one of those 500+ rows on every
  // change-detection pass, and would silently report only the loaded page if this
  // screen ever moves to server-side paging.
  totalMortality = 0;
  totalFeedUsed = 0;
  recordedDays = 0;
  private latestDay = 0;

  /** Cumulative feed (bags) through a given day, across saved + unsaved rows. */
  private cumulativeFeed: (day: number | null) => number = () => 0;
  /** Cumulative eggs collected through a given day of the batch. */
  private cumulativeEggs: (day: number | null) => number = () => 0;

  private subs = new Subscription();

  get hasPendingRows(): boolean {
    return this.pendingRows.length > 0;
  }

  get selectedBatch(): any {
    return this.batches.find(b => b.batch_id === this.currentBatchId) || null;
  }

  get paginatedRecords(): any[] {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.healthRecords.slice(start, start + this.pageSize);
  }

  /**
   * Birds still alive in the batch: what was placed, less every mortality recorded
   * against it. Taken from the batch and the SUM rather than from the last row's
   * total_birds, which is only as good as whatever the user last typed there.
   */
  get currentBirdCount(): number {
    return Math.max(0, (this.selectedBatch?.initial_birds || 0) - this.totalMortality);
  }

  get mortalityRate(): number {
    const placed = this.selectedBatch?.initial_birds || 0;
    return placed > 0 ? (this.totalMortality / placed) * 100 : 0;
  }

  /**
   * Feed per dozen eggs for the batch to date — the same cumulative window as the
   * last recorded day, so eggs collected after the final health entry are not
   * counted against feed that was never recorded. Null (a dash) when either side of
   * the window is empty; see layer-health.util.ts.
   */
  get latestFeedPerDozen(): number | null {
    return feedPerDozenEggs(this.totalFeedUsed, this.cumulativeEggs(this.latestDay));
  }

  getRowRemaining(row: any): number {
    return (Number(row?.total_birds) || 0) - (Number(row?.mortality) || 0);
  }

  getRowFeedPerDozen(row: any): number | null {
    const day = Number(row?.day_number);
    if (!Number.isFinite(day)) return null;
    return feedPerDozenEggs(this.cumulativeFeed(day), this.cumulativeEggs(day));
  }

  get editRemaining(): number {
    return this.getRowRemaining(this.editForm);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === 'a') {
      const activeTag = (event.target as HTMLElement)?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
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
    private farmUnitService: FarmUnitService, private dataChange: DataChangeService,
    private pendingState: PendingStateService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();

    // Units first — the currentUnit$ subscription below fires synchronously
    // (BehaviorSubject) and its filtering depends on this.units being populated.
    await this.loadUnits();
    this.applyActiveBatch(this.flockService.getCurrentFlock(), false);
    await this.loadBatches();
    await this.loadRecords();

    const cached = this.pendingState.getState('LayerFlockHealthComponent');
    if (cached?.batchId === this.currentBatchId) {
      this.pendingRows = cached.pendingRows || [];
      this.refreshDerived();
    }

    this.subs.add(
      this.flockService.currentFlock$.subscribe(flock => this.applyActiveBatch(flock, true))
    );

    this.subs.add(
      this.farmUnitService.currentUnit$.subscribe(async unit => {
        this.currentUnit = unit;
        await this.loadBatches();
        await this.loadRecords();
      })
    );

    this.subs.add(
      this.dataChange.onChange('units').subscribe(async () => {
        await this.loadUnits();
        await this.loadBatches();
        await this.loadRecords();
      })
    );
  }

  ngOnDestroy() {
    this.pendingState.saveState('LayerFlockHealthComponent', {
      batchId: this.currentBatchId,
      pendingRows: this.pendingRows
    });
    this.subs.unsubscribe();
  }

  private applyActiveBatch(flock: any, reload: boolean) {
    if (!flock?.batch_id) return;
    const batchId = Number(flock.batch_id);
    if (this.currentBatchId === batchId) return;
    this.currentBatchId = batchId;
    this.resetForBatchChange();
    if (reload) this.loadRecords();
  }

  private resetForBatchChange() {
    this.editingId = null;
    this.editForm = {};
    this.pendingRows = [];
    this.currentPage = 1;
    this.pendingState.clearState('LayerFlockHealthComponent');
  }

  onBatchChange(batchId: any) {
    const id = Number(batchId);
    if (this.currentBatchId === id) return;
    this.currentBatchId = id;
    this.resetForBatchChange();
    this.loadRecords();
  }

  async loadUnits() {
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id, 'layer');
    this.units = result.success ? result.data : [];
    this.currentUnit = this.farmUnitService.getCurrentUnit();
  }

  async loadBatches() {
    // No farms yet for this account — behave as though the farm selector did not
    // exist rather than filtering down to an empty list.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;

    const sql = unitId
      ? `SELECT * FROM batches WHERE farm_id = ? AND status = 'active' AND unit_id = ? ORDER BY batch_id DESC`
      : `SELECT * FROM batches WHERE farm_id = ? AND status = 'active' ORDER BY batch_id DESC`;
    const params = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];

    const result = await this.db.get(sql, params);
    this.batches = result.success ? result.data : [];

    if (!this.batches.find(b => b.batch_id === this.currentBatchId)) {
      this.currentBatchId = this.batches.length > 0 ? this.batches[0].batch_id : null;
      this.resetForBatchChange();
    }
  }

  /**
   * Everything the screen needs for ONE batch: its rows newest-first, the whole-batch
   * aggregates behind the summary cards, and the egg totals the Feed / Dozen column
   * divides into. Three queries regardless of how many rows the batch has.
   */
  async loadRecords() {
    if (!this.currentBatchId) {
      this.healthRecords = [];
      this.totalMortality = 0;
      this.totalFeedUsed = 0;
      this.recordedDays = 0;
      this.latestDay = 0;
      this.refreshDerived();
      this.cdr.detectChanges();
      return;
    }

    const batchId = this.currentBatchId;
    const startDate = this.selectedBatch?.start_date;

    const [rows, totals, eggs] = await Promise.all([
      this.db.get(
        `SELECT * FROM layer_health WHERE batch_id = ?
         ORDER BY day_number DESC, health_id DESC`,
        [batchId]
      ),
      this.db.get(
        `SELECT COUNT(*) AS row_count,
                COALESCE(SUM(mortality), 0) AS total_mortality,
                COALESCE(SUM(feed_used), 0) AS total_feed,
                COALESCE(MAX(day_number), 0) AS latest_day
         FROM layer_health WHERE batch_id = ?`,
        [batchId]
      ),
      // Grouped in SQL so what crosses the IPC bridge is one row per day, not one
      // per collection entry, whatever the batch's egg-recording habits are.
      this.db.get(
        `SELECT date, COALESCE(SUM(total_eggs), 0) AS eggs
         FROM egg_collection WHERE batch_id = ?
         GROUP BY date ORDER BY date ASC`,
        [batchId]
      )
    ]);

    this.healthRecords = rows.success ? rows.data : [];

    const summary = totals.success ? totals.data[0] : null;
    this.recordedDays = Number(summary?.row_count || 0);
    this.totalMortality = Number(summary?.total_mortality || 0);
    this.totalFeedUsed = Number(summary?.total_feed || 0);
    this.latestDay = Number(summary?.latest_day || 0);

    // Egg rows are dated; the health rows are day-indexed. Map the dates onto the
    // batch's day scale once, here, so the per-row lookup is a plain number compare.
    const eggRows: DayRow[] = (eggs.success ? eggs.data : []).map((row: any) => ({
      day_number: startDate ? dayNumberFor(startDate, row.date) : null,
      eggs: Number(row.eggs || 0)
    }));
    this.cumulativeEggs = cumulativeLookup(eggRows, 'eggs');

    const maxPage = Math.max(1, Math.ceil(this.healthRecords.length / this.pageSize));
    if (this.currentPage > maxPage) this.currentPage = maxPage;

    this.refreshDerived();
    this.cdr.detectChanges();
  }

  /**
   * Rebuilds the cumulative-feed window.
   *
   * One day's feed lands in the denominator of every LATER day, so a single edit
   * moves more than the row it was typed into — the whole lookup is rebuilt rather
   * than one entry patched. Unsaved rows and the row currently being edited are
   * included, so the figures on screen match what saving would produce.
   */
  private refreshDerived() {
    const saved = this.healthRecords.map(r =>
      this.editingId !== null && r.health_id === this.editingId
        ? { ...r, ...this.editForm }
        : r
    );
    this.cumulativeFeed = cumulativeLookup(saved.concat(this.pendingRows), 'feed_used');
  }

  onRowChanged() {
    this.refreshDerived();
  }

  /** Date drives the day index, never the other way round. */
  onRowDateChange(row: any) {
    const startDate = this.selectedBatch?.start_date;
    if (startDate && row.date) row.day_number = dayNumberFor(startDate, row.date);
    this.refreshDerived();
  }

  // ── Pending rows (multi-row add) ─────────────────────────────
  /**
   * The next day index comes from MAX(day) across saved AND unsaved rows — never
   * from a row count. Deleting a row does not renumber the ones after it, so a count
   * collides with a day index that is still in use.
   */
  makeNewRow(): any {
    const startDate = this.selectedBatch?.start_date;
    const nextDay = maxDayIndex(this.healthRecords, this.pendingRows) + 1;

    // healthRecords is newest-first, so the most recent row is the FIRST one.
    const last = this.healthRecords.length > 0 ? this.healthRecords[0] : null;
    const carriedBirds = last
      ? Math.max(0, (Number(last.total_birds) || 0) - (Number(last.mortality) || 0))
      : (this.selectedBatch?.initial_birds ?? null);

    return {
      day_number: nextDay,
      date: startDate ? dateForDayNumber(startDate, nextDay) : toLocalDateString(),
      total_birds: carriedBirds,
      mortality: null,
      feed_used: null,
      avg_weight: null,
      notes: ''
    };
  }

  addPendingRow() {
    if (this.isSaving || !this.currentBatchId) return;
    this.editingId = null;
    this.pendingRows.push(this.makeNewRow());
    this.refreshDerived();
  }

  addRowAfter(index: number) {
    this.pendingRows.splice(index + 1, 0, this.makeNewRow());
    this.refreshDerived();
  }

  removePendingRow(index: number) {
    this.pendingRows.splice(index, 1);
    this.refreshDerived();
  }

  cancelAllRows() {
    this.pendingRows = [];
    this.refreshDerived();
  }

  /**
   * One atomic batch rather than a `run()` per row: every write exports and rewrites
   * the entire database file, so N rows meant N full-file writes and a half-saved
   * set if one of them failed.
   */
  async saveAllRows() {
    if (this.pendingRows.length === 0 || this.isSavingAll) return;
    if (!this.currentBatchId) return;
    this.isSavingAll = true;

    try {
      const startDate = this.selectedBatch?.start_date;
      const invalidRows: any[] = [];
      const ops: { sql: string; params: any[] }[] = [];

      for (const row of this.pendingRows) {
        if (!row.date || row.total_birds === null || row.total_birds === '' || row.total_birds === undefined) {
          invalidRows.push(row);
          continue;
        }

        const day = startDate ? dayNumberFor(startDate, row.date) : (Number(row.day_number) || 1);

        ops.push({
          sql: `INSERT INTO layer_health
                  (batch_id, day_number, date, total_birds, mortality, feed_used, avg_weight, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            this.currentBatchId,
            day,
            row.date,
            Number(row.total_birds) || 0,
            Number(row.mortality) || 0,
            // Blank stays NULL, not 0. A 0 would claim no feed was used that day and
            // would then sit in every later day's cumulative denominator as fact.
            this.toNullableNumber(row.feed_used),
            this.toNullableNumber(row.avg_weight),
            row.notes || null
          ]
        });
      }

      if (ops.length > 0) {
        const result = await this.db.runBatch(ops);
        if (!result.success) {
          this.validationMessage = 'Could not save these rows: ' + friendlySqlError(result.error, 'unknown error');
          this.showValidationDialog = true;
          return;
        }
        this.pendingRows = invalidRows;
        await this.loadRecords();
      } else {
        this.pendingRows = invalidRows;
      }

      if (invalidRows.length > 0) {
        this.validationMessage = 'Some rows are missing required fields (Date, Total Birds) and were not saved.';
        this.showValidationDialog = true;
      }
    } finally {
      this.isSavingAll = false;
      this.cdr.detectChanges();
    }
  }

  private toNullableNumber(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // ── Edit ─────────────────────────────────────────────────────
  startEdit(record: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = record.health_id;
    this.editForm = {
      day_number: record.day_number,
      date: record.date,
      total_birds: record.total_birds,
      mortality: record.mortality,
      feed_used: record.feed_used,
      avg_weight: record.avg_weight,
      notes: record.notes
    };
    this.refreshDerived();
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
    this.refreshDerived();
  }

  async saveEdit(healthId: number) {
    if (this.isSaving) return;
    if (!this.editForm.date) {
      this.validationMessage = 'A date is required.';
      this.showValidationDialog = true;
      return;
    }

    this.isSaving = true;
    this.editingId = null;

    try {
      const startDate = this.selectedBatch?.start_date;
      const day = startDate
        ? dayNumberFor(startDate, this.editForm.date)
        : (Number(this.editForm.day_number) || 1);

      await this.db.run(
        `UPDATE layer_health SET
           day_number = ?, date = ?, total_birds = ?, mortality = ?,
           feed_used = ?, avg_weight = ?, notes = ?
         WHERE health_id = ?`,
        [
          day,
          this.editForm.date,
          Number(this.editForm.total_birds) || 0,
          Number(this.editForm.mortality) || 0,
          this.toNullableNumber(this.editForm.feed_used),
          this.toNullableNumber(this.editForm.avg_weight),
          this.editForm.notes || null,
          healthId
        ]
      );
      this.editForm = {};
      await this.loadRecords();
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  // ── Delete ───────────────────────────────────────────────────
  confirmDelete(healthId: number) {
    if (this.isSaving) return;
    this.deletingId = healthId;
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.isSaving) return;
    this.isSaving = true;
    this.showDeleteDialog = false;

    try {
      if (this.deletingId) {
        await this.db.run(`DELETE FROM layer_health WHERE health_id = ?`, [this.deletingId]);
        await this.loadRecords();
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
