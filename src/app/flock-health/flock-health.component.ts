import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DatabaseService } from '../shared/services/database.service';
import { FlockService } from '../shared/services/flock.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { Subscription } from 'rxjs';
import { skip } from 'rxjs/operators';
import { PendingStateService } from '../shared/services/pending-state.service';
import { computeAutoFcr, displayFcr, latestFlockFcr } from '../shared/utils/fcr.util';

@Component({
  selector: 'app-flock-health',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent],
  templateUrl: './flock-health.component.html',
  styleUrl: './flock-health.component.scss'
})
export class FlockHealthComponent implements OnInit, OnDestroy {
  currentFlock: any = null;
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

  private subs = new Subscription();

  // ── Computed ─────────────────────────────────────────────────
  get hasPendingRows(): boolean {
    return this.pendingRows.length > 0;
  }

  get totalFeedUsed(): number {
    return this.healthRecords.reduce((s, r) => s + (r.feed_used || 0), 0);
  }

  get totalMortality(): number {
    return this.healthRecords.reduce((s, r) => s + (r.mortality || 0), 0);
  }

  get currentBirdCount(): number {
    if (this.healthRecords.length === 0) return 0;
    const last = this.healthRecords[this.healthRecords.length - 1];
    return (last.total_birds || 0) - (last.mortality || 0);
  }

  getRowRemaining(row: any): number {
    return (row.total_birds || 0) - (row.mortality || 0);
  }

  /**
   * The FCR of the highest-day record that actually has both a weight and
   * cumulative feed to derive one from. The selection and the arithmetic now
   * live in `latestFlockFcr` in fcr.util.ts, because the broiler Report prints
   * the same figure on a card of its own — see the note there. The candidate
   * rows are the SAVED records while the denominator pool is `fcrRows`, so the
   * card moves as an unsaved row is typed.
   */
  get latestFcr(): number | null {
    return latestFlockFcr(this.healthRecords, this.fcrRows);
  }

  /**
   * Every row the FCR denominator is drawn from: the saved records, with the one
   * being edited swapped for the live form values, plus the unsaved pending rows.
   * Feed is cumulative from day 1, so one row's FCR depends on all the others.
   */
  private get fcrRows(): any[] {
    const saved = this.healthRecords.map(r =>
      this.editingId !== null && r.health_id === this.editingId
        ? { ...r, ...this.editForm }
        : r
    );
    return saved.concat(this.pendingRows);
  }

  getRowAutoFcr(row: any): number {
    return computeAutoFcr(row, this.fcrRows);
  }

  /**
   * FCR shown for a saved row. Derived rather than read back from the stored
   * `fcr` column, so changing an earlier day's feed moves every later day's
   * value, and so rows written by the old formula read correctly without their
   * stored value being rewritten. Hand-entered rows keep what was typed.
   */
  getDisplayFcr(record: any): number {
    return displayFcr(record, this.fcrRows);
  }

  /**
   * A day's feed lands in every later day's cumulative denominator, so one edit
   * moves more than one row — refresh every unsaved row, not just the one typed
   * into. Rows whose FCR was entered by hand keep their value.
   */
  onRowFeedOrWeightChange() {
    for (const row of this.pendingRows) {
      if (!row.fcrManuallyEdited) {
        row.fcr = this.getRowAutoFcr(row) || null;
      }
    }
  }

  onRowFcrChange(row: any) {
    row.fcrManuallyEdited = true;
  }

  get editRemaining(): number {
    return (this.editForm.total_birds || 0) - (this.editForm.mortality || 0);
  }

  get editAutoFcr(): number {
    return computeAutoFcr(this.editForm, this.fcrRows);
  }

  onEditFeedOrWeightChange() {
    if (!this.editForm.fcrManuallyEdited) {
      this.editForm.fcr = this.editAutoFcr || null;
    }
  }

  onEditFcrChange() {
    this.editForm.fcrManuallyEdited = true;
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
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    private pendingState: PendingStateService
  ) {}

  ngOnInit() {
    const resolved = this.route.snapshot.data['data'];
    if (resolved) {
      this.currentFlock = resolved.flock;
      this.healthRecords = resolved.records || [];

      const cached = this.pendingState.getState('FlockHealthComponent');
      if (cached && cached.flockId === this.currentFlock?.flock_id) {
        this.pendingRows = cached.pendingRows || [];
      }
    }

    this.subs.add(
      this.flockService.currentFlock$.pipe(skip(1)).subscribe(flock => {
        if (flock) {
          this.currentFlock = flock;
          this.editingId = null;
          this.pendingRows = [];
          this.isSaving = false;
          this.pendingState.clearState('FlockHealthComponent');
          this.loadRecords();
        }
      })
    );
  }

  ngOnDestroy() {
    this.pendingState.saveState('FlockHealthComponent', {
      flockId: this.currentFlock?.flock_id,
      pendingRows: this.pendingRows
    });
    this.subs.unsubscribe();
  }

  async loadRecords() {
    if (!this.currentFlock) return;
    const result = await this.db.get(
      `SELECT * FROM flock_health WHERE flock_id = ? ORDER BY week_number ASC`,
      [this.currentFlock.flock_id]
    );
    if (result.success) {
      this.healthRecords = result.data;
      this.cdr.detectChanges();
    }
  }

  // ── Pending Rows (Multi-row add) ─────────────────────────────
  /**
   * Highest day index across saved and unsaved rows. Deleting a row does not
   * renumber the ones after it, so a new row must be placed past the highest
   * surviving day — counting rows (`.length`) collides with whatever day was
   * left behind by an earlier delete.
   */
  private maxWeekNumber(): number {
    const fromSaved = this.healthRecords.reduce((max, r) => Math.max(max, Number(r.week_number) || 0), 0);
    const fromPending = this.pendingRows.reduce((max, r) => Math.max(max, Number(r.week_number) || 0), 0);
    return Math.max(fromSaved, fromPending);
  }

  makeNewRow(): any {
    const last = this.healthRecords.length > 0
      ? this.healthRecords[this.healthRecords.length - 1]
      : null;

    return {
      week_number: this.maxWeekNumber() + 1,
      total_birds: last ? last.total_birds - last.mortality : null,
      mortality: null,
      feed_used: null,
      avg_weight: null,
      fcr: null,
      fcrManuallyEdited: false
    };
  }

  addPendingRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.pendingRows.push(this.makeNewRow());
  }

  addRowAfter(index: number) {
    const newRow = this.makeNewRow();
    this.pendingRows.splice(index + 1, 0, newRow);
    this.recalculateWeekNumbers();
  }

  removePendingRow(index: number) {
    this.pendingRows.splice(index, 1);
    this.recalculateWeekNumbers();
  }

  recalculateWeekNumbers() {
    const baseWeek = this.healthRecords.reduce((max, r) => Math.max(max, Number(r.week_number) || 0), 0);
    this.pendingRows.forEach((row, i) => {
      row.week_number = baseWeek + i + 1;
    });
  }

  async saveAllRows() {
    if (this.pendingRows.length === 0) return;
    if (this.isSavingAll) return;
    this.isSavingAll = true;

    try {
      const invalidRows: any[] = [];
      let insertedCount = 0;

      for (const row of this.pendingRows) {
        if (!row.week_number || !row.total_birds) {
          invalidRows.push(row);
          continue;
        }

        const fcr = row.fcrManuallyEdited
          ? (row.fcr || 0)
          : this.getRowAutoFcr(row);

        await this.db.run(
          `INSERT INTO flock_health
            (flock_id, week_number, total_birds, mortality, feed_used, avg_weight, fcr, fcr_manual)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.currentFlock.flock_id,
            row.week_number,
            row.total_birds,
            row.mortality || 0,
            row.feed_used || 0,
            row.avg_weight || 0,
            fcr,
            row.fcrManuallyEdited ? 1 : 0
          ]
        );
        insertedCount++;
      }

      this.pendingRows = invalidRows;
      
      if (insertedCount > 0) {
        await this.loadRecords();
      }

      if (invalidRows.length > 0) {
        this.validationMessage = 'Some rows are missing required fields (Date, Total Birds, etc) and were not saved.';
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

  // ── Edit ─────────────────────────────────────────────────────
  startEdit(record: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = record.health_id;
    this.editForm = {
      week_number: record.week_number,
      total_birds: record.total_birds,
      mortality: record.mortality,
      feed_used: record.feed_used,
      avg_weight: record.avg_weight,
      fcr: record.fcr,
      // A hand-entered FCR stays hand-entered across reloads — the flag lives in
      // the `fcr_manual` column, not just in this session.
      fcrManuallyEdited: !!record.fcr_manual
    };
  }

  cancelEdit() {
    if (this.isSaving) return;
    this.editingId = null;
    this.editForm = {};
  }

  async saveEdit(healthId: number) {
    if (this.isSaving) return;

    this.isSaving = true;

    // Compute the FCR while `editingId` still points at this row — `fcrRows`
    // (and so the cumulative-feed denominator) only substitutes the live
    // `editForm` values in place of the stale saved row while editingId matches.
    // Clearing editingId first would compute against the pre-edit feed_used.
    const fcr = this.editForm.fcrManuallyEdited
      ? (this.editForm.fcr || 0)
      : this.editAutoFcr;

    this.editingId = null;

    try {
      await this.db.run(
        `UPDATE flock_health SET
          week_number = ?, total_birds = ?, mortality = ?,
          feed_used = ?, avg_weight = ?, fcr = ?, fcr_manual = ?
         WHERE health_id = ?`,
        [
          this.editForm.week_number,
          this.editForm.total_birds,
          this.editForm.mortality,
          this.editForm.feed_used,
          this.editForm.avg_weight,
          fcr,
          this.editForm.fcrManuallyEdited ? 1 : 0,
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
        await this.db.run(
          `DELETE FROM flock_health WHERE health_id = ?`,
          [this.deletingId]
        );
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