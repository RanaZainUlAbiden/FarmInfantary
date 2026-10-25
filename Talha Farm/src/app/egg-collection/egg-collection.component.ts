import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService, DbBatchOp } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { PendingStateService } from '../shared/services/pending-state.service';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { Subscription } from 'rxjs';

import { toLocalDateString } from '../shared/utils/date.util';
import { friendlySqlError } from '../shared/utils/sql-error.util';
@Component({
  selector: 'app-egg-collection',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe, PaginationComponent],
  templateUrl: './egg-collection.component.html',
  styleUrl: './egg-collection.component.scss'
})
export class EggCollectionComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  batches: any[] = [];
  collections: any[] = [];
  // All layer farms for this account — drives the unit_id filter below.
  units: any[] = [];
  // The farm currently selected in the sidebar.
  currentUnit: any = null;
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;
  errorMessage = '';
  defaultEggsPerCarton: number | null = null;
  // Screen-level recording mode — every new pending row inherits this. Locked
  // (see hasPendingRows) once rows are pending so one save can't mix modes.
  screenMode: 'per_egg' | 'per_carton' = 'per_egg';

  currentPage = 1;
  pageSize = 30;

  selectedBatchFilter: string = 'all';
  private subs = new Subscription();

  get filteredCollections() {
    if (this.selectedBatchFilter === 'all') return this.collections;
    return this.collections.filter(c => String(c.batch_id) === String(this.selectedBatchFilter));
  }

  get paginatedCollections() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.filteredCollections.slice(start, start + this.pageSize);
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

    const cached = this.pendingState.getState('EggCollectionComponent');
    if (cached && cached.farmId === this.currentFarm?.farm_id) {
      this.pendingRows = cached.pendingRows || [];
      this.defaultEggsPerCarton = cached.defaultEggsPerCarton ?? null;
      // Restored rows already committed to a mode — the screen must match
      // them, not reset to the default, or the lock below would be wrong.
      if (this.pendingRows.length) {
        this.screenMode = this.pendingRows[0].collection_mode === 'per_carton' ? 'per_carton' : 'per_egg';
      }
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

  ngOnDestroy() {
    this.subs.unsubscribe();
    this.pendingState.saveState('EggCollectionComponent', { farmId: this.currentFarm?.farm_id, pendingRows: this.pendingRows, defaultEggsPerCarton: this.defaultEggsPerCarton });
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

    const colSql = unitId
      ? `SELECT ec.*, b.batch_name FROM egg_collection ec JOIN batches b ON ec.batch_id = b.batch_id WHERE b.farm_id = ? AND b.unit_id = ? ORDER BY ec.date DESC, ec.collection_id DESC`
      : `SELECT ec.*, b.batch_name FROM egg_collection ec JOIN batches b ON ec.batch_id = b.batch_id WHERE b.farm_id = ? ORDER BY ec.date DESC, ec.collection_id DESC`;
    const colParams = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const colResult = await this.db.get(colSql, colParams);
    this.collections = colResult.success ? colResult.data : [];
    this.cdr.detectChanges();
  }

  getBatchName(batchId: number): string {
    return this.batches.find(b => b.batch_id === batchId)?.batch_name || '—';
  }

  makeNewRow(): any {
    return {
      batch_id: this.selectedBatchFilter !== 'all' ? Number(this.selectedBatchFilter) : (this.batches.length > 0 ? this.batches[0].batch_id : null),
      date: toLocalDateString(),
      collection_mode: this.screenMode,
      total_eggs: null,
      carton_count: null,
      eggs_per_carton: this.defaultEggsPerCarton || 360,
      broken_eggs: 0, small_grade: 0, medium_grade: 0, large_grade: 0, xl_grade: 0
    };
  }

  // Switching is refused outright while rows are pending — never
  // warn-and-convert, never discard the pending rows. The inactive tab is
  // also [disabled] in the template; this guard covers any other caller.
  setScreenMode(mode: 'per_egg' | 'per_carton') {
    if (this.hasPendingRows || this.screenMode === mode) return;
    this.screenMode = mode;
  }

  applyDefaultEggsPerCartonToAll() {
    const def = this.defaultEggsPerCarton;
    if (!def) return;
    this.pendingRows.forEach(row => {
      if (row.collection_mode === 'per_carton') row.eggs_per_carton = def;
    });
  }

  // The real egg count, regardless of recording mode — this is what egg stock,
  // cumulative production, the layer report and every other consumer read. A
  // per_carton row derives it from carton_count * eggs_per_carton rather than
  // taking a directly-entered number, so a 2-carton collection records 720
  // eggs, never 2. Same shape as computeQuantity() in egg-sales.component.ts.
  //
  // Only total_eggs is derived. broken_eggs and the four grade columns are
  // plain egg counts in BOTH modes — a 2-carton collection with 1 broken egg
  // stores 1, not one carton's worth — so the grading check below compares
  // egg counts to egg counts either way.
  computeTotalEggs(row: any): number {
    if (row.collection_mode === 'per_carton') {
      return Number(row.carton_count || 0) * Number(row.eggs_per_carton || 360);
    }
    return Number(row.total_eggs || 0);
  }

  addPendingRow() {
    if (this.isSaving) return;
    this.editingId = null;
    this.pendingRows.push(this.makeNewRow());
  }

  addRowAfter(index: number) { this.pendingRows.splice(index + 1, 0, this.makeNewRow()); }
  removePendingRow(index: number) { this.pendingRows.splice(index, 1); }

  // Returns an error message if the row is invalid, otherwise null.
  validateEggRow(row: any): string | null {
    if (!row.batch_id || !row.date) return 'Select a batch and date.';
    if (row.collection_mode === 'per_carton') {
      if (!(Number(row.carton_count) > 0)) return 'Carton count must be greater than 0.';
      if (!(Number(row.eggs_per_carton) > 0)) return 'Eggs per carton must be greater than 0.';
    } else if (row.total_eggs === null || row.total_eggs === undefined || row.total_eggs === '') {
      return 'Select a batch, date and enter total eggs.';
    }
    // The DERIVED count, so in carton mode broken + graded is checked against
    // the real egg total (2 cartons -> 720) rather than against the 2.
    const total = this.computeTotalEggs(row);
    const broken = Number(row.broken_eggs) || 0;
    const small = Number(row.small_grade) || 0;
    const medium = Number(row.medium_grade) || 0;
    const large = Number(row.large_grade) || 0;
    const xl = Number(row.xl_grade) || 0;

    if ([total, broken, small, medium, large, xl].some(v => v < 0)) {
      return 'Quantities cannot be negative.';
    }
    if (broken + small + medium + large + xl > total) {
      return 'Broken + graded eggs cannot exceed total eggs.';
    }
    return null;
  }

  async saveAllRows() {
    if (this.pendingRows.length === 0 || this.isSavingAll) return;
    this.errorMessage = '';
    for (const row of this.pendingRows) {
      const error = this.validateEggRow(row);
      if (error) { this.errorMessage = error; this.cdr.detectChanges(); return; }
    }
    this.isSavingAll = true;
    try {
      // One runBatch rather than a loop of db.run(): every runQuery writes the
      // whole database back to disk, so a 30-row collection day was 30 file
      // writes, and an unchecked db.run() in the middle of the loop reported
      // its failure in `.success` and was silently dropped on the floor. The
      // batch is atomic and checked. Every row has already passed
      // validateEggRow above, so there is no partial-success case to carry.
      const ops: DbBatchOp[] = this.pendingRows.map(row => ({
        sql: `INSERT INTO egg_collection (batch_id, date, total_eggs, broken_eggs, small_grade, medium_grade, large_grade, xl_grade, collection_mode, carton_count, eggs_per_carton) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          row.batch_id, row.date,
          // The derived count, never row.total_eggs and never row.carton_count.
          this.computeTotalEggs(row),
          row.broken_eggs || 0, row.small_grade || 0, row.medium_grade || 0, row.large_grade || 0, row.xl_grade || 0,
          row.collection_mode || 'per_egg',
          row.collection_mode === 'per_carton' ? row.carton_count : null,
          row.eggs_per_carton || 360
        ]
      }));
      const result = await this.db.runBatch(ops);
      if (!result || !result.success) {
        this.errorMessage = `Saving the egg collection failed: ${friendlySqlError(result && result.error, 'unknown error')}`;
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

  startEdit(c: any) {
    if (this.isSaving) return;
    this.pendingRows = [];
    this.editingId = c.collection_id;
    // The row opens in the mode it was RECORDED in, not the screen's current
    // one, so a carton row edits as cartons and a per-egg row as eggs.
    this.editForm = {
      batch_id: c.batch_id, date: c.date,
      collection_mode: c.collection_mode || 'per_egg',
      total_eggs: c.total_eggs,
      carton_count: c.carton_count,
      eggs_per_carton: c.eggs_per_carton || 360,
      broken_eggs: c.broken_eggs, small_grade: c.small_grade, medium_grade: c.medium_grade, large_grade: c.large_grade, xl_grade: c.xl_grade
    };
  }

  cancelEdit() { if (!this.isSaving) { this.editingId = null; this.editForm = {}; } }

  async saveEdit(id: number) {
    if (this.isSaving) return;
    const error = this.validateEggRow(this.editForm);
    if (error) { this.errorMessage = error; this.cdr.detectChanges(); return; }
    this.isSaving = true;
    this.editingId = null;
    this.errorMessage = '';
    try {
      // Switching a row's mode either way re-derives total_eggs from the mode
      // it is being saved in, and clears carton_count when it lands on per_egg
      // so no stale carton figure is left behind on a row nothing reads it for.
      const result = await this.db.run(
        `UPDATE egg_collection SET batch_id = ?, date = ?, total_eggs = ?, broken_eggs = ?, small_grade = ?, medium_grade = ?, large_grade = ?, xl_grade = ?, collection_mode = ?, carton_count = ?, eggs_per_carton = ? WHERE collection_id = ?`,
        [this.editForm.batch_id, this.editForm.date,
         this.computeTotalEggs(this.editForm),
         this.editForm.broken_eggs || 0, this.editForm.small_grade || 0, this.editForm.medium_grade || 0, this.editForm.large_grade || 0, this.editForm.xl_grade || 0,
         this.editForm.collection_mode || 'per_egg',
         this.editForm.collection_mode === 'per_carton' ? this.editForm.carton_count : null,
         this.editForm.eggs_per_carton || 360,
         id]
      );
      if (!result || !result.success) {
        this.errorMessage = `Saving the egg collection failed: ${friendlySqlError(result && result.error, 'unknown error')}`;
        // Nothing was written, so reopen the row with what the user typed
        // rather than dropping their edit on the floor.
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

  confirmDelete(id: number) { if (!this.isSaving) { this.deletingId = id; this.showDeleteDialog = true; } }

  async onDeleteConfirmed() {
    if (this.isSaving || !this.deletingId) return;
    this.isSaving = true;
    this.showDeleteDialog = false;
    this.errorMessage = '';
    try {
      const result = await this.db.run('DELETE FROM egg_collection WHERE collection_id = ?', [this.deletingId]);
      if (!result || !result.success) {
        this.errorMessage = `Deleting the egg collection record failed: ${friendlySqlError(result && result.error, 'unknown error')}`;
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
