import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { DatabaseService } from '../shared/services/database.service';
import { AuthService } from '../shared/services/auth.service';
import { FarmUnitService } from '../shared/services/farm-unit.service';
import { DataChangeService } from '../shared/services/data-change.service';
import { friendlySqlError } from '../shared/utils/sql-error.util';
import { ConfirmDialogComponent } from '../shared/components/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'app-farm-units',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent],
  templateUrl: './farm-units.component.html',
  styleUrl: './farm-units.component.scss'
})
export class FarmUnitsComponent implements OnInit, OnDestroy {
  currentFarm: any = null;
  moduleType: 'broiler' | 'layer' = 'broiler';
  units: any[] = [];
  showNewRow = false;
  editingId: number | null = null;
  editForm: any = {};
  showDeleteDialog = false;
  deletingId: number | null = null;
  isSaving = false;
  isLoading = false;
  errorMessage = '';

  newRow: { unit_name: string; location: string; notes: string; opening_balance: number | null } =
    { unit_name: '', location: '', notes: '', opening_balance: null };

  businessType = 'broiler';
  isSavingBusinessType = false;
  businessTypeMessage = '';

  private moduleChangedSub?: Subscription;

  constructor(
    private db: DatabaseService,
    private authService: AuthService,
    private farmUnitService: FarmUnitService,
    private dataChange: DataChangeService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.currentFarm = this.authService.getCurrentFarm();
    this.businessType = this.currentFarm?.business_type || 'broiler';
    this.moduleType = this.resolveModuleType();
    this.loadUnits();

    // The "Farms" menu item shares the same route in both the broiler and
    // layer menus, so switching business tabs while this page is already
    // open does NOT re-navigate and ngOnInit does not re-run. Without this,
    // moduleType stays stuck at whatever it was resolved to on mount, and
    // the unit list silently keeps querying the old module.
    this.moduleChangedSub = this.farmUnitService.moduleChanged$.subscribe(moduleType => {
      this.moduleType = moduleType;
      this.loadUnits();
    });
  }

  ngOnDestroy() {
    this.moduleChangedSub?.unsubscribe();
  }

  get itemLabel(): string {
    return this.moduleType === 'layer' ? 'Batches' : 'Flocks';
  }

  // Matches layout.component.ts's own resolution of the active module: 'all'
  // accounts read the tab the sidebar last had active, everyone else just
  // uses their fixed business_type.
  private resolveModuleType(): 'broiler' | 'layer' {
    const savedBusinessType = this.authService.getCurrentFarm()?.business_type || 'broiler';
    const activeTab = savedBusinessType === 'all'
      ? (localStorage.getItem('activeBusinessTab') || 'broiler')
      : savedBusinessType;
    return activeTab === 'layer' ? 'layer' : 'broiler';
  }

  async loadUnits() {
    this.isLoading = true;
    this.errorMessage = '';
    const result = await this.db.getFarmUnits(this.currentFarm.farm_id, this.moduleType);
    const units = result.success ? result.data : [];

    const countsResult = this.moduleType === 'layer'
      ? await this.db.get('SELECT unit_id, COUNT(*) as count FROM batches WHERE farm_id = ? GROUP BY unit_id', [this.currentFarm.farm_id])
      : await this.db.get('SELECT unit_id, COUNT(*) as count FROM flocks WHERE farm_id = ? GROUP BY unit_id', [this.currentFarm.farm_id]);

    const counts: Record<number, number> = {};
    if (countsResult.success) {
      for (const row of countsResult.data) counts[row.unit_id] = row.count;
    }

    this.units = units.map((u: any) => ({ ...u, itemCount: counts[u.unit_id] || 0 }));
    this.isLoading = false;
    this.cdr.detectChanges();
  }

  addNewRow() {
    this.showNewRow = true;
    this.errorMessage = '';
    this.newRow = { unit_name: '', location: '', notes: '', opening_balance: null };
  }

  cancelNewRow() {
    this.showNewRow = false;
  }

  async saveNewRow() {
    if (!this.newRow.unit_name.trim()) return;
    this.isSaving = true;
    this.showNewRow = false;
    this.errorMessage = '';
    try {
      const result = await this.db.addFarmUnit({
        farm_id: this.currentFarm.farm_id,
        module_type: this.moduleType,
        unit_name: this.newRow.unit_name.trim(),
        location: this.newRow.location?.trim() || undefined,
        notes: this.newRow.notes?.trim() || undefined,
        opening_balance: this.newRow.opening_balance ?? 0
      });
      if (!result.success) {
        this.errorMessage = friendlySqlError(result.error, 'Failed to save farm.');
      } else {
        await this.loadUnits();
        this.dataChange.announce('units');
      }
    } catch (err: any) {
      this.errorMessage = 'Failed to save farm: ' + err.message;
    } finally {
      this.isSaving = false;
      this.cdr.detectChanges();
    }
  }

  startEdit(u: any) {
    this.editingId = u.unit_id;
    this.errorMessage = '';
    this.editForm = { unit_name: u.unit_name, location: u.location, notes: u.notes, opening_balance: u.opening_balance ?? 0 };
  }

  cancelEdit() {
    this.editingId = null;
  }

  async saveEdit(id: number) {
    if (!this.editForm.unit_name?.trim()) return;
    this.errorMessage = '';
    try {
      const result = await this.db.updateFarmUnit(id, {
        unit_name: this.editForm.unit_name.trim(),
        location: this.editForm.location?.trim() || null,
        notes: this.editForm.notes?.trim() || null,
        opening_balance: this.editForm.opening_balance ?? 0
      });
      if (!result.success) {
        this.errorMessage = friendlySqlError(result.error, 'Failed to update farm.');
        this.cdr.detectChanges();
        return;
      }
      this.editingId = null;
      await this.loadUnits();
      this.dataChange.announce('units');
    } catch (err: any) {
      this.errorMessage = 'Failed to update farm: ' + err.message;
      this.cdr.detectChanges();
    }
  }

  confirmDelete(id: number) {
    this.deletingId = id;
    this.errorMessage = '';
    this.showDeleteDialog = true;
  }

  async onDeleteConfirmed() {
    if (this.deletingId === null) return;
    try {
      const result = await this.db.deleteFarmUnit(this.deletingId);
      this.showDeleteDialog = false;
      if (!result.success) {
        this.errorMessage = friendlySqlError(result.error, 'Failed to delete farm.');
        this.cdr.detectChanges();
        return;
      }
      await this.loadUnits();
      this.dataChange.announce('units');
    } catch (err: any) {
      this.errorMessage = 'Failed to delete farm: ' + err.message;
      this.showDeleteDialog = false;
      this.cdr.detectChanges();
    }
  }

  onDeleteCancelled() {
    this.showDeleteDialog = false;
  }

  get businessTypeDirty(): boolean {
    return this.businessType !== (this.currentFarm?.business_type || 'broiler');
  }

  async saveBusinessType() {
    if (!this.businessTypeDirty || this.isSavingBusinessType) return;
    this.isSavingBusinessType = true;
    this.businessTypeMessage = '';
    this.cdr.detectChanges();

    const result = await this.authService.updateBusinessType(this.currentFarm.farm_id, this.businessType);

    if (result.success) {
      this.currentFarm = this.authService.getCurrentFarm();
      this.businessTypeMessage = 'Saved. Your menu has been updated.';
      this.moduleType = this.resolveModuleType();
      await this.loadUnits();
    } else {
      this.businessTypeMessage = friendlySqlError(result.error, 'Failed to update. Please try again.');
    }

    this.isSavingBusinessType = false;
    this.cdr.detectChanges();
  }
}
