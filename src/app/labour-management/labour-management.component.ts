import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';
import { DeleteCodeDialogComponent } from '../shared/components/delete-code-dialog/delete-code-dialog.component';
import { PaginationComponent } from '../shared/components/pagination/pagination.component';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-labour-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent, DeleteCodeDialogComponent, PaginationComponent],
  templateUrl: './labour-management.component.html',
  styleUrl: './labour-management.component.scss'
})
export class LabourManagementComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  roster: any[] = [];
  isLoading = true;
  errorMessage = '';

  // Every farm (both broiler and layer) for this account — the roster itself
  // (`labour`) has no unit_id by design (a worker isn't tied to one physical
  // farm), so this only drives whether `total_paid` gets scoped to a unit.
  units: any[] = [];
  // Whichever farm is currently selected in the sidebar (broiler or layer,
  // whichever module was last active) — labour_payments has no unit_id
  // either, so total_paid is scoped by joining through flock_id to
  // flocks.unit_id (module_type='broiler') or batches.unit_id (module_type='layer').
  currentUnit: any = null;
  private subs = new Subscription();

  showForm = false;
  editingId: number | null = null;
  form = { labour_name: '', phone: '', role: '' };

  showDeleteDialog = false;
  showDeleteCodeDialog = false;
  deletingId: number | null = null;

  currentPage = 1;
  pageSize = 20;

  get paginatedRoster() {
    const start = (this.currentPage - 1) * this.pageSize;
    return this.roster.slice(start, start + this.pageSize);
  }

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private farmUnitService: FarmUnitService, private dataChange: DataChangeService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    if (!this.currentFarm) {
      this.isLoading = false;
      this.errorMessage = 'No farm selected — please log in again.';
      this.cdr.detectChanges();
      return;
    }
    try {
      // Load units first — the currentUnit$ subscription below fires
      // synchronously (BehaviorSubject) and its filtering depends on
      // this.units already being populated.
      await this.loadUnits();
      await this.loadData();
    } catch (error: any) {
      // loadData() already guards isLoading with its own finally; this only
      // catches a failure in loadUnits(), which has none — without it,
      // isLoading would stay true forever and the Add button would stay
      // disabled with no visible reason.
      this.isLoading = false;
      this.errorMessage = 'Error loading labour: ' + error.message;
      this.cdr.detectChanges();
    }

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

  ngOnDestroy() {
    this.subs.unsubscribe();
  }

  async loadUnits() {
    // No module filter — this screen isn't broiler- or layer-specific, it
    // just needs to know whether the account has any farms set up at all.
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id);
    this.units = result.success ? result.data : [];
  }

  async loadData() {
    this.isLoading = true;
    // No farms yet for this account — behave exactly as before the farm
    // selector existed rather than filtering to an empty total.
    const unitId = this.units.length > 0 ? this.currentUnit?.unit_id : undefined;
    try {
      const sql = unitId
        ? `SELECT l.*, COALESCE(SUM(CASE
             WHEN lp.module_type = 'broiler' AND fl.unit_id = ? THEN lp.amount
             WHEN lp.module_type = 'layer' AND ba.unit_id = ? THEN lp.amount
             ELSE 0 END), 0) as total_paid
           FROM labour l
           LEFT JOIN labour_payments lp ON l.labour_id = lp.labour_id
           LEFT JOIN flocks fl ON lp.flock_id = fl.flock_id AND lp.module_type = 'broiler'
           LEFT JOIN batches ba ON lp.flock_id = ba.batch_id AND lp.module_type = 'layer'
           WHERE l.farm_id = ?
           GROUP BY l.labour_id
           ORDER BY l.labour_name ASC`
        : `SELECT l.*, COALESCE(SUM(lp.amount), 0) as total_paid
           FROM labour l
           LEFT JOIN labour_payments lp ON l.labour_id = lp.labour_id
           WHERE l.farm_id = ?
           GROUP BY l.labour_id
           ORDER BY l.labour_name ASC`;
      const params = unitId ? [unitId, unitId, this.currentFarm.farm_id] : [this.currentFarm.farm_id];
      const result = await this.db.get(sql, params);
      this.roster = result.success ? result.data : [];
      this.currentPage = 1;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }

  openAddForm() {
    this.editingId = null;
    this.form = { labour_name: '', phone: '', role: '' };
    this.showForm = true;
  }

  openEditForm(l: any) {
    this.editingId = l.labour_id;
    this.form = { labour_name: l.labour_name, phone: l.phone || '', role: l.role || '' };
    this.showForm = true;
  }

  cancelForm() { this.showForm = false; this.editingId = null; }

  async saveForm() {
    if (!this.form.labour_name.trim()) return;
    this.errorMessage = '';
    try {
      const result = this.editingId
        ? await this.db.run(
            `UPDATE labour SET labour_name=?, phone=?, role=? WHERE labour_id=?`,
            [this.form.labour_name.trim(), this.form.phone, this.form.role, this.editingId]
          )
        : await this.db.run(
            `INSERT INTO labour (farm_id, labour_name, phone, role) VALUES (?,?,?,?)`,
            [this.currentFarm.farm_id, this.form.labour_name.trim(), this.form.phone, this.form.role]
          );
      if (!result.success) {
        this.errorMessage = 'Error saving: ' + friendlySqlError(result.error, 'Unknown error');
        this.cdr.detectChanges();
        return;
      }
      this.showForm = false;
      this.editingId = null;
      await this.loadData();
    } catch (error: any) {
      this.errorMessage = 'Error saving: ' + error.message;
      this.cdr.detectChanges();
    }
  }

  async toggleStatus(l: any) {
    const newStatus = l.status === 'inactive' ? 'active' : 'inactive';
    const result = await this.db.run(`UPDATE labour SET status=? WHERE labour_id=?`, [newStatus, l.labour_id]);
    if (result.success) {
      l.status = newStatus;
      this.cdr.detectChanges();
    } else {
      this.errorMessage = 'Error updating status: ' + friendlySqlError(result.error, 'Unknown error');
      this.cdr.detectChanges();
    }
  }

  confirmDelete(id: number) { this.deletingId = id; this.showDeleteCodeDialog = true; }
  onDeleteCodeVerified() { this.showDeleteCodeDialog = false; this.showDeleteDialog = true; }
  onDeleteCodeCancelled() { this.showDeleteCodeDialog = false; this.deletingId = null; }
  onDeleteCancelled() { this.showDeleteDialog = false; this.deletingId = null; }

  async onDeleteConfirmed() {
    if (!this.deletingId) return;
    try {
      // Payments already recorded for this labourer are kept — the money did
      // leave the farm, and deleting them would silently rewrite past profit.
      // Every screen that lists payments therefore LEFT JOINs `labour` and
      // shows an orphan as 'Deleted Worker' (labour.component.ts,
      // labour.resolver.ts, report.component.ts, layer-report.component.ts),
      // which is what Overview and the Farm Report already count — they never
      // join `labour` at all. Use the inactive toggle above to retire someone
      // from the roster without touching history.
      const result = await this.db.run(`DELETE FROM labour WHERE labour_id=?`, [this.deletingId]);
      if (!result.success) {
        this.errorMessage = 'Error deleting: ' + friendlySqlError(result.error, 'Unknown error');
        this.showDeleteDialog = false;
        this.cdr.detectChanges();
        return;
      }
      this.showDeleteDialog = false;
      this.deletingId = null;
      await this.loadData();
    } catch (error: any) {
      this.errorMessage = 'Error deleting: ' + error.message;
      this.showDeleteDialog = false;
      this.cdr.detectChanges();
    }
  }
}