import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DateOnlyPipe } from '../shared/pipes/date-format.pipe';
import { FlockService } from '../shared/services/flock.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { Subscription } from 'rxjs';

import { toLocalDateString } from '../shared/utils/date.util';
@Component({
  selector: 'app-vaccination',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DateOnlyPipe],
  templateUrl: './vaccination.component.html',
  styleUrl: './vaccination.component.scss'
})
export class VaccinationComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  batches: any[] = [];
  flocks: any[] = [];
  vaccinations: any[] = [];
  pendingRows: any[] = [];
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isSavingAll = false;
  currentBatchId: number | null = null;
  currentFlockId: number | null = null;
  // All layer farms for this account — drives the unit_id filter on batches.
  units: any[] = [];
  // The farm currently selected in the sidebar.
  currentUnit: any = null;
  private subs = new Subscription();

  get hasPendingRows(): boolean { return this.pendingRows.length > 0; }
  get totalVaccinationCost(): number {
    return this.vaccinations.reduce((s, v) => s + (v.cost || 0), 0);
  }

  /** Layer uses batches, broiler uses flocks — driven by the active flock/batch
   *  selection, falling back to the account's business type when nothing is
   *  selected yet (e.g. no records exist in either module). */
  get isLayerMode(): boolean {
    if (this.currentBatchId) return true;
    if (this.currentFlockId) return false;
    const type = this.currentFarm?.business_type === 'all'
      ? (localStorage.getItem('activeBusinessTab') || 'broiler')
      : this.currentFarm?.business_type;
    return type === 'layer';
  }

  get hasNoTargets(): boolean {
    return this.isLayerMode ? this.batches.length === 0 : this.flocks.length === 0;
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

  constructor(private db: DatabaseService, private authService: AuthService, private cdr: ChangeDetectorRef, private flockService: FlockService, private farmUnitService: FarmUnitService, private dataChange: DataChangeService) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    // Load units first — the currentUnit$ subscription below fires
    // synchronously (BehaviorSubject) and its filtering depends on
    // this.units already being populated.
    await this.loadUnits();
    this.applyActiveFlock(this.flockService.getCurrentFlock());
    await this.loadData();
    this.subs.add(
      this.flockService.currentFlock$.subscribe(flock => {
        this.applyActiveFlock(flock);
        this.loadData();
      })
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

  ngOnDestroy() { this.subs.unsubscribe(); }

  private applyActiveFlock(flock: any) {
    if (!flock) return;
    if (flock.batch_id) {
      this.currentBatchId = Number(flock.batch_id);
      this.currentFlockId = null;
    } else if (flock.flock_id) {
      this.currentFlockId = Number(flock.flock_id);
      this.currentBatchId = null;
    }
    this.cdr.detectChanges();
  }

  async loadData() {
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty list.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;
    const brSql = unitId
      ? `SELECT * FROM batches WHERE farm_id = ? AND status='active' AND unit_id = ?`
      : `SELECT * FROM batches WHERE farm_id = ? AND status='active'`;
    const brParams = unitId ? [this.currentFarm.farm_id, unitId] : [this.currentFarm.farm_id];
    const br = await this.db.get(brSql, brParams);
    this.batches = br.success ? br.data : [];

    const fr = await this.db.get(`SELECT * FROM flocks WHERE farm_id = ? AND status='active'`, [this.currentFarm.farm_id]);
    this.flocks = fr.success ? fr.data : [];

    if (this.currentBatchId) {
      // Layer view — only vaccinations for this specific batch
      const vr = await this.db.get(`
        SELECT v.*, b.batch_name, f.flock_name
        FROM vaccinations v
        LEFT JOIN batches b ON v.batch_id = b.batch_id
        LEFT JOIN flocks f ON v.flock_id = f.flock_id
        WHERE v.batch_id = ?
        ORDER BY v.date ASC`,
        [this.currentBatchId]);
      this.vaccinations = vr.success ? vr.data : [];
    } else if (this.currentFlockId) {
      // Broiler view — only vaccinations for this specific flock
      const vr = await this.db.get(`
        SELECT v.*, b.batch_name, f.flock_name
        FROM vaccinations v
        LEFT JOIN batches b ON v.batch_id = b.batch_id
        LEFT JOIN flocks f ON v.flock_id = f.flock_id
        WHERE v.flock_id = ?
        ORDER BY v.date ASC`,
        [this.currentFlockId]);
      this.vaccinations = vr.success ? vr.data : [];
    } else {
      this.vaccinations = [];
    }
    this.cdr.detectChanges();
  }

  getTargetName(v: any) { 
    if (v.flock_id) return this.flocks.find(f => f.flock_id === v.flock_id)?.flock_name || '—';
    return this.batches.find(b => b.batch_id === v.batch_id)?.batch_name || '—'; 
  }

  makeNewRow() { 
    return { 
      batch_id: this.currentBatchId || null, 
      flock_id: this.currentFlockId || null, 
      date: toLocalDateString(), 
      vaccine_name: '', 
      dose: '', 
      notes: '', 
      cost: null,
      done: 0 
    }; 
  }
  
  addPendingRow() { if (!this.isSaving) this.pendingRows.push(this.makeNewRow()); }
  addRowAfter(i: number) { this.pendingRows.splice(i + 1, 0, this.makeNewRow()); }
  removePendingRow(i: number) { this.pendingRows.splice(i, 1); }

  async saveAllRows() {
    if (!this.pendingRows.length || this.isSavingAll) return;
    this.isSavingAll = true;
    for (const row of this.pendingRows) {
      if ((!row.batch_id && !row.flock_id) || !row.vaccine_name) continue;
      await this.db.run(`INSERT INTO vaccinations (batch_id, flock_id, date, vaccine_name, dose, notes, cost, done) VALUES (?,?,?,?,?,?,?,?)`, 
        [row.batch_id || null, row.flock_id || null, row.date, row.vaccine_name, row.dose, row.notes, row.cost || 0, row.done ? 1 : 0]);
    }
    this.pendingRows = [];
    this.isSavingAll = false;
    await this.loadData();
  }

  cancelAllRows() { this.pendingRows = []; }

  startEdit(v: any) { this.editingId = v.vaccination_id; this.editForm = { batch_id: v.batch_id, flock_id: v.flock_id, date: v.date, vaccine_name: v.vaccine_name, dose: v.dose, notes: v.notes, cost: v.cost, done: !!v.done }; }
  cancelEdit() { this.editingId = null; }
  async saveEdit(id: number) {
    await this.db.run(`UPDATE vaccinations SET batch_id=?, flock_id=?, date=?, vaccine_name=?, dose=?, notes=?, cost=?, done=? WHERE vaccination_id=?`, 
      [this.editForm.batch_id || null, this.editForm.flock_id || null, this.editForm.date, this.editForm.vaccine_name, this.editForm.dose, this.editForm.notes, this.editForm.cost || 0, this.editForm.done ? 1 : 0, id]);
    this.editingId = null; await this.loadData();
  }

  confirmDelete(id: number) { this.deletingId = id; this.showDeleteDialog = true; }
  async onDeleteConfirmed() { await this.db.run('DELETE FROM vaccinations WHERE vaccination_id=?', [this.deletingId]); this.showDeleteDialog = false; await this.loadData(); }
  onDeleteCancelled() { this.showDeleteDialog = false; }
}
